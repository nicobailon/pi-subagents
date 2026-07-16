import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceInput,
	AcceptanceLedger,
	AcceptanceLevel,
	AcceptanceReport,
	AcceptanceRole,
	AcceptanceRuntimeCheck,
	AcceptanceRuntimeCheckStatus,
	AcceptanceReviewResult,
	AcceptanceVerifyCommand,
	AcceptanceVerifyResult,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
	SingleResult,
	SubagentRunMode,
} from "../../shared/types.ts";
import { classifyTaskMutationIntent, taskMayMutate } from "./task-intent.ts";

const LEVEL_RANK: Record<Exclude<AcceptanceLevel, "auto">, number> = {
	none: 0,
	attested: 1,
	checked: 2,
	verified: 3,
	reviewed: 4,
};

const VALID_LEVELS = new Set<AcceptanceLevel>(["auto", "none", "attested", "checked", "verified", "reviewed"]);
const VALID_EVIDENCE = new Set<AcceptanceEvidenceKind>([
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
	"diff-summary",
	"review-findings",
	"manual-notes",
]);
const ACCEPTANCE_CONFIG_KEYS = new Set(["level", "criteria", "evidence", "verify", "review", "stopRules", "reason"]);
const ACCEPTANCE_GATE_KEYS = new Set(["id", "must", "evidence", "severity"]);
const ACCEPTANCE_VERIFY_KEYS = new Set(["id", "command", "timeoutMs", "cwd", "env", "allowFailure"]);
const ACCEPTANCE_REVIEW_KEYS = new Set(["agent", "focus", "required"]);
const EXPLICIT_REVIEWED_UNAVAILABLE = "cannot be requested explicitly because this run cannot supply an independent reviewer result; use checked/verified and orchestrate the reviewer separately, or omit acceptance for read-only review tasks.";

function normalizeLevel(level: AcceptanceLevel | undefined): Exclude<AcceptanceLevel, "auto"> | "auto" {
	return level ?? "auto";
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function requiredEvidenceForLevel(level: Exclude<AcceptanceLevel, "auto">): AcceptanceEvidenceKind[] {
	switch (level) {
		case "none":
			return [];
		case "attested":
			return ["manual-notes", "residual-risks"];
		case "checked":
			return ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"];
		case "verified":
		case "reviewed":
			return ["changed-files", "tests-added", "commands-run", "validation-output", "residual-risks", "no-staged-files"];
	}
}

function inferLevel(input: {
	agentName: string;
	acceptanceRole?: AcceptanceRole;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): { level: Exclude<AcceptanceLevel, "auto">; reasons: string[]; criteria: string[]; evidence: AcceptanceEvidenceKind[]; review?: { agent?: string; required?: boolean } } {
	const agent = input.agentName.toLowerCase();
	const task = input.task?.toLowerCase() ?? "";
	const reasons: string[] = [];
	// Declared roles replace name heuristics, so use the full writer grammar to detect explicit mutation independently of the actual agent name.
	const intent = classifyTaskMutationIntent(input.acceptanceRole ? "worker" : input.agentName, input.task ?? "");
	const readOnlyTask = intent.kind === "read-only"
		|| (intent.kind === "unknown" && /\b(?:read[- ]only|review[- ]only|no edits|without edits|inspect|summari[sz]e)\b/.test(task));
	const rolePatchTask = input.acceptanceRole !== undefined
		&& intent.kind !== "read-only"
		&& !/\b(?:do not|don't|must not)\s+patch\b/.test(task)
		&& /\bpatch\s+(?:(?:\.{0,2}[\\/])?(?:[\w.-]+[\\/])+[\w.-]+|[\w.-]+\.[a-z0-9]+\b|(?:the\s+)?parser\b)/.test(task);
	const taskMayWrite = taskMayMutate(input.task ?? "") || intent.kind === "implementation" || rolePatchTask;
	const readOnlyAgent = input.acceptanceRole === "read-only"
		|| (input.acceptanceRole === undefined && /\b(?:reviewer|scout|context-builder|researcher|analyst)\b/.test(agent));
	const writeTask = taskMayWrite
		|| (input.acceptanceRole === "writer" && !readOnlyTask)
		|| (input.acceptanceRole === undefined && /\bworker\b/.test(agent) && !readOnlyTask);
	const inferredReadOnly = readOnlyTask || (input.acceptanceRole === "read-only" && !taskMayWrite);
	const roleResolvesReadOnly = input.acceptanceRole !== undefined && inferredReadOnly;
	const keywordRiskReadOnly = input.acceptanceRole === undefined ? intent.kind === "read-only" : inferredReadOnly;
	const risky = Boolean(input.async && writeTask)
		|| (Boolean(input.dynamic) && !roleResolvesReadOnly)
		|| (Boolean(input.dynamicGroup) && !roleResolvesReadOnly)
		|| (!keywordRiskReadOnly && /\b(?:release|migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/.test(task));

	if (risky) {
		reasons.push(input.async ? "async write-capable or risky run" : "risky write-capable run");
		if (input.dynamic || input.dynamicGroup) reasons.push("dynamic fanout context");
		return {
			level: "reviewed",
			reasons,
			criteria: ["Implement the requested change without widening scope", "Return evidence sufficient for an independent acceptance review"],
			evidence: requiredEvidenceForLevel("reviewed"),
			review: { agent: "reviewer", required: true },
		};
	}
	if (writeTask && !readOnlyTask) {
		reasons.push(input.acceptanceRole === "writer" && !taskMayWrite ? "declared writer acceptance role" : "write-capable worker/task");
		return {
			level: "checked",
			reasons,
			criteria: ["Implement the requested change without widening scope"],
			evidence: requiredEvidenceForLevel("checked"),
		};
	}
	if (readOnlyAgent || readOnlyTask) {
		reasons.push(input.acceptanceRole === "read-only" && !readOnlyTask ? "declared read-only acceptance role" : readOnlyAgent ? "read-only/reviewer-style agent" : "read-only task wording");
		return {
			level: "attested",
			reasons,
			criteria: ["Return concrete findings with file paths and severity when applicable"],
			evidence: ["review-findings", "residual-risks"],
		};
	}
	reasons.push("default lightweight attestation");
	return {
		level: "attested",
		reasons,
		criteria: ["Return a concise result and residual risks when applicable"],
		evidence: ["manual-notes", "residual-risks"],
	};
}

export function normalizeAcceptanceInput(input: AcceptanceInput | undefined): AcceptanceConfig {
	if (input === undefined || input === "auto") return { level: "auto" };
	if (input === false) return { level: "none", reason: "disabled by deprecated false shorthand" };
	if (typeof input === "string") return { level: input };
	return { ...input };
}

function explicitAcceptanceCanDisable(explicit: AcceptanceConfig): boolean {
	return explicit.level === "none" && typeof explicit.reason === "string" && explicit.reason.trim().length > 0;
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	const errors: string[] = [];
	if (input === undefined) return errors;
	if (input === false) return errors;
	if (typeof input === "string") {
		if (!VALID_LEVELS.has(input as AcceptanceLevel)) errors.push(`${pathLabel} has invalid level '${input}'.`);
		else if (input === "none") errors.push(`${pathLabel} level "none" requires a reason; use { level: "none", reason: "..." }.`);
		else if (input === "reviewed") errors.push(`${pathLabel} ${EXPLICIT_REVIEWED_UNAVAILABLE}`);
		return errors;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		errors.push(`${pathLabel} must be a string level, false, or an object.`);
		return errors;
	}
	const value = input as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		if (!ACCEPTANCE_CONFIG_KEYS.has(key)) errors.push(`${pathLabel}.${key} is not supported.`);
	}
	if (value.level !== undefined && (typeof value.level !== "string" || !VALID_LEVELS.has(value.level as AcceptanceLevel))) {
		errors.push(`${pathLabel}.level must be one of auto, none, attested, checked, verified, reviewed.`);
	}
	if (value.level === "none" && (typeof value.reason !== "string" || !value.reason.trim())) {
		errors.push(`${pathLabel}.reason is required when level is none.`);
	}
	if (value.level === "reviewed") errors.push(`${pathLabel}.level ${EXPLICIT_REVIEWED_UNAVAILABLE}`);
	if (value.reason !== undefined && typeof value.reason !== "string") errors.push(`${pathLabel}.reason must be a string.`);
	if (value.criteria !== undefined && !Array.isArray(value.criteria)) errors.push(`${pathLabel}.criteria must be an array.`);
	if (Array.isArray(value.criteria)) {
		const criterionIds = new Set<string>();
		for (const [index, criterion] of value.criteria.entries()) {
			if (typeof criterion === "string") continue;
			const criterionPath = `${pathLabel}.criteria[${index}]`;
			if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
				errors.push(`${criterionPath} must be a string or an object.`);
				continue;
			}
			const gate = criterion as Record<string, unknown>;
			for (const key of Object.keys(gate)) {
				if (!ACCEPTANCE_GATE_KEYS.has(key)) errors.push(`${criterionPath}.${key} is not supported.`);
			}
			if (typeof gate.id !== "string" || !gate.id.trim()) {
				errors.push(`${criterionPath}.id is required.`);
			} else {
				const normalizedId = normalizedToken(gate.id);
				if (criterionIds.has(normalizedId)) errors.push(`${criterionPath}.id duplicates normalized criterion id '${normalizedId}'.`);
				criterionIds.add(normalizedId);
			}
			if (typeof gate.must !== "string" || !gate.must.trim()) errors.push(`${criterionPath}.must is required.`);
			if (gate.evidence !== undefined && !Array.isArray(gate.evidence)) errors.push(`${criterionPath}.evidence must be an array.`);
			if (Array.isArray(gate.evidence)) {
				for (const [evidenceIndex, item] of gate.evidence.entries()) {
					if (typeof item !== "string" || !VALID_EVIDENCE.has(item as AcceptanceEvidenceKind)) {
						errors.push(`${criterionPath}.evidence[${evidenceIndex}] is not a supported evidence kind.`);
					}
				}
			}
			if (gate.severity !== undefined && gate.severity !== "required" && gate.severity !== "recommended") {
				errors.push(`${criterionPath}.severity must be required or recommended.`);
			}
		}
	}
	if (Array.isArray(value.evidence)) {
		for (const [index, item] of value.evidence.entries()) {
			if (typeof item !== "string" || !VALID_EVIDENCE.has(item as AcceptanceEvidenceKind)) {
				errors.push(`${pathLabel}.evidence[${index}] is not a supported evidence kind.`);
			}
		}
	} else if (value.evidence !== undefined) {
		errors.push(`${pathLabel}.evidence must be an array.`);
	}
	if (value.verify !== undefined && !Array.isArray(value.verify)) errors.push(`${pathLabel}.verify must be an array.`);
	if (Array.isArray(value.verify)) {
		for (const [index, command] of value.verify.entries()) {
			if (!command || typeof command !== "object" || Array.isArray(command)) {
				errors.push(`${pathLabel}.verify[${index}] must be an object.`);
				continue;
			}
			const cmd = command as Record<string, unknown>;
			for (const key of Object.keys(cmd)) {
				if (!ACCEPTANCE_VERIFY_KEYS.has(key)) errors.push(`${pathLabel}.verify[${index}].${key} is not supported.`);
			}
			if (typeof cmd.id !== "string" || !cmd.id.trim()) errors.push(`${pathLabel}.verify[${index}].id is required.`);
			if (typeof cmd.command !== "string" || !cmd.command.trim()) errors.push(`${pathLabel}.verify[${index}].command is required.`);
			if (cmd.timeoutMs !== undefined && (typeof cmd.timeoutMs !== "number" || !Number.isInteger(cmd.timeoutMs) || cmd.timeoutMs < 1)) {
				errors.push(`${pathLabel}.verify[${index}].timeoutMs must be an integer >= 1.`);
			}
			if (cmd.cwd !== undefined && typeof cmd.cwd !== "string") errors.push(`${pathLabel}.verify[${index}].cwd must be a string.`);
			if (cmd.env !== undefined) {
				if (!cmd.env || typeof cmd.env !== "object" || Array.isArray(cmd.env)) {
					errors.push(`${pathLabel}.verify[${index}].env must be an object.`);
				} else {
					for (const [envKey, envValue] of Object.entries(cmd.env as Record<string, unknown>)) {
						if (typeof envValue !== "string") errors.push(`${pathLabel}.verify[${index}].env.${envKey} must be a string.`);
					}
				}
			}
			if (cmd.allowFailure !== undefined && typeof cmd.allowFailure !== "boolean") {
				errors.push(`${pathLabel}.verify[${index}].allowFailure must be a boolean.`);
			}
		}
	}
	if (value.review !== undefined && value.review !== false) {
		if (!value.review || typeof value.review !== "object" || Array.isArray(value.review)) {
			errors.push(`${pathLabel}.review must be false or an object.`);
		} else {
			const review = value.review as Record<string, unknown>;
			for (const key of Object.keys(review)) {
				if (!ACCEPTANCE_REVIEW_KEYS.has(key)) errors.push(`${pathLabel}.review.${key} is not supported.`);
			}
			if (review.agent !== undefined && typeof review.agent !== "string") errors.push(`${pathLabel}.review.agent must be a string.`);
			if (review.focus !== undefined && typeof review.focus !== "string") errors.push(`${pathLabel}.review.focus must be a string.`);
			if (review.required !== undefined && typeof review.required !== "boolean") errors.push(`${pathLabel}.review.required must be a boolean.`);
		}
	}
	if (value.stopRules !== undefined && !Array.isArray(value.stopRules)) errors.push(`${pathLabel}.stopRules must be an array.`);
	if (Array.isArray(value.stopRules)) {
		for (const [index, item] of value.stopRules.entries()) {
			if (typeof item !== "string") errors.push(`${pathLabel}.stopRules[${index}] must be a string.`);
		}
	}
	return errors;
}

export function validateExecutionAcceptance(input: {
	acceptance?: unknown;
	tasks?: Array<{ acceptance?: unknown }>;
	chain?: Array<{
		acceptance?: unknown;
		parallel?: Array<{ acceptance?: unknown }> | { acceptance?: unknown };
	}>;
}): string[] {
	const errors = validateAcceptanceInput(input.acceptance, "acceptance");
	for (const [index, task] of (input.tasks ?? []).entries()) {
		errors.push(...validateAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`));
	}
	for (const [stepIndex, step] of (input.chain ?? []).entries()) {
		errors.push(...validateAcceptanceInput(step.acceptance, `chain[${stepIndex}].acceptance`));
		if (Array.isArray(step.parallel)) {
			for (const [taskIndex, task] of step.parallel.entries()) {
				errors.push(...validateAcceptanceInput(task.acceptance, `chain[${stepIndex}].parallel[${taskIndex}].acceptance`));
			}
		} else if (step.parallel) {
			errors.push(...validateAcceptanceInput(step.parallel.acceptance, `chain[${stepIndex}].parallel.acceptance`));
		}
	}
	return errors;
}

function normalizeCriteria(criteria: Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }> | undefined, evidence: AcceptanceEvidenceKind[]): ResolvedAcceptanceGate[] {
	return (criteria ?? []).map((criterion, index) => {
		if (typeof criterion === "string") {
			return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" };
		}
		return {
			id: criterion.id?.trim() || `criterion-${index + 1}`,
			must: criterion.must ?? "",
			evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
			severity: criterion.severity ?? "required",
		};
	}).filter((criterion) => criterion.must.trim());
}

export function resolveEffectiveAcceptance(input: {
	explicit?: AcceptanceInput;
	agentName: string;
	acceptanceRole?: AcceptanceRole;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): ResolvedAcceptanceConfig {
	const explicit = normalizeAcceptanceInput(input.explicit);
	const inferred = inferLevel(input);
	const explicitLevel = normalizeLevel(explicit.level);
	const level = explicitAcceptanceCanDisable(explicit)
		? "none"
		: explicitLevel === "auto"
			? inferred.level
			: (LEVEL_RANK[explicitLevel] >= LEVEL_RANK[inferred.level] ? explicitLevel : inferred.level);
	const evidence = unique([...(level === inferred.level ? inferred.evidence : requiredEvidenceForLevel(level)), ...(explicit.evidence ?? [])]);
	const criteria = normalizeCriteria(
		(explicit.criteria?.length ? explicit.criteria : inferred.criteria) as Array<string | { id?: string; must?: string; evidence?: AcceptanceEvidenceKind[]; severity?: "required" | "recommended" }>,
		evidence,
	);
	let review = explicit.review !== undefined ? explicit.review : inferred.review;
	if (level === "reviewed" && input.explicit !== undefined && explicitLevel !== "reviewed" && explicit.review === undefined && review && review !== false) {
		review = { ...review, required: false };
	}
	return {
		level,
		explicit: input.explicit !== undefined,
		inferredReason: inferred.reasons,
		criteria,
		evidence,
		verify: explicit.verify ?? [],
		review,
		stopRules: explicit.stopRules ?? [],
		reason: explicit.reason,
	};
}

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig): string {
	if (acceptance.level === "none") return "";
	const lines = [
		"",
		"## Acceptance Contract",
		`Acceptance level: ${acceptance.level}`,
		"Completion is not accepted from prose alone. End with a structured acceptance report.",
		"",
		"Criteria:",
		...(acceptance.criteria.length ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- Return the requested result."]),
		"",
		`Required evidence: ${acceptance.evidence.join(", ") || "none"}`,
	];
	if (acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands configured by parent:");
		for (const command of acceptance.verify) lines.push(`- ${command.id}: ${command.command}`);
	}
	if (acceptance.review && acceptance.review !== false) {
		lines.push("", `Review gate: ${acceptance.review.required === false ? "optional" : "required"}${acceptance.review.agent ? ` by ${acceptance.review.agent}` : ""}.`);
		if (acceptance.review.focus) lines.push(`Review focus: ${acceptance.review.focus}`);
	}
	if (acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
		"Use empty arrays when no items apply; array fields contain strings unless object entries are shown.",
		"`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.",
		"`commandsRun[].result` must be exactly one of: passed, failed, not-run.",
		"`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: acceptance.criteria
				.filter((criterion) => criterion.severity !== "recommended")
				.map((criterion) => ({ id: criterion.id, status: "satisfied", evidence: "specific proof" })),
			changedFiles: ["src/file.ts"],
			testsAddedOrUpdated: ["test/file.test.ts"],
			commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
			validationOutput: ["validation output or concise summary"],
			residualRisks: ["none"],
			noStagedFiles: true,
			diffSummary: "short description of the diff",
			reviewFindings: ["blocker: file.ts:12 - issue found, or no blockers"],
			manualNotes: "anything else the parent should know",
		}, null, 2),
		"```",
	);
	return lines.join("\n");
}

function extractBalancedJson(text: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

const ACCEPTANCE_REPORT_WRAPPERS = new Set(["acceptance", "acceptance-report", "acceptance_report", "acceptanceReport"]);

const ACCEPTANCE_REPORT_FIELDS: Record<string, keyof AcceptanceReport> = {
	criteriaSatisfied: "criteriaSatisfied",
	criteria_satisfied: "criteriaSatisfied",
	changedFiles: "changedFiles",
	changed_files: "changedFiles",
	testsAddedOrUpdated: "testsAddedOrUpdated",
	tests_added_or_updated: "testsAddedOrUpdated",
	commandsRun: "commandsRun",
	commands_run: "commandsRun",
	validationOutput: "validationOutput",
	validation_output: "validationOutput",
	residualRisks: "residualRisks",
	residual_risks: "residualRisks",
	noStagedFiles: "noStagedFiles",
	no_staged_files: "noStagedFiles",
	diffSummary: "diffSummary",
	diff_summary: "diffSummary",
	reviewFindings: "reviewFindings",
	review_findings: "reviewFindings",
	manualNotes: "manualNotes",
	manual_notes: "manualNotes",
	notes: "notes",
};

const CRITERION_REPORT_FIELDS = new Set(["id", "status", "evidence"]);
const COMMAND_REPORT_FIELDS = new Set(["command", "result", "summary"]);

function normalizedToken(value: string): string {
	return value.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

function normalizeCriterionStatus(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const token = normalizedToken(value);
	if (["satisfied", "met", "complete", "completed", "done", "pass", "passed", "success", "succeeded"].includes(token)) return "satisfied";
	if (["not-satisfied", "not-met", "unmet", "incomplete", "fail", "failed"].includes(token)) return "not-satisfied";
	if (["not-applicable", "n-a", "na", "skip", "skipped"].includes(token)) return "not-applicable";
	return value;
}

function normalizeCommandResult(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const token = normalizedToken(value);
	if (["passed", "pass", "success", "successful", "succeeded", "ok"].includes(token)) return "passed";
	if (["failed", "fail", "failure", "error"].includes(token)) return "failed";
	if (["not-run", "not-executed", "skip", "skipped"].includes(token)) return "not-run";
	return value;
}

function normalizeCriterionReport(value: unknown, pathLabel: string, errors: string[]): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const normalized: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
		if (!CRITERION_REPORT_FIELDS.has(key)) {
			errors.push(`${pathLabel}.${key}: unsupported acceptance criterion field`);
			continue;
		}
		normalized[key] = key === "id" && typeof fieldValue === "string"
			? normalizedToken(fieldValue)
			: key === "status"
				? normalizeCriterionStatus(fieldValue)
				: fieldValue;
	}
	return normalized;
}

function normalizeCommandReport(value: unknown, pathLabel: string, errors: string[]): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const normalized: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
		if (!COMMAND_REPORT_FIELDS.has(key)) {
			errors.push(`${pathLabel}.${key}: unsupported acceptance command field`);
			continue;
		}
		normalized[key] = key === "result" ? normalizeCommandResult(fieldValue) : fieldValue;
	}
	return normalized;
}

function normalizeAcceptanceReportValue(value: unknown, pathLabel = ""): { value: unknown; pathLabel: string; errors: string[] } {
	const errors: string[] = [];
	let reportValue = value;
	let reportPath = pathLabel;
	if (reportValue && typeof reportValue === "object" && !Array.isArray(reportValue)) {
		const record = reportValue as Record<string, unknown>;
		const wrapperKeys = Object.keys(record).filter((key) => ACCEPTANCE_REPORT_WRAPPERS.has(key));
		if (wrapperKeys.length > 0) {
			const wrapperKey = wrapperKeys[0]!;
			if (wrapperKeys.length > 1) errors.push(`${pathLabel || "acceptance-report"}: multiple acceptance report wrappers are ambiguous`);
			for (const key of Object.keys(record)) {
				if (key !== wrapperKey) errors.push(`${pathFor(pathLabel, key)}: unsupported alongside acceptance report wrapper '${wrapperKey}'`);
			}
			reportValue = record[wrapperKey];
			reportPath = pathFor(pathLabel, wrapperKey);
		}
	}
	if (!reportValue || typeof reportValue !== "object" || Array.isArray(reportValue)) return { value: reportValue, pathLabel: reportPath, errors };

	const normalized: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(reportValue as Record<string, unknown>)) {
		const canonical = ACCEPTANCE_REPORT_FIELDS[key];
		if (!canonical) {
			errors.push(`${pathFor(reportPath, key)}: unsupported acceptance report field`);
			continue;
		}
		if (Object.hasOwn(normalized, canonical)) {
			errors.push(`${pathFor(reportPath, key)}: duplicates normalized field '${canonical}'`);
			continue;
		}
		const fieldPath = pathFor(reportPath, canonical);
		switch (canonical) {
			case "criteriaSatisfied": {
				const items = Array.isArray(fieldValue) ? fieldValue : fieldValue && typeof fieldValue === "object" ? [fieldValue] : fieldValue;
				normalized[canonical] = Array.isArray(items)
					? items.map((item, index) => normalizeCriterionReport(item, `${fieldPath}[${index}]`, errors))
					: items;
				break;
			}
			case "commandsRun": {
				const items = Array.isArray(fieldValue) ? fieldValue : fieldValue && typeof fieldValue === "object" ? [fieldValue] : fieldValue;
				normalized[canonical] = Array.isArray(items)
					? items.map((item, index) => normalizeCommandReport(item, `${fieldPath}[${index}]`, errors))
					: items;
				break;
			}
			case "changedFiles":
			case "testsAddedOrUpdated":
			case "validationOutput":
			case "residualRisks":
			case "reviewFindings":
				normalized[canonical] = typeof fieldValue === "string" ? [fieldValue] : fieldValue;
				break;
			case "noStagedFiles": {
				const token = typeof fieldValue === "string" ? fieldValue.trim().toLowerCase() : undefined;
				normalized[canonical] = token === "true" ? true : token === "false" ? false : fieldValue;
				break;
			}
			default:
				normalized[canonical] = fieldValue;
		}
	}
	return { value: normalized, pathLabel: reportPath, errors };
}

function hasGenericAcceptanceReportSignal(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return "criteriaSatisfied" in record && [
		"changedFiles",
		"testsAddedOrUpdated",
		"commandsRun",
		"validationOutput",
		"residualRisks",
		"noStagedFiles",
		"diffSummary",
		"reviewFindings",
		"manualNotes",
	].some((key) => key in record);
}

function parseReportJson(body: string): unknown {
	const trimmed = body.trim();
	try {
		return JSON.parse(trimmed) as unknown;
	} catch (error) {
		const jsonStart = trimmed.indexOf("{");
		if (jsonStart > 0) {
			const json = extractBalancedJson(trimmed, jsonStart);
			if (json) return JSON.parse(json) as unknown;
		}
		throw error;
	}
}

function fencedBlocks(output: string, tag: string): string[] {
	return [...output.matchAll(new RegExp(`\`\`\`${tag}\\s*\\n([\\s\\S]*?)\`\`\``, "gi"))]
		.map((match) => match[1]?.trim())
		.filter((value): value is string => Boolean(value));
}

function parseAcceptanceReportBody(body: string): { report?: AcceptanceReport; errors: string[] } {
	return validateAcceptanceReport(parseReportJson(body));
}

function parseGenericJsonAcceptanceReportBody(body: string): { report?: AcceptanceReport; error?: string } {
	const parsed = parseReportJson(body);
	const normalized = normalizeAcceptanceReportValue(parsed);
	const hasCriteriaMarker = normalized.value !== null
		&& typeof normalized.value === "object"
		&& !Array.isArray(normalized.value)
		&& "criteriaSatisfied" in normalized.value;
	if (!hasGenericAcceptanceReportSignal(normalized.value) && !(hasCriteriaMarker && normalized.errors.length > 0)) return {};
	const validation = validateAcceptanceReport(parsed);
	return validation.report
		? { report: validation.report }
		: { error: `Invalid acceptance-report: ${validation.errors.join("; ")}` };
}

export const ACCEPTANCE_REPORT_NOT_FOUND = "Structured acceptance report not found.";

export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
	const explicitFencePresent = /```acceptance[-_]report\b/i.test(output);
	const fenced = fencedBlocks(output, "acceptance[-_]report");
	const parseErrors: string[] = [];
	for (const body of fenced) {
		try {
			const validation = parseAcceptanceReportBody(body);
			if (validation.report) return { report: validation.report };
			parseErrors.push(`Invalid acceptance-report: ${validation.errors.join("; ")}`);
		} catch (error) {
			parseErrors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (parseErrors.length > 0) return { error: `Failed to parse acceptance-report: ${parseErrors.join("; ")}` };
	if (explicitFencePresent) {
		return { error: "Failed to parse acceptance-report: Empty or unterminated acceptance-report fence." };
	}
	for (const body of fencedBlocks(output, "(?:json|jsonc|json5)")) {
		try {
			const parsed = parseGenericJsonAcceptanceReportBody(body);
			if (parsed.report) return { report: parsed.report };
			if (parsed.error) return { error: `Failed to parse acceptance-report: ${parsed.error}` };
		} catch {
			// Ignore unrelated malformed generic JSON. A recognizable report shape
			// returns exact validation errors above instead of being mistaken for prose.
		}
	}
	const markerIndex = output.search(/ACCEPTANCE_REPORT\s*:/i);
	if (markerIndex !== -1) {
		const jsonStart = output.indexOf("{", markerIndex);
		if (jsonStart === -1) {
			return { error: "Failed to parse acceptance-report: Expected a JSON object after ACCEPTANCE_REPORT:." };
		}
		const json = extractBalancedJson(output, jsonStart);
		if (!json) {
			return { error: "Failed to parse acceptance-report: Unterminated JSON object after ACCEPTANCE_REPORT:." };
		}
		try {
			const parsed = JSON.parse(json) as unknown;
			const validation = validateAcceptanceReport(parsed);
			if (validation.report) return { report: validation.report };
			return { error: `Failed to parse acceptance-report: Invalid acceptance-report: ${validation.errors.join("; ")}` };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `Failed to parse acceptance-report: ${message}` };
		}
	}
	return { error: ACCEPTANCE_REPORT_NOT_FOUND };
}

function parseAcceptanceReportSources(
	output: string,
	fileOutput: { content: string; path: string; authoritative?: boolean } | undefined,
): { report?: AcceptanceReport; error?: string } {
	const fromText = () => parseAcceptanceReport(output);
	const fromFile = () => {
		if (!fileOutput) return { error: ACCEPTANCE_REPORT_NOT_FOUND };
		const parsed = parseAcceptanceReport(fileOutput.content);
		return parsed.report || parsed.error === ACCEPTANCE_REPORT_NOT_FOUND
			? parsed
			: { error: `${parsed.error} (in configured output ${fileOutput.path})` };
	};
	const [primary, secondary] = fileOutput?.authoritative ? [fromFile, fromText] : [fromText, fromFile];
	const first = primary();
	// A malformed report in the primary source is a defect to surface, not a
	// miss to paper over with the secondary source; only a genuinely absent
	// report falls through.
	if (first.report || first.error !== ACCEPTANCE_REPORT_NOT_FOUND) return first;
	return secondary();
}

export function stripAcceptanceReport(output: string): string {
	const trailingFencePattern = /\n?```(acceptance[-_]report|json|jsonc|json5)\s*\n([\s\S]*?)```\s*/gi;
	let trailingFence: { index: number; tag: string; body: string } | undefined;
	for (const match of output.matchAll(trailingFencePattern)) {
		const end = (match.index ?? 0) + match[0].length;
		if (output.slice(end).trim().length === 0 && match[1] && match[2]) {
			trailingFence = { index: match.index ?? 0, tag: match[1].toLowerCase(), body: match[2] };
		}
	}
	if (trailingFence) {
		if (trailingFence.tag === "acceptance-report" || trailingFence.tag === "acceptance_report") return output.slice(0, trailingFence.index).trimEnd();
		try {
			if (parseGenericJsonAcceptanceReportBody(trailingFence.body).report) return output.slice(0, trailingFence.index).trimEnd();
		} catch {
			// Leave unrelated or malformed generic JSON fences visible.
		}
	}
	return output
		.replace(/\n?```acceptance[-_]report\s*\n[\s\S]*?```\s*$/i, "")
		.replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
		.trimEnd();
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function pathFor(base: string, segment: string): string {
	return base ? `${base}.${segment}` : segment;
}

function describeValidationValue(value: unknown): string {
	if (value === undefined) return "missing";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	if (typeof value === "string") {
		const short = value.length > 80 ? `${value.slice(0, 77)}...` : value;
		return JSON.stringify(short);
	}
	return `${typeof value} ${String(value)}`;
}

function pushTypeError(errors: string[], pathLabel: string, expected: string, value: unknown): void {
	errors.push(`${pathLabel}: expected ${expected}; got ${describeValidationValue(value)}`);
}

function validateStringArrayField(errors: string[], value: unknown, pathLabel: string): void {
	if (!Array.isArray(value)) {
		pushTypeError(errors, pathLabel, "string[]", value);
		return;
	}
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string" || !item.trim()) pushTypeError(errors, `${pathLabel}[${index}]`, "non-empty string", item);
	}
}

function validateAcceptanceReport(value: unknown, pathLabel = ""): { report?: AcceptanceReport; errors: string[] } {
	const normalized = normalizeAcceptanceReportValue(value, pathLabel);
	value = normalized.value;
	pathLabel = normalized.pathLabel;
	const errors = normalized.errors;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		pushTypeError(errors, pathLabel || "acceptance-report", "object", value);
		return { errors };
	}
	const report = value as AcceptanceReport;
	if (report.criteriaSatisfied !== undefined) {
		if (!Array.isArray(report.criteriaSatisfied)) {
			pushTypeError(errors, pathFor(pathLabel, "criteriaSatisfied"), "array", report.criteriaSatisfied);
		} else {
			const criterionIds = new Set<string>();
			for (const [index, item] of report.criteriaSatisfied.entries()) {
				const itemPath = `${pathFor(pathLabel, "criteriaSatisfied")}[${index}]`;
				if (!item || typeof item !== "object" || Array.isArray(item)) {
					pushTypeError(errors, itemPath, "object", item);
					continue;
				}
				const criterion = item as { id?: unknown; status?: unknown; evidence?: unknown };
				if (criterion.id !== undefined && typeof criterion.id !== "string") {
					pushTypeError(errors, `${itemPath}.id`, "string", criterion.id);
				} else if (typeof criterion.id === "string" && criterion.id) {
					if (criterionIds.has(criterion.id)) errors.push(`${itemPath}.id: duplicate normalized criterion id '${criterion.id}'`);
					criterionIds.add(criterion.id);
				}
				if (criterion.status !== "satisfied" && criterion.status !== "not-satisfied" && criterion.status !== "not-applicable") {
					pushTypeError(errors, `${itemPath}.status`, "one of \"satisfied\", \"not-satisfied\", \"not-applicable\"", criterion.status);
				}
				if (typeof criterion.evidence !== "string" || !criterion.evidence.trim()) pushTypeError(errors, `${itemPath}.evidence`, "non-empty string", criterion.evidence);
			}
		}
	}
	if (report.changedFiles !== undefined) validateStringArrayField(errors, report.changedFiles, pathFor(pathLabel, "changedFiles"));
	if (report.testsAddedOrUpdated !== undefined) validateStringArrayField(errors, report.testsAddedOrUpdated, pathFor(pathLabel, "testsAddedOrUpdated"));
	if (report.commandsRun !== undefined) {
		if (!Array.isArray(report.commandsRun)) {
			pushTypeError(errors, pathFor(pathLabel, "commandsRun"), "array", report.commandsRun);
		} else {
			for (const [index, item] of report.commandsRun.entries()) {
				const itemPath = `${pathFor(pathLabel, "commandsRun")}[${index}]`;
				if (!item || typeof item !== "object" || Array.isArray(item)) {
					pushTypeError(errors, itemPath, "object", item);
					continue;
				}
				const command = item as { command?: unknown; result?: unknown; summary?: unknown };
				if (typeof command.command !== "string" || !command.command.trim()) pushTypeError(errors, `${itemPath}.command`, "non-empty string", command.command);
				if (command.result !== "passed" && command.result !== "failed" && command.result !== "not-run") {
					pushTypeError(errors, `${itemPath}.result`, "one of \"passed\", \"failed\", \"not-run\"", command.result);
				}
				if (typeof command.summary !== "string" || !command.summary.trim()) pushTypeError(errors, `${itemPath}.summary`, "non-empty string", command.summary);
			}
		}
	}
	if (report.validationOutput !== undefined) validateStringArrayField(errors, report.validationOutput, pathFor(pathLabel, "validationOutput"));
	if (report.residualRisks !== undefined) validateStringArrayField(errors, report.residualRisks, pathFor(pathLabel, "residualRisks"));
	if (report.noStagedFiles !== undefined && typeof report.noStagedFiles !== "boolean") pushTypeError(errors, pathFor(pathLabel, "noStagedFiles"), "boolean", report.noStagedFiles);
	if (report.diffSummary !== undefined && (typeof report.diffSummary !== "string" || !report.diffSummary.trim())) pushTypeError(errors, pathFor(pathLabel, "diffSummary"), "non-empty string", report.diffSummary);
	if (report.reviewFindings !== undefined) validateStringArrayField(errors, report.reviewFindings, pathFor(pathLabel, "reviewFindings"));
	if (report.manualNotes !== undefined && typeof report.manualNotes !== "string") pushTypeError(errors, pathFor(pathLabel, "manualNotes"), "string", report.manualNotes);
	if (report.notes !== undefined && typeof report.notes !== "string") pushTypeError(errors, pathFor(pathLabel, "notes"), "string", report.notes);
	if (errors.length > 0) return { errors };
	const hasReportField = report.criteriaSatisfied !== undefined
		|| report.changedFiles !== undefined
		|| report.testsAddedOrUpdated !== undefined
		|| report.commandsRun !== undefined
		|| report.validationOutput !== undefined
		|| report.residualRisks !== undefined
		|| report.noStagedFiles !== undefined
		|| report.diffSummary !== undefined
		|| report.manualNotes !== undefined
		|| report.notes !== undefined
		|| report.reviewFindings !== undefined;
	return hasReportField
		? { report, errors }
		: { errors: [`${pathLabel || "acceptance-report"}: expected at least one acceptance report field`] };
}

function checkCriteriaSatisfied(criteria: ResolvedAcceptanceGate[], report: AcceptanceReport): AcceptanceRuntimeCheck[] {
	const reports = new Map((report.criteriaSatisfied ?? []).filter((item) => item.id).map((item) => [normalizedToken(item.id!), item]));
	return criteria.filter((criterion) => criterion.severity !== "recommended").map((criterion) => {
		const item = reports.get(normalizedToken(criterion.id));
		if (!item) return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was not reported.` };
		if (item.status !== "satisfied") return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was reported as ${item.status}.` };
		return { id: `criterion:${criterion.id}`, status: "passed", message: `Required criterion '${criterion.id}' satisfied.` };
	});
}

function reportEvidenceStatus(report: AcceptanceReport, kind: AcceptanceEvidenceKind): AcceptanceRuntimeCheckStatus {
	switch (kind) {
		case "changed-files":
			if (!isStringArray(report.changedFiles)) return "failed";
			return report.changedFiles.length === 0 ? "not-applicable" : "passed";
		case "tests-added":
			if (!isStringArray(report.testsAddedOrUpdated)) return "failed";
			return report.testsAddedOrUpdated.length === 0 ? "not-applicable" : "passed";
		case "commands-run": return Array.isArray(report.commandsRun) && report.commandsRun.length > 0 ? "passed" : "failed";
		case "validation-output": return isStringArray(report.validationOutput) && report.validationOutput.length > 0 ? "passed" : "failed";
		case "residual-risks": return isStringArray(report.residualRisks) ? "passed" : "failed";
		case "no-staged-files": return report.noStagedFiles === true ? "passed" : "failed";
		case "diff-summary": return typeof report.diffSummary === "string" && report.diffSummary.trim().length > 0 ? "passed" : "failed";
		case "review-findings": return isStringArray(report.reviewFindings) ? "passed" : "failed";
		case "manual-notes": return Boolean((report.manualNotes ?? report.notes)?.trim()) ? "passed" : "failed";
	}
}

function checkNoStagedFiles(cwd: string): AcceptanceRuntimeCheck {
	const result = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		return { id: "no-staged-files", status: "not-applicable", message: "git status unavailable; no staged-files check skipped" };
	}
	const staged = result.stdout.split(/\r?\n/).filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
	return staged.length === 0
		? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
		: { id: "no-staged-files", status: "failed", message: `Staged files present: ${staged.join(", ")}` };
}

function runStructuralChecks(acceptance: ResolvedAcceptanceConfig, report: AcceptanceReport, cwd: string): AcceptanceRuntimeCheck[] {
	const checks: AcceptanceRuntimeCheck[] = [];
	for (const kind of acceptance.evidence) {
		const status = reportEvidenceStatus(report, kind);
		checks.push({
			id: `evidence:${kind}`,
			status,
			message: status === "passed"
				? `${kind} evidence present.`
				: status === "not-applicable"
					? `${kind} evidence explicitly reported as not applicable.`
					: `${kind} evidence missing from child report.`,
		});
	}
	if (acceptance.evidence.includes("no-staged-files")) checks.push(checkNoStagedFiles(cwd));
	return checks;
}

function trimOutput(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n...[truncated]` : trimmed;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
	return unique(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)));
}

export function aggregateAcceptanceReport(input: {
	results: Array<Pick<SingleResult, "agent" | "acceptance" | "error" | "exitCode">>;
	notes?: string;
}): AcceptanceReport {
	const childReports = input.results.map((result) => result.acceptance?.childReport).filter((report): report is AcceptanceReport => Boolean(report));
	const blockers = input.results.filter((result) => result.exitCode !== 0 || result.acceptance?.status === "rejected");
	const successfulChildren = input.results.length > 0 && blockers.length === 0;
	return {
		criteriaSatisfied: [
			{ id: "criterion-1", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? `All ${input.results.length} dynamic child run(s) completed without child or acceptance blockers.` : "Dynamic fanout produced no accepted child evidence." },
			{ id: "criterion-2", status: successfulChildren ? "satisfied" : "not-satisfied", evidence: successfulChildren ? "Collected child acceptance evidence for aggregate review." : "Dynamic fanout produced no aggregate review evidence." },
			...input.results.map((result, index) => ({
				id: `child-${index + 1}`,
				status: result.exitCode === 0 && result.acceptance?.status !== "rejected" ? "satisfied" : "not-satisfied",
				evidence: `${result.agent}: acceptance ${result.acceptance?.status ?? "unreported"}${result.error ? ` (${result.error})` : ""}`,
			})),
		],
		changedFiles: uniqueStrings(childReports.flatMap((report) => report.changedFiles ?? [])),
		testsAddedOrUpdated: uniqueStrings(childReports.flatMap((report) => report.testsAddedOrUpdated ?? [])),
		commandsRun: childReports.flatMap((report) => report.commandsRun ?? []),
		validationOutput: uniqueStrings(childReports.flatMap((report) => report.validationOutput ?? [])),
		residualRisks: uniqueStrings([
			...childReports.flatMap((report) => report.residualRisks ?? []),
			...blockers.map((result) => `${result.agent}: ${result.error ?? "child or acceptance gate failed"}`),
		]),
		noStagedFiles: childReports.length > 0 && childReports.every((report) => report.noStagedFiles === true),
		reviewFindings: uniqueStrings(childReports.flatMap((report) => report.reviewFindings ?? [])),
		manualNotes: input.notes ?? `Aggregated acceptance evidence from ${input.results.length} dynamic fanout child run(s).`,
		notes: input.notes,
	};
}

function runVerifyCommand(command: AcceptanceVerifyCommand, defaultCwd: string, options: { signal?: AbortSignal; abortMessage?: string } = {}): Promise<AcceptanceVerifyResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let hardKill: NodeJS.Timeout | undefined;
		const child = spawn(command.command, {
			cwd,
			env: { ...process.env, ...(command.env ?? {}) },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const finish = (result: Omit<AcceptanceVerifyResult, "id" | "command" | "cwd" | "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (hardKill) clearTimeout(hardKill);
			options.signal?.removeEventListener("abort", abortVerification);
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				durationMs: Date.now() - startedAt,
				...result,
			});
		};
		const abortVerification = () => {
			if (settled || timedOut) return;
			timedOut = true;
			child.kill("SIGTERM");
			hardKill = setTimeout(() => {
				child.kill("SIGKILL");
				finish({
					exitCode: null,
					status: "timed-out",
					stdout: trimOutput(stdout),
					stderr: trimOutput(stderr || options.abortMessage || "Acceptance verification timed out."),
				});
			}, 1000);
			hardKill.unref?.();
		};
		const timeout = setTimeout(abortVerification, command.timeoutMs ?? 120_000);
		timeout.unref?.();
		if (options.signal?.aborted) abortVerification();
		else options.signal?.addEventListener("abort", abortVerification, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (exitCode) => {
			const passed = exitCode === 0 && !timedOut;
			finish({
				exitCode,
				status: timedOut ? "timed-out" : passed ? "passed" : command.allowFailure ? "allowed-failure" : "failed",
				stdout: trimOutput(stdout),
				stderr: trimOutput(stderr || (timedOut ? options.abortMessage ?? "" : "")),
			});
		});
		child.on("error", (error) => {
			finish({
				exitCode: timedOut ? null : 1,
				status: timedOut ? "timed-out" : command.allowFailure ? "allowed-failure" : "failed",
				stderr: timedOut ? trimOutput(stderr || options.abortMessage || "Acceptance verification timed out.") : error instanceof Error ? error.message : String(error),
			});
		});
	});
}

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd: string;
	/**
	 * Content the child sent to its configured output file (from its own write
	 * tool calls, not from disk, so a concurrent writer to the same path cannot
	 * be misattributed). Searched for the acceptance report; searched before
	 * the assistant output when `authoritative` (outputMode "file-only").
	 */
	fileOutput?: { content: string; path: string; authoritative?: boolean };
	report?: AcceptanceReport;
	reviewResult?: AcceptanceReviewResult;
	signal?: AbortSignal;
	abortMessage?: string;
}): Promise<AcceptanceLedger> {
	const acceptance = input.acceptance;
	const ledger: AcceptanceLedger = {
		status: acceptance.level === "none" ? "not-required" : "claimed",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
	if (acceptance.level === "none") return ledger;

	const parsed = input.report
		? (() => {
			const validation = validateAcceptanceReport(input.report);
			return validation.report
				? { report: validation.report }
				: { error: `Failed to parse acceptance-report: Invalid acceptance-report: ${validation.errors.join("; ")}` };
		})()
		: parseAcceptanceReportSources(input.output, input.fileOutput);
	if (parsed.report) {
		ledger.childReport = parsed.report;
		ledger.status = "attested";
	} else {
		ledger.childReportParseError = parsed.error;
		ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
		ledger.status = "rejected";
		return ledger;
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
		ledger.runtimeChecks = [
			...checkCriteriaSatisfied(acceptance.criteria, parsed.report),
			...runStructuralChecks(acceptance, parsed.report, input.cwd),
		];
		if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "checked";
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.verified && (acceptance.level === "verified" || acceptance.verify.length > 0)) {
		if (acceptance.level === "verified" && acceptance.verify.length === 0) {
			ledger.runtimeChecks.push({ id: "verification-config", status: "failed", message: "verified acceptance requires runtime verify commands." });
			ledger.status = "rejected";
			return ledger;
		}
		ledger.verifyRuns = [];
		for (const command of acceptance.verify) {
			ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd, { signal: input.signal, abortMessage: input.abortMessage }));
			if (input.signal?.aborted) break;
		}
		if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "verified";
	}

	if (acceptance.level === "reviewed") {
		if (input.reviewResult) {
			ledger.reviewResult = input.reviewResult;
			ledger.status = input.reviewResult.status === "no-blockers" ? "reviewed" : "rejected";
		} else {
			const optionalReview = acceptance.review && acceptance.review !== false && acceptance.review.required === false;
			ledger.reviewResult = {
				status: "needs-parent-decision",
				findings: [{
					severity: acceptance.explicit && !optionalReview ? "blocker" : "non-blocking",
					issue: "Reviewed acceptance requires an independent reviewer result.",
					rationale: "The run cannot be marked reviewed from child evidence alone.",
				}],
			};
			if (acceptance.review === false || (acceptance.explicit && !optionalReview)) ledger.status = "rejected";
		}
	}

	return ledger;
}

export function buildSkippedAcceptanceLedger(acceptance: ResolvedAcceptanceConfig, input: { id: string; message: string }): AcceptanceLedger {
	return {
		status: acceptance.level === "none" ? "not-required" : "rejected",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: acceptance.level === "none"
			? []
			: [{ id: input.id, status: "failed", message: input.message }],
		verifyRuns: [],
	};
}

export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
	if (ledger.status !== "rejected") return undefined;
	const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
	if (failedCheck) return `Acceptance rejected: ${failedCheck.message}`;
	const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
	if (ledger.reviewResult?.status === "needs-parent-decision") return "Acceptance review required but no automatic reviewer result is available.";
	if (ledger.reviewResult?.status === "blockers") return "Acceptance review found blockers.";
	return "Acceptance rejected.";
}
