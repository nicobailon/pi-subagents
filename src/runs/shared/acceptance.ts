import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	AcceptanceConfig,
	AcceptanceContract,
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
	SubagentRunMode,
} from "../../shared/types.ts";
import { classifyTaskMutationIntent, taskMayMutate } from "./task-intent.ts";

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
const ACCEPTANCE_CONFIG_KEYS = new Set(["level", "criteria", "evidence", "verify", "review", "stopRules", "reason", "report", "onFailure"]);
const LEGACY_ONLY_KEYS = new Set(["level", "criteria", "evidence", "stopRules", "reason"]);
const CANONICAL_ONLY_KEYS = new Set(["report", "onFailure"]);
const ACCEPTANCE_REPORT_KEYS = new Set(["criteria", "evidence"]);
const ACCEPTANCE_CONTRACT_KEYS = new Set(["report", "verify", "review", "onFailure"]);
const ACCEPTANCE_GATE_KEYS = new Set(["id", "must", "evidence", "severity"]);
const ACCEPTANCE_VERIFY_KEYS = new Set(["id", "command", "timeoutMs", "cwd", "env", "allowFailure"]);
const ACCEPTANCE_REVIEW_KEYS = new Set(["agent", "focus", "required"]);
const EXPLICIT_REVIEWED_UNAVAILABLE = "cannot be requested explicitly because this run cannot supply an independent reviewer result; use checked/verified and orchestrate the reviewer separately, or omit acceptance for read-only review tasks.";

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

export function normalizeAcceptanceInput(input: AcceptanceInput | undefined): AcceptanceInput {
	if (input === undefined) return "auto";
	if (typeof input === "object" && input !== null) return { ...input };
	return input;
}

export interface AdaptedAcceptance {
	contract: AcceptanceContract | false;
	stopRules: string[];
	reason?: string;
	deprecationWarnings: string[];
}

const MERGED_ACCEPTANCE_KIND = "merged-acceptance";

/** Internal, serializable representation used after parent/child contract merging. */
export interface MergedAcceptanceInput extends AcceptanceContract {
	kind: typeof MERGED_ACCEPTANCE_KIND;
	adapted: AdaptedAcceptance;
}

export type EffectiveAcceptanceInput = AcceptanceInput | MergedAcceptanceInput;

const MERGED_ACCEPTANCE_KEYS = new Set(["kind", "adapted"]);
const ADAPTED_ACCEPTANCE_KEYS = new Set(["contract", "stopRules", "reason", "deprecationWarnings"]);

function mergedAcceptanceContractErrors(input: unknown, pathLabel: string): string[] {
	if (input === false) return [];
	if (!input || typeof input !== "object" || Array.isArray(input)) return [`${pathLabel} must be false or a canonical acceptance contract.`];
	const contract = input as Record<string, unknown>;
	const errors = Object.keys(contract)
		.filter((key) => !ACCEPTANCE_CONTRACT_KEYS.has(key))
		.map((key) => `${pathLabel}.${key} is not supported in a canonical acceptance contract.`);
	const review = contract.review;
	const validationInput = review && typeof review === "object" && !Array.isArray(review)
		&& (review as Record<string, unknown>).required === true
		? { ...contract, review: { ...(review as Record<string, unknown>), required: false } }
		: contract;
	errors.push(...validateAcceptanceInput(validationInput, pathLabel));
	return errors;
}

/** Validate acceptance metadata read from trusted execution artifacts. */
export function validatePersistedAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	if (!input || typeof input !== "object" || Array.isArray(input) || (input as Record<string, unknown>).kind !== MERGED_ACCEPTANCE_KIND) {
		return validateAcceptanceInput(input, pathLabel);
	}
	const errors: string[] = [];
	const merged = input as Record<string, unknown>;
	for (const key of Object.keys(merged)) {
		if (!MERGED_ACCEPTANCE_KEYS.has(key)) errors.push(`${pathLabel}.${key} is not supported in persisted merged acceptance metadata.`);
	}
	if (!merged.adapted || typeof merged.adapted !== "object" || Array.isArray(merged.adapted)) {
		errors.push(`${pathLabel}.adapted must be an object.`);
		return errors;
	}
	const adapted = merged.adapted as Record<string, unknown>;
	for (const key of Object.keys(adapted)) {
		if (!ADAPTED_ACCEPTANCE_KEYS.has(key)) errors.push(`${pathLabel}.adapted.${key} is not supported.`);
	}
	if (!Object.prototype.hasOwnProperty.call(adapted, "contract")) errors.push(`${pathLabel}.adapted.contract is required.`);
	else errors.push(...mergedAcceptanceContractErrors(adapted.contract, `${pathLabel}.adapted.contract`));
	if (!Array.isArray(adapted.stopRules)) errors.push(`${pathLabel}.adapted.stopRules must be an array.`);
	else for (const [index, rule] of adapted.stopRules.entries()) {
		if (typeof rule !== "string") errors.push(`${pathLabel}.adapted.stopRules[${index}] must be a string.`);
	}
	if (adapted.reason !== undefined && typeof adapted.reason !== "string") errors.push(`${pathLabel}.adapted.reason must be a string.`);
	if (!Array.isArray(adapted.deprecationWarnings)) errors.push(`${pathLabel}.adapted.deprecationWarnings must be an array.`);
	else for (const [index, warning] of adapted.deprecationWarnings.entries()) {
		if (typeof warning !== "string") errors.push(`${pathLabel}.adapted.deprecationWarnings[${index}] must be a string.`);
	}
	return errors;
}

export function isPersistedMergedAcceptanceInput(input: unknown): input is MergedAcceptanceInput {
	return typeof input === "object"
		&& input !== null
		&& !Array.isArray(input)
		&& (input as Record<string, unknown>).kind === MERGED_ACCEPTANCE_KIND
		&& validatePersistedAcceptanceInput(input).length === 0;
}

function isMergedAcceptanceInput(input: EffectiveAcceptanceInput | undefined): input is MergedAcceptanceInput {
	return isPersistedMergedAcceptanceInput(input);
}

function isCanonicalObject(value: Record<string, unknown>): boolean {
	return !Object.keys(value).some((key) => LEGACY_ONLY_KEYS.has(key));
}

export function mergeAcceptanceContracts(
	parent: AcceptanceContract | false | undefined,
	child: AcceptanceContract | false | undefined,
): AcceptanceContract | false | undefined {
	if (child === false) return false;
	if (child === undefined) return parent;
	if (parent === false || parent === undefined) return { ...child };
	const merged: AcceptanceContract = { ...parent };
	if (Object.prototype.hasOwnProperty.call(child, "report")) merged.report = child.report;
	if (Object.prototype.hasOwnProperty.call(child, "verify")) merged.verify = child.verify;
	if (Object.prototype.hasOwnProperty.call(child, "review")) merged.review = child.review;
	if (Object.prototype.hasOwnProperty.call(child, "onFailure")) merged.onFailure = child.onFailure;
	return merged;
}

function mergeAdaptedAcceptance(parent: AdaptedAcceptance, child: AdaptedAcceptance, childInput: AcceptanceConfig & AcceptanceContract): AdaptedAcceptance {
	const childHasStopRules = Object.prototype.hasOwnProperty.call(childInput, "stopRules");
	const childHasReason = Object.prototype.hasOwnProperty.call(childInput, "reason");
	return {
		contract: mergeAcceptanceContracts(parent.contract, child.contract) ?? false,
		stopRules: childHasStopRules ? child.stopRules : parent.stopRules,
		...(childHasReason ? { reason: child.reason } : parent.reason !== undefined ? { reason: parent.reason } : {}),
		deprecationWarnings: unique([...parent.deprecationWarnings, ...child.deprecationWarnings]),
	};
}

/** Merge raw parent/child inputs before advisory inference and final resolution. */
export function mergeAcceptanceInputs(parent: EffectiveAcceptanceInput | undefined, child: EffectiveAcceptanceInput | undefined): EffectiveAcceptanceInput | undefined {
	if (child === undefined || child === "auto") return parent;
	if (isMergedAcceptanceInput(child)) return child;
	const childObject = typeof child === "object" && child !== null ? child as AcceptanceConfig & AcceptanceContract : undefined;
	if (childObject?.level === "auto") return parent;
	if (child === false || child === "none") return child;
	if (childObject?.level === "none") return child;
	if (typeof child === "string" || childObject?.level !== undefined) return child;
	const childAdapted = adaptLegacyAcceptance(child);
	if (childAdapted.contract === false) return child;
	if (parent === undefined || parent === "auto") return child;
	const parentObject = !isMergedAcceptanceInput(parent) && typeof parent === "object" && parent !== null
		? parent as AcceptanceConfig & AcceptanceContract
		: undefined;
	if (parentObject?.level === "auto") return child;
	const merged = mergeAdaptedAcceptance(adaptLegacyAcceptance(parent), childAdapted, childObject ?? {});
	if (merged.stopRules.length === 0 && merged.reason === undefined && merged.deprecationWarnings.length === 0) return merged.contract;
	return { kind: MERGED_ACCEPTANCE_KIND, adapted: merged };
}

export function adaptLegacyAcceptance(input: EffectiveAcceptanceInput | undefined): AdaptedAcceptance {
	if (isMergedAcceptanceInput(input)) return input.adapted;
	if (input === undefined || input === "auto") return { contract: false, stopRules: [], deprecationWarnings: [] };
	if (input === false) return { contract: false, stopRules: [], deprecationWarnings: [] };
	if (input === "none") {
		return { contract: false, stopRules: [], deprecationWarnings: ['Acceptance level "none" is deprecated; use acceptance: false.'] };
	}
	if (typeof input === "string") return adaptLegacyAcceptance({ level: input });

	const value = input as AcceptanceConfig & AcceptanceContract;
	if (isCanonicalObject(value as Record<string, unknown>)) {
		return {
			contract: {
				...(Object.prototype.hasOwnProperty.call(value, "report") ? { report: value.report } : {}),
				...(Object.prototype.hasOwnProperty.call(value, "verify") ? { verify: value.verify } : {}),
				...(Object.prototype.hasOwnProperty.call(value, "review") ? { review: value.review } : {}),
				...(Object.prototype.hasOwnProperty.call(value, "onFailure") ? { onFailure: value.onFailure } : {}),
			},
			stopRules: [],
			deprecationWarnings: [],
		};
	}

	const level = value.level;
	if (level === undefined) {
		const report = value.criteria !== undefined || value.evidence !== undefined
			? { criteria: value.criteria, evidence: value.evidence }
			: undefined;
		return {
			contract: {
				...(report ? { report } : {}),
				...(value.verify !== undefined ? { verify: value.verify } : {}),
				...(value.review !== undefined ? { review: value.review } : {}),
				onFailure: "fail",
			},
			stopRules: value.stopRules ?? [],
			reason: value.reason,
			deprecationWarnings: [],
		};
	}
	if (level === "auto") return { contract: false, stopRules: value.stopRules ?? [], reason: value.reason, deprecationWarnings: [] };
	if (level === "none") {
		return {
			contract: false,
			stopRules: value.stopRules ?? [],
			reason: value.reason,
			deprecationWarnings: ['Acceptance level "none" is deprecated; use acceptance: false.'],
		};
	}

	const evidence = unique([...(requiredEvidenceForLevel(level)), ...(value.evidence ?? [])]);
	return {
		contract: {
			report: { criteria: value.criteria, evidence },
			verify: value.verify ?? [],
			review: level === "reviewed" ? (value.review === false ? false : value.review ?? { required: true }) : value.review,
			onFailure: "fail",
		},
		stopRules: value.stopRules ?? [],
		reason: value.reason,
		deprecationWarnings: [],
	};
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	const errors: string[] = [];
	if (input === undefined) return errors;
	if (input === false) return errors;
	if (typeof input === "string") {
		if (!VALID_LEVELS.has(input as AcceptanceLevel)) errors.push(`${pathLabel} has invalid level '${input}'.`);
		else if (input === "reviewed") errors.push(`${pathLabel} ${EXPLICIT_REVIEWED_UNAVAILABLE}`);
		else if (input === "verified") errors.push(`${pathLabel} verification-config requires at least one runtime verify command.`);
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
	const hasCanonicalField = Object.keys(value).some((key) => CANONICAL_ONLY_KEYS.has(key));
	const hasLegacyField = Object.keys(value).some((key) => LEGACY_ONLY_KEYS.has(key));
	if (hasCanonicalField && hasLegacyField) errors.push(`${pathLabel} cannot mix legacy and canonical acceptance fields.`);
	if (value.level === "auto" || value.level === "none") {
		const allowedKeys = value.level === "none" ? new Set(["level", "reason"]) : new Set(["level"]);
		const discardedDimensions = Object.keys(value).filter((key) => !allowedKeys.has(key));
		if (discardedDimensions.length > 0) {
			errors.push(`${pathLabel}.level '${value.level}' cannot combine with contract dimensions: ${discardedDimensions.join(", ")}.`);
		}
	}
	if (value.report !== undefined && value.report !== false) {
		if (!value.report || typeof value.report !== "object" || Array.isArray(value.report)) {
			errors.push(`${pathLabel}.report must be false or an object.`);
		} else {
			const report = value.report as Record<string, unknown>;
			for (const key of Object.keys(report)) {
				if (!ACCEPTANCE_REPORT_KEYS.has(key)) errors.push(`${pathLabel}.report.${key} is not supported.`);
			}
			errors.push(...validateAcceptanceInput(
				{ criteria: report.criteria, evidence: report.evidence },
				`${pathLabel}.report`,
			));
		}
	}
	if (value.onFailure !== undefined && value.onFailure !== "fail" && value.onFailure !== "warn") {
		errors.push(`${pathLabel}.onFailure must be fail or warn.`);
	}
	if (value.level !== undefined && (typeof value.level !== "string" || !VALID_LEVELS.has(value.level as AcceptanceLevel))) {
		errors.push(`${pathLabel}.level must be one of auto, none, attested, checked, verified, reviewed.`);
	}
	if (value.level === "reviewed") errors.push(`${pathLabel}.level ${EXPLICIT_REVIEWED_UNAVAILABLE}`);
	if (value.level === "verified" && (!Array.isArray(value.verify) || value.verify.length === 0)) {
		errors.push(`${pathLabel} verification-config requires at least one runtime verify command for level verified.`);
	}
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
			if (review.required !== undefined && typeof review.required !== "boolean") {
				errors.push(`${pathLabel}.review.required must be a boolean.`);
			} else if (review.required !== false) {
				errors.push(`${pathLabel}.review.required must be false; this run cannot supply an independent reviewer result.`);
			}
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
			return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" as const };
		}
		return {
			id: criterion.id?.trim() || `criterion-${index + 1}`,
			must: criterion.must ?? "",
			evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
			severity: criterion.severity ?? "required",
		};
	}).filter((criterion) => criterion.must.trim());
}

export function inferAcceptanceRecommendations(input: {
	agentName: string;
	acceptanceRole?: AcceptanceRole;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): { recommendations: string[]; inferredReason: string[] } {
	const inferred = inferLevel(input);
	return {
		recommendations: [
			`Suggested legacy level: ${inferred.level}.`,
			...inferred.criteria.map((criterion) => `Suggested criterion: ${criterion}`),
			...(inferred.evidence.length > 0 ? [`Suggested evidence: ${inferred.evidence.join(", ")}.`] : []),
		],
		inferredReason: inferred.reasons,
	};
}

export function resolveEffectiveAcceptance(input: {
	explicit?: EffectiveAcceptanceInput;
	agentName: string;
	acceptanceRole?: AcceptanceRole;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): ResolvedAcceptanceConfig {
	const adapted = adaptLegacyAcceptance(input.explicit);
	const advisory = inferAcceptanceRecommendations(input);
	const contract = adapted.contract;
	const report = contract === false ? false : contract.report ?? false;
	const reportCriteria = report === false ? undefined : report.criteria;
	const evidence = report === false ? [] : report.evidence ?? [];
	const criteria = normalizeCriteria(reportCriteria, evidence);
	const verify = contract === false ? [] : contract.verify ?? [];
	const review = contract === false ? false : contract.review ?? false;
	const level: ResolvedAcceptanceConfig["level"] = review !== false
		? "reviewed"
		: verify.length > 0
			? "verified"
			: report !== false
				? (criteria.length > 0 || evidence.length > 0 ? "checked" : "attested")
				: "none";
	const explicitObject = typeof input.explicit === "object" && input.explicit !== null && !Array.isArray(input.explicit) && !isMergedAcceptanceInput(input.explicit)
		? input.explicit as Record<string, unknown>
		: undefined;
	const explicitObjectAuto = explicitObject?.level === "auto"
		&& Object.keys(explicitObject).every((key) => key === "level");
	const explicit = input.explicit !== undefined && input.explicit !== "auto" && !explicitObjectAuto;
	return {
		level,
		explicit,
		report,
		onFailure: contract === false ? "warn" : contract.onFailure ?? "fail",
		recommendations: explicit ? [] : advisory.recommendations,
		deprecationWarnings: adapted.deprecationWarnings,
		inferredReason: advisory.inferredReason,
		criteria,
		evidence,
		verify,
		review,
		stopRules: adapted.stopRules,
		reason: adapted.reason,
	};
}

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig): string {
	if (acceptance.level === "none") return "";
	const lines = ["", "## Acceptance Contract", `Acceptance level: ${acceptance.level}`];
	if (acceptance.report !== false) {
		lines.push(
			"Completion is not accepted from prose alone. End with a structured acceptance report.",
			"",
			"Criteria:",
			...(acceptance.criteria.length ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- Return the requested result."]),
			"",
			`Required evidence: ${acceptance.evidence.join(", ") || "none"}`,
		);
	}
	if (acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands configured by parent:");
		for (const command of acceptance.verify) lines.push(`- ${command.id}: ${command.command}`);
	}
	if (acceptance.review) {
		lines.push("", `Review gate: ${acceptance.review.required === false ? "optional" : "required"}${acceptance.review.agent ? ` by ${acceptance.review.agent}` : ""}.`);
		if (acceptance.review.focus) lines.push(`Review focus: ${acceptance.review.focus}`);
	}
	if (acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	if (acceptance.report !== false) lines.push(
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
		if (Object.prototype.hasOwnProperty.call(normalized, canonical)) {
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

const VERIFY_OUTPUT_LIMIT_BYTES = 12_000;
const VERIFY_OUTPUT_TRUNCATED = "\n...[truncated]";

interface BoundedVerifyOutput {
	chunks: Buffer[];
	bytes: number;
	truncated: boolean;
}

function createBoundedVerifyOutput(): BoundedVerifyOutput {
	return { chunks: [], bytes: 0, truncated: false };
}

function appendBoundedOutput(output: BoundedVerifyOutput, chunk: Buffer): void {
	assert(output.bytes >= 0);
	assert(output.bytes <= VERIFY_OUTPUT_LIMIT_BYTES);
	const remaining = VERIFY_OUTPUT_LIMIT_BYTES - output.bytes;
	const keptBytes = Math.min(remaining, chunk.length);
	if (keptBytes > 0) {
		output.chunks.push(Buffer.from(chunk.subarray(0, keptBytes)));
		output.bytes += keptBytes;
	}
	output.truncated ||= keptBytes < chunk.length;
	assert(output.bytes <= VERIFY_OUTPUT_LIMIT_BYTES);
}

function decodeBoundedOutput(output: BoundedVerifyOutput): string {
	assert(output.bytes >= 0);
	assert(output.bytes <= VERIFY_OUTPUT_LIMIT_BYTES);
	const bytes = Buffer.concat(output.chunks, output.bytes);
	assert(bytes.length === output.bytes);
	if (!output.truncated) return bytes.toString("utf-8");

	// Do not flush the decoder: an incomplete code point at the byte cap stays
	// buffered instead of becoming a replacement character in ledger output.
	return new StringDecoder("utf-8").write(bytes);
}

function trimOutput(value: string, truncated = false): string | undefined {
	const trimmed = value.trim();
	if (!trimmed && !truncated) return undefined;
	return `${trimmed}${truncated ? VERIFY_OUTPUT_TRUNCATED : ""}`;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
	return unique(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item)));
}

export function aggregateAcceptanceReport(input: {
	criteria: ResolvedAcceptanceGate[];
	results: Array<{
		agent: string;
		acceptance?: AcceptanceLedger;
		error?: string;
		exitCode: number | null;
	}>;
	notes?: string;
}): AcceptanceReport {
	const childReports = input.results.map((result) => result.acceptance?.childReport).filter((report): report is AcceptanceReport => Boolean(report));
	const blockers = input.results.filter((result) => result.exitCode !== 0 || (result.acceptance ? acceptanceBlocksRun(result.acceptance) : false));
	const successfulChildren = input.results.length > 0 && blockers.length === 0;
	const requiredCriteria = input.criteria.filter((criterion) => criterion.severity !== "recommended");
	const childEvidence = input.results.map((result, index) =>
		`Child ${index + 1} (${result.agent}): acceptance ${result.acceptance?.status ?? "unreported"}${result.error ? ` (${result.error})` : ""}`,
	);
	const aggregateNotes = uniqueStrings([input.notes, ...childEvidence]).join("\n");
	return {
		criteriaSatisfied: requiredCriteria.map((criterion, index) => ({
			id: normalizedToken(criterion.id),
			status: successfulChildren ? "satisfied" as const : "not-satisfied" as const,
			evidence: successfulChildren
				? index === 0
					? `All ${input.results.length} dynamic child run(s) completed without child or acceptance blockers.`
					: "Collected child acceptance evidence for aggregate review."
				: index === 0
					? "Dynamic fanout produced no accepted child evidence."
					: "Dynamic fanout produced no aggregate review evidence.",
		})),
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
		manualNotes: aggregateNotes || `Aggregated acceptance evidence from ${input.results.length} dynamic fanout child run(s).`,
		notes: aggregateNotes || input.notes,
	};
}

function runVerifyCommand(command: AcceptanceVerifyCommand, defaultCwd: string, options: { signal?: AbortSignal; abortMessage?: string } = {}): Promise<AcceptanceVerifyResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
		const stdout = createBoundedVerifyOutput();
		const stderr = createBoundedVerifyOutput();
		let timedOut = false;
		let settled = false;
		let hardKill: NodeJS.Timeout | undefined;
		const child = spawn(command.command, {
			cwd,
			env: { ...process.env, ...(command.env ?? {}) },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		const killTree = (signal: "SIGTERM" | "SIGKILL") => {
			if (process.platform === "win32") {
				if (child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
				return;
			}
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch {
				child.kill(signal);
			}
		};
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
			killTree("SIGTERM");
			hardKill = setTimeout(() => {
				killTree("SIGKILL");
				const decodedStderr = decodeBoundedOutput(stderr);
				finish({
					exitCode: null,
					status: "timed-out",
					stdout: trimOutput(decodeBoundedOutput(stdout), stdout.truncated),
					stderr: trimOutput(decodedStderr || options.abortMessage || "Acceptance verification timed out.", stderr.truncated),
				});
			}, 100);
			hardKill.unref?.();
		};
		const timeout = setTimeout(abortVerification, command.timeoutMs ?? 120_000);
		timeout.unref?.();
		if (options.signal?.aborted) abortVerification();
		else options.signal?.addEventListener("abort", abortVerification, { once: true });
		child.stdout.on("data", (chunk: Buffer) => appendBoundedOutput(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => appendBoundedOutput(stderr, chunk));
		child.on("close", (exitCode) => {
			if (timedOut) return;
			const passed = exitCode === 0;
			finish({
				exitCode,
				status: passed ? "passed" : command.allowFailure ? "allowed-failure" : "failed",
				stdout: trimOutput(decodeBoundedOutput(stdout), stdout.truncated),
				stderr: trimOutput(decodeBoundedOutput(stderr), stderr.truncated),
			});
		});
		child.on("error", (error) => {
			finish({
				exitCode: timedOut ? null : 1,
				status: timedOut ? "timed-out" : command.allowFailure ? "allowed-failure" : "failed",
				stderr: timedOut ? trimOutput(decodeBoundedOutput(stderr) || options.abortMessage || "Acceptance verification timed out.", stderr.truncated) : error instanceof Error ? error.message : String(error),
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

	let reportPassed = acceptance.report === false;
	if (acceptance.report !== false) {
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
			ledger.runtimeChecks.push(
				...checkCriteriaSatisfied(acceptance.criteria, parsed.report),
				...runStructuralChecks(acceptance, parsed.report, input.cwd),
			);
			reportPassed = !ledger.runtimeChecks.some((check) => check.status === "failed");
		} else {
			ledger.childReportParseError = parsed.error;
			ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
		}
	}

	for (const command of acceptance.verify) {
		ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd, { signal: input.signal, abortMessage: input.abortMessage }));
		if (input.signal?.aborted) break;
	}
	const verifyPassed = !ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out");

	let reviewPassed = true;
	if (acceptance.review !== false) {
		if (input.reviewResult) {
			ledger.reviewResult = input.reviewResult;
			reviewPassed = input.reviewResult.status === "no-blockers";
		} else {
			const required = acceptance.review.required !== false;
			ledger.reviewResult = {
				status: "needs-parent-decision",
				findings: [{
					severity: required ? "blocker" : "non-blocking",
					issue: "Reviewed acceptance requires an independent reviewer result.",
					rationale: "The run cannot be marked reviewed from child evidence alone.",
				}],
			};
			reviewPassed = !required;
		}
	}

	if (!reportPassed || !verifyPassed || !reviewPassed) ledger.status = "rejected";
	else if (acceptance.review !== false && ledger.reviewResult?.status === "no-blockers") ledger.status = "reviewed";
	else if (acceptance.verify.length > 0) ledger.status = "verified";
	else if (acceptance.report !== false) ledger.status = acceptance.criteria.length > 0 || acceptance.evidence.length > 0 ? "checked" : "attested";
	else if (acceptance.review !== false && acceptance.review.required === false && !input.reviewResult) ledger.status = "not-required";
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

function rejectedAcceptanceBlocksRun(status: string, explicit: boolean, onFailure: "fail" | "warn"): boolean {
	return status === "rejected" && explicit && onFailure === "fail";
}

export function acceptanceBlocksRun(ledger: AcceptanceLedger): boolean {
	return rejectedAcceptanceBlocksRun(ledger.status, ledger.explicit, ledger.effectiveAcceptance.onFailure);
}

export function acceptanceControlBlocksRun(acceptance: {
	status: string;
	explicit: boolean;
	effectiveAcceptance?: { onFailure: "fail" | "warn" };
}): boolean {
	return rejectedAcceptanceBlocksRun(acceptance.status, acceptance.explicit, acceptance.effectiveAcceptance?.onFailure ?? "fail");
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
