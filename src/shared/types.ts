/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../agents/agents.ts";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "../runs/shared/capability-ceiling.ts";
import type { AuthorityPolicyConfig } from "../policy/authority.ts";
import type { GlobalMissionIndexRecord, MissionRecord, MissionStoreConfig } from "../missions/types.ts";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type AcceptanceRole = "read-only" | "writer";

export type JsonSchemaObject = Record<string, unknown>;

export interface ChainOutputMapEntry {
	text: string;
	structured?: unknown;
	agent: string;
	stepIndex: number;
}

export type ChainOutputMap = Record<string, ChainOutputMapEntry>;

export type WorkflowNodeStatus = "pending" | "running" | "completed" | "failed" | "paused" | "stopped" | "detached" | "rejected";

export interface WorkflowGraphNode {
	id: string;
	kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent" | "checkpoint";
	agent?: string;
	phase?: string;
	label: string;
	status: WorkflowNodeStatus;
	flatIndex?: number;
	stepIndex?: number;
	children?: WorkflowGraphNode[];
	dynamic?: {
		sourceOutput: string;
		sourcePath: string;
		itemName: string;
		maxItems?: number;
		collectAs?: string;
	};
	itemKey?: string;
	outputName?: string;
	structured?: boolean;
	acceptanceStatus?: AcceptanceLedgerStatus;
	error?: string;
	checkpoint?: ChainCheckpointState;
}

export interface ChainCheckpointState {
	name: string;
	message?: string;
	status: "pending" | "approved" | "rejected";
	stepIndex: number;
	approvedAt?: number;
	rejectedAt?: number;
}

export interface WorkflowGraphSnapshot {
	runId: string;
	mode: SubagentRunMode;
	phases: Array<{ title: string; nodeIds: string[] }>;
	nodes: WorkflowGraphNode[];
	currentNodeId?: string;
}

export interface SavedOutputReference {
	path: string;
	bytes: number;
	lines: number;
	message: string;
}

interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TurnBudgetConfig {
	maxTurns: number;
	graceTurns?: number;
}

export interface ResolvedTurnBudget {
	maxTurns: number;
	graceTurns: number;
}

export interface ToolBudgetConfig {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface ResolvedToolBudget {
	soft?: number;
	hard: number;
	block: string[] | "*";
}

export type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
	outcome: ToolBudgetOutcome;
	toolCount: number;
	softReachedAt?: number;
	hardReachedAt?: number;
	blockedTool?: string;
}

export type TurnBudgetOutcome = "within-budget" | "wrap-up-requested" | "termination-deferred" | "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
	outcome: TurnBudgetOutcome;
	turnCount: number;
	wrapUpRequestedAtTurn?: number;
	terminationDeferredAtTurn?: number;
	exceededAtTurn?: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

/**
 * Smart completion batching for async-completion notifications. Successful
 * sibling completions are held briefly so they arrive as one grouped message;
 * failure and attention signals bypass grouping and always fire immediately.
 */
export interface CompletionBatchConfig {
	enabled?: boolean;
	/** Idle window after each arrival; resets on every new item. */
	debounceMs?: number;
	/** Hard cap measured from the first item in a group. */
	maxWaitMs?: number;
	/** Shorter idle window for straggler groups. */
	stragglerDebounceMs?: number;
	/** Shorter hard cap for straggler groups. */
	stragglerMaxWaitMs?: number;
	/** Arrivals within this window after an emit join a straggler group. */
	stragglerWindowMs?: number;
}

export interface WaitToolConfigObject {
	enabled?: boolean;
}

export type WaitToolConfig = boolean | WaitToolConfigObject;

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	nestedRunId?: string;
	nestingPath?: NestedRunAddress["path"];
	message: string;
	reason?: "idle" | "completion_guard" | "active_long_running" | "tool_failures" | "supervisor_request" | "time_threshold" | "turn_threshold" | "token_threshold";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}

export type SubagentResultStatus = "completed" | "failed" | "paused" | "stopped" | "detached";
export type SubagentOutputState = "present" | "absent" | "unknown";
export type SubagentRunMode = "single" | "parallel" | "chain" | "workflow";
export type SubagentResultMode = SubagentRunMode;

export interface ParallelHandoffPatch {
	path: string;
	branch: string;
	changed: boolean;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	error?: string;
}

export interface ParallelHandoffChild {
	index: number;
	taskIndex: number;
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	outputPath?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	sessionPath?: string;
	patch: ParallelHandoffPatch;
}

export interface ParallelHandoffCleanupTask {
	index: number;
	path: string;
	branch: string;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	preserved?: boolean;
	reason?: string;
	errors?: string[];
}

export interface ParallelHandoffGroup {
	stepIndex: number;
	baseCommit: string;
	repoRoot: string;
	children: ParallelHandoffChild[];
	cleanup: {
		state: "complete" | "partial";
		tasks: ParallelHandoffCleanupTask[];
		pruned: boolean;
		errors?: string[];
	};
}

export interface ParallelHandoffManifest {
	version: 1;
	runId: string;
	mode: "parallel" | "chain";
	source: "foreground" | "async";
	cwd: string;
	createdAt: number;
	updatedAt: number;
	groups: ParallelHandoffGroup[];
}

export interface ParallelHandoffReference {
	version: 1;
	path: string;
	groupCount: number;
	childCount: number;
	changedPatches: number;
	cleanupState: "complete" | "partial";
}

export interface AgentContract {
	version: 1;
}

export type ChainGateLayer = "execution" | "acceptance";

export type ExecutionProjectionStatus = "completed" | "failed" | "paused" | "stopped" | "detached";

export interface ExecutionProjection {
	status: ExecutionProjectionStatus;
	success: boolean;
	exitCode: number;
	error?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	detached?: boolean;
}

export interface ReviewProjection {
	status: "not-requested" | "review-required" | "reviewed" | "blockers";
	findings?: AcceptanceReviewResult["findings"];
}

export interface FileMutationEffect {
	status: "not-requested" | "not-applicable" | "observed" | "missing";
	expected: boolean;
	attempted: boolean;
	message?: string;
}

export interface EffectsProjection {
	fileMutation?: FileMutationEffect;
}

export const SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 3;
export type SubagentLifecycleArtifactVersion = typeof SUBAGENT_LIFECYCLE_ARTIFACT_VERSION;

export type ProcessTerminalState = "pending" | "observed" | "unknown" | "not-started";
export type ProcessTerminalReason =
	| "observer-unavailable"
	| "runner-candidate-missing"
	| "runner-instance-mismatch"
	| "writer-close-unverified"
	| "canonical-session-unavailable"
	| "canonical-session-lease-active"
	| "canonical-session-release-unverified"
	| "proof-write-failed"
	| "stale-repair";

export interface RunnerProcessInstanceExitV1 {
	processInstanceId: string;
	kind: "runner";
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

export interface PiWriterProcessInstanceExitV1 {
	processInstanceId: string;
	kind: "pi-writer";
	attempt: number;
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

export type ProcessInstanceExitV1 = RunnerProcessInstanceExitV1 | PiWriterProcessInstanceExitV1;

export interface CanonicalSessionTerminalV1 {
	canonicalSessionId: string;
	leaseDisposition: "released" | "not-held";
	freeAtObservation: true;
	canonicalSessionLeaseReleased?: true;
}

interface ProcessTerminalBaseV1 {
	version: 1;
	runId: string;
	childIndex?: number;
	runnerProcessInstanceId: string;
	observedAt?: number;
	reason?: ProcessTerminalReason;
	resumeDisposition?: "resumable" | "non-resumable" | "unavailable";
}

export type ProcessTerminalV1 =
	| (ProcessTerminalBaseV1 & { state: "pending" | "not-started" })
	| (ProcessTerminalBaseV1 & {
		state: "observed";
		observedAt: number;
		instances: ProcessInstanceExitV1[];
		canonicalSession?: CanonicalSessionTerminalV1;
	})
	| (ProcessTerminalBaseV1 & {
		state: "unknown";
		reason: ProcessTerminalReason;
		diagnostic?: string;
	});

export type SteeringActionState = "delivered" | "scheduled" | "pending" | "partial" | "recovered" | "failed";
export type SteeringTargetState = "scheduled" | "pending" | "routed" | "queued" | "delivered" | "late" | "failed" | "recovered";

export interface SteeringTargetStatus {
	index: number;
	state: SteeringTargetState;
	routedAt?: number;
	deliveredAt?: number;
	lateDeliveredAt?: number;
	failedAt?: number;
	recoveredAt?: number;
	reason?: string;
	replacementRunId?: string;
}

export interface SteeringRequestStatus {
	id: string;
	requestedAt: number;
	source?: string;
	messagePreview: string;
	targets: SteeringTargetStatus[];
}

export interface SteeringStatus {
	requested: number;
	scheduled: number;
	pending: number;
	delivered: number;
	failed: number;
	recovered: number;
	lastRequestedAt?: number;
	lastDeliveredAt?: number;
	recent: SteeringRequestStatus[];
}

export interface SteerActionTarget {
	index: number;
	state: SteeringTargetState;
	deliveredAt?: number;
	lateDeliveredAt?: number;
	reason?: string;
	replacementRunId?: string;
}

export interface SteerActionResult {
	requestId: string;
	state: SteeringActionState;
	deliveryStatus: "delivered" | "queued";
	sourceRunId: string;
	replacementRunId?: string;
	targets: SteerActionTarget[];
}

export interface SteeringNotice {
	type: "subagent.steering.notice";
	ts: number;
	runId: string;
	requestId: string;
	state: "failed" | "partial" | "recovered";
	message: string;
	currentSessionId?: string;
}

export interface SteeringRecoveryDescriptor {
	version: 1;
	launchContractDigest?: string;
	sourceRunId: string;
	agentContract?: AgentContract;
	agent: string;
	sessionFile?: string;
	cwd: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string;
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	skillPath?: string[];
	agentFilePath?: string;
	completionGuard?: boolean;
	memory?: { scope: "project" | "user"; path: string };
	outputPath?: string;
	outputMode: "inline" | "file-only";
	structuredOutputSchema?: JsonSchemaObject;
	acceptance?: AcceptanceInput;
	controlConfig?: ResolvedControlConfig;
	absoluteDeadlineAt?: number;
	initialTurnBudget?: ResolvedTurnBudget;
	initialToolBudget?: ResolvedToolBudget;
	maxSubagentDepth: number;
	maxOutput?: MaxOutputConfig;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	share: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
}

export type PublicNestedStepSummary = Pick<
	NestedStepSummary,
	"agent" | "status" | "model" | "thinking" | "sessionFile" | "transcriptPath" | "transcriptError" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "toolBudget" | "toolBudgetBlocked" | "startedAt" | "endedAt" | "error" | "timedOut" | "stopped"
> & {
	children?: PublicNestedRunSummary[];
};

export type CostSummary = {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
};

export type PublicNestedRunSummary = Pick<
	NestedRunSummary,
	"id" | "parentRunId" | "parentStepIndex" | "parentAgent" | "depth" | "path" | "asyncDir" | "sessionId" | "sessionFile" | "intercomTarget" | "ownerIntercomTarget" | "leafIntercomTarget" | "ownerState" | "mode" | "state" | "agent" | "agents" | "model" | "thinking" | "currentStep" | "chainStepCount" | "parallelGroups" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "toolBudget" | "toolBudgetBlocked" | "totalTokens" | "totalCost" | "startedAt" | "endedAt" | "lastUpdate" | "error" | "timeoutMs" | "deadlineAt" | "timedOut" | "stopped" | "turnBudget" | "turnBudgetExceeded" | "wrapUpRequested"
> & {
	steps?: PublicNestedStepSummary[];
	children?: PublicNestedRunSummary[];
};

export interface SubagentResultIntercomChild {
	agent: string;
	/** Process/lifecycle status. It does not establish semantic task completion. */
	status: SubagentResultStatus;
	/** Whether the child produced substantive output before its process ended. */
	outputState?: SubagentOutputState;
	summary: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	intercomTarget?: string;
	children?: PublicNestedRunSummary[];
}

export interface SubagentResultIntercomPayload {
	to: string;
	message: string;
	requestId?: string;
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	summary: string;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
	agent?: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	parallelHandoff?: ParallelHandoffReference;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface ChildWatchdogProgress {
	phase: "idle" | "reviewing" | "autofollow" | "settling" | "stale" | "failed";
	seq: number;
	lastUpdate: number;
	followUpPending: boolean;
	reason?: string;
	timedOut?: boolean;
}

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached";
	activityState?: ActivityState;
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	/** Resolved launch model/effort and split usage for public live projections. */
	model?: string;
	thinking?: string;
	inputTokens?: number;
	outputTokens?: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
	watchdog?: ChildWatchdogProgress;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

interface ProgressSummary {
	index?: number;
	agent?: string;
	status?: AgentProgress["status"];
	activityState?: ActivityState;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput?: string[];
	toolCount: number;
	tokens: number;
	model?: string;
	thinking?: string;
	durationMs: number;
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export type AcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified";

export type AcceptanceEvidenceKind =
	| "changed-files"
	| "tests-added"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface AcceptanceGate {
	id: string;
	must: string;
	evidence?: AcceptanceEvidenceKind[];
	severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
	id: string;
	command: string;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
	agent?: string;
	focus?: string;
	required?: boolean;
}

export interface AcceptanceConfig {
	level?: AcceptanceLevel;
	criteria?: Array<string | AcceptanceGate>;
	evidence?: AcceptanceEvidenceKind[];
	verify?: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules?: string[];
	reason?: string;
}

/** Bare "none" and "verified" are not accepted; verified policies require object form with runtime commands. */
export type AcceptanceInput = Exclude<AcceptanceLevel, "none" | "verified"> | false | AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
	id: string;
	must: string;
	evidence: AcceptanceEvidenceKind[];
	severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
	level: Exclude<AcceptanceLevel, "auto">;
	explicit: boolean;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	evidence: AcceptanceEvidenceKind[];
	verify: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules: string[];
	reason?: string;
}

export interface AcceptanceReport {
	criteriaSatisfied?: Array<{
		id?: string;
		status: "satisfied" | "not-satisfied" | "not-applicable";
		evidence: string;
	}>;
	changedFiles?: string[];
	testsAddedOrUpdated?: string[];
	commandsRun?: Array<{
		command: string;
		result: "passed" | "failed" | "not-run";
		summary: string;
	}>;
	validationOutput?: string[];
	residualRisks?: string[];
	noStagedFiles?: boolean;
	diffSummary?: string;
	reviewFindings?: string[];
	manualNotes?: string;
	notes?: string;
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
	id: string;
	status: AcceptanceRuntimeCheckStatus;
	message: string;
}

export interface AcceptanceVerifyResult {
	id: string;
	command: string;
	cwd?: string;
	exitCode: number | null;
	status: "passed" | "failed" | "timed-out" | "allowed-failure";
	stdout?: string;
	stderr?: string;
	durationMs: number;
	artifactPath?: string;
	cacheKey?: string;
	memoized?: boolean;
	envKeys?: string[];
	envHash?: string;
	workspaceState?: {
		kind: "git-tracked";
		repoRoot: string;
		cwdRelative: string;
		head: string;
		diffHash: string;
	};
	artifactError?: string;
}

export interface AcceptanceReviewResult {
	status: "review-required" | "reviewed" | "blockers";
	findings: Array<{
		severity: "blocker" | "non-blocking";
		file?: string;
		issue: string;
		rationale: string;
	}>;
}

export type AcceptanceEvidenceStatus =
	| "pending"
	| "not-required"
	| "claimed"
	| "attested"
	| "checked"
	| "verified"
	| "rejected";

export type AcceptanceLedgerStatus =
	| AcceptanceEvidenceStatus
	| "review-required"
	| "reviewed"
	| "accepted";

export interface AcceptanceLedger {
	status: AcceptanceLedgerStatus;
	evidenceStatus: AcceptanceEvidenceStatus;
	explicit: boolean;
	effectiveAcceptance: ResolvedAcceptanceConfig;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	childReport?: AcceptanceReport;
	childReportParseError?: string;
	runtimeChecks: AcceptanceRuntimeCheck[];
	verifyRuns: AcceptanceVerifyResult[];
	reviewResult?: AcceptanceReviewResult;
	parentDecision?: {
		status: "accepted" | "rejected";
		at: string;
		reason?: string;
	};
}

export interface ProtocolOutputLimit {
	code: "protocol_output_limit";
	stream: "stdout" | "stderr";
	limitBytes: number;
	observedBytes: number;
	diagnosticPrefix: string;
	diagnosticTail: string;
}

export interface LaunchResolvedChildExtensionsV1 {
	version: 1;
	/** This is parent-resolved launch intent, not child-runtime acknowledgement that extensions loaded. */
	source: "launch-resolved";
	disableAmbientExtensions: boolean;
	runtime: string[];
	configured: string[];
	effective: string[];
	omitted: {
		runtime: number;
		configured: number;
		effective: number;
	};
}

export interface RuntimeAcknowledgedChildExtensionsV1 {
	version: 1;
	/** Best-effort child-runtime registration acknowledgement, not extension health. */
	source: "child-runtime";
	ids: string[];
	omitted: number;
}

export interface UsageBudgetLimitConfig {
	soft?: number;
	hard: number;
}

export interface UsageBudgetConfig {
	tokens?: UsageBudgetLimitConfig;
	costUsd?: UsageBudgetLimitConfig;
}

export interface UsageBudgetMetricState extends UsageBudgetLimitConfig {
	used: number;
	outcome: "within-budget" | "soft-exceeded" | "hard-exceeded";
}

export interface UsageBudgetState {
	version: 1;
	/** Enforced from usage reported by completed or streaming child runs; no reservation estimates. */
	source: "reported";
	tokens?: UsageBudgetMetricState;
	costUsd?: UsageBudgetMetricState;
	exhausted: boolean;
	reason?: "tokens" | "costUsd";
}

export interface SingleResult {
	/**
	 * Stable child identity within the foreground run. Pair with Details.runId for
	 * cross-run correlation. This is assigned in launch order, remains stable across
	 * partial progress snapshots and the final result, and is independent of the
	 * result row's array position.
	 */
	index: number;
	agent: string;
	task: string;
	/** Resolved launch context for this child. */
	context?: "fresh" | "fork";
	exitCode: number;
	processSignal?: string | null;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	/** Effective thinking level used by this foreground child, when known. */
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	protocolError?: ProtocolOutputLimit;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	/** Provenance-aware state for substantive child output, excluding synthetic lifecycle messages. */
	outputState?: SubagentOutputState;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
	/** Best-effort metadata persistence failure; execution and receipt publication continue. */
	metadataSaveError?: string;
	structuredOutput?: unknown;
	structuredOutputFailed?: boolean;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	agentContract?: AgentContract;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	execution?: ExecutionProjection;
	review?: ReviewProjection;
	effects?: EffectsProjection;
	transcriptPath?: string;
	transcriptError?: string;
	children?: NestedRunSummary[];
	watchdog?: ChildWatchdogProgress;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
}

export interface SpawnBudgetGrant {
	sessionId: string;
	amount: number;
	grantedAt: number;
	previousLimit: number;
	limit: number;
}

export interface SpawnBudgetSnapshot {
	used: number;
	configuredLimit: number | null;
	granted: number;
	limit: number | null;
	remaining: number | null;
	grantRemaining: number | null;
	grantHistory: SpawnBudgetGrant[];
}

/** Slim per-child projection of a terminal result payload, safe to surface in tool_result details. */
export interface WaitCompletionChild {
	agent?: string;
	/** Child run identity where the producer records one (workflow children); artifact files are keyed by it. */
	runId?: string;
	success?: boolean;
	outputState?: SubagentOutputState;
	error?: string;
	model?: string;
	artifactPaths?: Partial<ArtifactPaths>;
}

/**
 * Terminal completion observed for a run a subagent_wait call covered. Carries run
 * identity and the artifact trail; output text stays in the tool result content.
 */
export interface WaitCompletion {
	runId: string;
	agent?: string;
	mode?: string;
	state?: string;
	success?: boolean;
	/** Versioned bounded output archive retained with the durable completion replay. */
	archivePath?: string;
	results?: WaitCompletionChild[];
}

export interface Details {
	mode: SubagentResultMode | "management";
	runId?: string;
	/** Host tool-call id retained when it differs from the internal run id. */
	toolCallId?: string;
	/** Run-level context summary. "mixed" when children resolved to different modes. */
	context?: "fresh" | "fork" | "mixed";
	results: SingleResult[];
	/**
	 * Terminal completion payloads for runs this subagent_wait call observed
	 * finishing. Async completions travel as result files that are consumed and
	 * deleted after text delivery, so without this field their run and artifact
	 * identity never reaches tool_result details.
	 */
	completions?: WaitCompletion[];
	controlEvents?: ControlEvent[];
	steering?: SteerActionResult;
	asyncId?: string;
	asyncDir?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	usageBudget?: UsageBudgetState;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
	workflowGraph?: WorkflowGraphSnapshot;
	checkpoint?: ChainCheckpointState;
	outputs?: ChainOutputMap;
	// Aggregated child usage across all agents in the run
	totalChildUsage?: Usage;
	// Aggregated cost across all agents in the run
	totalCost?: CostSummary;
	spawnBudget?: SpawnBudgetSnapshot;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	parallelHandoff?: ParallelHandoffReference;
	lifecycleStatus?: {
		processTerminal?: ProcessTerminalV1;
	};
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	/** Original launch contract whose persisted session is being revived. */
	sourceLaunchContractDigest?: string;
	/** Durable mission attached to this run, when mission mode was explicitly used. */
	missionId?: string;
	missionPath?: string;
	/** Non-fatal automatic mission persistence failure. */
	missionWarning?: string;
	mission?: MissionRecord;
	workflow?: {
		value?: unknown;
		trace: Array<{
			operation: "run" | "status";
			key: string;
			state: "started" | "completed" | "failed" | "reused";
			runId?: string;
			phase?: string;
			label?: string;
			durationMs?: number;
			error?: string;
		}>;
		emits: unknown[];
		console: Array<{ level: "log" | "info" | "warn" | "error"; text: string }>;
	};
	chatProgress?: {
		mode: "off" | "live-card";
		repoRelation: "same" | "other";
		repoLabel?: string;
	};
	missions?: {
		records?: MissionRecord[];
		globalEntries?: GlobalMissionIndexRecord[];
		warnings: string[];
	};
	/** Project-scoped recurring schedule records and run history for management actions. */
	schedules?: {
		records?: unknown[];
		runs?: unknown[];
	};
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	transcriptPath: string;
	metadataPath: string;
}

export type ArtifactDirPreference = "project" | "session" | "temp";

export interface ArtifactConfig {
	enabled: boolean;
	dir?: ArtifactDirPreference;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeTranscript?: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

// ============================================================================
// Async Execution
// ============================================================================

export interface AsyncParallelGroupStatus {
	start: number;
	count: number;
	stepIndex: number;
}

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
export type NestedOwnerState = "live" | "gone" | "unknown";

export interface NestedRunAddress {
	id: string;
	parentRunId: string;
	parentStepIndex?: number;
	parentAgent?: string;
	depth: number;
	path: Array<{ runId: string; stepIndex?: number; agent?: string }>;
}

export interface NestedStepSummary {
	agent: string;
	status: "pending" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped" | "rejected";
	model?: string;
	thinking?: string;
	sessionFile?: string;
	transcriptPath?: string;
	transcriptError?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	watchdog?: ChildWatchdogProgress;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	processTerminal?: ProcessTerminalV1;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	children?: NestedRunSummary[];
}

export interface NestedRunSummary extends NestedRunAddress {
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	intercomTarget?: string;
	ownerIntercomTarget?: string;
	leafIntercomTarget?: string;
	ownerState?: NestedOwnerState;
	controlInbox?: string;
	capabilityToken?: string;
	mode?: SubagentRunMode;
	processTerminal?: ProcessTerminalV1;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	state: NestedRunState;
	agent?: string;
	agents?: string[];
	model?: string;
	thinking?: string;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: NestedStepSummary[];
	children?: NestedRunSummary[];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	startedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	error?: string;
}

export interface NestedRouteInfo {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export interface AsyncStartedEvent {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	id?: string;
	asyncDir?: string;
	/** Parent-resolved launch directory, used as a trusted artifact root while this session is live. */
	cwd?: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	/** Truncated first child task retained for backwards compatibility. */
	task?: string;
	/** Workflow-level caller task, falling back to the first child task. */
	goal?: string;
	chain?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	checkpoint?: ChainCheckpointState;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	usageBudget?: UsageBudgetState;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: TurnBudgetState;
	nestedRoute?: NestedRouteInfo;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	parentWorkflowRunId?: string;
	workflowKey?: string;
}

export type AgentRunnerConfig =
	| { type: "pi" }
	| {
		type: "external-cli";
		command: string;
		args?: string[];
		promptDelivery?: "stdin";
	};

export interface ExternalCliRunnerStatus {
	type: "external-cli";
	command: string;
	args: string[];
	promptDelivery: "stdin";
	capabilities: {
		stop: true;
		steer: false;
		resume: false;
		structuredOutput: false;
		toolEvents: false;
	};
}

export interface ExternalProcessStatus {
	pid?: number;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	exitCode?: number | null;
	processSignal?: string | null;
	stdoutPath: string;
	stderrPath: string;
}

export interface AsyncStatus {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	runId: string;
	/** Host tool-call id retained when it differs from the internal run id. */
	toolCallId?: string;
	sessionId?: string;
	mode: SubagentRunMode;
	context?: "fresh" | "fork" | "mixed";
	isNested?: boolean;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
	error?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steering?: SteeringStatus;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	usageBudget?: UsageBudgetState;
	pid?: number;
	cwd?: string;
	currentStep?: number;
	chainStepCount?: number;
	pendingAppends?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	checkpoint?: ChainCheckpointState;
	processTerminal?: ProcessTerminalV1;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	workflow?: Details["workflow"];
	parentWorkflowRunId?: string;
	workflowKey?: string;
	steps?: Array<{
		agent: string;
		runner?: ExternalCliRunnerStatus;
		externalProcess?: ExternalProcessStatus;
		/** Resolved launch context for this child step. */
		context?: "fresh" | "fork";
		/** Short caller-facing task/goal shown in fleet surfaces when available. */
		description?: string;
		phase?: string;
		label?: string;
		workflowKey?: string;
		parentWorkflowRunId?: string;
		outputName?: string;
		structured?: boolean;
		checkpoint?: ChainCheckpointState;
		status: "pending" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped" | "rejected";
		children?: NestedRunSummary[];
		sessionFile?: string;
		transcriptPath?: string;
		transcriptError?: string;
		activityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolArgs?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		recentTools?: Array<{ tool: string; args: string; endMs: number }>;
		recentOutput?: string[];
		turnCount?: number;
		toolCount?: number;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		timedOut?: boolean;
		stopped?: boolean;
		turnBudget?: TurnBudgetState;
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
		toolBudget?: ToolBudgetState;
		toolBudgetBlocked?: boolean;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		thinking?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		totalCost?: CostSummary;
		steering?: SteeringStatus;
		error?: string;
		structuredOutput?: unknown;
		structuredOutputPath?: string;
		structuredOutputSchemaPath?: string;
		acceptance?: AcceptanceLedger;
		agentContract?: AgentContract;
		launchContractDigest?: string;
		launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
		runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
		execution?: ExecutionProjection;
		review?: ReviewProjection;
		effects?: EffectsProjection;
		watchdog?: ChildWatchdogProgress;
		processTerminal?: ProcessTerminalV1;
		capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
		capabilityAudit?: SubagentCapabilityAudit;
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	sessionFile?: string;
	outputs?: ChainOutputMap;
	parallelHandoff?: ParallelHandoffReference;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
	index?: number;
	description?: string;
};

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	/** Parent-resolved launch directory retained for trusted live artifact lookup. */
	cwd?: string;
	status: "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
	/** Short caller-facing task/goal shown in fleet surfaces when available. */
	description?: string;
	pid?: number;
	sessionId?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steering?: SteeringStatus;
	mode?: SubagentRunMode;
	/** Run-level context summary derived from step contexts. */
	context?: "fresh" | "fork" | "mixed";
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: AsyncJobStep[];
	checkpoint?: ChainCheckpointState;
	stepsTotal?: number;
	runningSteps?: number;
	completedSteps?: number;
	hasParallelGroups?: boolean;
	activeParallelGroup?: boolean;
	startedAt?: number;
	updatedAt?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	usageBudget?: UsageBudgetState;
	sessionFile?: string;
	controlEventCursor?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
	parentWorkflowRunId?: string;
	workflowKey?: string;
	workflow?: Details["workflow"];
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	context?: "fresh" | "fork";
	sessionFile?: string;
	model?: string;
	thinking?: string;
	status: SubagentResultStatus;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	toolCount?: number;
	exitCode?: number;
	error?: string;
	finalOutput?: string;
	outputState?: SubagentOutputState;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputSaveError?: string;
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	detachedReason?: string;
	acceptance?: AcceptanceLedger;
	agentContract?: AgentContract;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	execution?: ExecutionProjection;
	review?: ReviewProjection;
	effects?: EffectsProjection;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	updatedAt?: number;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	/** Originating parent session. Detached exits can outlive the active session. */
	sessionId?: string;
	updatedAt: number;
	checkpoint?: ChainCheckpointState;
	children: ForegroundResumeChild[];
}

export interface ForegroundChildControl {
	index: number;
	agent: string;
	description?: string;
	startedAt: number;
	updatedAt: number;
	currentActivityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	model?: string;
	thinking?: string;
	toolCount?: number;
	interrupt?: () => boolean;
	detach?: () => boolean;
}

export interface ForegroundRunControl {
	runId: string;
	/** Originating parent session; required for public fleet projection. */
	sessionId?: string;
	mode: SubagentRunMode;
	startedAt: number;
	updatedAt: number;
	/** Effective working directory used to resolve live transcript artifacts. */
	cwd?: string;
	currentAgent?: string;
	currentIndex?: number;
	/** Short caller-facing task/goal shown in fleet surfaces when available. */
	description?: string;
	currentActivityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	model?: string;
	thinking?: string;
	toolCount?: number;
	/** Independently tracked children for foreground parallel work and fleet inspection. */
	activeChildren?: Map<number, ForegroundChildControl>;
	/** Scheduling owners that may still launch another child. Removal is safe only at zero. */
	schedulingOwners?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
	interrupt?: () => boolean;
	detach?: () => boolean;
}

export interface WaitSubscriptionRecord {
	version: 1;
	token: string;
	sessionId: string;
	targetKind: "async" | "foreground";
	runId: string;
	requestedId: string;
	createdAt: number;
	expiresAt: number;
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	/** Runtime-owned artifact resolution inputs used by Fleet transcript targeting. */
	artifactDirPreference?: ArtifactDirPreference;
	/** Runtime authority snapshot used by optional inspector controls. */
	authorityPolicy?: AuthorityPolicyConfig;
	/** Runtime mission-store snapshot used by optional inspector context. */
	missionStoreConfig?: MissionStoreConfig;
	parentSessionFile?: string | null;
	/** Last valid parent session model observed for this session; used when continuation contexts omit ctx.model. */
	lastParentModel?: { provider: string; id: string };
	subagentInProgress?: boolean;
	subagentSpawns?: {
		sessionId: string | null;
		count: number;
		configuredLimit?: number | null;
		granted?: number;
		grantHistory?: SpawnBudgetGrant[];
	};
	asyncJobs: Map<string, AsyncJobState>;
	/** Current-session active and recent async runs for the native fleet inspector. */
	fleetJobs?: Map<string, AsyncJobState>;
	/** Suppress dynamic status widgets while the fleet overlay owns the viewport. */
	fleetInspectorOpen?: boolean;
	foregroundRuns?: Map<string, ForegroundResumeRun>;
	foregroundControls: Map<string, ForegroundRunControl>;
	lastForegroundControlId: string | null;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	/** Terminal result payloads observed by the result watcher, keyed by run id and pruned by the completion TTL. */
	completedResults?: Map<string, { seenAt: number; completion: WaitCompletion }>;
	watcher: FSWatcher | null;
	watcherRestartTimer: ReturnType<typeof setTimeout> | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
	/** Current-session durable non-blocking wait registrations. */
	waitSubscriptions?: Map<string, WaitSubscriptionRecord>;
	/** Live in-process workflow controllers. Durable status remains on disk after settlement. */
	workflowControllers?: Map<string, AbortController>;
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem = 
	| { type: "text"; text: string } 
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_STEERING_NOTICE_EVENT = "subagent:steering-notice";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	/** Opt-in global permission rules; missing tools remain allowed. */
	permissions?: import("../runs/shared/permissions.ts").PermissionConfig;
	/** Session id of the direct parent session for permission-system ask forwarding. */
	parentSessionId?: string;
	/** Resolved launch context for this child. */
	context?: "fresh" | "fork";
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	usageBudget?: UsageBudgetConfig;
	/** Enforce maxTurns + graceTurns as a hard model-turn boundary. */
	enforceHardTurnLimit?: boolean;
	toolBudget?: ResolvedToolBudget;
	allowZeroToolBudget?: boolean;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onUpdate?: (r: import("@earendil-works/pi-agent-core").AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	/** Exposes a non-terminating detach callback while the child is active. */
	onDetachReady?: (detach: (reason?: string) => boolean) => void;
	/** Internal foreground receipt proposal; returns true only when the outer waiter accepted it. */
	onDetachReceipt?: (result: SingleResult) => boolean;
	/** Authoritative terminal result, emitted only after the full detached run finalizes. */
	onDetachedExit?: (result: SingleResult) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	maxSubagentDepth?: number;
	/** Effective parent wait-tool setting propagated to the child runtime. */
	waitToolEnabled?: boolean;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	nestedRoute?: NestedRouteInfo;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Override the agent's default thinking level for this run */
	thinkingOverride?: AgentConfig["thinking"];
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Optional subagent model-scope enforcement for fallback candidates */
	modelScope?: ModelScopeConfig;
	/** Skills to make available (overrides agent default if provided) */
	skills?: string[];
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	agentContract?: AgentContract;
	acceptance?: AcceptanceInput;
	acceptanceContext?: {
		mode?: SubagentRunMode;
		async?: boolean;
		dynamic?: boolean;
		dynamicGroup?: boolean;
	};
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
	/** Deliver grouped completion messages through an external acknowledged intercom listener. */
	resultDelivery?: boolean;
}

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

interface ExtensionChainConfig {
	dynamicFanout?: {
		maxItems?: number;
	};
}

export interface ProactiveSkillSubagentsConfig {
	enabled?: boolean;
	minReferences?: number;
	maxRecommendations?: number;
	preferredAgent?: string;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";
export type InlineToolDisplay = "rich" | "summary";

export interface ScheduledRunsConfig {
	enabled?: boolean;
	maxPending?: number;
	/** Absolute or `~/` root for per-project durable schedules. */
	storeRoot?: string;
}

export type FleetViewPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	/** Show the Claude Code-style navigable fleet. Defaults to true. */
	fleetView?: boolean;
	/** Place the persistent FleetView above or below the editor. Defaults to belowEditor. */
	fleetViewPlacement?: FleetViewPlacement;
	/** Show the under-editor async runs widget. Defaults to true, including when FleetView is enabled. */
	asyncWidget?: boolean;
	/** Tool description variant registered for the parent-facing subagent tool. Defaults to full. */
	toolDescriptionMode?: ToolDescriptionMode;
	/** Inline chat rendering for the subagent tool. Defaults to rich. */
	inlineToolDisplay?: InlineToolDisplay;
	forceTopLevelAsync?: boolean;
	waitTool?: WaitToolConfig;
	defaultSessionDir?: string;
	singleRunOutputBaseDir?: string;
	maxSubagentDepth?: number;
	/** Optional cumulative session cap. Unset or 0 means unlimited. */
	maxSubagentSpawnsPerSession?: number;
	/** Global cap on simultaneously-running subagent tasks within a single run. Defaults to 20. */
	globalConcurrencyLimit?: number;
	control?: ControlConfig;
	completionBatch?: CompletionBatchConfig;
	turnBudget?: TurnBudgetConfig;
	toolBudget?: ToolBudgetConfig;
	/** Opt-in native tool permissions. Bash remains outside this policy. */
	permissions?: import("../runs/shared/permissions.ts").PermissionConfig;
	usageBudget?: UsageBudgetConfig;
	parallel?: TopLevelParallelConfig;
	chain?: ExtensionChainConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	/** Where to store subagent artifact files. Defaults to "project" (cwd/.pi-subagents). Set to "session" for pi session dir, or "temp" for OS temp. */
	artifactDir?: ArtifactDirPreference;
	intercomBridge?: IntercomBridgeConfig;
	proactiveSkillSubagents?: ProactiveSkillSubagentsConfig | false;
	scheduledRuns?: ScheduledRunsConfig;
	/** Durable mission behavior. Missions are automatic by default; set enabled:false to disable auto-create. Explicit mission actions/fields still work. */
	missions?: MissionStoreConfig;
	/** Small fixed authority policy for the supported operational actions. */
	authorityPolicy?: AuthorityPolicyConfig;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024,
	lines: 5000,
};

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	dir: "project",
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeTranscript: true,
	includeMetadata: true,
	cleanupDays: 7,
};

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid = options && Object.hasOwn(options, "getuid")
		? options.getuid
		: process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo")
		? options.userInfo
		: os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir")
		? options.homedir
		: os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;
export const TEMP_ROOT_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const CHAIN_RUNS_DIR = path.join(TEMP_ROOT_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");

export const DIRS = {
	results: RESULTS_DIR,
	async: ASYNC_DIR,
	chain: CHAIN_RUNS_DIR,
	artifacts: TEMP_ARTIFACTS_DIR,
};
export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_ACTIONS = ["list", "get", "models", "children.list", "guide", "create", "update", "delete", "eject", "disable", "enable", "reset", "mission.create", "mission.list", "mission.show", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close", "worktree.discard", "refine", "refine.show", "refine.rollback", "inspector.open", "inspector.status", "inspector.close", "project.open", "project.status", "project.close", "status", "grant-spawn-budget", "interrupt", "resume", "steer", "stop", "append-step", "approve-checkpoint", "reject-checkpoint", "doctor", "watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model", "schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"] as const;

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to execute the task below and return a focused result for that task using your tools.";

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
	return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
	override: unknown,
	configValue: unknown,
): number {
	return normalizeTopLevelParallelValue(override)
		?? normalizeTopLevelParallelValue(configValue)
		?? MAX_CONCURRENCY;
}

export function getAsyncConfigPath(suffix: string): string {
	return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

function normalizeNonNegativeInteger(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	return normalizeNonNegativeInteger(value);
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
	};
}

export function normalizeMaxSubagentSpawnsPerSession(value: unknown): number | undefined {
	return normalizeNonNegativeInteger(value);
}

export function resolveMaxSubagentSpawnsPerSession(configMaxSpawns?: number): number | undefined {
	const envMaxSpawns = normalizeMaxSubagentSpawnsPerSession(process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION);
	if (envMaxSpawns !== undefined) return envMaxSpawns === 0 ? undefined : envMaxSpawns;
	const configuredMaxSpawns = normalizeMaxSubagentSpawnsPerSession(configMaxSpawns);
	return configuredMaxSpawns === 0 ? undefined : configuredMaxSpawns;
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (lines.length > config.lines) {
		truncatedLines = lines.slice(0, config.lines);
	}

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
