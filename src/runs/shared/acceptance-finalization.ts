import type {
	AcceptanceFinalizationTurn,
	AcceptanceLedger,
	ResolvedAcceptanceConfig,
} from "../../shared/types.ts";
import { acceptanceFailureMessage } from "./acceptance-evaluation.ts";
import { formatEvidenceReportFieldMapping } from "./acceptance-contract.ts";
import { stripAcceptanceReport } from "./acceptance-reports.ts";

const INITIAL_OUTPUT_LIMIT = 8_000;

function truncateForPrompt(value: string): string {
	const trimmed = stripAcceptanceReport(value).trim();
	if (trimmed.length <= INITIAL_OUTPUT_LIMIT) return trimmed || "(initial output was empty after removing acceptance-report)";
	return `${trimmed.slice(0, INITIAL_OUTPUT_LIMIT)}\n...[truncated]`;
}

function formatReportForPrompt(ledger: AcceptanceLedger): string {
	if (ledger.childReport) return JSON.stringify(ledger.childReport, null, 2);
	return `Missing or malformed acceptance report: ${ledger.childReportParseError ?? "no parse detail"}`;
}

export function formatAcceptanceFinalizationPrompt(input: {
	acceptance: ResolvedAcceptanceConfig;
	initialOutput: string;
	initialLedger: AcceptanceLedger;
	turn: number;
	maxTurns: number;
	previousFailure?: string;
}): string {
	const lines = [
		"## Acceptance Finalization",
		"You are continuing the same subagent session. Before this run can be accepted, compare the current work to the acceptance contract and the evidence below.",
		`This is finalization turn ${input.turn} of ${input.maxTurns}. The run will be rejected if the contract is still not satisfied after turn ${input.maxTurns}.`,
		"",
		"If a criterion is incomplete and fixable in this session, keep working now before returning the final report.",
		"If a criterion cannot be satisfied in this session, report it as not-satisfied, explain the blocker in residualRisks, and say what input would unblock progress.",
		"Do not claim a criterion is satisfied unless the current work has concrete evidence from files, commands, validation output, or other inspectable artifacts.",
		"",
		"## Acceptance Contract",
		"Criteria:",
		...(input.acceptance.criteria.length ? input.acceptance.criteria.map((criterion) => `- ${criterion.id}: ${criterion.must}`) : ["- No explicit criteria were configured; satisfy the requested task and required evidence/checks."]),
		"",
		`Required evidence: ${input.acceptance.evidence.join(", ") || "none explicitly requested"}`,
	];
	if (input.acceptance.evidence.length > 0) {
		lines.push(
			"",
			"Structured evidence must be present in the final `acceptance-report` JSON fields. Markdown sections in the visible answer do not satisfy required evidence by themselves. If the previous visible output already included the evidence, copy or summarize it into the matching JSON field.",
			"Evidence field mapping:",
			...formatEvidenceReportFieldMapping(input.acceptance.evidence),
		);
	}
	if (input.acceptance.verify.length > 0) {
		lines.push("", "Runtime verification commands that must pass:", ...input.acceptance.verify.map((command) => `- ${command.id}: ${command.command}`));
	}
	if (input.acceptance.review) {
		lines.push("", `Independent review gate after self-review: ${input.acceptance.review.required === false ? "optional" : "required"}${input.acceptance.review.agent ? ` by ${input.acceptance.review.agent}` : ""}.`);
	}
	if (input.acceptance.stopRules.length > 0) {
		lines.push("", "Stop rules are hard constraints while deciding whether to continue, stop as blocked, or report success:", ...input.acceptance.stopRules.map((rule) => `- ${rule}`));
	}
	lines.push(
		"",
		"Initial visible output:",
		truncateForPrompt(input.initialOutput),
		"",
		"Initial acceptance report:",
		formatReportForPrompt(input.initialLedger),
	);
	if (input.previousFailure) {
		lines.push("", "Previous finalization failure to address:", input.previousFailure);
	}
	lines.push(
		"",
		"Now do the self-check. If work was missing and you repaired it, report the repaired final state. Finish with exactly one fenced JSON block tagged `acceptance-report`.",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof from the final state" }],
			changedFiles: [],
			testsAddedOrUpdated: [],
			commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
			validationOutput: [],
			residualRisks: [],
			noStagedFiles: true,
			diffSummary: "concise summary of changed behavior and important files",
			reviewFindings: [],
			manualNotes: "manual notes or external evidence, if any",
			notes: "final self-review summary",
		}, null, 2),
		"```",
	);
	return lines.join("\n");
}

export function createFinalizationTurn(input: {
	turn: number;
	prompt: string;
	rawOutput: string;
	ledger: AcceptanceLedger;
}): AcceptanceFinalizationTurn {
	const failureMessage = acceptanceFailureMessage(input.ledger);
	return {
		turn: input.turn,
		prompt: input.prompt,
		status: input.ledger.status,
		rawOutput: input.rawOutput,
		...(input.ledger.childReport ? { report: input.ledger.childReport } : {}),
		...(input.ledger.childReportParseError ? { parseError: input.ledger.childReportParseError } : {}),
		runtimeChecks: input.ledger.runtimeChecks,
		verifyRuns: input.ledger.verifyRuns,
		...(failureMessage ? { failureMessage } : {}),
	};
}

export function createFinalizationProcessFailureTurn(input: {
	turn: number;
	prompt: string;
	rawOutput?: string;
	message: string;
}): AcceptanceFinalizationTurn {
	return {
		turn: input.turn,
		prompt: input.prompt,
		status: "rejected",
		...(input.rawOutput ? { rawOutput: input.rawOutput } : {}),
		runtimeChecks: [{ id: "finalization-process", status: "failed", message: input.message }],
		verifyRuns: [],
		failureMessage: `Acceptance rejected: ${input.message}`,
	};
}

export function attachFinalizationToLedger(input: {
	initialLedger: AcceptanceLedger;
	authoritativeLedger: AcceptanceLedger;
	turns: AcceptanceFinalizationTurn[];
	status: "completed" | "failed";
	maxTurns: number;
}): AcceptanceLedger {
	return {
		...input.authoritativeLedger,
		...(input.initialLedger.childReport ? { initialChildReport: input.initialLedger.childReport } : {}),
		...(input.initialLedger.childReportParseError ? { initialChildReportParseError: input.initialLedger.childReportParseError } : {}),
		finalization: {
			mode: "self-review-loop",
			status: input.status,
			maxTurns: input.maxTurns,
			turns: input.turns,
		},
	};
}

export function buildFinalizationProcessFailureLedger(input: {
	initialLedger: AcceptanceLedger;
	turns: AcceptanceFinalizationTurn[];
	maxTurns: number;
	message: string;
}): AcceptanceLedger {
	return attachFinalizationToLedger({
		initialLedger: input.initialLedger,
		authoritativeLedger: {
			...input.initialLedger,
			status: "rejected",
			runtimeChecks: [
				...input.initialLedger.runtimeChecks,
				{ id: "finalization-process", status: "failed", message: input.message },
			],
		},
		turns: input.turns,
		status: "failed",
		maxTurns: input.maxTurns,
	});
}
