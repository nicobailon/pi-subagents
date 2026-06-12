import type {
	AcceptanceConfig,
	AcceptanceEvidenceKind,
	AcceptanceInput,
	AcceptanceProvenanceLevel,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
	SubagentRunMode,
} from "../../shared/types.ts";

const DEFAULT_FINALIZATION_MAX_TURNS = 3;
const MAX_FINALIZATION_TURNS = 10;

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

const ACCEPTANCE_KEYS = new Set([
	"criteria",
	"evidence",
	"verify",
	"review",
	"stopRules",
	"maxFinalizationTurns",
]);

const REMOVED_ACCEPTANCE_KEYS = new Set(["level", "finalization", "reason"]);

const EVIDENCE_REPORT_FIELDS: Record<AcceptanceEvidenceKind, string> = {
	"changed-files": "changedFiles: array of changed file paths",
	"tests-added": "testsAddedOrUpdated: array of test files, suites, or cases added/updated",
	"commands-run": "commandsRun: array of commands with result passed/failed/not-run and a short summary",
	"validation-output": "validationOutput: array of relevant validation output summaries",
	"residual-risks": "residualRisks: array of remaining risks or blockers; use [] when none remain",
	"no-staged-files": "noStagedFiles: boolean",
	"diff-summary": "diffSummary: non-empty string summarizing changed behavior and important files",
	"review-findings": "reviewFindings: array of reviewer findings; use [] when no findings remain",
	"manual-notes": "manualNotes: string for manual notes or external evidence",
};

export function formatEvidenceReportFieldMapping(evidence: AcceptanceEvidenceKind[]): string[] {
	return evidence.map((kind) => `- ${kind} -> ${EVIDENCE_REPORT_FIELDS[kind]}`);
}

function hasArrayItems(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
	const errors: string[] = [];
	if (input === undefined) return errors;
	if (input === false || typeof input === "string") {
		errors.push(`${pathLabel} must be an object. Public acceptance levels and false disables are no longer supported.`);
		return errors;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		errors.push(`${pathLabel} must be an object.`);
		return errors;
	}

	const value = input as Record<string, unknown>;
	if (Object.hasOwn(value, "level")) {
		errors.push(`${pathLabel}.level is no longer supported; configure criteria, evidence, verify, and review directly.`);
	}
	if (Object.hasOwn(value, "finalization")) {
		errors.push(`${pathLabel}.finalization is not supported; acceptance contracts always run the self-review loop.`);
	}
	if (Object.hasOwn(value, "reason")) {
		errors.push(`${pathLabel}.reason is not supported because acceptance is disabled by omitting the field.`);
	}
	for (const key of Object.keys(value)) {
		if (!ACCEPTANCE_KEYS.has(key) && !REMOVED_ACCEPTANCE_KEYS.has(key)) errors.push(`${pathLabel}.${key} is not supported.`);
	}

	if (value.criteria !== undefined) {
		if (!Array.isArray(value.criteria)) {
			errors.push(`${pathLabel}.criteria must be an array.`);
		} else {
			for (const [index, criterion] of value.criteria.entries()) {
				if (typeof criterion === "string") {
					if (!criterion.trim()) errors.push(`${pathLabel}.criteria[${index}] must not be empty.`);
					continue;
				}
				if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
					errors.push(`${pathLabel}.criteria[${index}] must be a string or object.`);
					continue;
				}
				const item = criterion as Record<string, unknown>;
				if (typeof item.id !== "string" || !item.id.trim()) errors.push(`${pathLabel}.criteria[${index}].id is required.`);
				if (typeof item.must !== "string" || !item.must.trim()) errors.push(`${pathLabel}.criteria[${index}].must is required.`);
				if (item.evidence !== undefined && !Array.isArray(item.evidence)) errors.push(`${pathLabel}.criteria[${index}].evidence must be an array.`);
				if (Array.isArray(item.evidence)) {
					for (const [evidenceIndex, evidence] of item.evidence.entries()) {
						if (typeof evidence !== "string" || !VALID_EVIDENCE.has(evidence as AcceptanceEvidenceKind)) {
							errors.push(`${pathLabel}.criteria[${index}].evidence[${evidenceIndex}] is not a supported evidence kind.`);
						}
					}
				}
				if (item.severity !== undefined && item.severity !== "required" && item.severity !== "recommended") {
					errors.push(`${pathLabel}.criteria[${index}].severity must be required or recommended.`);
				}
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
			if (typeof cmd.id !== "string" || !cmd.id.trim()) errors.push(`${pathLabel}.verify[${index}].id is required.`);
			if (typeof cmd.command !== "string" || !cmd.command.trim()) errors.push(`${pathLabel}.verify[${index}].command is required.`);
			if (cmd.timeoutMs !== undefined && (!Number.isInteger(cmd.timeoutMs) || Number(cmd.timeoutMs) <= 0)) {
				errors.push(`${pathLabel}.verify[${index}].timeoutMs must be a positive integer.`);
			}
			if (cmd.cwd !== undefined && typeof cmd.cwd !== "string") errors.push(`${pathLabel}.verify[${index}].cwd must be a string.`);
			if (cmd.env !== undefined) {
				if (!cmd.env || typeof cmd.env !== "object" || Array.isArray(cmd.env)) {
					errors.push(`${pathLabel}.verify[${index}].env must be an object with string values.`);
				} else {
					for (const [key, envValue] of Object.entries(cmd.env as Record<string, unknown>)) {
						if (typeof envValue !== "string") errors.push(`${pathLabel}.verify[${index}].env.${key} must be a string.`);
					}
				}
			}
			if (cmd.allowFailure !== undefined && typeof cmd.allowFailure !== "boolean") errors.push(`${pathLabel}.verify[${index}].allowFailure must be a boolean.`);
		}
	}

	if (value.review !== undefined) {
		if (!value.review || typeof value.review !== "object" || Array.isArray(value.review)) {
			errors.push(`${pathLabel}.review must be an object.`);
		} else {
			const review = value.review as Record<string, unknown>;
			if (review.agent !== undefined && typeof review.agent !== "string") errors.push(`${pathLabel}.review.agent must be a string.`);
			if (review.focus !== undefined && typeof review.focus !== "string") errors.push(`${pathLabel}.review.focus must be a string.`);
			if (review.required !== undefined && typeof review.required !== "boolean") errors.push(`${pathLabel}.review.required must be a boolean.`);
		}
	}

	if (value.stopRules !== undefined) {
		if (!Array.isArray(value.stopRules)) {
			errors.push(`${pathLabel}.stopRules must be an array.`);
		} else {
			for (const [index, rule] of value.stopRules.entries()) {
				if (typeof rule !== "string" || !rule.trim()) errors.push(`${pathLabel}.stopRules[${index}] must be a non-empty string.`);
			}
		}
	}

	if (value.maxFinalizationTurns !== undefined) {
		if (!Number.isInteger(value.maxFinalizationTurns) || Number(value.maxFinalizationTurns) < 1 || Number(value.maxFinalizationTurns) > MAX_FINALIZATION_TURNS) {
			errors.push(`${pathLabel}.maxFinalizationTurns must be an integer from 1 to ${MAX_FINALIZATION_TURNS}.`);
		}
	}

	const hasContract = hasArrayItems(value.criteria)
		|| hasArrayItems(value.evidence)
		|| hasArrayItems(value.verify)
		|| value.review !== undefined
		|| hasArrayItems(value.stopRules);
	if (!hasContract) {
		errors.push(`${pathLabel} must include at least one of criteria, evidence, verify, review, or stopRules.`);
	}

	return errors;
}

function normalizeCriteria(criteria: AcceptanceConfig["criteria"], evidence: AcceptanceEvidenceKind[]): ResolvedAcceptanceGate[] {
	return (criteria ?? []).map((criterion, index) => {
		if (typeof criterion === "string") {
			return { id: `criterion-${index + 1}`, must: criterion, evidence, severity: "required" as const };
		}
		return {
			id: criterion.id.trim(),
			must: criterion.must,
			evidence: criterion.evidence?.filter((item) => VALID_EVIDENCE.has(item)) ?? evidence,
			severity: criterion.severity ?? "required",
		};
	}).filter((criterion) => criterion.must.trim());
}

function deriveAcceptanceLevel(config: AcceptanceConfig): AcceptanceProvenanceLevel {
	if (config.review) return "reviewed";
	if ((config.verify?.length ?? 0) > 0) return "verified";
	return "checked";
}

export function resolveEffectiveAcceptance(input: {
	explicit?: AcceptanceInput;
	agentName: string;
	task?: string;
	mode?: SubagentRunMode;
	async?: boolean;
	dynamic?: boolean;
	dynamicGroup?: boolean;
}): ResolvedAcceptanceConfig {
	if (input.explicit === undefined) {
		return {
			level: "none",
			explicit: false,
			inferredReason: ["acceptance not configured"],
			criteria: [],
			evidence: [],
			verify: [],
			stopRules: [],
			finalization: { mode: "none", maxTurns: 0 },
		};
	}

	const validationErrors = validateAcceptanceInput(input.explicit);
	if (validationErrors.length > 0) throw new Error(validationErrors.join(" "));
	const explicit = input.explicit;
	const evidence = [...new Set(explicit.evidence ?? [])];
	const criteria = normalizeCriteria(explicit.criteria, evidence);
	const verify = explicit.verify ?? [];
	const stopRules = explicit.stopRules ?? [];
	return {
		level: deriveAcceptanceLevel(explicit),
		explicit: true,
		inferredReason: ["explicit acceptance contract"],
		criteria,
		evidence,
		verify,
		...(explicit.review ? { review: explicit.review } : {}),
		stopRules,
		finalization: { mode: "self-review-loop", maxTurns: explicit.maxFinalizationTurns ?? DEFAULT_FINALIZATION_MAX_TURNS },
	};
}

export function shouldRunAcceptanceFinalization(acceptance: ResolvedAcceptanceConfig): boolean {
	return acceptance.explicit && acceptance.finalization.mode === "self-review-loop" && acceptance.finalization.maxTurns > 0;
}

export function acceptanceSelfReviewConfig(acceptance: ResolvedAcceptanceConfig): ResolvedAcceptanceConfig {
	if (!acceptance.review && acceptance.verify.length === 0) return acceptance;
	const { review: _review, verify: _verify, ...selfReview } = acceptance;
	return {
		...selfReview,
		level: "checked",
		verify: [],
	};
}

export function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig): string {
	if (acceptance.level === "none") return "";
	const lines = [
		"",
		"## Acceptance Contract",
		"Completion is not accepted from prose alone. End the initial response with a structured acceptance report.",
		"After the initial response, the runtime will continue this same session for a bounded self-review/repair loop before accepting the run.",
		"",
		"Criteria:",
		...(acceptance.criteria.length ? acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- No explicit criteria were configured; satisfy the requested task and the required evidence/checks below."]),
		"",
		`Required evidence: ${acceptance.evidence.join(", ") || "none explicitly requested"}`,
	];
	if (acceptance.evidence.length > 0) {
		lines.push(
			"",
			"Structured evidence must be present in the `acceptance-report` JSON fields. Markdown sections in your visible answer do not satisfy required evidence by themselves. If you already described evidence in prose, copy or summarize it into the matching JSON field.",
			"Evidence field mapping:",
			...formatEvidenceReportFieldMapping(acceptance.evidence),
		);
	}
	if (acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands configured by parent:");
		for (const command of acceptance.verify) lines.push(`- ${command.id}: ${command.command}`);
	}
	if (acceptance.review) {
		lines.push("", `Independent review gate: ${acceptance.review.required === false ? "optional" : "required"}${acceptance.review.agent ? ` by ${acceptance.review.agent}` : ""}.`);
		if (acceptance.review.focus) lines.push(`Review focus: ${acceptance.review.focus}`);
	}
	if (acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules:", ...acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof" }],
			changedFiles: [],
			testsAddedOrUpdated: [],
			commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
			validationOutput: [],
			residualRisks: [],
			noStagedFiles: true,
			diffSummary: "concise summary of changed behavior and important files",
			reviewFindings: [],
			manualNotes: "manual notes or external evidence, if any",
			notes: "anything else the parent should know",
		}, null, 2),
		"```",
	);
	return lines.join("\n");
}
