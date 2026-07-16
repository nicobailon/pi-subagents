export const SUBAGENT_DELEGATION_PROTOCOL_VERSION = 1 as const;

// This is the established extension-to-extension transport. The public API
// intentionally reuses it instead of adding a second event protocol.
export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface SubagentDelegationTurnBudget {
	maxTurns: number;
	graceTurns?: number;
}

export interface SubagentDelegationToolBudget {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export type SubagentDelegationAcceptanceEvidence =
	| "changed-files"
	| "tests-added"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface SubagentDelegationAcceptanceCriterion {
	id: string;
	must: string;
	evidence?: SubagentDelegationAcceptanceEvidence[];
	severity?: "required" | "recommended";
}

export interface SubagentDelegationAcceptanceVerifyCommand {
	id: string;
	command: string;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export interface SubagentDelegationAcceptanceReview {
	agent?: string;
	focus?: string;
	required?: boolean;
}

interface SubagentDelegationAcceptanceFields {
	criteria?: Array<string | SubagentDelegationAcceptanceCriterion>;
	evidence?: SubagentDelegationAcceptanceEvidence[];
	verify?: SubagentDelegationAcceptanceVerifyCommand[];
	review?: SubagentDelegationAcceptanceReview | false;
	stopRules?: string[];
}

export type SubagentDelegationAcceptanceConfig = SubagentDelegationAcceptanceFields & (
	| { level: "none"; reason: string }
	| { level?: "auto" | "attested" | "checked" | "verified"; reason?: string }
);

export type SubagentDelegationAcceptance =
	| "auto"
	| "attested"
	| "checked"
	| "verified"
	| false
	| SubagentDelegationAcceptanceConfig;

export interface SubagentDelegationRequest {
	version: typeof SUBAGENT_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	cwd: string;
	model?: string;
	timeoutMs?: number;
	turnBudget?: SubagentDelegationTurnBudget;
	toolBudget?: SubagentDelegationToolBudget;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	acceptance?: SubagentDelegationAcceptance;
	artifacts?: boolean;
}

export interface SubagentDelegationStarted {
	version: typeof SUBAGENT_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
}

export interface SubagentDelegationUpdate extends SubagentDelegationStarted {
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

export type SubagentDelegationStatus =
	| "completed"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted"
	| "turn_budget_exhausted"
	| "tool_budget_exhausted"
	| "acceptance_failed"
	| "invalid_request"
	| "unavailable_context";

export type SubagentDelegationAcceptanceStatus =
	| "pending"
	| "not-required"
	| "claimed"
	| "attested"
	| "checked"
	| "verified"
	| "reviewed"
	| "accepted"
	| "rejected";

export interface SubagentDelegationAcceptanceResult {
	status: SubagentDelegationAcceptanceStatus;
	explicit: boolean;
}

export interface SubagentDelegationResponse extends SubagentDelegationStarted {
	status: SubagentDelegationStatus;
	error?: string;
	runId?: string;
	childIndex?: number;
	agent?: string;
	model?: string;
	exitCode?: number;
	output?: string;
	outputPath?: string;
	sessionFile?: string;
	acceptance?: SubagentDelegationAcceptanceResult;
	turns?: number;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	warnings?: string[];
}

export interface SubagentDelegationCancel extends SubagentDelegationStarted {}
