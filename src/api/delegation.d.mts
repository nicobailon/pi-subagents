export declare const SUBAGENT_DELEGATION_REQUEST_EVENT: "subagent:delegation:request";
export declare const SUBAGENT_DELEGATION_STARTED_EVENT: "subagent:delegation:started";
export declare const SUBAGENT_DELEGATION_UPDATE_EVENT: "subagent:delegation:update";
export declare const SUBAGENT_DELEGATION_RESPONSE_EVENT: "subagent:delegation:response";
export declare const SUBAGENT_DELEGATION_CANCEL_EVENT: "subagent:delegation:cancel";

export interface SubagentDelegationTurnBudget {
	maxTurns: number;
	graceTurns?: number;
}

export interface SubagentDelegationToolBudget {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export type SubagentDelegationAcceptance =
	| "auto"
	| "attested"
	| "checked"
	| "verified"
	| false
	| Record<string, unknown>;

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

export interface SubagentDelegationRequest {
	version: 1;
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	cwd: string;
	model?: string;
	timeoutMs?: number;
	maxRuntimeMs?: number;
	turnBudget?: SubagentDelegationTurnBudget;
	toolBudget?: SubagentDelegationToolBudget;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	acceptance?: SubagentDelegationAcceptance;
	artifacts?: boolean;
}

export interface SubagentDelegationStarted {
	version: 1;
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
	acceptance?: unknown;
	turns?: number;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	warnings?: string[];
}

export interface SubagentDelegationCancel extends SubagentDelegationStarted {}

export type SubagentDelegationParseResult =
	| { ok: true; request: SubagentDelegationRequest }
	| { ok: false; requestId?: string; error: string };

export function parseSubagentDelegationRequest(data: unknown): SubagentDelegationParseResult;
