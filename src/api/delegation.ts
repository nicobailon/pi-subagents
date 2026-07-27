import { PACKAGE_METADATA } from "../shared/package-metadata.ts";

export const SUBAGENT_DELEGATION_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION = 2 as const;

// This is the established extension-to-extension transport. The public API
// intentionally reuses it instead of adding a second event protocol.
export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

export const SUBAGENT_DELEGATION_PROVIDER_ID = "pi-subagents/prompt-template-bridge" as const;
export const SUBAGENT_DELEGATION_PROVIDER_PACKAGE = PACKAGE_METADATA.name;
export const SUBAGENT_DELEGATION_PROVIDER_PACKAGE_VERSION = PACKAGE_METADATA.version;

export interface SubagentDelegationRequestFieldCapabilities {
	readonly model: boolean;
	readonly thinking: boolean;
	readonly timeout: boolean;
	readonly turnBudget: boolean;
	readonly toolBudget: boolean;
	readonly skills: boolean;
	readonly artifacts: boolean;
	readonly textResult: boolean;
	readonly structuredResult: boolean;
	readonly ownershipIdentity: boolean;
}

export interface SubagentDelegationProtocolCapability {
	readonly version: 1 | 2;
	readonly terminalStatuses: readonly string[];
	readonly requestFields: SubagentDelegationRequestFieldCapabilities;
}

export interface SubagentDelegationProviderDescriptor {
	readonly providerId: string;
	readonly packageName: string;
	readonly packageVersion: string;
	/** Monotonically unique within this process-global provider registry. */
	readonly generation: number;
	readonly protocols: readonly SubagentDelegationProtocolCapability[];
	readonly cancellation: Readonly<{
		supported: boolean;
		preCancellation: boolean;
		identity: "requestId" | "requestId+ownerRunId+nodeId" | "protocol-specific";
	}>;
	readonly concurrency: Readonly<{
		semantics: "v1-request-id-v2-owner-node";
		maximumConcurrentRequests: number | null;
		v2IdentityHistoryLimit: number;
		v1DuplicateIdentity: "ignored";
		v2DuplicateIdentity: "ignored";
		v2ConcurrentLogicalNode: "duplicate_node";
	}>;
}

export type SubagentDelegationProviderRegistration = Omit<SubagentDelegationProviderDescriptor, "generation">;

interface SubagentDelegationProviderRegistry {
	readonly providers: WeakMap<object, SubagentDelegationProviderDescriptor>;
	nextGeneration: number;
}

// Symbol.for intentionally lets duplicate installed copies observe and replace the
// provider owning the same concrete EventBus instead of maintaining split registries.
const DELEGATION_PROVIDER_REGISTRY = Symbol.for("pi-subagents.delegation-provider-registry.v1");
const globalRegistry = globalThis as typeof globalThis & {
	[DELEGATION_PROVIDER_REGISTRY]?: SubagentDelegationProviderRegistry;
};
const delegationProviderRegistry = globalRegistry[DELEGATION_PROVIDER_REGISTRY] ??= {
	providers: new WeakMap<object, SubagentDelegationProviderDescriptor>(),
	nextGeneration: 0,
};

function freezeDelegationProviderDescriptor(
	descriptor: SubagentDelegationProviderRegistration,
	generation: number,
): SubagentDelegationProviderDescriptor {
	const protocols = descriptor.protocols.map((protocol) => Object.freeze({
		...protocol,
		terminalStatuses: Object.freeze([...protocol.terminalStatuses]),
		requestFields: Object.freeze({ ...protocol.requestFields }),
	}));
	return Object.freeze({
		...descriptor,
		generation,
		protocols: Object.freeze(protocols),
		cancellation: Object.freeze({ ...descriptor.cancellation }),
		concurrency: Object.freeze({ ...descriptor.concurrency }),
	});
}

/**
 * Registers the provider currently owning a concrete Pi EventBus/extension context.
 * Registration is synchronous and does not dispatch or reserve delegation work.
 * Disposing an older generation never invalidates a newer replacement.
 */
export function registerSubagentDelegationProvider(
	context: object,
	descriptor: SubagentDelegationProviderRegistration,
): { readonly descriptor: SubagentDelegationProviderDescriptor; dispose(): void } {
	const generation = ++delegationProviderRegistry.nextGeneration;
	const immutableDescriptor = freezeDelegationProviderDescriptor(descriptor, generation);
	delegationProviderRegistry.providers.set(context, immutableDescriptor);
	return Object.freeze({
		descriptor: immutableDescriptor,
		dispose: () => {
			if (delegationProviderRegistry.providers.get(context)?.generation === generation) delegationProviderRegistry.providers.delete(context);
		},
	});
}

/** Returns the current provider generation for this exact context without emitting events. */
export function getSubagentDelegationProvider(
	context: object,
): SubagentDelegationProviderDescriptor | undefined {
	return delegationProviderRegistry.providers.get(context);
}

export const DEFAULT_SUBAGENT_DELEGATION_PROVIDER: SubagentDelegationProviderRegistration = Object.freeze({
	providerId: SUBAGENT_DELEGATION_PROVIDER_ID,
	packageName: SUBAGENT_DELEGATION_PROVIDER_PACKAGE,
	packageVersion: SUBAGENT_DELEGATION_PROVIDER_PACKAGE_VERSION,
	protocols: Object.freeze([
		Object.freeze({
			version: 1 as const,
			terminalStatuses: Object.freeze(["completed", "failed", "timed_out", "cancelled", "interrupted", "turn_budget_exhausted", "tool_budget_exhausted", "structured_output_failed", "acceptance_failed", "invalid_request", "unavailable_context"]),
			requestFields: Object.freeze({ model: true, thinking: false, timeout: true, turnBudget: true, toolBudget: true, skills: true, artifacts: true, textResult: true, structuredResult: true, ownershipIdentity: false }),
		}),
		Object.freeze({
			version: 2 as const,
			terminalStatuses: Object.freeze(["completed", "failed", "timed_out", "cancelled", "interrupted", "turn_budget_exhausted", "tool_budget_exhausted", "structured_output_failed", "acceptance_failed", "invalid_request", "unavailable_context", "duplicate_node"]),
			requestFields: Object.freeze({ model: true, thinking: true, timeout: true, turnBudget: true, toolBudget: true, skills: true, artifacts: true, textResult: true, structuredResult: true, ownershipIdentity: true }),
		}),
	]),
	cancellation: Object.freeze({ supported: true, preCancellation: true, identity: "protocol-specific" as const }),
	concurrency: Object.freeze({
		semantics: "v1-request-id-v2-owner-node" as const,
		maximumConcurrentRequests: null,
		v2IdentityHistoryLimit: 8_192,
		v1DuplicateIdentity: "ignored" as const,
		v2DuplicateIdentity: "ignored" as const,
		v2ConcurrentLogicalNode: "duplicate_node" as const,
	}),
});

export interface SubagentDelegationTurnBudget {
	maxTurns: number;
	graceTurns?: number;
}

export interface SubagentDelegationToolBudget {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface SubagentDelegationAgentContract {
	version: 1;
}

export type SubagentDelegationJsonSchemaObject = Record<string, unknown>;

export interface SubagentDelegationExecutionResult {
	status: "completed" | "failed" | "paused" | "stopped" | "detached";
	success: boolean;
	exitCode: number;
	error?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	detached?: boolean;
}

export interface SubagentDelegationReviewResult {
	status: "not-requested" | "review-required" | "reviewed" | "blockers";
	findings?: Array<{ severity: "blocker" | "non-blocking"; file?: string; issue: string; rationale: string }>;
}

export interface SubagentDelegationEffectsResult {
	fileMutation?: {
		status: "not-requested" | "not-applicable" | "observed" | "missing";
		expected: boolean;
		attempted: boolean;
		message?: string;
	};
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
	outputSchema?: SubagentDelegationJsonSchemaObject;
	agentContract?: SubagentDelegationAgentContract;
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
	| "structured_output_failed"
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
	| "review-required"
	| "reviewed"
	| "accepted"
	| "rejected";

export interface SubagentDelegationAcceptanceResult {
	status: SubagentDelegationAcceptanceStatus;
	evidenceStatus: Exclude<SubagentDelegationAcceptanceStatus, "review-required" | "reviewed" | "accepted">;
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
	execution?: SubagentDelegationExecutionResult;
	output?: string;
	outputPath?: string;
	sessionFile?: string;
	acceptance?: SubagentDelegationAcceptanceResult;
	review?: SubagentDelegationReviewResult;
	effects?: SubagentDelegationEffectsResult;
	turns?: number;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	warnings?: string[];
}

export interface SubagentDelegationCancel extends SubagentDelegationStarted {}

export type SubagentDelegationV2Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type SubagentDelegationV2ResultRequest =
	| { kind: "text" }
	| { kind: "structured"; schema: SubagentDelegationJsonSchemaObject };

export interface SubagentDelegationV2Request {
	version: typeof SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	cwd: string;
	model?: string;
	thinking?: SubagentDelegationV2Thinking;
	timeoutMs?: number;
	turnBudget?: SubagentDelegationTurnBudget;
	toolBudget?: SubagentDelegationToolBudget;
	skill?: string | string[] | boolean;
	artifacts?: boolean;
	result: SubagentDelegationV2ResultRequest;
}

export interface SubagentDelegationV2Started {
	version: typeof SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
}

export interface SubagentDelegationV2Update extends SubagentDelegationV2Started {
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

export type SubagentDelegationV2Status = SubagentDelegationStatus | "duplicate_node";

export type SubagentDelegationV2Value =
	| { kind: "text"; text: string }
	| { kind: "structured"; value: unknown };

export interface SubagentDelegationV2Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

export interface SubagentDelegationV2TerminalResponse extends SubagentDelegationV2Started {
	status: Exclude<SubagentDelegationV2Status, "invalid_request">;
	error?: string;
	runId?: string;
	agent?: string;
	model?: string;
	thinking?: string;
	exitCode?: number;
	result?: SubagentDelegationV2Value;
	usage?: SubagentDelegationV2Usage;
}

/** A malformed V2 request can only be correlated by the valid identity fields it supplied. */
export interface SubagentDelegationV2InvalidResponse {
	version: typeof SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION;
	requestId: string;
	ownerRunId?: string;
	nodeId?: string;
	status: "invalid_request";
	error?: string;
}

export type SubagentDelegationV2Response = SubagentDelegationV2TerminalResponse | SubagentDelegationV2InvalidResponse;

export interface SubagentDelegationV2Cancel extends SubagentDelegationV2Started {}
