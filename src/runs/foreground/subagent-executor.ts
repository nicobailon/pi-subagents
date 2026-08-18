import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findBlockingAgentDiagnostic, resolveAgentName, type AgentConfig, type AgentDiscoveryDiagnostic, type AgentScope } from "../../agents/agents.ts";
import { getArtifactsDir, getChainRunsDir, getProjectArtifactPackagingWarning, getProjectSubagentsDir } from "../../shared/artifacts.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { createCapacityResilientJsonWriter } from "../../shared/capacity-resilient-json.ts";
import { isStorageCapacityError } from "../../shared/file-system-retry.ts";
import { resolveEffectiveThinking, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	beginForegroundChild,
	finishForegroundChild,
	foregroundSchedulingSettled,
	retainForegroundSchedulingOwner,
	settleForegroundSchedulingOwner,
	updateForegroundChild,
} from "./foreground-control.ts";
import { getLivePromptAudit, rewritePromptWithGuidance, updateLiveEffectivePrompt } from "./prompt-audit.ts";
import { persistForegroundRunHistory, MAX_REMEMBERED_FOREGROUND_RUNS } from "./foreground-history.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { handleRefinementAction } from "../../agents/agent-refinements.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { readSubagentGuide } from "../../extension/subagent-guide.ts";
import { normalizePublicSubagentExecution } from "../../extension/public-execution.ts";
import { runSync } from "./execution.ts";
import { handleWatchdogToolAction, WATCHDOG_TOOL_ACTIONS } from "../../watchdog/tool-actions.ts";
import type { MainWatchdogRuntime } from "../../watchdog/runtime.ts";
import { buildModelCandidates, normalizeParentModel, resolveEffectiveSubagentModel, resolveModelCandidate, type ParentModel } from "../shared/model-fallback.ts";
import { formatRetainedChildren, listRetainedChildren } from "../background/retained-children.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	buildChainInstructions,
	writeInitialProgressFile,
	getStepAgents,
	isParallelStep,
	isDynamicParallelStep,
	resolveChainPath,
	resolveExistingReadPaths,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type ChainStep,
	type DynamicParallelStep,
	type ParallelStep,
	type ParallelTaskItem,
	type ResolvedStepBehavior,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { buildAsyncRunnerSteps, DEFAULT_ASYNC_TIMEOUT_MS, executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable, workflowAwaitedAsyncResultPath } from "../background/async-execution.ts";
import { updateActiveRunIndex } from "../background/active-run-index.ts";
import { steeringReceipt } from "../background/steering.ts";
import { acquireActiveAsyncCapacity, ActiveAsyncCapacityError, getActiveAsyncCapacitySnapshot, resolveMaxActiveAsyncRunsPerSession, transferActiveAsyncCapacity, type ActiveAsyncCapacityHandle } from "../background/active-async-capacity.ts";
import { isScheduledRunAction, type ScheduledRunAction } from "../background/scheduled-runs.ts";
import { enqueueChainAppendRequest, readPendingChainAppendRequests, runnerStepOutputNames } from "../background/chain-append.ts";
import { ChainOutputValidationError, validateChainOutputBindingsWithContext } from "../shared/chain-outputs.ts";
import { normalizeGateAcceptance, validateExecutionAcceptance } from "../shared/acceptance.ts";
import { canPreferFork, createForkContextResolver, forkedChildRequiresThinkingOff, resolveSubagentLaunchContext } from "../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { currentCompletionOwnerId } from "../../shared/completion-owner.ts";
import { applyIntercomBridgeToAgent, INTERCOM_BRIDGE_MARKER, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "../shared/subagent-control.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";
import { formatSpawnBudget, getSpawnBudgetSnapshot, grantSpawnBudget, preflightSpawnBudget, preflightSpawnBudgetGrant, reserveSpawnBudget } from "../shared/spawn-budget.ts";
import { claimRunFanoutBatch, claimRunFanoutBatchWithCommit, createRunFanoutBudget, decodeRunFanoutBudgetDescriptor, formatRunFanoutBudget, getRunFanoutBudgetSnapshot, readRunFanoutBudgetDescriptor, RunFanoutLimitError, RUN_FANOUT_BUDGET_ENV, writeRunFanoutBudgetDescriptor } from "../shared/run-fanout-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { usageBudgetExceededMessage, usageBudgetState, validateUsageBudgetConfig } from "../shared/usage-budget.ts";
import { intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling, type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { isAgentContractV1 } from "../shared/agent-contract.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { cleanupStructuredOutputRuntime, createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd, sumResultsCost, sumResultsUsage } from "../../shared/utils.ts";
import { createTaskMutationArbiter } from "../shared/llm-intent-arbiter.ts";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../shared/parallel-utils.ts";
import { discardPreservedWorktrees, formatParallelHandoffError, formatParallelHandoffReference, parallelHandoffPath, writeParallelHandoffGroup, writePendingParallelHandoff } from "../shared/parallel-handoff.ts";
import { summarizeContextModes, type ContextMode, type ContextSummary } from "../shared/context-mode.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../intercom/result-intercom.ts";
import { applySteeringRecoveryAgentConfig, buildRevivedAsyncTask, resolveAsyncResumeTarget, resolveAsyncRunLocation } from "../background/async-resume.ts";
import { deliverInterruptRequest, readRevivalBriefs, requestAsyncSteer, type SteerDeliveryMode } from "../background/control-channel.ts";
import { updateSteeringTarget, waitForSteeringAction } from "../background/steering.ts";
import { canQueueRetainedAsyncFollowUp, steerAsyncRun } from "./async-steering-action.ts";
import {
	removeWorkflowForegroundSteeringRoute,
	resolveWorkflowForegroundSteeringTarget,
	steerWorkflowForegroundTarget,
	workflowForegroundSteeringDir,
	workflowForegroundSteeringLaunchOptions,
} from "./workflow-foreground-steering.ts";
import { stopAsyncRun } from "./async-stop-action.ts";
import { dismissRecoveredWorkflow } from "./async-dismiss-action.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { resolveAsyncRootResultPath, waitForImportedAsyncRoot } from "../background/chain-root-attachment.ts";
import { resultFilePath, writeAsyncResultFile } from "../background/result-files.ts";
import { attachRootChildrenToSteps, createNestedRoute, findNestedControlResult, resolveInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, snapshotNestedEventFiles, updateForegroundNestedProjection, writeNestedControlRequest, writeNestedEvent, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import { handleMissionAction, MISSION_ACTIONS } from "../../missions/actions.ts";
import { attachMissionToLaunchResult, prepareMissionLaunch, writeMissionAsyncBinding, type MissionLaunchBinding } from "../../missions/lifecycle.ts";
import { MissionNotFoundError, updateMission } from "../../missions/store.ts";
import type { MissionWorkflowChildUpdate } from "../../missions/types.ts";
import { createMissionWorkflowState } from "../../missions/workflow-state.ts";
import { resolveAuthorityDecision } from "../../policy/authority.ts";
import { handleHerdrInspectorAction, HERDR_INSPECTOR_ACTIONS } from "../../inspectors/herdr/actions.ts";
import { handleHerdrProjectPaneAction, HERDR_PROJECT_PANE_ACTIONS } from "../../inspectors/herdr/project-panes.ts";
import { previewSimpleWorkflowRun, runWorkflowScript, WorkflowScriptError, type WorkflowScriptChildResult, type WorkflowSteerOptions, type WorkflowSteerResult } from "../../workflows/scripted-workflow.ts";
import { resolveWorkflowChatProgress, type WorkflowChatProgressProjection } from "../../workflows/chat-progress.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type AgentProgress,
	type AsyncJobState,
	type AsyncStatus,
	type AcceptanceInput,
	type AgentContract,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlConfig,
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type ForegroundRunControl,
	type IntercomBridgeConfig,
	type IntercomEventBus,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type RunFanoutBudgetDescriptor,
	type SingleResult,
	type ToolBudgetConfig,
	type TurnBudgetConfig,
	type UsageBudgetConfig,
	type SubagentRunMode,
	type SubagentState,
	DIRS,
	DEFAULT_ARTIFACT_CONFIG,
	DEFAULT_FORK_PREAMBLE,
	SUBAGENT_ACTIONS,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	checkSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	resolveMaxSubagentSpawnsPerRun,
	wrapForkTask,
} from "../../shared/types.ts";

const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete", "eject", "disable", "enable", "reset", "grant-spawn-budget", "watchdog.configure", "mission.create", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close", "inspector.open", "inspector.close", "project.open", "project.close", "worktree.discard", "refine", "refine.rollback", "dismiss", "schedule.create", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"]);
const DESTRUCTIVE_MANAGEMENT_ACTIONS = new Set(["delete", "eject", "disable", "reset", "mission.close", "worktree.discard", "refine.rollback", "inspector.close", "project.close", "stop", "interrupt", "schedule.delete"]);

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		let diagonal = previous[0]!;
		previous[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const above = previous[rightIndex]!;
			previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
				? diagonal
				: Math.min(diagonal, above, previous[rightIndex - 1]!) + 1;
			diagonal = above;
		}
	}
	return previous[right.length]!;
}

function hasSingleAdjacentTransposition(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	const mismatch = [...left].findIndex((character, index) => character !== right[index]);
	return mismatch >= 0
		&& left[mismatch] === right[mismatch + 1]
		&& left[mismatch + 1] === right[mismatch]
		&& left.slice(mismatch + 2) === right.slice(mismatch + 2);
}

export function unknownSubagentActionMessage(action: string): string {
	const requested = action.toLowerCase();
	const suggestion = SUBAGENT_ACTIONS.find((candidate) => {
		const distance = editDistance(requested, candidate);
		const closeMatch = distance <= Math.max(1, Math.floor(candidate.length / 4)) || hasSingleAdjacentTransposition(requested, candidate);
		if (DESTRUCTIVE_MANAGEMENT_ACTIONS.has(candidate)) return distance === 1 && requested.length >= candidate.length - 1;
		return closeMatch;
	});
	const nextStep = 'Use subagent({ action: "status" }) to inspect runs or subagent({ action: "list" }) to inspect agents.';
	const validActions = `Valid: ${SUBAGENT_ACTIONS.join(", ")}.`;
	return suggestion
		? `Unknown action: ${action}. Did you mean ${suggestion}? ${nextStep} ${validActions}`
		: `Unknown action: ${action}. ${nextStep} ${validActions}`;
}

type UndefinedOmitted<T extends object> = {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

// These helpers mutate their argument, so keep calls scoped to fresh object literals or shallow copies.
function omitUndefinedProperties<T extends object>(value: T): UndefinedOmitted<T> {
	for (const key of Object.keys(value) as Array<keyof T>) {
		if (value[key] === undefined) delete value[key];
	}
	return value as UndefinedOmitted<T>;
}

type WithUndefinedOptionals<T extends object> = {
	[K in keyof T]: {} extends Pick<T, K> ? T[K] | undefined : T[K];
};

type RequiredKeysAllowingUndefined<T extends object> = {
	[K in keyof T]-?: {} extends Pick<T, K> ? never : undefined extends T[K] ? K : never;
}[keyof T];

function compactOptional<T extends object>(
	value: WithUndefinedOptionals<T> & (RequiredKeysAllowingUndefined<T> extends never ? unknown : never),
): T {
	for (const key of Object.keys(value) as Array<keyof T>) {
		if (value[key] === undefined) delete value[key];
	}
	return value as T;
}

interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	outputSchema?: JsonSchemaObject;
	acceptance?: AcceptanceInput;
	agentContract?: AgentContract;
	toolBudget?: ToolBudgetConfig;
}

export interface SubagentParamsLike {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	handoffPath?: string;
	index?: number;
	view?: "fleet" | "transcript";
	lines?: number;
	topic?: string;
	chainName?: string;
	config?: unknown;
	name?: string;
	type?: string;
	agent?: string;
	task?: string;
	/** Retained async child run id. Valid only on workflow runs.run items. */
	resume?: string;
	message?: string;
	steeringRecovery?: boolean;
	mode?: SteerDeliveryMode;
	workflowScript?: string;
	chatProgress?: "auto" | "off" | "live-card";
	isolation?: "none" | "worktree";
	step?: ChainStep;
	/** Internal workflow ownership metadata; not part of the public schema. */
	workflowParentRunId?: string;
	workflowKey?: string;
	workflowChildAsyncId?: string;
	workflowParentDeadlineAt?: number;
	suppressRoutineResultIntercom?: boolean;
	/** Internal inherited cumulative run-tree budget. */
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	/** Internal workflow host admission proof. */
	runFanoutAdmitted?: boolean;
	/** Internal durable-run compatibility fields. Public callers must use workflowScript. */
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	/** Per-run intercom bridge config. It replaces the global config for this launch only. */
	intercomBridge?: IntercomBridgeConfig;
	async?: boolean;
	foregroundOnly?: boolean;
	timeoutMs?: number;
	maxRuntimeMs?: number;
	/** Optional hard per-tool-call timeout (ms). Known-fast tools also have a default. */
	toolTimeoutMs?: number;
	turnBudget?: TurnBudgetConfig;
	/** Internal-only strict turn-boundary enforcement for versioned foreground delegation. */
	enforceHardTurnLimit?: boolean;
	toolBudget?: ToolBudgetConfig;
	usageBudget?: UsageBudgetConfig;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	thinking?: string | false;
	scope?: string;
	target?: string;
	focus?: boolean;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	/** Internal-only; not part of the public tool schema. Wired for single-run reads (chain steps use their own field). */
	reads?: string[] | false;
	outputMode?: "inline" | "file-only";
	outputSchema?: JsonSchemaObject;
	agentScope?: unknown;
	chainDir?: string;
	acceptance?: AcceptanceInput;
	gate?: string;
	agentContract?: AgentContract;
	at?: string;
	every?: string;
	on?: string | number;
	timezone?: string;
	overlap?: "skip";
	catchUp?: "none" | "latest";
	additional?: number;
	missionId?: string;
	mission?: unknown;
	missionUpdate?: unknown;
	missionStatus?: string;
	missionScope?: string;
	runMode?: string;
	runStatus?: string;
	summary?: string;
}

function rememberParentModel(state: { currentSessionId?: string | null; lastParentModel?: ParentModel }, sessionId: string | null, model: unknown): ParentModel | undefined {
	if (state.currentSessionId !== sessionId) delete state.lastParentModel;
	state.currentSessionId = sessionId;
	const parentModel = normalizeParentModel(model);
	if (!sessionId) return parentModel;
	if (parentModel) state.lastParentModel = parentModel;
	return parentModel ?? state.lastParentModel;
}

interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	waitToolEnabled?: boolean;
	handleScheduledRunAction?: (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
	watchdog?: MainWatchdogRuntime;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[]; agentDiagnostics?: AgentDiscoveryDiagnostic[]; modelScope?: ModelScopeConfig };
	allowMutatingManagementActions?: boolean;
	activateSupervisorTransport?: () => void;
	refreshResultDelivery?: () => void;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

type ForkSessionFileForTask = (agentName: string, idx?: number, modelOverride?: string) => string | undefined;
type ForkThinkingOverrideForTask = (agentName: string, idx?: number, modelOverride?: string) => AgentConfig["thinking"] | undefined;

interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	/** Discovered agent definitions before per-run bridge injection. */
	recoveryAgents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: ForkSessionFileForTask;
	thinkingOverrideForTask: ForkThinkingOverrideForTask;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	asyncRunId: string;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
	timeoutMs?: number;
	deadlineAt?: number;
	/** Raw global config.toolTimeoutMs, for per-step resolution in async runners. */
	configToolTimeoutMs?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	usageBudget?: UsageBudgetConfig;
	allowZeroToolBudget?: boolean;
	configToolBudget?: ResolvedToolBudget;
	contextPolicy: AgentDefaultContextPolicy;
	modelScope?: ModelScopeConfig;
	parentModel?: ParentModel;
	parentSessionId: string | null;
	parentPiSessionId?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	runFanoutBudget: RunFanoutBudgetDescriptor;
	topLevelAsyncCapacityEligible: boolean;
	activeAsyncCapacity?: ActiveAsyncCapacityHandle;
}

function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

function removeForegroundControlIfIdle(state: SubagentState, runId: string): boolean {
	const control = state.foregroundControls.get(runId);
	if (control && (!foregroundSchedulingSettled(control) || (control.activeChildren?.size ?? 0) > 0)) return false;
	if (control) removeWorkflowForegroundSteeringRoute(control);
	state.foregroundControls.delete(runId);
	if (state.lastForegroundControlId === runId) state.lastForegroundControlId = null;
	return true;
}

function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

function promptAuditRedoParams(value: unknown, rewrittenTask: string): SubagentParamsLike {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Prompt redo is missing a safe live launch contract.");
	const params = { ...(value as SubagentParamsLike), task: rewrittenTask, async: false };
	delete params.workflowParentRunId;
	delete params.workflowKey;
	delete params.workflowChildAsyncId;
	delete params.workflowParentDeadlineAt;
	delete params.suppressRoutineResultIntercom;
	if (params.worktree === true && Array.isArray(params.tasks)) delete params.cwd;
	return params;
}

function formatForegroundActivity(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): string | undefined {
	const facts: string[] = [];
	if (control.currentTool && control.currentToolStartedAt) facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (control.currentActivityState === "active_long_running") return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	if (control.currentActivityState === "active_long_running") return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}

function nestedResolutionScopeForExecutor(deps: ExecutorDeps): NestedRunResolutionScope | undefined {
	if (deps.allowMutatingManagementActions !== false) return undefined;
	const route = resolveInheritedNestedRouteFromEnv();
	const address = route ? resolveNestedParentAddressFromEnv() : undefined;
	return {
		routes: route ? [route] : [],
		...(address ? { descendantOf: { parentRunId: address.parentRunId, ...(address.parentStepIndex !== undefined ? { parentStepIndex: address.parentStepIndex } : {}) } } : {}),
	};
}

function trustedSessionRootsForStatus(ctx: ExtensionContext, deps: ExecutorDeps): string[] {
	const roots = deps.config.defaultSessionDir ? [path.resolve(deps.expandTilde(deps.config.defaultSessionDir))] : [];
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	if (parentSessionFile) roots.push(deps.getSubagentSessionRoot(parentSessionFile));
	return [...new Set(roots)];
}

function spawnBudgetErrorResult(message: string, mode: "single" | "parallel" | "chain"): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

function withSpawnBudgetStatus(
	result: AgentToolResult<Details>,
	state: SubagentState,
	config: ExtensionConfig,
	sessionId: string | null,
): AgentToolResult<Details> {
	const spawnBudget = getSpawnBudgetSnapshot(state, config, sessionId);
	const activeAsyncCapacity = sessionId
		? getActiveAsyncCapacitySnapshot(sessionId, resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession), {
			liveWorkflowRunIds: new Set(state.workflowControllers?.keys() ?? []),
		})
		: { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession) ?? 0 };
	state.activeAsyncCapacity = activeAsyncCapacity;
	return {
		...result,
		content: result.content.map((item, index) => index === 0 && item.type === "text"
			? { ...item, text: `${formatSpawnBudget(spawnBudget)}\nActive async capacity: ${activeAsyncCapacity.used}/${activeAsyncCapacity.limit || "unlimited"} used\n${item.text}` }
			: item),
		details: { ...result.details, spawnBudget, activeAsyncCapacity },
	};
}

function hasActiveSubagentChildren(state: SubagentState): boolean {
	if (state.subagentInProgress || state.foregroundControls.size > 0) return true;
	const isActive = (status: string) => status === "queued" || status === "running";
	return [...state.asyncJobs.values(), ...(state.fleetJobs?.values() ?? [])].some((job) => isActive(job.status));
}

function countRequestedSubagentSpawns(params: SubagentParamsLike, config: ExtensionConfig): number {
	if (params.tasks) return params.tasks.length;
	if (params.chain) {
		return params.chain.reduce((total, step) => {
			if (isDynamicParallelStep(step)) return total + (step.expand.maxItems ?? config.chain?.dynamicFanout?.maxItems ?? 0);
			return total + getStepAgents(step).length;
		}, 0);
	}
	return params.agent ? 1 : 0;
}

function staticRunFanoutPaths(params: SubagentParamsLike): string[] {
	if (params.tasks) return params.tasks.map((_, index) => `tasks[${index}]`);
	if (params.chain) return params.chain.flatMap((step, stepIndex) => {
		if (isDynamicParallelStep(step)) return [];
		if (isParallelStep(step)) return step.parallel.map((_, itemIndex) => `chain[${stepIndex}].parallel[${itemIndex}]`);
		return [`chain[${stepIndex}]`];
	});
	return params.agent ? ["single"] : [];
}

function runFanoutErrorResult(error: RunFanoutLimitError, mode: "single" | "parallel" | "chain"): AgentToolResult<Details> {
	return { content: [{ type: "text", text: error.message }], isError: true, details: { mode, results: [], runFanoutBudget: error.snapshot, runFanoutRejection: error.rejection } };
}

function withRunFanoutBudget(result: AgentToolResult<Details>, descriptor: RunFanoutBudgetDescriptor, options: { annotateContent?: boolean } = {}): AgentToolResult<Details> {
	const runFanoutBudget = getRunFanoutBudgetSnapshot(descriptor);
	return {
		...result,
		content: options.annotateContent === false
			? result.content
			: result.content.map((item, index) => index === 0 && item.type === "text" ? { ...item, text: `${formatRunFanoutBudget(runFanoutBudget)}\n${item.text}` } : item),
		details: { ...result.details, runFanoutBudget },
	};
}

function foregroundStatusResult(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): AgentToolResult<Details> {
	let nestedWarning: string | undefined;
	try {
		updateForegroundNestedProjection(control);
	} catch (error) {
		nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
	if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

function trimRememberedForegroundRuns(state: SubagentState): void {
	if (!state.foregroundRuns) return;
	while (state.foregroundRuns.size > MAX_REMEMBERED_FOREGROUND_RUNS) {
		const oldestTerminal = [...state.foregroundRuns.values()]
			.filter((run) => !run.children.some((child) => child.status === "detached"))
			.sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (!oldestTerminal) break;
		state.foregroundRuns.delete(oldestTerminal.runId);
	}
}

function persistRememberedForegroundRuns(state: SubagentState): void {
	try {
		persistForegroundRunHistory(state);
	} catch (error) {
		console.error("Failed to persist foreground run history:", error);
	}
}

function foregroundChildActivityFromProgress(progress: SingleResult["progress"] | undefined) {
	return {
		...(progress?.activityState ? { activityState: progress.activityState } : {}),
		...(progress?.lastActivityAt !== undefined ? { lastActivityAt: progress.lastActivityAt } : {}),
		...(progress?.currentTool ? { currentTool: progress.currentTool } : {}),
		...(progress?.currentToolStartedAt !== undefined ? { currentToolStartedAt: progress.currentToolStartedAt } : {}),
		...(progress?.currentPath ? { currentPath: progress.currentPath } : {}),
		...(progress?.turnCount !== undefined ? { turnCount: progress.turnCount } : {}),
		...(progress?.tokens !== undefined ? { tokens: progress.tokens } : {}),
		...(progress?.toolCount !== undefined ? { toolCount: progress.toolCount } : {}),
	};
}

function rememberForegroundRun(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; sessionId: string | null; results: SingleResult[] }): void {
	state.foregroundRuns ??= new Map();
	const previous = state.foregroundRuns.get(input.runId);
	const updatedAt = Date.now();
	state.foregroundRuns.set(input.runId, {
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		updatedAt,
		children: input.results.map((result, index) => {
			const child = {
				agent: result.agent,
				index,
				...(result.context ? { context: result.context } : {}),
				status: resolveSubagentResultStatus(omitUndefinedProperties({
					exitCode: result.exitCode,
					interrupted: result.interrupted,
					detached: result.detached,
					processSignal: result.processSignal,
					timedOut: result.timedOut,
					stopped: result.stopped,
					turnBudgetExceeded: result.turnBudgetExceeded,
				})),
				...foregroundChildActivityFromProgress(result.progress),
				updatedAt,
				...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
				...(result.error ? { error: result.error } : {}),
				...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
				...(result.outputState ? { outputState: result.outputState } : {}),
				...(result.outputMode ? { outputMode: result.outputMode } : {}),
				...(result.savedOutputPath ? { savedOutputPath: result.savedOutputPath } : {}),
				...(result.outputSaveError ? { outputSaveError: result.outputSaveError } : {}),
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(result.model ? { model: result.model } : {}),
				...(result.thinking ? { thinking: result.thinking } : {}),
				...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
				...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
				...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
				...(result.detachedReason ? { detachedReason: result.detachedReason } : {}),
				...(result.acceptance ? { acceptance: result.acceptance } : {}),
				...(result.launchContractDigest ? { launchContractDigest: result.launchContractDigest } : {}),
				...(result.launchResolvedExtensions ? { launchResolvedExtensions: result.launchResolvedExtensions } : {}),
				...(result.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: result.runtimeAcknowledgedExtensions } : {}),
				...(result.capabilityCeiling ? { capabilityCeiling: result.capabilityCeiling } : {}),
				...(result.capabilityAudit ? { capabilityAudit: result.capabilityAudit } : {}),
			};
			const recovered = previous?.children[index];
			return child.status === "detached" && recovered && recovered.status !== "detached" ? recovered : child;
		}),
	});
	trimRememberedForegroundRuns(state);
	persistRememberedForegroundRuns(state);
}

function applyControlEventToRememberedForegroundRun(state: SubagentState, event: ControlEvent): void {
	const run = state.foregroundRuns?.get(event.runId);
	if (!run) return;
	const index = event.index ?? (run.children.length === 1 ? run.children[0]?.index : undefined);
	if (index === undefined) return;
	const child = run.children[index];
	if (!child || child.status !== "detached") return;
	const updatedAt = event.ts;
	run.updatedAt = updatedAt;
	run.children[index] = {
		...child,
		activityState: event.to,
		updatedAt,
		...(event.elapsedMs !== undefined ? { lastActivityAt: event.ts - event.elapsedMs } : {}),
		...(event.currentTool ? { currentTool: event.currentTool } : {}),
		...(event.currentToolDurationMs !== undefined ? { currentToolStartedAt: event.ts - event.currentToolDurationMs } : {}),
		...(event.currentPath ? { currentPath: event.currentPath } : {}),
		...(event.turns !== undefined ? { turnCount: event.turns } : {}),
		...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
		...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
	};
}

function updateRememberedForegroundChild(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; sessionId: string | null; index: number; result: SingleResult; events: IntercomEventBus; notify?: boolean }): void {
	state.foregroundRuns ??= new Map();
	const updatedAt = Date.now();
	let run = state.foregroundRuns.get(input.runId);
	if (!run) {
		run = { runId: input.runId, mode: input.mode, cwd: input.cwd, ...(input.sessionId ? { sessionId: input.sessionId } : {}), updatedAt, children: [] };
		state.foregroundRuns.set(input.runId, run);
	}
	run.updatedAt = updatedAt;
	const terminalStatus = resolveSubagentResultStatus(omitUndefinedProperties({
		exitCode: input.result.exitCode,
		...(input.result.acceptance?.status === "rejected" ? { success: false } : {}),
		interrupted: input.result.interrupted,
		detached: false,
		processSignal: input.result.processSignal,
		timedOut: input.result.timedOut,
		stopped: input.result.stopped,
		turnBudgetExceeded: input.result.turnBudgetExceeded,
	}));
	const child = run.children[input.index] ?? { agent: input.result.agent, index: input.index, status: "detached" as const };
	run.children[input.index] = omitUndefinedProperties({
		...child,
		agent: input.result.agent,
		index: input.index,
		...(input.result.context ? { context: input.result.context } : {}),
		status: terminalStatus,
		...foregroundChildActivityFromProgress(input.result.progress),
		updatedAt,
		...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
		...(input.result.error ? { error: input.result.error } : {}),
		...(input.result.finalOutput ? { finalOutput: input.result.finalOutput } : {}),
		outputState: input.result.outputState,
		outputMode: input.result.outputMode,
		savedOutputPath: input.result.savedOutputPath,
		outputSaveError: input.result.outputSaveError,
		...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
		...(input.result.model ? { model: input.result.model } : {}),
		...(input.result.thinking ? { thinking: input.result.thinking } : {}),
		...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
		...(input.result.transcriptPath ? { transcriptPath: input.result.transcriptPath } : {}),
		...(input.result.transcriptError ? { transcriptError: input.result.transcriptError } : {}),
		...(input.result.detachedReason ? { detachedReason: input.result.detachedReason } : {}),
		...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
		...(input.result.launchContractDigest ? { launchContractDigest: input.result.launchContractDigest } : {}),
		...(input.result.launchResolvedExtensions ? { launchResolvedExtensions: input.result.launchResolvedExtensions } : {}),
		...(input.result.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: input.result.runtimeAcknowledgedExtensions } : {}),
		...(input.result.capabilityCeiling ? { capabilityCeiling: input.result.capabilityCeiling } : {}),
		...(input.result.capabilityAudit ? { capabilityAudit: input.result.capabilityAudit } : {}),
	});
	trimRememberedForegroundRuns(state);
	persistRememberedForegroundRuns(state);
	const output = getSingleResultOutput(input.result).trim();
	const success = terminalStatus === "completed";
	const summary = !success && input.result.error
		? `${input.result.error}${output ? `\n\nOutput:\n${output}` : ""}`
		: output || input.result.error || "Detached child exited without final output.";
	// A detached callback may outlive its extension runtime. Stale sessions are
	// intentionally dropped rather than routed through a replacement runtime.
	if (input.notify === false || !input.sessionId || input.sessionId !== state.currentSessionId) return;
	input.events.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, {
		id: `${input.runId}:${input.index}`,
		runId: input.runId,
		source: "foreground",
		mode: input.mode,
		agent: input.result.agent,
		success,
		summary,
		exitCode: input.result.exitCode,
		state: terminalStatus === "completed" ? "complete" : terminalStatus,
		...(input.result.interrupted !== undefined ? { interrupted: input.result.interrupted } : {}),
		...(input.result.stopped !== undefined ? { stopped: input.result.stopped } : {}),
		...(input.result.processSignal !== undefined ? { processSignal: input.result.processSignal } : {}),
		...(input.result.timedOut !== undefined ? { timedOut: input.result.timedOut } : {}),
		...(input.result.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: input.result.turnBudgetExceeded } : {}),
		timestamp: updatedAt,
		cwd: input.cwd,
		sessionFile: input.result.sessionFile,
		sessionId: input.sessionId,
		taskIndex: input.index,
	});
}

function resolveForegroundResumeTarget(params: SubagentParamsLike, state: SubagentState): { runId: string; mode: SubagentRunMode; state: "complete"; agent: string; index: number; cwd: string; sessionFile: string; model?: string; thinking?: string; launchContractDigest?: string; capabilityCeiling?: ResolvedSubagentCapabilityCeiling } | undefined {
	const requested = (params.id ?? params.runId)?.trim();
	if (!requested || !state.foregroundRuns?.size || !state.currentSessionId) return undefined;
	const sessionRuns = [...state.foregroundRuns.values()].filter((run) => run.sessionId === state.currentSessionId);
	const direct = sessionRuns.find((run) => run.runId === requested);
	const matches = direct ? [direct] : sessionRuns.filter((run) => run.runId.startsWith(requested));
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
	const run = matches[0]!;
	if (run.children.some((child) => child.status === "detached")) throw new Error(`Foreground run '${run.runId}' is detached for intercom coordination and cannot be revived safely while any child may still be live. Reply to the supervisor request first, then wait with subagent_wait({ id: "${run.runId}" }); use status to recover the result and do not launch a replacement while it remains detached.`);
	if (run.children.length > 1 && params.index === undefined) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`);
	const index = params.index ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
	if (index < 0 || index >= run.children.length) throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`);
	const child = run.children[index]!;
	if (!child.sessionFile) throw new Error(`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`);
	if (path.extname(child.sessionFile) !== ".jsonl") throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file: ${child.sessionFile}`);
	const sessionFile = path.resolve(child.sessionFile);
	if (!fs.existsSync(sessionFile)) throw new Error(`Foreground run '${run.runId}' child ${index} session file does not exist: ${child.sessionFile}`);
	return {
		runId: run.runId,
		mode: run.mode,
		state: "complete",
		agent: child.agent,
		index,
		cwd: run.cwd,
		sessionFile,
		...(child.model ? { model: child.model } : {}),
		...(child.thinking ? { thinking: child.thinking } : {}),
		...(child.launchContractDigest ? { launchContractDigest: child.launchContractDigest } : {}),
		...(child.capabilityCeiling ? { capabilityCeiling: child.capabilityCeiling } : {}),
	};
}

type AsyncResumeSourceTarget = ReturnType<typeof resolveAsyncResumeTarget> & { source: "async" };
type ForegroundResumeSourceTarget = NonNullable<ReturnType<typeof resolveForegroundResumeTarget>> & { kind: "revive"; source: "foreground" };
type NestedResumeSourceTarget = {
	kind: "revive";
	source: "nested";
	runId: string;
	state: "complete" | "failed" | "paused";
	agent: string;
	index: number;
	cwd?: string;
	sessionFile: string;
	model?: string;
	thinking?: AgentConfig["thinking"];
	launchContractDigest?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
};
type ResumeSourceTarget = AsyncResumeSourceTarget | ForegroundResumeSourceTarget | NestedResumeSourceTarget;

function isAsyncRunNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Async run not found.");
}

function isResumeAmbiguity(error: unknown): boolean {
	return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
	return target?.runId === requested;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactResumeError(error: unknown, source: "async" | "foreground", requested: string): boolean {
	if (!(error instanceof Error) || !requested) return false;
	return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

function resolveResumeTarget(params: SubagentParamsLike, state: SubagentState, options: { asyncRequireSessionFile?: boolean } = {}): ResumeSourceTarget {
	const requested = (params.id ?? params.runId)?.trim() ?? "";
	let foregroundTarget: ForegroundResumeSourceTarget | undefined;
	let foregroundError: unknown;
	let asyncTarget: AsyncResumeSourceTarget | undefined;
	let asyncError: unknown;

	try {
		const target = resolveForegroundResumeTarget(params, state);
		if (target) foregroundTarget = { kind: "revive", source: "foreground", ...target };
	} catch (error) {
		foregroundError = error;
	}
	try {
		asyncTarget = {
			source: "async",
			...resolveAsyncResumeTarget(params, {}, compactOptional<NonNullable<Parameters<typeof resolveAsyncResumeTarget>[2]>>({
				requireSessionFile: options.asyncRequireSessionFile,
				sessionId: state.currentSessionId ?? undefined,
			})),
		};
	} catch (error) {
		asyncError = error;
	}

	if (foregroundTarget && asyncTarget) {
		const foregroundExact = resumeTargetExact(foregroundTarget, requested);
		const asyncExact = resumeTargetExact(asyncTarget, requested);
		if (foregroundExact && !asyncExact) return foregroundTarget;
		if (asyncExact && !foregroundExact) return asyncTarget;
		throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
	}
	if (foregroundTarget) {
		if (isExactResumeError(asyncError, "async", requested)) throw asyncError;
		if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested)) throw asyncError;
		return foregroundTarget;
	}
	if (asyncTarget) {
		if (isExactResumeError(foregroundError, "foreground", requested)) throw foregroundError;
		if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested)) throw foregroundError;
		return asyncTarget;
	}
	if (foregroundError && !isAsyncRunNotFound(asyncError)) throw foregroundError;
	if (foregroundError) throw foregroundError;
	if (asyncError) throw asyncError;
	throw new Error("Run not found. Provide id or runId.");
}

function getAsyncInterruptTarget(
	state: SubagentState,
	runId: string | undefined,
	location?: { asyncDir: string | null; resolvedId?: string },
	options: { fallbackToNewest?: boolean } = {},
): { asyncId: string; asyncDir: string } | undefined {
	if (location?.asyncDir) {
		return {
			asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
			asyncDir: location.asyncDir,
		};
	}
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
		if (options.fallbackToNewest === false) return undefined;
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

function isStaleExtensionContextError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /extension ctx is stale|stale after session replacement or reload/i.test(error.message);
}

function emitAdvisoryControlEvent(pi: ExtensionAPI, channel: string, payload: unknown): void {
	try {
		pi.events.emit(channel, payload);
	} catch (error) {
		if (isStaleExtensionContextError(error)) return;
		throw error;
	}
}

function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		emitAdvisoryControlEvent(input.pi, SUBAGENT_CONTROL_EVENT, payload);
	}
	if (input.event.type !== "active_long_running" && input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
		emitAdvisoryControlEvent(input.pi, SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

function interruptAsyncRun(
	state: SubagentState,
	runId: string | undefined,
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
	location?: { asyncDir: string | null; resolvedId?: string },
): AgentToolResult<Details> | null {
	const target = getAsyncInterruptTarget(state, runId, location);
	if (!target) return null;
	const status = reconcileAsyncRun(target.asyncDir, omitUndefinedProperties({ kill })).status;
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return {
			content: [{ type: "text", text: `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const activeSteps = status.steps?.filter((step) => step.status === "running") ?? [];
	if (activeSteps.length > 0 && activeSteps.every((step) => step.runner?.type === "external-cli" || step.runner?.type === "external-job")) {
		return {
			content: [{ type: "text", text: `Interrupt is unsupported for external async run ${target.asyncId}; use stop instead.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (status.mode === "workflow") {
		return {
			content: [{ type: "text", text: `Interrupt is unsupported for async workflow ${target.asyncId}; use stop instead.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	try {
		deliverInterruptRequest({ asyncDir: target.asyncDir, source: "interrupt-action" });
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			delete tracked.activityState;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

function duplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		else seen.add(name);
	}
	return [...duplicates];
}

function appendStepToAsyncChain(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
	parentModel?: ParentModel;
}): AgentToolResult<Details> {
	const targetRunId = input.params.id ?? input.params.runId;
	if (!targetRunId) {
		return {
			content: [{ type: "text", text: "action='append-step' requires id." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!input.params.step) {
		return {
			content: [{ type: "text", text: "action='append-step' requires step." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const chain = [input.params.step];
	const acceptanceErrors = validateExecutionAcceptance({ ...input.params, chain } as Parameters<typeof validateExecutionAcceptance>[0]);
	if (acceptanceErrors.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot append step: ${acceptanceErrors.join(" ")}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let resolved: ResolvedSubagentRunId | undefined;
	try {
		resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}
	if (!resolved) {
		return {
			content: [{ type: "text", text: `No async chain run found for '${targetRunId}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (resolved.kind !== "async" || !resolved.location.asyncDir) {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' is not an append-capable async chain run.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const status = readStatus(resolved.location.asyncDir);
	if (!status) {
		return {
			content: [{ type: "text", text: `No async run status found for '${resolved.id}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (status.mode !== "chain") {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' is ${status.mode}; only active chain runs accept appended steps.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (status.state !== "running") {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' is ${status.state}; only running chain runs accept appended steps.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const stillInProgress = (status.steps ?? []).some((step) => step.status === "running" || step.status === "pending") || (status.pendingAppends ?? 0) > 0;
	if (!stillInProgress) {
		return {
			content: [{ type: "text", text: `Run '${resolved.id}' has no running or pending chain steps left; append-step must target an in-progress chain.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const pendingAppendRequests = readPendingChainAppendRequests(resolved.location.asyncDir);
	const reservedOutputNames = new Set<string>([
		...Object.keys(status.outputs ?? {}),
		...(status.steps ?? []).map((step) => step.outputName).filter((name): name is string => Boolean(name)),
		...pendingAppendRequests.flatMap((request) => runnerStepOutputNames(request.steps)),
	]);
	try {
		validateChainOutputBindingsWithContext(chain, omitUndefinedProperties({ maxItems: input.deps.config.chain?.dynamicFanout?.maxItems }), {
			priorOutputNames: reservedOutputNames,
			startStepIndex: status.chainStepCount ?? status.steps?.length ?? 0,
		});
	} catch (error) {
		if (!(error instanceof ChainOutputValidationError)) throw error;
		return {
			content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': ${error.message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	const discoveredForAppend = input.deps.discoverAgents(input.requestCwd, scope);
	const agents = discoveredForAppend.agents;
	const contextPolicy = resolveExplicitContextPolicy(input.params);
	const chainSkillInput = normalizeSkillInput(input.params.skill);
	const chainSkills = chainSkillInput === false ? [] : (chainSkillInput ?? []);
	const parentModel = input.parentModel;
	const asyncCtx = compactOptional<Parameters<typeof executeAsyncSingle>[1]["ctx"]>({
		pi: input.deps.pi,
		cwd: input.ctx.cwd,
		currentSessionId: resolveCurrentSessionId(input.ctx.sessionManager),
		parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
		currentModelProvider: parentModel?.provider,
		currentModel: parentModel,
		modelScope: discoveredForAppend.modelScope,
		interactive: input.ctx.hasUI,
		permissions: input.deps.config.permissions,
	});
	const built = buildAsyncRunnerSteps(resolved.id, compactOptional<Parameters<typeof buildAsyncRunnerSteps>[1]>({
		chain: wrapChainTasksForFork(chain, contextPolicy),
		task: input.params.task,
		resultMode: "chain",
		agents,
		ctx: asyncCtx,
		availableModels: input.ctx.modelRegistry.getAvailable().map(toModelInfo),
		cwd: status.cwd ?? input.requestCwd,
		chainSkills,
		dynamicFanoutMaxItems: input.deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
		waitToolEnabled: input.deps.waitToolEnabled,
		contextForAgent: contextPolicy.contextForAgent,
		asyncDir: resolved.location.asyncDir,
		validateOutputBindings: false,
		capabilityCeiling: intersectSubagentCapabilityCeilings(status.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(asyncCtx.currentSessionId)),
	}));
	if ("error" in built) {
		return {
			content: [{ type: "text", text: built.error }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const appendedOutputNames = runnerStepOutputNames(built.steps);
	const duplicateAppendedOutputs = duplicateNames(appendedOutputNames);
	if (duplicateAppendedOutputs.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': duplicate output name in appended step: ${duplicateAppendedOutputs.join(", ")}.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const pendingOutputNames = new Set(pendingAppendRequests.flatMap((request) => runnerStepOutputNames(request.steps)));
	const pendingDuplicateOutputs = appendedOutputNames.filter((name) => pendingOutputNames.has(name));
	if (pendingDuplicateOutputs.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': output name already belongs to a pending append: ${pendingDuplicateOutputs.join(", ")}.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	try {
		const asyncDir = resolved.location.asyncDir;
		if (!asyncDir) throw new Error(`Run '${resolved.id}' is missing its async directory.`);
		const runFanoutBudget = readRunFanoutBudgetDescriptor(asyncDir);
		if (!runFanoutBudget) throw new Error(`Run '${resolved.id}' is missing its run fan-out budget identity.`);
		const startIndex = (status.chainStepCount ?? status.steps?.length ?? 0) + pendingAppendRequests.reduce((total, request) => total + request.steps.length, 0);
		const appendPaths = chain.flatMap((step, localIndex) => {
			const absoluteIndex = startIndex + localIndex;
			if (isDynamicParallelStep(step)) return [];
			if (isParallelStep(step)) return step.parallel.map((_, itemIndex) => `chain[${absoluteIndex}].parallel[${itemIndex}]`);
			return [`chain[${absoluteIndex}]`];
		});
		const result = enqueueChainAppendRequest({
			asyncDir,
			runId: resolved.id,
			steps: built.steps,
			admit: (persist) => claimRunFanoutBatchWithCommit(runFanoutBudget, appendPaths, persist),
		});
		const stepText = built.steps.length === 1 ? "step" : "steps";
		return {
			content: [{
				type: "text",
				text: `Append queued for chain run ${resolved.id}: ${built.steps.length} ${stepText}. It becomes eligible after the chain's already-queued steps finish. Pending appends: ${result.pendingCount}.${result.bookkeepingError ? ` Bookkeeping warning: ${result.bookkeepingError}` : ""}`,
			}],
			details: { mode: "management", results: [], asyncId: resolved.id, asyncDir },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to append step to chain run ${resolved.id}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

function nestedRunSessionFile(run: NestedRunSummary): string | undefined {
	return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}

function nestedRunAgent(run: NestedRunSummary): string | undefined {
	return run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function validateNestedSessionFile(run: NestedRunSummary, trustedSessionRoots: string[]): string {
	const sessionFile = nestedRunSessionFile(run);
	if (!sessionFile) throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!path.isAbsolute(sessionFile)) throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
	if (!fs.existsSync(resolved)) throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
	const realSessionFile = fs.realpathSync(resolved);
	const trustedRoots = trustedSessionRoots
		.filter((root) => fs.existsSync(root))
		.map((root) => fs.realpathSync(root));
	if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
		throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
	}
	if (!realSessionFile.split(path.sep).includes(run.id)) {
		throw new Error(`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`);
	}
	return realSessionFile;
}

function resolveNestedResumeTarget(match: ResolvedSubagentRunId & { kind: "nested" }, trustedSessionRoots: string[]): NestedResumeSourceTarget {
	const run = match.match.run;
	if (run.state === "running" || run.state === "queued") throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
	if (run.state === "stopped") throw new Error(`Nested run '${run.id}' was stopped and cannot be resumed. Start a new run instead.`);
	const agent = nestedRunAgent(run);
	if (!agent) throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
	const state = run.state === "complete" || run.state === "failed" || run.state === "paused" ? run.state : "failed";
	const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
	return compactOptional<NestedResumeSourceTarget>({
		kind: "revive",
		source: "nested",
		runId: run.id,
		state,
		agent,
		index: 0,
		cwd: asyncDir ? path.dirname(asyncDir) : undefined,
		sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
		...(run.capabilityCeiling ? { capabilityCeiling: run.capabilityCeiling } : {}),
	});
}

async function waitForNestedControlResult(target: ResolvedSubagentRunId & { kind: "nested" }, requestId: string, ignoredFiles: ReadonlySet<string>, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = findNestedControlResult(target.match.route, requestId, target.match.run.id, ignoredFiles);
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

async function sendNestedControlRequest(target: ResolvedSubagentRunId & { kind: "nested" }, action: "interrupt" | "resume", message?: string) {
	const requestId = randomUUID();
	const ignoredFiles = snapshotNestedEventFiles(target.match.route);
	const requestedAt = Date.now();
	writeNestedControlRequest(target.match.route, {
		ts: requestedAt,
		requestId,
		targetRunId: target.match.run.id,
		action,
		...(message ? { message } : {}),
	});
	return waitForNestedControlResult(target, requestId, ignoredFiles);
}

function directNestedAsyncInterrupt(target: ResolvedSubagentRunId & { kind: "nested" }): AgentToolResult<Details> | undefined {
	const run = target.match.run;
	const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = reconcileAsyncRun(asyncDir, { resultsDir: path.join(DIRS.results, "nested", target.match.rootRunId) }).status;
	const pid = typeof status?.pid === "number" && status.pid > 0 ? status.pid : run.pid;
	if (!status || status.state !== "running" || typeof pid !== "number" || pid <= 0) return undefined;
	try {
		deliverInterruptRequest({ asyncDir, source: "nested-interrupt" });
		return { content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }], details: { mode: "management", results: [] } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` }], isError: true, details: { mode: "management", results: [] } };
	}
}

async function directNestedAsyncSteer(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string; mode?: SteerDeliveryMode; index?: number; signal?: AbortSignal }): Promise<AgentToolResult<Details> | undefined> {
	const run = input.target.match.run;
	const asyncDir = resolveNestedAsyncDir(input.target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = reconcileAsyncRun(asyncDir, { resultsDir: path.join(DIRS.results, "nested", input.target.match.rootRunId) }).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) return undefined;
	const steps = status.steps ?? [];
	if (input.index !== undefined) {
		if (input.index < 0 || input.index >= steps.length) return { content: [{ type: "text", text: `Nested async run ${run.id} has ${steps.length} children. Index ${input.index} is out of range.` }], isError: true, details: { mode: "management", results: [] } };
		const step = steps[input.index];
		if (step && step.status !== "running" && step.status !== "pending") return { content: [{ type: "text", text: `Nested async run ${run.id} child ${input.index} is ${step.status} and cannot be steered.` }], isError: true, details: { mode: "management", results: [] } };
	}
	const runningIndexes = steps
		.map((step, index) => step.status === "running" ? index : undefined)
		.filter((index): index is number => index !== undefined);
	const effectiveTargetIndex = input.index ?? (status.mode === "single" && runningIndexes.length === 0 && steps[0]?.status === "pending" ? 0 : undefined);
	const targetIndexes = effectiveTargetIndex !== undefined ? [effectiveTargetIndex] : runningIndexes;
	if (targetIndexes.length === 0) return { content: [{ type: "text", text: `Nested async run ${run.id} has no running child to steer.` }], isError: true, details: { mode: "management", results: [] } };
	const requestId = randomUUID();
	try {
		requestAsyncSteer(asyncDir, {
			message: input.message,
			mode: input.mode,
			...(effectiveTargetIndex !== undefined ? { targetIndex: effectiveTargetIndex } : { targetIndexes }),
			source: "nested-steer",
			id: requestId,
		});
	} catch (error) {
		return { content: [{ type: "text", text: `Failed to queue steering for nested async run ${run.id}: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "management", results: [] } };
	}
	const targets = targetIndexes.map((index) => ({ index, state: steps[index]?.status === "pending" ? "scheduled" as const : "pending" as const }));
	if (targets.every((target) => target.state === "scheduled")) {
		const scheduled = { requestId, state: "scheduled" as const, deliveryStatus: "queued" as const, sourceRunId: run.id, targets };
		return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering scheduled for nested async run ${run.id} (request ${requestId}).`) }], details: { mode: "management", results: [], steering: scheduled } };
	}
	const waited = await waitForSteeringAction(omitUndefinedProperties({ asyncDir, sourceRunId: run.id, requestId, timeoutMs: 3_000, signal: input.signal }));
	const result = waited ?? { requestId, state: "pending" as const, deliveryStatus: "queued" as const, sourceRunId: run.id, targets };
	const stateText = result.state === "failed" ? "failed" : result.state === "partial" ? "partial" : result.deliveryStatus === "queued" ? "queued" : result.state === "delivered" ? "delivered" : "pending";
	return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering ${stateText} for nested async run ${run.id} (request ${requestId}).`) }], ...(result.state === "failed" || result.state === "partial" ? { isError: true } : {}), details: { mode: "management", results: [], steering: result } };
}

async function interruptNestedRun(target: ResolvedSubagentRunId & { kind: "nested" }): Promise<AgentToolResult<Details>> {
	const run = target.match.run;
	if (run.state === "complete") return { content: [{ type: "text", text: `Nested run ${run.id} is already complete and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "failed") return { content: [{ type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
	if (run.state === "paused") return { content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }], isError: true, details: { mode: "management", results: [] } };
	const result = await sendNestedControlRequest(target, "interrupt");
	if (result) return { content: [{ type: "text", text: result.message }], ...(result.ok ? {} : { isError: true }), details: { mode: "management", results: [] } };
	const direct = directNestedAsyncInterrupt(target);
	if (direct) return direct;
	return { content: [{ type: "text", text: `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.` }], isError: true, details: { mode: "management", results: [] } };
}

async function resumeLiveNestedRun(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string }): Promise<AgentToolResult<Details>> {
	const run = input.target.match.run;
	const result = await sendNestedControlRequest(input.target, "resume", input.message);
	if (result) return { content: [{ type: "text", text: result.message }], ...(result.ok ? {} : { isError: true }), details: { mode: "management", results: [] } };
	return { content: [{ type: "text", text: `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry action='resume'.` }], isError: true, details: { mode: "management", results: [] } };
}

async function steerNestedRun(input: { target: ResolvedSubagentRunId & { kind: "nested" }; message: string; mode?: SteerDeliveryMode; index?: number; signal?: AbortSignal }): Promise<AgentToolResult<Details>> {
	const run = input.target.match.run;
	if (run.state !== "running" && run.state !== "queued") return { content: [{ type: "text", text: `Nested run ${run.id} is ${run.state} and cannot be steered.` }], isError: true, details: { mode: "management", results: [] } };
	const direct = await directNestedAsyncSteer(input);
	if (direct) return direct;
	return { content: [{ type: "text", text: `Nested run ${run.id} is not a live async Pi child session with a steering inbox. action='steer' cannot target foreground nested runs.` }], isError: true, details: { mode: "management", results: [] } };
}

function externalRunnerControlError(asyncDir: string, action: "steer" | "resume"): AgentToolResult<Details> | undefined {
	const status = readStatus(asyncDir);
	if (!status?.steps?.length || !status.steps.every((step) => step.runner?.type === "external-cli" || step.runner?.type === "external-job")) return undefined;
	const message = action === "steer"
		? "External runners do not accept live steer messages."
		: "External runners do not persist Pi sessions and cannot be resumed.";
	return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
}

async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
	parentModel?: ParentModel;
	absoluteDeadlineAt?: number;
	signal?: AbortSignal;
}): Promise<AgentToolResult<Details>> {
	const followUp = (input.params.message ?? input.params.task ?? "").trim();
	const attachChain = (input.params.chain?.length ?? 0) > 0 ? input.params.chain as ChainStep[] : undefined;
	if (!followUp && !attachChain) {
		return {
			content: [{ type: "text", text: "action='resume' requires message." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (input.params.model !== undefined) {
		return {
			content: [{ type: "text", text: "action='resume' reuses the persisted child model and does not accept a model override." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const acceptanceErrors = validateExecutionAcceptance(input.params as Parameters<typeof validateExecutionAcceptance>[0]);
	if (acceptanceErrors.length > 0) {
		return {
			content: [{ type: "text", text: `Cannot resume: ${acceptanceErrors.join(" ")}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);

	let target: ResumeSourceTarget;
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	try {
		const requestedId = input.params.id ?? input.params.runId;
		let resolved: ResolvedSubagentRunId | undefined;
		try {
			resolved = requestedId ? resolveSubagentRunId(requestedId, omitUndefinedProperties({ state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) })) : undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			const asyncMatches = message.match(/async:/g)?.length ?? 0;
			if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1) throw error;
		}
		if (resolved?.kind === "nested") {
			if (attachChain) {
				return {
					content: [{ type: "text", text: "Attaching a running subagent as a chain root is currently available for top-level async runs only." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
				return resumeLiveNestedRun({ target: resolved, message: followUp });
			}
			const trustedSessionRoots = [
				...(input.deps.config.defaultSessionDir ? [path.resolve(input.deps.expandTilde(input.deps.config.defaultSessionDir))] : []),
				...(parentSessionFile ? [input.deps.getSubagentSessionRoot(parentSessionFile)] : []),
			];
			target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
		} else {
			if (resolved?.kind === "async" && resolved.location.asyncDir) {
				const unsupported = externalRunnerControlError(resolved.location.asyncDir, "resume");
				if (unsupported) return unsupported;
			}
			target = resolveResumeTarget(input.params, input.deps.state, { asyncRequireSessionFile: !attachChain });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	if (target.kind === "live" && !attachChain) {
		return {
			content: [{
				type: "text",
				text: [
					`Async child '${target.runId}' index ${target.index} is still running. action='resume' only revives paused, completed, or failed children.`,
					`Send live input with subagent({ action: "steer", id: "${target.runId}", index: ${target.index}, message: "..." }).`,
				].join("\n"),
			}],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
	if (blocked) {
		return {
			content: [{ type: "text", text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const effectiveCwd = target.cwd ?? input.requestCwd;
	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	const discovered = input.deps.discoverAgents(effectiveCwd, scope);
	const discoveredAgents = discovered.agents;
	const modelScope = discovered.modelScope;
	const sessionName = resolveIntercomSessionTarget(input.deps.pi.getSessionName(), input.ctx.sessionManager.getSessionId());
	const recoveryDescriptor = "recoveryDescriptor" in target ? target.recoveryDescriptor : undefined;
	const intercomBridge = resolveIntercomBridge({
		config: input.deps.config.intercomBridge,
		override: input.params.intercomBridge ?? recoveryDescriptor?.intercomBridge,
		context: input.params.context,
		orchestratorTarget: sessionName,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const discoveredAgentConfig = discoveredAgents.find((agent) => agent.name === target.agent);
	const baseAgentConfig: AgentConfig | undefined = discoveredAgentConfig ?? (recoveryDescriptor ? {
		name: recoveryDescriptor.agent,
		description: "Persisted async recovery contract",
		systemPrompt: "",
		systemPromptMode: recoveryDescriptor.systemPromptMode,
		inheritProjectContext: recoveryDescriptor.inheritProjectContext,
		inheritSkills: recoveryDescriptor.inheritSkills,
		source: "project",
		filePath: recoveryDescriptor.agentFilePath ?? path.join(getProjectSubagentsDir(recoveryDescriptor.cwd), "recovery-agent"),
	} : undefined);
	if (!baseAgentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${target.agent}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	if (attachChain) {
		if (target.source !== "async") {
			return {
				content: [{ type: "text", text: "Attaching a running subagent as a chain root is currently available for async runs only." }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
				isError: true,
				details: { mode: "chain", results: [] },
			};
		}
		const runId = randomUUID();
		const topLevelResume = depth === 0 && !resolveInheritedNestedRouteFromEnv() && !input.params.workflowParentRunId;
		let activeAsyncCapacity: ActiveAsyncCapacityHandle | undefined;
		try {
			activeAsyncCapacity = topLevelResume ? acquireActiveAsyncCapacity({
				sessionId: input.deps.state.currentSessionId!,
				limit: resolveMaxActiveAsyncRunsPerSession(input.deps.config.maxActiveAsyncRunsPerSession),
				runId,
				kind: "runner",
				asyncDir: path.join(DIRS.async, runId),
			}, { liveWorkflowRunIds: new Set(input.deps.state.workflowControllers?.keys() ?? []) }) : undefined;
		} catch (error) {
			if (error instanceof ActiveAsyncCapacityError) return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: "chain", results: [], activeAsyncCapacity: error.snapshot } };
			throw error;
		}
		const artifactConfig: ArtifactConfig = omitUndefinedProperties({ ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir });
		const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
		const contextPolicy = resolveExplicitContextPolicy(input.params);
		const workflowTask = (input.params.task ?? followUp) || undefined;
		const goal = resolveAsyncEventGoal(workflowTask, attachChain);
		const chain = wrapChainTasksForFork(attachChain, contextPolicy);
		const normalized = normalizeSkillInput(input.params.skill);
		const parentModel = input.parentModel;
		const result = executeAsyncChain(runId, compactOptional<Parameters<typeof executeAsyncChain>[1]>({
			chain,
			task: workflowTask,
			goal,
			attachRoot: {
				runId: target.runId,
				asyncDir: target.asyncDir ?? path.join(DIRS.async, target.runId),
				resultPath: resolveAsyncRootResultPath(DIRS.results, target.runId),
				index: target.index,
				agent: target.agent,
				label: `Attached ${target.runId}`,
			},
			agents,
			ctx: compactOptional<Parameters<typeof executeAsyncSingle>[1]["ctx"]>({
				pi: input.deps.pi,
				cwd: input.requestCwd,
				currentSessionId: input.deps.state.currentSessionId,
				parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
				currentModelProvider: parentModel?.provider,
				currentModel: parentModel,
				modelScope,
				interactive: input.ctx.hasUI,
		permissions: input.deps.config.permissions,
			}),
			availableModels,
			cwd: effectiveCwd,
			maxOutput: input.params.maxOutput,
			artifactsDir: getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir),
			artifactConfig,
			shareEnabled: input.params.share === true,
			sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
			chainSkills: normalized === false ? [] : (normalized ?? []),
			agentContract: input.params.agentContract,
			dynamicFanoutMaxItems: input.deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
			waitToolEnabled: input.deps.waitToolEnabled,
			worktreeSetupHook: input.deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: input.deps.config.worktreeBaseDir,
			controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
			controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
			globalConcurrencyLimit: input.deps.config.globalConcurrencyLimit,
			runFanoutBudget: createRunFanoutBudget(runId, resolveMaxSubagentSpawnsPerRun(input.deps.config.maxSubagentSpawnsPerRun)),
			capabilityCeiling: intersectSubagentCapabilityCeilings("capabilityCeiling" in target ? target.capabilityCeiling : undefined, resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId)),
			activeAsyncCapacity,
		}));
		if (result.isError) {
			activeAsyncCapacity?.rollback();
			return result;
		}
		const attachedId = result.details.asyncId ?? runId;
		const lines = [
			`Attached async subagent ${target.runId} as the first step of a new chain.`,
			`Chain run: ${attachedId}`,
			`Root: ${target.agent} (step ${target.index + 1})`,
			result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
			`Status if needed: subagent({ action: "status", id: "${attachedId}" })`,
		].filter((line): line is string => Boolean(line));
		return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), input.ctx.hasUI) }], details: result.details };
	}

	const sourceAsyncDir = target.source === "async" ? target.asyncDir : undefined;
	const queuedBriefs = sourceAsyncDir ? readRevivalBriefs(sourceAsyncDir) : [];
	const effectiveFollowUp = [...queuedBriefs.map(({ request }) => request.message), followUp].filter(Boolean).join("\n\n");
	const revivalSessionFile = target.sessionFile;
	if (!revivalSessionFile) {
		return { content: [{ type: "text", text: `Async child '${target.runId}' has no persisted session file to resume.` }], isError: true, details: { mode: "management", results: [] } };
	}
	if (target.source === "async" && !recoveryDescriptor) {
		return { content: [{ type: "text", text: `Async child '${target.runId}' is missing its required run fan-out recovery identity. Start a new run instead.` }], isError: true, details: { mode: "management", results: [] } };
	}
	const runId = randomUUID();
	const topLevelResume = depth === 0 && !resolveInheritedNestedRouteFromEnv() && !input.params.workflowParentRunId;
	let activeAsyncCapacity: ActiveAsyncCapacityHandle | undefined;
	try {
		activeAsyncCapacity = !topLevelResume ? undefined : target.source === "async"
			? transferActiveAsyncCapacity({
				sessionId: input.deps.state.currentSessionId!,
				limit: resolveMaxActiveAsyncRunsPerSession(input.deps.config.maxActiveAsyncRunsPerSession),
				sourceRunId: target.runId,
				runId,
				asyncDir: path.join(DIRS.async, runId),
			})
			: acquireActiveAsyncCapacity({
				sessionId: input.deps.state.currentSessionId!,
				limit: resolveMaxActiveAsyncRunsPerSession(input.deps.config.maxActiveAsyncRunsPerSession),
				runId,
				kind: "runner",
				asyncDir: path.join(DIRS.async, runId),
			});
	} catch (error) {
		if (error instanceof ActiveAsyncCapacityError) return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: "single", results: [], activeAsyncCapacity: error.snapshot } };
		return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "single", results: [] } };
	}
	const recoveryAgentConfig = recoveryDescriptor ? applySteeringRecoveryAgentConfig(baseAgentConfig, recoveryDescriptor) : baseAgentConfig;
	const agentConfig = intercomBridge.active ? applyIntercomBridgeToAgent(recoveryAgentConfig, intercomBridge) : recoveryAgentConfig;
	const artifactConfig: ArtifactConfig = recoveryDescriptor?.artifactConfig ?? omitUndefinedProperties({ ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir });
	const artifactsDir = recoveryDescriptor?.artifactsDir ?? getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);
	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const parentModel = input.parentModel;
	const revivalAsyncDir = path.join(DIRS.async, runId);
	const result = executeAsyncSingle(runId, compactOptional<Parameters<typeof executeAsyncSingle>[1]>({
		agent: target.agent,
		task: buildRevivedAsyncTask(target as Parameters<typeof buildRevivedAsyncTask>[0], effectiveFollowUp),
		goal: effectiveFollowUp,
		agentConfig,
		recoveryAgentConfig,
		ctx: compactOptional<Parameters<typeof executeAsyncSingle>[1]["ctx"]>({
			pi: input.deps.pi,
			cwd: input.requestCwd,
			currentSessionId: input.deps.state.currentSessionId,
			parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
			currentModelProvider: parentModel?.provider,
			currentModel: parentModel,
			modelScope,
			interactive: input.ctx.hasUI,
		permissions: input.deps.config.permissions,
		}),
		cwd: effectiveCwd,
		maxOutput: input.params.maxOutput ?? recoveryDescriptor?.maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled: recoveryDescriptor?.share ?? input.params.share === true,
		sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile ?? revivalSessionFile),
		...(recoveryDescriptor?.sessionDir ? { sessionDir: recoveryDescriptor.sessionDir } : {}),
		sessionFile: revivalSessionFile,
		revivalLease: {
			sessionFile: revivalSessionFile,
			runId,
			sourceRunId: target.runId,
			...(input.deps.state.currentSessionId ? { parentSessionId: input.deps.state.currentSessionId } : {}),
		},
		modelOverride: recoveryDescriptor?.model ?? target.model,
		thinkingOverride: recoveryDescriptor?.thinking ?? target.thinking,
		outputBaseDir: resolveSingleRunOutputBaseDir(input.deps, artifactsDir, runId),
		maxSubagentDepth: recoveryDescriptor?.maxSubagentDepth ?? resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
		waitToolEnabled: input.deps.waitToolEnabled,
		worktreeSetupHook: input.deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
		worktreeBaseDir: input.deps.config.worktreeBaseDir,
		worktree: input.params.worktree === true,
		controlConfig: recoveryDescriptor?.controlConfig ?? resolveControlConfig(input.deps.config.control, input.params.control),
		intercomBridge: input.params.intercomBridge ?? recoveryDescriptor?.intercomBridge,
		controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
		childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
		availableModels,
		output: typeof input.params.output === "string" ? input.params.output : recoveryDescriptor?.outputPath,
		outputMode: input.params.outputMode ?? recoveryDescriptor?.outputMode,
		...(recoveryDescriptor?.agentContract ? { agentContract: recoveryDescriptor.agentContract } : {}),
		...(recoveryDescriptor?.structuredOutputSchema ? { structuredOutputSchema: recoveryDescriptor.structuredOutputSchema } : {}),
		...(recoveryDescriptor?.skills ? { skills: [...recoveryDescriptor.skills] } : {}),
		...(recoveryDescriptor?.acceptance !== undefined && input.params.acceptance === undefined ? { acceptance: recoveryDescriptor.acceptance } : {}),
		...(input.params.timeoutMs !== undefined ? { timeoutMs: input.params.timeoutMs } : {}),
		...(input.absoluteDeadlineAt !== undefined ? { absoluteDeadlineAt: input.absoluteDeadlineAt } : {}),
		...(input.params.turnBudget !== undefined ? { turnBudget: input.params.turnBudget } : {}),
		...(input.params.toolBudget !== undefined ? { toolBudget: input.params.toolBudget } : {}),
		capabilityCeiling: intersectSubagentCapabilityCeilings("capabilityCeiling" in target ? target.capabilityCeiling : undefined, recoveryDescriptor?.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId)),
		runFanoutBudget: input.params.runFanoutBudget ?? recoveryDescriptor?.runFanoutBudget ?? createRunFanoutBudget(runId, resolveMaxSubagentSpawnsPerRun(input.deps.config.maxSubagentSpawnsPerRun)),
		parentWorkflowRunId: input.params.workflowParentRunId,
		workflowKey: input.params.workflowKey,
		activeAsyncCapacity,
	}));
	if (result.isError) {
		const startedStatus = readStatus(revivalAsyncDir);
		if (input.params.workflowParentRunId !== undefined && startedStatus?.runId === runId && startedStatus.processTerminal?.runnerProcessInstanceId) {
			return {
				...result,
				details: {
					...result.details,
					runId,
					asyncId: runId,
					asyncDir: revivalAsyncDir,
					...(target.launchContractDigest ? { sourceLaunchContractDigest: target.launchContractDigest } : {}),
				},
			};
		}
		activeAsyncCapacity?.rollback();
		return result;
	}
	for (const brief of queuedBriefs) fs.rmSync(brief.path, { force: true });
	if (queuedBriefs.length > 0 && sourceAsyncDir) {
		const sourceStatus = readStatus(sourceAsyncDir);
		if (sourceStatus?.steering) {
			for (const brief of queuedBriefs) updateSteeringTarget(sourceStatus.steering, brief.request.id, target.index, "delivered", Date.now());
			createCapacityResilientJsonWriter({ keepAlive: true }).write(path.join(sourceAsyncDir, "status.json"), sourceStatus);
		}
	}

	const revivedId = result.details.asyncId ?? runId;
	if (input.params.workflowParentRunId !== undefined && result.details.asyncDir) {
		const asyncDir = result.details.asyncDir;
		const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
		const stopOnAbort = () => { stopAsyncRun(input.deps.state, revivedId, input.deps.kill, { asyncDir, resolvedId: revivedId }); };
		if (input.signal?.aborted) stopOnAbort();
		else input.signal?.addEventListener("abort", stopOnAbort, { once: true });
		let completed: Awaited<ReturnType<typeof waitForImportedAsyncRoot>>;
		try {
			completed = await waitForImportedAsyncRoot({ runId: revivedId, asyncDir, resultPath, index: 0 });
		} finally {
			input.signal?.removeEventListener("abort", stopOnAbort);
		}
		fs.rmSync(resultPath, { force: true });
		const totalCost = completed.totalCost;
		const childResult: SingleResult = {
			index: 0,
			agent: completed.agent,
			task: effectiveFollowUp,
			exitCode: completed.exitCode,
			usage: {
				input: totalCost?.inputTokens ?? 0,
				output: totalCost?.outputTokens ?? 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: totalCost?.costUsd ?? 0,
				turns: 0,
			},
			finalOutput: completed.output,
			outputState: completed.output.trim() ? "present" : "absent",
			...(completed.error ? { error: completed.error } : {}),
			...(completed.timedOut ? { timedOut: true } : {}),
			...(completed.stopped ? { stopped: true } : {}),
			...(completed.sessionFile ? { sessionFile: completed.sessionFile } : {}),
			...(completed.model ? { model: completed.model } : {}),
			...(completed.attemptedModels ? { attemptedModels: completed.attemptedModels } : {}),
			...(completed.modelAttempts ? { modelAttempts: completed.modelAttempts } : {}),
			...(completed.structuredOutput !== undefined ? { structuredOutput: completed.structuredOutput } : {}),
			...(completed.structuredOutputPath ? { structuredOutputPath: completed.structuredOutputPath } : {}),
			...(completed.structuredOutputSchemaPath ? { structuredOutputSchemaPath: completed.structuredOutputSchemaPath } : {}),
			...(completed.acceptance ? { acceptance: completed.acceptance } : {}),
		};
		return {
			content: [{ type: "text", text: completed.output || completed.error || `Revived ${target.source} subagent ${revivedId} completed without output.` }],
			...(completed.success ? {} : { isError: true }),
			details: {
				...result.details,
				runId: revivedId,
				results: [childResult],
				...(target.launchContractDigest ? { sourceLaunchContractDigest: target.launchContractDigest } : {}),
			},
		};
	}
	const revivedTarget = intercomBridge.active ? resolveSubagentIntercomTarget(revivedId, target.agent, 0) : undefined;
	const sourceLabel = target.source;
	const lines = [
		`Revived ${sourceLabel} subagent from ${target.runId}.`,
		`Revived run: ${revivedId}`,
		`Agent: ${target.agent}`,
		`Session: ${target.sessionFile}`,
		result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
		revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
		`Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
	].filter((line): line is string => Boolean(line));
	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), input.ctx.hasUI) }],
		details: {
			...result.details,
			...(target.launchContractDigest ? { sourceLaunchContractDigest: target.launchContractDigest } : {}),
		},
	};
}

function resultSummaryForIntercom(result: SingleResult): string {
	const output = getSingleResultOutput(result);
	if (result.exitCode !== 0 && result.error) {
		return output ? `${result.error}\n\nOutput:\n${output}` : result.error;
	}
	return output || result.error || "(no output)";
}

function formatFailedSingleRunOutput(result: SingleResult, displayOutput: string): string {
	const error = result.error || "Failed";
	const output = displayOutput.trim();
	const lines = [error];
	if (output && output !== error.trim()) {
		lines.push("", "Output:", output);
	}
	if (result.artifactPaths?.outputPath && fs.existsSync(result.artifactPaths.outputPath)) {
		lines.push("", `Output artifact: ${result.artifactPaths.outputPath}`);
	}
	return lines.join("\n");
}

function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi" | "state">): (event: ControlEvent) => void {
	return (event) => {
		applyControlEventToRememberedForegroundRun(deps.state, event);
		emitControlNotification({
			pi: deps.pi,
			controlConfig: data.controlConfig,
			intercomBridge: data.intercomBridge,
			event,
		});
	};
}

export function foregroundResultIntercomStatus(result: SingleResult): ReturnType<typeof resolveSubagentResultStatus> {
	return resolveSubagentResultStatus(omitUndefinedProperties({
		exitCode: result.exitCode,
		...(result.acceptance?.status === "rejected" ? { success: false } : {}),
		interrupted: result.interrupted,
		detached: result.detached,
		processSignal: result.processSignal,
		timedOut: result.timedOut,
		stopped: result.stopped,
		turnBudgetExceeded: result.turnBudgetExceeded,
	}));
}

export function shouldSuppressRoutineResultIntercom(input: { suppressRoutineResultIntercom?: boolean; results: SingleResult[] }): boolean {
	return input.suppressRoutineResultIntercom === true
		&& input.results.length > 0
		&& input.results.every((result) => foregroundResultIntercomStatus(result) === "completed");
}

async function emitForegroundResultIntercom(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	results: SingleResult[];
	chainSteps?: number;
	nestedChildren?: NestedRunSummary[];
	parallelHandoff?: Details["parallelHandoff"];
}): Promise<ReturnType<typeof buildSubagentResultIntercomPayload> | null> {
	if (!input.intercomBridge.active || !input.intercomBridge.resultDelivery || !input.intercomBridge.orchestratorTarget) return null;
	const children = input.results.flatMap((result, index) => result.detached ? [] : [omitUndefinedProperties({
		agent: result.agent,
		status: foregroundResultIntercomStatus(result),
		outputState: result.outputState ?? "unknown",
		summary: resultSummaryForIntercom(result),
		index,
		artifactPath: result.artifactPaths?.outputPath,
		sessionPath: result.sessionFile,
		intercomTarget: resolveSubagentIntercomTarget(input.runId, result.agent, index),
	})]);
	if (children.length === 0) return null;
	const payload = buildSubagentResultIntercomPayload({
		to: input.intercomBridge.orchestratorTarget,
		runId: input.runId,
		mode: input.mode,
		source: "foreground",
		children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
		...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
		...(input.parallelHandoff ? { parallelHandoff: input.parallelHandoff } : {}),
	});
	const delivered = await deliverSubagentResultIntercomEvent(input.pi.events, payload);
	if (!delivered) return null;
	return payload;
}

async function maybeBuildForegroundIntercomReceipt(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	details: Details;
	nestedChildren?: NestedRunSummary[];
	preserveDetailsOutputs?: boolean;
}): Promise<{ text: string; details: Details } | null> {
	const payload = await emitForegroundResultIntercom({
		pi: input.pi,
		intercomBridge: input.intercomBridge,
		runId: input.runId,
		mode: input.mode,
		results: input.details.results,
		...(typeof input.details.totalSteps === "number" ? { chainSteps: input.details.totalSteps } : {}),
		...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
		...(input.details.parallelHandoff ? { parallelHandoff: input.details.parallelHandoff } : {}),
	});
	if (!payload) return null;
	return {
		text: formatSubagentResultReceipt({ mode: input.mode, runId: input.runId, payload }),
		details: input.preserveDetailsOutputs ? input.details : stripDetailsOutputsForIntercomReceipt(input.details),
	};
}

function canonicalizeAgentName(name: string, agents: AgentConfig[], diagnostics?: AgentDiscoveryDiagnostic[]): { name?: string; error?: string } {
	const resolved = resolveAgentName(name, agents);
	const candidates = resolved.error ? agents.filter((agent) => resolveAgentName(name, [agent]).agent) : resolved.agent;
	const diagnostic = findBlockingAgentDiagnostic(name, candidates, diagnostics);
	if (diagnostic) return { error: `Agent '${name}' has invalid configuration: ${diagnostic.error}` };
	if (resolved.error) return { error: resolved.error };
	if (!resolved.agent) return { error: `Unknown agent: ${name}` };
	return { name: resolved.agent.name };
}

function canonicalizeExecutionParams(params: SubagentParamsLike, agents: AgentConfig[], diagnostics?: AgentDiscoveryDiagnostic[]): { params?: SubagentParamsLike; error?: string } {
	const resolve = (name: string, location?: string): { name?: string; error?: string } => {
		const result = canonicalizeAgentName(name, agents, diagnostics);
		return result.error && location ? { error: `${result.error} (${location})` } : result;
	};
	if (params.agent) {
		const result = resolve(params.agent);
		if (result.error) return { error: result.error };
		params = omitUndefinedProperties({ ...params, agent: result.name });
	}
	if (params.tasks) {
		const tasks: TaskParam[] = [];
		for (let index = 0; index < params.tasks.length; index++) {
			const task = params.tasks[index]!;
			const result = resolve(task.agent, `task ${index + 1}`);
			if (result.error) return { error: result.error };
			tasks.push({ ...task, agent: result.name! });
		}
		params = { ...params, tasks };
	}
	if (params.chain) {
		const chain: ChainStep[] = [];
		for (let index = 0; index < params.chain.length; index++) {
			const step = params.chain[index]!;
			if (isParallelStep(step)) {
				const parallel: ParallelTaskItem[] = [];
				for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
					const task = step.parallel[taskIndex]!;
					const result = resolve(task.agent, `step ${index + 1}, task ${taskIndex + 1}`);
					if (result.error) return { error: result.error };
					parallel.push({ ...task, agent: result.name! });
				}
				chain.push({ ...step, parallel });
				continue;
			}
			if (isDynamicParallelStep(step)) {
				const result = resolve(step.parallel.agent, `step ${index + 1}`);
				if (result.error) return { error: result.error };
				chain.push({ ...step, parallel: { ...step.parallel, agent: result.name! } });
				continue;
			}
			if ("agent" in step && typeof step.agent === "string") {
				const result = resolve(step.agent, `step ${index + 1}`);
				if (result.error) return { error: result.error };
				chain.push({ ...step, agent: result.name! });
				continue;
			}
			chain.push(step);
		}
		params = { ...params, chain };
	}
	return { params };
}

function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
	allowClarifyTaskPrompt: boolean,
): AgentToolResult<Details> | null {
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const acceptanceErrors = validateExecutionAcceptance(params as Parameters<typeof validateExecutionAcceptance>[0]);
	if (acceptanceErrors.length > 0) {
		return {
			content: [{ type: "text", text: acceptanceErrors.join(" ") }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		};
	}

	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i]!;
			if (!agents.find((agent) => agent.name === task.agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
		}
	}

	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (isDynamicParallelStep(firstStep)) {
			return {
				content: [{ type: "text", text: "First step in chain cannot be dynamic fanout; expand.from requires a prior structured named output" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		} else if (!(firstStep as SequentialStep).task && !params.task && !allowClarifyTaskPrompt) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	return null;
}

function validateExecutionChainBindings(params: SubagentParamsLike, dynamicFanoutMaxItems?: number): AgentToolResult<Details> | null {
	if ((params.chain?.length ?? 0) === 0) return null;
	try {
		validateChainOutputBindingsWithContext(params.chain as ChainStep[], dynamicFanoutMaxItems === undefined ? {} : { maxItems: dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		throw error;
	}
	return null;
}

function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if (params.workflowScript !== undefined) return "workflow";
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

function formatStatusTargetLabel(params: Pick<SubagentParamsLike, "dir" | "index" | "view">, targetRunId: string | undefined): string {
	let target: string;
	if (targetRunId) {
		target = `run ${targetRunId}`;
	} else if (params.dir) {
		target = `dir ${params.dir}`;
	} else {
		target = params.view === "transcript" ? "active run" : "active runs";
	}
	if (params.view !== "transcript") return `Status target: ${target}`;
	return `Transcript target: ${target}${params.index !== undefined ? ` · child ${params.index}` : ""}`;
}

interface AgentDefaultContextPolicy {
	params: SubagentParamsLike;
	contextForAgent(agentName: string): ContextMode;
	contextSummary?: ContextSummary;
	usesFork: boolean;
}

function resolveAgentDefaultContextPolicy(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	defaultSubagentContext: ExtensionConfig["defaultSubagentContext"],
	canUseDefaultFork = false,
): AgentDefaultContextPolicy {
	if (params.context !== undefined) return resolveExplicitContextPolicy(params);
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const contextForAgent = (agentName: string): ContextMode =>
		resolveSubagentLaunchContext({
			explicitContext: params.context,
			agentDefaultContext: byName.get(agentName)?.defaultContext,
			defaultSubagentContext,
			canUseImplicitFork: canUseDefaultFork,
		});
	const requestedAgentNames = collectRequestedAgentNames(params);
	const contextSummary = summarizeContextModes(requestedAgentNames.map((name) => contextForAgent(name)));
	const usesFork = contextSummary === "fork" || contextSummary === "mixed";
	return omitUndefinedProperties({
		params,
		contextForAgent,
		contextSummary,
		usesFork,
	});
}

function resolveExplicitContextPolicy(params: SubagentParamsLike): AgentDefaultContextPolicy {
	const context = resolveSubagentLaunchContext({
		explicitContext: params.context,
		canUseImplicitFork: false,
	});
	return {
		params,
		contextForAgent: () => context,
		contextSummary: context,
		usesFork: context === "fork",
	};
}

function collectRequestedAgentNames(params: SubagentParamsLike): string[] {
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names;
}

function shouldForkAgent(contextPolicy: AgentDefaultContextPolicy, agentName: string): boolean {
	return contextPolicy.contextForAgent(agentName) === "fork";
}

function summarizeResultContext(details: Details, fallback: ContextSummary | undefined): ContextSummary | undefined {
	return summarizeContextModes(details.results.map((result) => result.context)) ?? fallback;
}

function buildRequestedModeError(params: SubagentParamsLike, message: string): AgentToolResult<Details> {
	return withResolvedContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function applySingleAgentLaunchDefaults(params: SubagentParamsLike, agents: AgentConfig[]): SubagentParamsLike {
	if ((params.chain?.length ?? 0) > 0 || (params.tasks?.length ?? 0) > 0 || !params.agent) return params;
	const agent = agents.find((candidate) => candidate.name === params.agent);
	if (!agent) return params;
	const parentTimeoutMs = params.timeoutMs === undefined && params.maxRuntimeMs === undefined && agent.defaultTimeoutMs === undefined && params.workflowParentDeadlineAt !== undefined
		? Math.max(1, params.workflowParentDeadlineAt - Date.now())
		: undefined;
	return {
		...params,
		...(params.async === undefined && agent.defaultAsync !== undefined ? { async: agent.defaultAsync } : {}),
		...(params.timeoutMs === undefined && params.maxRuntimeMs === undefined && agent.defaultTimeoutMs !== undefined
			? { timeoutMs: agent.defaultTimeoutMs }
			: {}),
		...(parentTimeoutMs !== undefined ? { timeoutMs: parentTimeoutMs } : {}),
		...(params.turnBudget === undefined && agent.defaultTurnBudget !== undefined
			? { turnBudget: agent.defaultTurnBudget }
			: {}),
		...(params.acceptance === undefined && agent.defaultAcceptance !== undefined
			? { acceptance: agent.defaultAcceptance }
			: {}),
	};
}

export const DEFAULT_FOREGROUND_TIMEOUT_MS = 30 * 60 * 1000;

// Async single-agent runs also need a wall-clock backstop: a child whose bash
// tool blocks forever (e.g. a background process inheriting the terminal with
// no bash `timeout` arg) would otherwise hang the parent indefinitely with
// zero signal. Same generous default as foreground; explicit timeoutMs/
// maxRuntimeMs and agent-level defaultTimeoutMs remain authoritative.
//
// Deliberately NOT applied at the workflow level: async scripted workflows
// stay unbounded as a whole, while each runner child has its own deadline.
export { DEFAULT_ASYNC_TIMEOUT_MS };

/**
 * Maximum delay a Node.js timer accepts. Values above the 32-bit signed integer
 * ceiling overflow `setTimeout`, which silently clamps the delay to ~1ms and
 * fires almost immediately — so a run configured with a larger deadline would
 * terminate right away while reporting the long duration. Any timeout destined
 * for a timer must stay within this bound.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Resolve the optional global default runtime deadline from extension config
 * (`config.timeoutMs`). Returns undefined for unset or invalid values so callers
 * fall back to the built-in defaults. "Invalid" covers non-positive-integer
 * values and values above `MAX_TIMER_DELAY_MS`; the latter would overflow the
 * Node.js timer and expire the run almost immediately instead of running long.
 */
export function resolveConfigDefaultTimeoutMs(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_TIMER_DELAY_MS) return undefined;
	return raw;
}

export function resolveForegroundTimeout(params: SubagentParamsLike, defaultTimeoutMs?: number): { timeoutMs?: number; error?: string } {
	const rawTimeout = params.timeoutMs;
	const rawMaxRuntime = params.maxRuntimeMs;
	if (rawTimeout === undefined && rawMaxRuntime === undefined) {
		return defaultTimeoutMs === undefined ? {} : { timeoutMs: defaultTimeoutMs };
	}
	for (const [name, value] of [["timeoutMs", rawTimeout], ["maxRuntimeMs", rawMaxRuntime]] as const) {
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			return { error: `${name} must be a positive integer.` };
		}
	}
	if (rawTimeout !== undefined && rawMaxRuntime !== undefined && rawTimeout !== rawMaxRuntime) {
		return { error: "timeoutMs and maxRuntimeMs are aliases; provide only one value or use the same value for both." };
	}
	const timeoutMs = rawTimeout ?? rawMaxRuntime;
	return timeoutMs === undefined ? {} : { timeoutMs };
}

/**
 * Resolve the effective launch timeout for a single-agent run, applying the
 * async/foreground default when neither the caller nor the agent set one.
 *
 * A global config default (`config.timeoutMs`, passed as `configDefaultTimeoutMs`)
 * replaces the built-in 30-minute backstop wherever a concrete default is applied.
 * The async default is deliberately applied only to plain single-agent launches.
 * Composite launches keep their top-level execution unbounded when no timeout is
 * set — even with a config default — while their runner children resolve separate
 * deadlines. Exported so the executor wiring is directly testable.
 */
export function resolveSingleAgentLaunchTimeout(params: SubagentParamsLike, async: boolean, configDefaultTimeoutMs?: number): { timeoutMs?: number; error?: string } {
	const isComposite = (params.chain?.length ?? 0) > 0 || (params.tasks?.length ?? 0) > 0 || params.workflowScript !== undefined;
	const foregroundDefault = configDefaultTimeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS;
	const asyncSingleDefault = configDefaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS;
	const defaultTimeoutMs = !async ? foregroundDefault : isComposite ? undefined : asyncSingleDefault;
	return resolveForegroundTimeout(params, defaultTimeoutMs);
}

function resolveToolBudget(
	raw: unknown,
	label = "toolBudget",
	options?: { minimumHard?: 0 | 1 },
): { toolBudget?: ResolvedToolBudget; error?: string } {
	const resolved = validateToolBudgetConfig(raw, label, options);
	return { ...(resolved.budget === undefined ? {} : { toolBudget: resolved.budget }), ...(resolved.error === undefined ? {} : { error: resolved.error }) };
}

function resolveEffectiveToolBudget(input: { stepBudget?: ToolBudgetConfig; runBudget?: ResolvedToolBudget; agentBudget?: ToolBudgetConfig; configBudget?: ToolBudgetConfig }): { toolBudget?: ResolvedToolBudget; error?: string } {
	if (input.stepBudget !== undefined) return resolveToolBudget(input.stepBudget, "toolBudget");
	if (input.runBudget !== undefined) return { toolBudget: input.runBudget };
	if (input.agentBudget !== undefined) return resolveToolBudget(input.agentBudget, "agent.toolBudget");
	return resolveToolBudget(input.configBudget, "config.toolBudget");
}

function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}

function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel: ParallelTaskItem[] = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, ...(expandedTasks.tasks === undefined ? {} : { tasks: expandedTasks.tasks }) } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, ...(expandedChain.chain === undefined ? {} : { chain: expandedChain.chain }) } };
	}
	return { params };
}

function withResolvedContext(
	result: AgentToolResult<Details>,
	fallback: ContextSummary | undefined,
): AgentToolResult<Details> {
	if (!result.details) return result;
	const context = summarizeResultContext(result.details, fallback);
	if (!context) return result;
	return {
		...result,
		details: {
			...result.details,
			context,
		},
	};
}

function withForkThinkingNotes(
	result: AgentToolResult<Details>,
	downgrades: Map<number, string>,
): AgentToolResult<Details> {
	if (downgrades.size === 0) return result;
	const children = [...downgrades.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, agent]) => `${agent} (child ${index})`)
		.join(", ");
	const note = `Note: fork context forced thinking off for ${children}. The forked transcript contained signed Anthropic thinking blocks that were sanitized, and Anthropic children cannot resume such a transcript with thinking enabled. Use context: "fresh" when an Anthropic child needs thinking.`;
	return { ...result, content: [...result.content, { type: "text", text: note }] };
}

function toExecutionErrorResult(params: SubagentParamsLike, error: unknown, contextSummary?: ContextSummary): AgentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withResolvedContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		contextSummary,
	);
}

function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForTask: ForkSessionFileForTask,
	dynamicFanoutMaxItems?: number,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				sessionFiles.push(sessionFileForTask(task.agent, flatIndex, task.model));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
				sessionFiles.push(sessionFileForTask(step.parallel.agent, flatIndex, step.parallel.model));
				flatIndex++;
			}
			continue;
		}
		const sequential = step as SequentialStep;
		sessionFiles.push(sessionFileForTask(sequential.agent, flatIndex, sequential.model));
		flatIndex++;
	}
	return sessionFiles;
}

function collectChainThinkingOverrides(
	chain: ChainStep[],
	thinkingOverrideForTask: ForkThinkingOverrideForTask,
	dynamicFanoutMaxItems?: number,
): (AgentConfig["thinking"] | undefined)[] {
	const thinkingOverrides: (AgentConfig["thinking"] | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				thinkingOverrides.push(thinkingOverrideForTask(task.agent, flatIndex, task.model));
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
				thinkingOverrides.push(thinkingOverrideForTask(step.parallel.agent, flatIndex, step.parallel.model));
				flatIndex++;
			}
			continue;
		}
		const sequential = step as SequentialStep;
		thinkingOverrides.push(thinkingOverrideForTask(sequential.agent, flatIndex, sequential.model));
		flatIndex++;
	}
	return thinkingOverrides;
}

type StaticLaunchSummary = { agent: string; model?: string; thinking?: string };

function resolveStaticLaunchSummary(input: {
	agent: string;
	index: number;
	explicitModel?: string;
	agents: AgentConfig[];
	parentModel?: ParentModel;
	availableModels: ModelInfo[];
	currentProvider?: string;
	modelScope?: ModelScopeConfig;
	thinkingOverrideForTask: ForkThinkingOverrideForTask;
}): StaticLaunchSummary {
	const agentConfig = input.agents.find((agent) => agent.name === input.agent);
	const externalRunner = agentConfig?.runner?.type === "external-cli" || agentConfig?.runner?.type === "external-job";
	const model = externalRunner
		? undefined
		: resolveEffectiveSubagentModel(
			input.explicitModel,
			agentConfig?.model,
			input.parentModel,
			input.availableModels,
			input.currentProvider,
			input.modelScope === undefined ? {} : { scope: input.modelScope },
		);
	const thinkingOverride = externalRunner ? undefined : input.thinkingOverrideForTask(input.agent, input.index, model);
	const thinking = externalRunner ? undefined : resolveEffectiveThinking(model, thinkingOverride ?? agentConfig?.thinking);
	return {
		agent: input.agent,
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
	};
}

function collectStaticLaunchSummaries(input: {
	params: SubagentParamsLike;
	agents: AgentConfig[];
	parentModel?: ParentModel;
	availableModels: ModelInfo[];
	currentProvider?: string;
	modelScope?: ModelScopeConfig;
	thinkingOverrideForTask: ForkThinkingOverrideForTask;
	dynamicFanoutMaxItems?: number;
}): StaticLaunchSummary[] {
	const summary = (agent: string, index: number, explicitModel?: string) => resolveStaticLaunchSummary({
		agent,
		index,
		explicitModel,
		agents: input.agents,
		parentModel: input.parentModel,
		availableModels: input.availableModels,
		currentProvider: input.currentProvider,
		modelScope: input.modelScope,
		thinkingOverrideForTask: input.thinkingOverrideForTask,
	});
	if (input.params.tasks) return input.params.tasks.map((task, index) => summary(task.agent, index, task.model));
	if (input.params.chain?.length) {
		const launches: StaticLaunchSummary[] = [];
		let flatIndex = 0;
		for (const step of input.params.chain) {
			if (isParallelStep(step)) {
				for (const task of step.parallel) {
					launches.push(summary(task.agent, flatIndex, task.model));
					flatIndex++;
				}
				continue;
			}
			if (isDynamicParallelStep(step)) {
				const maxItems = step.expand.maxItems ?? input.dynamicFanoutMaxItems ?? 0;
				for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
					launches.push(summary(step.parallel.agent, flatIndex, step.parallel.model));
					flatIndex++;
				}
				continue;
			}
			const sequential = step as SequentialStep;
			launches.push(summary(sequential.agent, flatIndex, sequential.model));
			flatIndex++;
		}
		return launches;
	}
	return input.params.agent ? [summary(input.params.agent, 0, input.params.model as string | undefined)] : [];
}

function firstChainAgent(chain: ChainStep[]): string | undefined {
	const first = chain[0];
	if (!first) return undefined;
	if (isParallelStep(first)) return first.parallel[0]?.agent;
	if (isDynamicParallelStep(first)) return first.parallel.agent;
	return (first as SequentialStep).agent;
}

function firstRawChainTask(chain: ChainStep[]): string | undefined {
	const first = chain[0];
	if (!first) return undefined;
	if (isParallelStep(first)) return first.parallel[0]?.task;
	if (isDynamicParallelStep(first)) return first.parallel.task;
	return (first as SequentialStep).task;
}

function resolveAsyncEventGoal(workflowTask: string | undefined, rawChain: ChainStep[], unwrapForkFallback = false): string {
	if (workflowTask?.trim()) return workflowTask;
	const fallback = firstRawChainTask(rawChain) || "";
	if (!unwrapForkFallback) return fallback;
	const forkPrefix = `${DEFAULT_FORK_PREAMBLE}\n\nTask:\n`;
	return fallback.startsWith(forkPrefix) ? fallback.slice(forkPrefix.length) : fallback;
}

function wrapChainTasksForFork(chain: ChainStep[], contextPolicy: AgentDefaultContextPolicy): ChainStep[] {
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return compactOptional<ParallelStep>({
				...step,
				parallel: step.parallel.map((task) => compactOptional<ParallelTaskItem>({
					...task,
					task: shouldForkAgent(contextPolicy, task.agent)
						? wrapForkTask(task.task ?? "{previous}")
						: task.task,
				})),
			});
		}
		if (isDynamicParallelStep(step)) {
			return compactOptional<DynamicParallelStep>({
				...step,
				parallel: compactOptional<DynamicParallelStep["parallel"]>({
					...step.parallel,
					task: shouldForkAgent(contextPolicy, step.parallel.agent)
						? wrapForkTask(step.parallel.task ?? "{previous}")
						: step.parallel.task,
				}),
			});
		}
		const sequential = step as SequentialStep;
		return compactOptional<SequentialStep>({
			...sequential,
			task: shouldForkAgent(contextPolicy, sequential.agent)
				? wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}"))
				: sequential.task,
		});
	});
}

function preflightForkSessionsForStaticTasks(
	params: SubagentParamsLike,
	contextPolicy: AgentDefaultContextPolicy,
	sessionFileForTask: ForkSessionFileForTask,
	dynamicFanoutMaxItems?: number,
): void {
	if (!contextPolicy.usesFork) return;
	if (params.agent) {
		if (shouldForkAgent(contextPolicy, params.agent)) sessionFileForTask(params.agent, 0, params.model);
		return;
	}
	if (params.tasks) {
		params.tasks.forEach((task, index) => {
			if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, index, task.model);
		});
		return;
	}
	if (!params.chain?.length) return;
	let flatIndex = 0;
	for (const step of params.chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, flatIndex, task.model);
				flatIndex++;
			}
			continue;
		}
		if (isDynamicParallelStep(step)) {
			const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
			if (shouldForkAgent(contextPolicy, step.parallel.agent)) {
				for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) sessionFileForTask(step.parallel.agent, flatIndex + itemIndex, step.parallel.model);
			}
			flatIndex += maxItems;
			continue;
		}
		const sequential = step as SequentialStep;
		if (shouldForkAgent(contextPolicy, sequential.agent)) sessionFileForTask(sequential.agent, flatIndex, sequential.model);
		flatIndex++;
	}
}

function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): AgentToolResult<Details> | null {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
		contextPolicy,
	} = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;


	if (!isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const id = data.asyncRunId;
	const parentModel = data.parentModel;
	const asyncCtx = compactOptional<Parameters<typeof executeAsyncSingle>[1]["ctx"]>({
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: data.parentSessionId!,
		parentSessionId: data.parentPiSessionId,
		currentModelProvider: parentModel?.provider,
		currentModel: parentModel,
		modelScope: data.modelScope,
		interactive: ctx.hasUI,
		permissions: deps.config.permissions,
	});
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const currentProvider = parentModel?.provider;
	const controlIntercomTarget = intercomBridge.active ? intercomBridge.orchestratorTarget : undefined;
	const childIntercomTarget = intercomBridge.active ? (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index) : undefined;


	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
		const effectiveOutputMode = params.outputMode ?? "inline";
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const externalRunnerWithoutExplicitModel = (a.runner?.type === "external-cli" || a.runner?.type === "external-job")
			&& params.model === undefined
			&& (a.model === undefined || (a.modelSource?.type === "subagents.defaultModel" && a.model === a.modelSource.model));
		const modelOverride = a.runner?.type === "external-cli" || a.runner?.type === "external-job"
			? params.model ?? (externalRunnerWithoutExplicitModel ? undefined : a.model)
			: resolveEffectiveSubagentModel(params.model as string | undefined, a.model, parentModel, availableModels, currentProvider, data.modelScope === undefined ? {} : { scope: data.modelScope });
		return executeAsyncSingle(id, compactOptional<Parameters<typeof executeAsyncSingle>[1]>({
			agent: params.agent!,
			task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			goal: params.task ?? "",
			agentConfig: a,
			recoveryAgentConfig: data.recoveryAgents.find((agent) => agent.name === params.agent),
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			activeAsyncCapacity: data.activeAsyncCapacity,
			sessionRoot,
			sessionFile: sessionFileForTask(params.agent!, 0, modelOverride),
			context: contextPolicy.contextForAgent(params.agent!),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			...(params.reads !== undefined ? { reads: params.reads } : {}),
			outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
			modelOverride,
			thinkingOverride: externalRunnerWithoutExplicitModel ? undefined : thinkingOverrideForTask(params.agent!, 0, modelOverride),
			maxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			...(params.worktree === true ? { worktree: true } : {}),
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			intercomBridge: params.intercomBridge,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
			nestedRoute,
			agentContract: params.agentContract,
			structuredOutputSchema: params.outputSchema,
			acceptance: params.acceptance,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			toolTimeoutMs: data.params?.toolTimeoutMs,
			configToolTimeoutMs: data.configToolTimeoutMs,
			capabilityCeiling: data.capabilityCeiling,
			runFanoutBudget: data.runFanoutBudget,
			parentWorkflowRunId: params.workflowParentRunId,
			workflowKey: params.workflowKey,
		}));
	}

	return null;
}

function createSingleWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	agent: string,
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
	baseDir: ExtensionConfig["worktreeBaseDir"],
): { setup?: WorktreeSetup; errorResult?: AgentToolResult<Details> } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, 1, omitUndefinedProperties({
				agents: [agent],
				setupHook: setupHook
					? { hookPath: setupHook, ...(setupHookTimeoutMs === undefined ? {} : { timeoutMs: setupHookTimeoutMs }) }
					: undefined,
				baseDir,
			})),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } } };
	}
}

function resolveConfiguredSingleRunOutputBaseDir(deps: ExecutorDeps): string | undefined {
	return deps.config.singleRunOutputBaseDir
		? path.resolve(deps.expandTilde(deps.config.singleRunOutputBaseDir))
		: undefined;
}

function resolveSingleRunOutputBaseDir(deps: ExecutorDeps, artifactsDir: string, runId: string): string {
	return resolveConfiguredSingleRunOutputBaseDir(deps) ?? path.join(artifactsDir, "outputs", runId);
}

function resolveWorkflowAggregateOutputPath(
	output: string | boolean | undefined,
	ctxCwd: string,
	workflowCwd: string,
	outputBaseDir: string,
	configuredOutputBaseDir: string | undefined,
): string | undefined {
	if (typeof output === "string" && output && !path.isAbsolute(output) && !configuredOutputBaseDir) return path.resolve(workflowCwd, output);
	return resolveSingleOutputPath(output, ctxCwd, workflowCwd, outputBaseDir);
}

function workflowChildDefaultOutput(aggregateOutputPath: string | undefined, artifactsDir: string, workflowRunId: string, workflowKey: string): string {
	if (aggregateOutputPath) {
		const parsed = path.parse(aggregateOutputPath);
		return path.join(parsed.dir, `${parsed.name}.${workflowKey}${parsed.ext || ".md"}`);
	}
	return path.join(artifactsDir, "outputs", workflowRunId, `${workflowKey}.md`);
}

function writeWorkflowAggregateOutput(outputPath: string | undefined, text: string, producedChildOutputPaths: ReadonlySet<string>): string | undefined {
	if (!outputPath) return undefined;
	try {
		if (producedChildOutputPaths.has(outputPath)) return undefined;
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, text, "utf-8");
		return undefined;
	} catch (error) {
		return `Output file error: ${outputPath}\n${error instanceof Error ? error.message : String(error)}`;
	}
}

function appendWorkflowOutputWarning(text: string, warning: string | undefined): string {
	return warning ? `${text}\n\n${warning}` : text;
}

function resolveWorkflowChildOutputPath(input: {
	ctxCwd: string;
	workflowCwd: string;
	artifactsDir: string;
	workflowRunId: string;
	aggregateOutputPath?: string;
	configuredOutputBaseDir?: string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	workflowAgentScope?: unknown;
	key: string;
	params: Record<string, unknown>;
}): string | undefined {
	const rawOutput = input.params.output;
	const hasExplicitOutput = typeof rawOutput === "string" || typeof rawOutput === "boolean";
	const childCwd = typeof input.params.cwd === "string" ? resolveChildCwd(input.workflowCwd, input.params.cwd) : input.workflowCwd;
	const agentScope = resolveExecutionAgentScope(input.params.agentScope ?? input.workflowAgentScope);
	const agents = input.discoverAgents(childCwd, agentScope).agents;
	const agent = typeof input.params.agent === "string" ? resolveAgentName(input.params.agent, agents).agent : undefined;
	const agentOutput = typeof agent?.output === "string" ? agent.output : undefined;
	const output = rawOutput === true || rawOutput === "true"
		? agentOutput
		: hasExplicitOutput
			? rawOutput
			: input.aggregateOutputPath
				? workflowChildDefaultOutput(input.aggregateOutputPath, input.artifactsDir, input.workflowRunId, input.key)
				: agentOutput;
	return resolveSingleOutputPath(output, input.ctxCwd, childCwd, input.configuredOutputBaseDir);
}

function workflowChildOutputClaims(input: {
	ctxCwd: string;
	workflowCwd: string;
	artifactsDir: string;
	workflowRunId: string;
	aggregateOutputPath?: string;
	configuredOutputBaseDir?: string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	workflowAgentScope?: unknown;
	claimedOutputPaths: Map<string, string>;
	entries: Array<{ key: string; params: Record<string, unknown> }>;
}): { error?: string; claims?: Map<string, string> } {
	const claims = new Map(input.claimedOutputPaths);
	for (const { key, params } of input.entries) {
		const resolved = resolveWorkflowChildOutputPath({ ...input, key, params });
		if (!resolved) continue;
		const previous = claims.get(resolved);
		if (previous) return { error: `Workflow children '${previous}' and '${key}' resolve output to the same path: ${resolved}. Use distinct child output paths.` };
		claims.set(resolved, key);
	}
	return { claims };
}

function applyWorkflowChildOutputClaims(target: Map<string, string>, claims: Map<string, string>): void {
	target.clear();
	for (const [resolved, key] of claims) target.set(resolved, key);
}

function prepareWorkflowChildLaunchParams(input: {
	workflowDefaults: SubagentParamsLike;
	childParams: Record<string, unknown>;
	parentWorkflowRunId: string;
	workflowKey: string;
	ctxCwd: string;
	workflowCwd: string;
	artifactsDir: string;
	aggregateOutputPath?: string;
	configuredOutputBaseDir?: string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
	workflowAgentScope?: unknown;
	options?: { missionDetached?: boolean; suppressRoutineResultIntercom?: boolean; runFanoutBudget?: RunFanoutBudgetDescriptor; parentDeadlineAt?: number };
}): SubagentParamsLike {
	let childParams = input.childParams;
	if (input.childParams.output === undefined && input.childParams.resume === undefined && input.aggregateOutputPath !== undefined) {
		childParams = { ...input.childParams, output: workflowChildDefaultOutput(input.aggregateOutputPath, input.artifactsDir, input.parentWorkflowRunId, input.workflowKey) };
	} else if (input.childParams.resume === undefined) {
		const resolvedOutput = resolveWorkflowChildOutputPath({ ctxCwd: input.ctxCwd, workflowCwd: input.workflowCwd, artifactsDir: input.artifactsDir, workflowRunId: input.parentWorkflowRunId, aggregateOutputPath: input.aggregateOutputPath, configuredOutputBaseDir: input.configuredOutputBaseDir, discoverAgents: input.discoverAgents, workflowAgentScope: input.workflowAgentScope, key: input.workflowKey, params: input.childParams });
		if (resolvedOutput) childParams = { ...input.childParams, output: resolvedOutput };
	}
	return prepareWorkflowLaunchParams(input.workflowDefaults, childParams, input.parentWorkflowRunId, input.workflowKey, input.options);
}

function finalizeSingleWorktreeHandoff(input: {
	worktreeSetup: WorktreeSetup;
	artifactsDir: string;
	runId: string;
	cwd: string;
	agent: string;
	result: SingleResult;
}): { suffix: string; reference?: NonNullable<Details["parallelHandoff"]> } {
	const diffsDir = path.join(input.artifactsDir, "worktree-diffs", input.runId);
	const diffs = diffWorktrees(input.worktreeSetup, [input.agent], diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	const manifestPath = parallelHandoffPath(input.artifactsDir, input.runId);
	const handoff = {
		manifestPath,
		runId: input.runId,
		mode: "single" as const,
		source: "foreground" as const,
		cwd: input.cwd,
		stepIndex: 0,
		flatStartIndex: 0,
		setup: input.worktreeSetup,
		diffs,
		results: [{
			agent: input.result.agent,
			status: resolveSubagentResultStatus(omitUndefinedProperties({
				exitCode: input.result.exitCode,
				interrupted: input.result.interrupted,
				detached: input.result.detached,
				state: input.result.stopped ? "stopped" : undefined,
				processSignal: input.result.processSignal,
				timedOut: input.result.timedOut,
				stopped: input.result.stopped,
				turnBudgetExceeded: input.result.turnBudgetExceeded,
			})),
			summary: resultSummaryForIntercom(input.result),
			...(input.result.artifactPaths?.outputPath ? { outputPath: input.result.artifactPaths.outputPath } : {}),
			...(input.result.structuredOutput !== undefined ? { structuredOutput: input.result.structuredOutput } : {}),
			...(input.result.structuredOutputPath ? { structuredOutputPath: input.result.structuredOutputPath } : {}),
			...(input.result.sessionFile ? { sessionPath: input.result.sessionFile } : {}),
		}],
	};
	try {
		writeParallelHandoffGroup(handoff);
		const cleanup = cleanupWorktrees(input.worktreeSetup, { kind: "preserve", capturedDiffs: diffs, handoffManifestPath: manifestPath });
		const reference = writeParallelHandoffGroup({ ...handoff, cleanup });
		return {
			suffix: [diffSummary, formatParallelHandoffReference(reference)].filter(Boolean).join("\n\n"),
			reference,
		};
	} catch (error) {
		return { suffix: [diffSummary, formatParallelHandoffError(error)].filter(Boolean).join("\n\n") };
	}
}

async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, 0) : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const effectiveToolBudget = resolveEffectiveToolBudget(omitUndefinedProperties({ runBudget: data.toolBudget, agentBudget: agentConfig.toolBudget, configBudget: data.configToolBudget }));
	if (effectiveToolBudget.error) return toExecutionErrorResult(params, new Error(effectiveToolBudget.error), data.contextPolicy.contextSummary);

	const parentModel = data.parentModel;
	const currentProvider = parentModel?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveEffectiveSubagentModel(
		params.model as string | undefined,
		agentConfig.model,
		parentModel,
		availableModels,
		currentProvider,
		data.modelScope === undefined ? {} : { scope: data.modelScope },
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	let readsOverride: string[] | false | undefined = params.reads;
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);


	const sourceCwd = effectiveCwd;
	const { setup: worktreeSetup, errorResult: worktreeSetupError } = createSingleWorktreeSetup(
		params.worktree,
		sourceCwd,
		runId,
		params.agent!,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
		deps.config.worktreeBaseDir,
	);
	if (worktreeSetupError) return worktreeSetupError;
	const singleCwd = worktreeSetup?.worktrees[0]?.agentCwd ?? sourceCwd;
	let pendingHandoff: Details["parallelHandoff"];
	if (worktreeSetup) {
		try {
			pendingHandoff = writePendingParallelHandoff({
				manifestPath: parallelHandoffPath(artifactsDir, runId),
				runId,
				mode: "single",
				source: "foreground",
				cwd: sourceCwd,
				stepIndex: 0,
				flatStartIndex: 0,
				setup: worktreeSetup,
			});
		} catch (error) {
			cleanupWorktrees(worktreeSetup);
			return { content: [{ type: "text", text: formatParallelHandoffError(error) }], isError: true, details: { mode: "single", results: [] } };
		}
	}

	const authoredTask = task;
	if (shouldForkAgent(contextPolicy, params.agent!)) {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, singleCwd, resolveSingleRunOutputBaseDir(deps, artifactsDir, runId));
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	const structuredRuntime = params.outputSchema
		? createStructuredOutputRuntime(params.outputSchema, artifactConfig.enabled ? path.join(artifactsDir, "structured-output", runId) : undefined)
		: undefined;
	// Reads: caller override > agent defaultReads > none. `~`/`~/` expand to home;
	// absolute paths pass through; relative paths resolve against the child cwd.
	const reads = readsOverride !== undefined ? readsOverride : agentConfig.defaultReads ?? false;
	const readPaths = Array.isArray(reads) ? resolveExistingReadPaths(reads, singleCwd) : [];
	const readsInstruction = readPaths.length > 0
		? `[Read from: ${readPaths.join(", ")}]\n\n`
		: "";
	task = readsInstruction + task;
	task = injectSingleOutputInstruction(task, outputPath, agentConfig);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	let detachForeground: ((reason?: string) => boolean) | undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	if (foregroundControl) {
		const thinking = resolveEffectiveThinking(modelOverride, thinkingOverrideForTask(params.agent!, 0, modelOverride));
		beginForegroundChild(foregroundControl, omitUndefinedProperties({
			index: 0,
			agent: params.agent!,
			authoredTask,
			effectivePrompt: task,
			cwd: singleCwd,
			outputPath,
			rerun: { params: { ...params, task: authoredTask, async: params.async ?? false } },
			description: foregroundControl.description,
			...(modelOverride ? { model: modelOverride } : {}),
			...(thinking ? { thinking } : {}),
			interrupt: () => {
				if (interruptController.signal.aborted) return false;
				interruptController.abort();
				return true;
			},
			detach: () => detachForeground?.("user request") === true,
		}));
	}

	const forwardSingleUpdate = onUpdate
		? (update: AgentToolResult<Details>) => {
			if (foregroundControl) updateForegroundChild(foregroundControl, 0, update.details?.progress?.[0]);
			onUpdate(update);
		}
		: undefined;

	const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
	let r: Awaited<ReturnType<typeof runSync>> | undefined;
	try {
		r = await runSync(ctx.cwd, agents, params.agent!, task, compactOptional<Parameters<typeof runSync>[4]>({
			permissions: deps.config.permissions,
			parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
			llmIntentArbiter: createTaskMutationArbiter(ctx),
			...workflowForegroundSteeringLaunchOptions(foregroundControl, 0),
			context: data.contextPolicy.contextForAgent(params.agent!),
			runFanoutBudget: params.runFanoutAdmitted ? data.runFanoutBudget : { ...data.runFanoutBudget, parentPath: `${data.runFanoutBudget.parentPath ? `${data.runFanoutBudget.parentPath}/` : ""}single` },
			cwd: singleCwd,
			signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: deps.pi.events,
			runId,
			sessionDir: sessionDirForIndex(0),
			sessionFile: sessionFileForTask(params.agent!, 0, modelOverride),
			share: shareEnabled,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			maxOutput: params.maxOutput,
			outputPath,
			outputMode: effectiveOutputMode,
			maxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			onUpdate: forwardSingleUpdate,
			controlConfig,
			onControlEvent,
			intercomSessionName: childIntercomTarget,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			nestedRoute: foregroundControl?.nestedRoute,
			index: 0,
			modelOverride,
			thinkingOverride: thinkingOverrideForTask(params.agent!, 0, modelOverride),
			availableModels,
			preferredModelProvider: currentProvider,
			modelScope: data.modelScope,
			skills: effectiveSkills,
			structuredOutput: structuredRuntime,
			agentContract: params.agentContract,
			acceptance: params.acceptance,
			acceptanceContext: { mode: "single" },
			onEffectivePrompt: foregroundControl ? (prompt) => updateLiveEffectivePrompt(foregroundControl, 0, prompt) : undefined,
			onDetachReady: (detach) => {
				detachForeground = detach;
			},
			onDetachedExit: (result) => {
				try {
					try {
						updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: singleCwd, sessionId: data.parentSessionId, index: 0, result, events: deps.pi.events, notify: params.workflowParentRunId === undefined });
					} catch {
						// Remembered foreground state is best-effort; run history and cleanup must still complete.
					}
				} finally {
					try {
						if (!artifactConfig.enabled) cleanupStructuredOutputRuntime(structuredRuntime);
					} finally {
						try {
							if (foregroundControl) finishForegroundChild(foregroundControl, 0);
						} finally {
							removeForegroundControlIfIdle(deps.state, runId);
						}
					}
				}
				recordRun(params.agent!, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
			},
			timeoutMs: data.timeoutMs,
			deadlineAt,
			toolTimeoutMs: params.toolTimeoutMs,
			configToolTimeoutMs: data.configToolTimeoutMs,
			turnBudget: data.turnBudget,
			enforceHardTurnLimit: params.enforceHardTurnLimit,
			toolBudget: effectiveToolBudget.toolBudget,
			capabilityCeiling: data.capabilityCeiling,
			allowZeroToolBudget: data.allowZeroToolBudget && effectiveToolBudget.toolBudget === data.toolBudget,
		}));
	} catch (error) {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
		throw error;
	} finally {
		// An attached runSync rejection still owns its child and structured runtime.
		// A successful detached receipt transfers both to onDetachedExit while the
		// authoritative completion remains live.
		if (!r?.detached) {
			if (!artifactConfig.enabled) cleanupStructuredOutputRuntime(structuredRuntime);
			if (foregroundControl) finishForegroundChild(foregroundControl, 0);
		}
	}
	if (!r.detached) {
		recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);
	}

	let worktreeHandoff: ReturnType<typeof finalizeSingleWorktreeHandoff> | undefined;
	if (worktreeSetup) {
		worktreeHandoff = r.detached
			? { suffix: pendingHandoff ? formatParallelHandoffReference(pendingHandoff) : "", reference: pendingHandoff }
			: finalizeSingleWorktreeHandoff({ worktreeSetup, artifactsDir, runId, cwd: sourceCwd, agent: params.agent!, result: r });
	}

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const preserveRejectedSavedOutput = r.acceptance?.explicit && r.acceptance.status === "rejected" && r.savedOutputPath !== undefined;
	const finalizedOutput = finalizeSingleOutput(omitUndefinedProperties({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		preserveSavedOutput: preserveRejectedSavedOutput,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	}));
	if (foregroundControl) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, [r], foregroundControl.nestedChildren);
	}
	const totalCost = sumResultsCost([r]);
	const details = compactForegroundDetails(compactOptional<Details>({
		mode: "single",
		runId,
		timeoutMs: data.timeoutMs,
		results: [r],
		...(data.turnBudget ? { turnBudget: data.turnBudget } : {}),
		...(effectiveToolBudget.toolBudget ? { toolBudget: effectiveToolBudget.toolBudget } : {}),
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
		totalChildUsage: sumResultsUsage([r]),
		totalCost,
		usageBudget: usageBudgetState(data.usageBudget, totalCost),
		...(worktreeHandoff?.reference ? { parallelHandoff: worktreeHandoff.reference } : {}),
	}));
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: singleCwd, sessionId: data.parentSessionId, results: details.results });

	const suppressRoutineResultIntercom = shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: params.suppressRoutineResultIntercom, results: [r] });
	if (!r.detached && !r.interrupted && !suppressRoutineResultIntercom) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
			...(params.workflowParentRunId !== undefined ? { preserveDetailsOutputs: true } : {}),
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	const worktreeSuffix = worktreeHandoff?.suffix ? `\n\n${worktreeHandoff.suffix}` : "";
	if (r.detached) {
		const statusRecovery = `subagent({ action: "status", id: "${runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.`;
		const blockingRecovery = `subagent_wait({ id: "${runId}" }). Use ${statusRecovery}`;
		const message = r.detachedReason === "intercom coordination"
			? `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first, then wait with ${blockingRecovery}`
			: r.detachedReason === "user request"
				? `Detached at user request: ${params.agent}. The child continues independently. Register a completion wake-up with subagent_wait({ id: "${runId}", nonBlocking: true }), or use ${statusRecovery}`
				: `Detached before task completion: ${params.agent}. Wait with ${blockingRecovery}`;
		return {
			content: [{ type: "text", text: `${message}${worktreeSuffix}` }],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.${worktreeSuffix}` }],
			details,
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: `${formatFailedSingleRunOutput(r, finalizedOutput.displayOutput)}${worktreeSuffix}` }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: `${finalizedOutput.displayOutput || "(no output)"}${worktreeSuffix}` }],
		details,
	};
}

function inferExecutionMode(params: SubagentParamsLike): Details["mode"] {
	if (params.workflowScript !== undefined) return "workflow";
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

function duplicateSubagentCallResult(params: SubagentParamsLike): AgentToolResult<Details> {
	return {
		content: [{
			type: "text",
			text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
		}],
		isError: true,
		details: { mode: inferExecutionMode(params), results: [] },
	};
}

const workflowLaunchObservers = new WeakMap<object, (launch: { agent: string; sessionFile?: string; async: boolean; runId?: string }) => void>();

/**
 * Terminal-mission retention can remove a mission while its children still
 * report. Remember it to prevent later heartbeats from warning repeatedly.
 */
const missionsMissingFromStore = new Set<string>();

function recordMissionWorkflowChild(
	binding: MissionLaunchBinding | undefined,
	workflowRunId: string,
	key: string,
	update: Omit<MissionWorkflowChildUpdate, "workflowRunId" | "key">,
): void {
	if (!binding || missionsMissingFromStore.has(binding.missionId)) return;
	const { task: _task, ...durableUpdate } = update;
	try {
		updateMission(binding.location, binding.missionId, { upsertWorkflowChildren: [{ workflowRunId, key, ...durableUpdate }] });
	} catch (error) {
		if (error instanceof MissionNotFoundError) {
			missionsMissingFromStore.add(binding.missionId);
			console.warn(`[pi-subagents] Mission '${binding.missionId}' is no longer in the mission store; stopped recording its workflow children. Terminal-mission retention can prune a mission while its run is still active.`);
			return;
		}
		console.warn(`[pi-subagents] Failed to record mission workflow child '${key}': ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function missionWorkflowChildStatus(result: AgentToolResult<Details>): string {
	const childResults = result.details.results;
	if (childResults.some((child) => child.detached || child.interrupted)) return "paused";
	if (result.isError === true || childResults.some((child) => child.exitCode !== 0)) return "failed";
	if (childResults.length === 0 && (result.details.asyncId || result.details.asyncDir)) return "running";
	return "completed";
}

export async function runMissionWorkflowChild(
	binding: MissionLaunchBinding | undefined,
	workflowRunId: string,
	key: string,
	phase: string | undefined,
	run: () => Promise<AgentToolResult<Details>>,
): Promise<AgentToolResult<Details>> {
	try {
		return await run();
	} catch (error) {
		recordMissionWorkflowChild(binding, workflowRunId, key, {
			status: "failed",
			completedAt: new Date().toISOString(),
			heartbeat: { status: "failed", ...(phase ? { phase } : {}), message: error instanceof Error ? error.message : String(error) },
		});
		throw error;
	}
}

export function bindMissionWorkflowChildAsyncLaunch(
	params: SubagentParamsLike,
	binding: MissionLaunchBinding | undefined,
	asyncByDefault: boolean,
	asyncId: string = randomUUID(),
): SubagentParamsLike {
	const requestedAsync = params.async ?? asyncByDefault;
	if (!binding || !requestedAsync || params.clarify === true) return params;
	const id = asyncId.trim();
	if (!id || path.basename(id) !== id) throw new Error("workflow child async id must be a single path segment");
	writeMissionAsyncBinding(path.join(DIRS.async, id), binding);
	return { ...params, workflowChildAsyncId: id };
}

function workflowChildResult(key: string, result: AgentToolResult<Details>): WorkflowScriptChildResult {
	const receiptOutput = result.content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
	const output = result.details.results.length === 1 && result.details.results[0]?.finalOutput !== undefined
		? result.details.results[0].finalOutput
		: receiptOutput;
	const detached = result.details.results.some((child) => child.detached);
	const ok = result.isError !== true && !detached;
	const artifactPaths = new Set<string>();
	if (result.details.asyncDir) artifactPaths.add(result.details.asyncDir);
	if (result.details.parallelHandoff?.path) artifactPaths.add(result.details.parallelHandoff.path);
	for (const child of result.details.results) {
		if (child.savedOutputPath) artifactPaths.add(child.savedOutputPath);
		if (child.outputReference?.path) artifactPaths.add(child.outputReference.path);
		if (child.sessionFile) artifactPaths.add(child.sessionFile);
	}
	const structured = result.details.results.map((child) => child.structuredOutput).filter((value) => value !== undefined);
	const resolvedAgents = [...new Set(result.details.results.map((child) => child.agent).filter((agent): agent is string => Boolean(agent)))];
	return {
		key,
		ok,
		...(resolvedAgents.length === 1 ? { agent: resolvedAgents[0] } : {}),
		...(result.details.runId || result.details.asyncId ? { runId: result.details.runId ?? result.details.asyncId } : {}),
		output,
		...(!ok ? { error: receiptOutput || output || "Child run failed." } : {}),
		...(detached ? { detached: true } : {}),
		...(structured.length === 1 ? { structuredOutput: structured[0] } : structured.length > 1 ? { structuredOutput: structured } : {}),
		artifactPaths: [...artifactPaths],
		results: result.details.results,
	};
}

function workflowSteerReceipt(key: string, result: AgentToolResult<Details>): WorkflowSteerResult {
	const steering = result.details.steering;
	const error = result.content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n") || undefined;
	if (!steering) return { key, state: "failed", ...(error ? { error } : {}) };
	const state = result.isError === true || steering.state === "failed" || steering.state === "partial"
		? "failed"
		: steering.deliveryStatus === "delivered" ? "delivered" : "queued";
	return {
		key,
		state,
		requestId: steering.requestId,
		deliveryStatus: steering.deliveryStatus,
		targets: steering.targets.map((target) => ({ index: target.index, state: target.state, ...(target.reason ? { reason: target.reason } : {}) })),
		...(state === "failed" && error ? { error } : {}),
	};
}

export async function steerWorkflowChildByKey(input: {
	state: SubagentState;
	workflowRunId: string;
	key: string;
	message: string;
	options: WorkflowSteerOptions;
	signal?: AbortSignal;
	asyncDirRoot?: string;
	resolveRunId?: () => string | undefined;
}): Promise<WorkflowSteerResult> {
	const asyncDirRoot = input.asyncDirRoot ?? DIRS.async;
	const ackTimeoutMs = input.options.ackTimeoutMs ?? 3_000;
	const deadline = Date.now() + ackTimeoutMs;
	while (true) {
		const control = [...input.state.foregroundControls.values()].find((candidate) => candidate.parentWorkflowRunId === input.workflowRunId
			&& candidate.workflowKey === input.key
			&& Boolean(candidate.workflowSteeringDir)
			&& (candidate.activeChildren?.size ?? 0) > 0);
		if (control) {
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId: input.workflowRunId, sourceRunId: control.runId },
				message: input.message,
				mode: input.options.mode,
				index: input.options.index,
				ackTimeoutMs: Math.max(1, deadline - Date.now()),
				signal: input.signal,
			});
			return workflowSteerReceipt(input.key, result);
		}

		const workflowStatus = readStatus(path.join(asyncDirRoot, input.workflowRunId));
		const step = workflowStatus?.steps?.find((candidate) => candidate.workflowKey === input.key);
		const childRunId = step?.runId ?? input.resolveRunId?.();
		if (childRunId) {
			const asyncDir = path.join(asyncDirRoot, childRunId);
			const childStatus = reconcileAsyncRun(asyncDir).status;
			if (childStatus && childStatus.state !== "running" && childStatus.state !== "queued" && (input.options.mode !== "follow_up" || !canQueueRetainedAsyncFollowUp(childStatus, input.options.index))) {
				return { key: input.key, state: "missed", error: `Workflow child '${input.key}' is ${childStatus.state}.` };
			}
			if (childStatus) {
				const result = await steerAsyncRun({
					state: input.state,
					runId: childRunId,
					message: input.message,
					mode: input.options.mode,
					index: input.options.index,
					ackTimeoutMs: Math.max(1, deadline - Date.now()),
					location: { asyncDir },
					signal: input.signal,
				});
				return workflowSteerReceipt(input.key, result);
			}
		}
		if (step && step.status !== "running" && step.status !== "pending") {
			return { key: input.key, state: "missed", error: `Workflow child '${input.key}' is ${step.status}.` };
		}
		if (workflowStatus && workflowStatus.state !== "running" && workflowStatus.state !== "queued") {
			return { key: input.key, state: "missed", error: `Workflow '${input.workflowRunId}' is ${workflowStatus.state}.` };
		}
		if (input.signal?.aborted || Date.now() >= deadline) {
			return { key: input.key, state: "missed", error: `Workflow child '${input.key}' had no live steering route.` };
		}
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
	}
}

export function prepareWorkflowLaunchParams(
	workflowDefaults: SubagentParamsLike,
	childParams: Record<string, unknown>,
	parentWorkflowRunId: string,
	workflowKey: string,
	options: { missionDetached?: boolean; suppressRoutineResultIntercom?: boolean; runFanoutBudget?: RunFanoutBudgetDescriptor; parentDeadlineAt?: number } = {},
): SubagentParamsLike {
	const parentTimeoutMs = options.parentDeadlineAt === undefined
		|| childParams.timeoutMs !== undefined
		|| childParams.maxRuntimeMs !== undefined
		|| workflowDefaults.timeoutMs !== undefined
		|| workflowDefaults.maxRuntimeMs !== undefined
		? undefined
		: Math.max(1, options.parentDeadlineAt - Date.now());
	if (typeof childParams.resume === "string") {
		if (childParams.gate !== undefined || workflowDefaults.gate !== undefined) {
			throw new Error("gate is not supported with retained resume; resume uses the retained child contract.");
		}
		const timeoutMs = childParams.timeoutMs ?? childParams.maxRuntimeMs ?? workflowDefaults.timeoutMs ?? workflowDefaults.maxRuntimeMs;
		const turnBudget = childParams.turnBudget ?? workflowDefaults.turnBudget;
		const toolBudget = childParams.toolBudget ?? workflowDefaults.toolBudget;
		const intercomBridge = childParams.intercomBridge ?? workflowDefaults.intercomBridge;
		const worktree = childParams.worktree ?? workflowDefaults.worktree;
		return {
			action: "resume",
			id: childParams.resume.trim(),
			message: typeof childParams.task === "string" ? childParams.task.trim() : "",
			workflowParentRunId: parentWorkflowRunId,
			workflowKey,
			...(worktree !== undefined ? { worktree: worktree as boolean } : {}),
			...(options.runFanoutBudget ? { runFanoutBudget: { ...options.runFanoutBudget, parentPath: `${options.runFanoutBudget.parentPath ? `${options.runFanoutBudget.parentPath}/` : ""}workflow[${workflowKey}]` } } : {}),
			...(options.missionDetached ? { mission: false } : {}),
			...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
			...(turnBudget !== undefined ? { turnBudget: turnBudget as TurnBudgetConfig } : {}),
			...(toolBudget !== undefined ? { toolBudget: toolBudget as ToolBudgetConfig } : {}),
			...(intercomBridge !== undefined ? { intercomBridge: intercomBridge as IntercomBridgeConfig } : {}),
		};
	}
	const launchParams = {
		...workflowDefaults,
		async: false,
		...childParams,
		...(options.missionDetached ? { mission: false } : {}),
		workflowParentRunId: parentWorkflowRunId,
		workflowKey,
		...(parentTimeoutMs !== undefined ? { workflowParentDeadlineAt: options.parentDeadlineAt } : {}),
		...(options.runFanoutBudget ? { runFanoutBudget: { ...options.runFanoutBudget, parentPath: `${options.runFanoutBudget.parentPath ? `${options.runFanoutBudget.parentPath}/` : ""}workflow[${workflowKey}]` } } : {}),
		...(options.suppressRoutineResultIntercom ? { suppressRoutineResultIntercom: true } : {}),
	} as SubagentParamsLike;
	const normalizedGate = normalizeGateParams(launchParams);
	if (!normalizedGate.ok) throw new Error(normalizedGate.error);
	return normalizedGate.params;
}

type GateParamsNormalizationResult =
	| { ok: true; params: SubagentParamsLike }
	| { ok: false; error: string };

function normalizeGateParams(params: SubagentParamsLike): GateParamsNormalizationResult {
	if (params.gate !== undefined && params.action === "resume") {
		return { ok: false, error: "gate is not supported with action='resume'; resume uses the retained child contract." };
	}
	const normalized = normalizeGateAcceptance(params.gate, params.acceptance);
	if (!normalized.ok) return { ok: false, error: normalized.error };
	if (params.gate === undefined) return { ok: true, params };
	const { gate: _gate, ...rest } = params;
	return { ok: true, params: { ...rest, ...(normalized.acceptance !== undefined ? { acceptance: normalized.acceptance } : {}) } };
}

function formatWorkflowValue(value: unknown): string {
	if (value === undefined) return "(undefined)";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function workflowChatProgressUpdate(
	runId: string,
	chatProgress: WorkflowChatProgressProjection,
	workflow: NonNullable<Details["workflow"]>,
): AgentToolResult<Details> | undefined {
	if (chatProgress.mode !== "live-card") return undefined;
	return {
		content: [{ type: "text", text: "Workflow running." }],
		details: { mode: "workflow", runId, results: [], workflow, chatProgress },
	};
}

function createScheduledOwnerState(source: SubagentState, ownerSessionId: string, ctx: ExtensionContext): SubagentState {
	const ownerSpawns = source.subagentSpawns?.sessionId === ownerSessionId
		? {
			...source.subagentSpawns,
			grantHistory: [...(source.subagentSpawns.grantHistory ?? [])],
		}
		: undefined;
	return {
		...source,
		baseCwd: ctx.cwd,
		currentSessionId: ownerSessionId,
		parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
		subagentInProgress: false,
		...(ownerSpawns ? { subagentSpawns: ownerSpawns } : { subagentSpawns: undefined }),
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		waitSubscriptions: new Map(),
		workflowControllers: new Map(),
	};
}

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	/** Public/model-facing execution boundary. Internal direct launch primitives use execute or executeDelegated. */
	executePublic: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	/**
	 * Correlated extension-to-extension delegation owns its request IDs and
	 * cancellation controllers, so independent requests may execute concurrently.
	 * The ordinary model-facing tool keeps the one-foreground-call-per-turn guard.
	 */
	executeDelegated: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	/** Scheduled launches retain their owning context without replacing the live active session. */
	executeScheduled: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
} {
	const delegatedThinkingOverrides = new WeakMap<object, AgentConfig["thinking"]>();
	const delegatedZeroToolBudgets = new WeakSet<object>();
	const delegatedExecutions = new WeakSet<object>();
	const warnedArtifactPackageDirs = new Set<string>();
	const scheduledOwnerExecutors = new Map<string, ReturnType<typeof createSubagentExecutor>>();
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		preserveActiveSession = false,
	): Promise<AgentToolResult<Details>> => {
		const workflowLaunchObserver = workflowLaunchObservers.get(params);
		const delegatedThinkingOverride = delegatedThinkingOverrides.get(params);
		const allowZeroToolBudget = delegatedZeroToolBudgets.has(params);
		const delegatedExecution = delegatedExecutions.has(params);
		if (!preserveActiveSession) deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const normalizedGate = normalizeGateParams(params);
		if (!normalizedGate.ok) return buildRequestedModeError(params, normalizedGate.error);
		const requestParams = normalizedGate.params;
		const normalizedAction = typeof requestParams.action === "string" ? requestParams.action.trim() : requestParams.action;
		if (requestParams.workflowScript !== undefined && normalizedAction === undefined) {
			const parentCwd = ctx.cwd;
			const timeout = requestParams.timeoutMs ?? requestParams.maxRuntimeMs ?? (requestParams.async === false ? resolveConfigDefaultTimeoutMs(deps.config.timeoutMs) ?? DEFAULT_FOREGROUND_TIMEOUT_MS : undefined);
			const workflowUsageBudget = validateUsageBudgetConfig(requestParams.usageBudget ?? deps.config.usageBudget, requestParams.usageBudget ? "usageBudget" : "config.usageBudget");
			if (workflowUsageBudget.error) return buildRequestedModeError(requestParams, workflowUsageBudget.error);
			const workflowCwd = resolveRequestedCwd(parentCwd, requestParams.cwd);
			const workflowArtifactConfig: ArtifactConfig = omitUndefinedProperties({
				...DEFAULT_ARTIFACT_CONFIG,
				enabled: requestParams.artifacts !== false,
				dir: deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
			});
			const workflowArtifactsDir = getArtifactsDir(ctx.sessionManager.getSessionFile() ?? null, workflowCwd, workflowArtifactConfig.dir);
			if (workflowArtifactConfig.dir === "project" && !warnedArtifactPackageDirs.has(workflowCwd)) {
				warnedArtifactPackageDirs.add(workflowCwd);
				const warning = getProjectArtifactPackagingWarning(workflowCwd);
				if (warning) console.warn(`[pi-subagents] ${warning}`);
			}
			const chatProgressResult = resolveWorkflowChatProgress({ requested: requestParams.chatProgress, parentCwd, workflowCwd, background: requestParams.async !== false });
			if (chatProgressResult.error) return { content: [{ type: "text", text: chatProgressResult.error }], isError: true, details: { mode: "workflow", results: [] } };
			const chatProgress = chatProgressResult.projection!;
			const explicitMission = requestParams.missionId !== undefined || requestParams.mission !== undefined;
			const autoMission = !explicitMission;
			const workflowPreview = autoMission ? previewSimpleWorkflowRun(requestParams.workflowScript) : undefined;
			const previewAgent = workflowPreview?.agent?.trim() || undefined;
			const scriptFirstLine = requestParams.workflowScript.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Workflow";
			const boundedScriptPreview = scriptFirstLine.length > 100 ? `${scriptFirstLine.slice(0, 97)}...` : scriptFirstLine;
			const derivedObjective = previewAgent ? `Workflow: ${previewAgent}` : boundedScriptPreview;
			const workflowDepth = checkSubagentDepth(deps.config.maxSubagentDepth).depth;
			const asyncWorkflow = requestParams.async !== false;
			const topLevelAsyncWorkflow = asyncWorkflow
				&& workflowDepth === 0
				&& !resolveInheritedNestedRouteFromEnv()
				&& !requestParams.workflowParentRunId;
			const workflowRunId = asyncWorkflow ? randomUUID() : undefined;
			let workflowCapacity: ActiveAsyncCapacityHandle | undefined;
			if (workflowRunId && topLevelAsyncWorkflow) {
				const currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				try {
					workflowCapacity = acquireActiveAsyncCapacity({
						sessionId: currentSessionId,
						limit: resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession),
						runId: workflowRunId,
						kind: "workflow",
						asyncDir: path.join(DIRS.async, workflowRunId),
					}, { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []) });
				} catch (error) {
					if (error instanceof ActiveAsyncCapacityError) {
						deps.state.activeAsyncCapacity = error.snapshot;
						return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: "workflow", results: [], activeAsyncCapacity: error.snapshot } };
					}
					throw error;
				}
			}
			let workflowFanoutBudget: RunFanoutBudgetDescriptor;
			try {
				workflowFanoutBudget = requestParams.runFanoutBudget
					?? decodeRunFanoutBudgetDescriptor(process.env[RUN_FANOUT_BUDGET_ENV])
					?? createRunFanoutBudget(_id, resolveMaxSubagentSpawnsPerRun(deps.config.maxSubagentSpawnsPerRun));
			} catch (error) {
				workflowCapacity?.rollback();
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "workflow", results: [] } };
			}
			let missionBinding: MissionLaunchBinding | undefined;
			let missionWarning: string | undefined;
			try {
				missionBinding = prepareMissionLaunch({
					params: autoMission ? { ...requestParams, task: derivedObjective } : requestParams,
					projectRoot: workflowCwd,
					...(deps.config.missions ? { config: deps.config.missions } : {}),
					ownerSessionId: resolveCurrentSessionId(ctx.sessionManager),
				});
			} catch (error) {
				if (explicitMission) {
					workflowCapacity?.rollback();
					return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "workflow", results: [] } };
				}
				missionWarning = `Mission tracking unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}
			const detachWorkflowChildMissions = autoMission || missionBinding !== undefined || requestParams.mission === false;
			const workflowState = missionBinding ? createMissionWorkflowState(missionBinding.location, missionBinding.missionId) : undefined;
			const attachWorkflowMission = (result: AgentToolResult<Details>): AgentToolResult<Details> => {
				if (!missionBinding) return missionWarning ? { ...result, details: { ...result.details, missionWarning } } : result;
				try {
					return attachMissionToLaunchResult({ binding: missionBinding, result });
				} catch (error) {
					const warning = `Mission tracking unavailable after launch: ${error instanceof Error ? error.message : String(error)}`;
					return explicitMission
						? { ...result, isError: true, content: [...result.content, { type: "text", text: warning }], details: { ...result.details, missionWarning: warning } }
						: { ...result, details: { ...result.details, missionWarning: warning } };
				}
			};
			if (workflowRunId) {
				const toolCallId = _id;
				const workflowSessionRoot = requestParams.sessionDir
					? path.resolve(deps.expandTilde(requestParams.sessionDir))
					: trustedSessionRootsForStatus(ctx, deps)[0];
				const asyncDir = path.join(DIRS.async, workflowRunId);
				const resultPath = resultFilePath(DIRS.results, workflowRunId);
				const statusPath = path.join(asyncDir, "status.json");
				const eventsPath = path.join(asyncDir, "events.jsonl");
				const startedAt = Date.now();
				const currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const completionOwnerId = deps.state.completionOwnerId ?? currentCompletionOwnerId();
				deps.state.completionOwnerId = completionOwnerId;
				try {
					fs.mkdirSync(asyncDir, { recursive: true });
					writeRunFanoutBudgetDescriptor(asyncDir, workflowFanoutBudget);
					fs.mkdirSync(DIRS.results, { recursive: true });
				} catch (error) {
					workflowCapacity?.rollback();
					return { content: [{ type: "text", text: `Failed to create async workflow storage: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "workflow", results: [] } };
				}
				const controller = new AbortController();
				deps.state.workflowControllers ??= new Map();
				deps.state.workflowControllers.set(workflowRunId, controller);
				workflowCapacity?.markWorkflowStarted();
				if (workflowCapacity) deps.state.activeAsyncCapacity = getActiveAsyncCapacitySnapshot(currentSessionId, resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession), { liveWorkflowRunIds: new Set(deps.state.workflowControllers.keys()) });
				let status: AsyncStatus = {
					runId: workflowRunId,
					toolCallId,
					sessionId: currentSessionId ?? undefined,
					completionOwnerId,
					mode: "workflow",
					state: "running",
					startedAt,
					lastUpdate: startedAt,
					...(timeout !== undefined ? { deadlineAt: startedAt + timeout, timeoutMs: timeout } : {}),
					cwd: workflowCwd,
					...(workflowSessionRoot ? { sessionRoot: workflowSessionRoot } : {}),
					pid: process.pid,
					steps: [],
					workflow: { trace: [], emits: [], console: [] },
					runFanoutBudget: getRunFanoutBudgetSnapshot(workflowFanoutBudget),
				};
				const appendWorkflowEvent = (event: Record<string, unknown>) => {
					try {
						fs.appendFileSync(eventsPath, `${JSON.stringify({ ts: Date.now(), runId: workflowRunId, ...event })}\n`, "utf-8");
					} catch (error) {
						if (!isStorageCapacityError(error)) throw error;
						console.error(`Failed to append async workflow event while storage is full:`, error);
					}
				};
				let indexedState: AsyncStatus["state"] | undefined;
				const indexPersistence = createCapacityResilientJsonWriter({
					keepAlive: true,
					onSuccess: (_filePath, payload) => { indexedState = (payload as { state: AsyncStatus["state"] }).state; },
					onError: (error, filePath) => console.error(`Failed to update async workflow index '${filePath}':`, error),
				});
				const queueActiveRunIndex = (): void => {
					const state = status.state;
					if (indexedState === state && indexPersistence.pendingCount() === 0) return;
					indexPersistence.write(asyncDir, { state, toolCallId: status.toolCallId }, (_filePath, payload) => {
						const indexPayload = payload as { state: AsyncStatus["state"]; toolCallId?: string };
						updateActiveRunIndex(asyncDir, indexPayload.state, indexPayload.toolCallId, { retryCapacityErrors: true });
					});
				};
				const runPersistence = createCapacityResilientJsonWriter({
					keepAlive: true,
					onSuccess: (filePath) => { if (filePath === statusPath) queueActiveRunIndex(); },
					onError: (error, filePath) => console.error(`Failed to persist async workflow state '${filePath}':`, error),
					write: (filePath, payload) => filePath === resultPath
						? writeAsyncResultFile(filePath, payload as Record<string, unknown>)
						: writeAtomicJson(filePath, payload),
				});
				let initialPersistenceComplete = false;
				const persist = () => {
					status.lastUpdate = Date.now();
					if (initialPersistenceComplete) runPersistence.write(statusPath, status);
					else {
						writeAtomicJson(statusPath, status);
						initialPersistenceComplete = true;
						queueActiveRunIndex();
					}
					const job = deps.state.asyncJobs.get(workflowRunId);
					if (job) {
						job.status = status.state;
						job.updatedAt = status.lastUpdate;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount;
						job.toolCount = status.toolCount;
						job.currentStep = status.currentStep;
						if (status.steps) {
							job.steps = status.steps.map((step, index) => ({ ...step, index }));
							job.agents = status.steps.map((step) => step.agent);
						} else {
							delete job.steps;
							delete job.agents;
						}
						job.workflow = status.workflow;
					}
				};
				const writeWorkflowResult = (payload: Record<string, unknown>): boolean => {
					try {
						runPersistence.write(resultPath, payload);
						return true;
					} catch (error) {
						const message = `Failed to write async workflow result ${resultPath}: ${error instanceof Error ? error.message : String(error)}`;
						console.error(message, error);
						appendWorkflowEvent({ type: "subagent.workflow.result_write_failed", error: message });
						return false;
					}
				};
				const projectWorkflowActivity = () => {
					const steps = status.steps ?? [];
					const runningSteps = steps.filter((step) => step.status === "running");
					const lastActivityAt = runningSteps.reduce<number | undefined>((latest, step) => step.lastActivityAt === undefined ? latest : Math.max(latest ?? step.lastActivityAt, step.lastActivityAt), undefined);
					const activeToolStep = runningSteps
						.filter((step) => step.currentTool)
						.sort((left, right) => (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0))
						.at(-1);
					status.activityState = runningSteps.some((step) => step.activityState === "needs_attention")
						? "needs_attention"
						: runningSteps.some((step) => step.activityState === "active_long_running") ? "active_long_running" : undefined;
					status.lastActivityAt = lastActivityAt;
					status.currentTool = activeToolStep?.currentTool;
					status.currentToolStartedAt = activeToolStep?.currentToolStartedAt;
					status.currentPath = activeToolStep?.currentPath;
					const turnCounts = steps.flatMap((step) => step.turnCount === undefined ? [] : [step.turnCount]);
					const toolCounts = steps.flatMap((step) => step.toolCount === undefined ? [] : [step.toolCount]);
					status.turnCount = turnCounts.length > 0 ? turnCounts.reduce((total, count) => total + count, 0) : undefined;
					status.toolCount = toolCounts.length > 0 ? toolCounts.reduce((total, count) => total + count, 0) : undefined;
					status.currentStep = runningSteps.length === 1 ? steps.indexOf(runningSteps[0]!) : undefined;
				};
				const workflowJob: AsyncJobState = { asyncId: workflowRunId, asyncDir, toolCallId, cwd: workflowCwd, ...(workflowSessionRoot ? { sessionRoot: workflowSessionRoot } : {}), status: "running", sessionId: currentSessionId ?? undefined, mode: "workflow", agents: [], steps: [], startedAt, updatedAt: startedAt, ...(timeout !== undefined ? { timeoutMs: timeout, deadlineAt: startedAt + timeout } : {}), workflow: status.workflow };
				deps.state.asyncJobs.set(workflowRunId, workflowJob);
				deps.state.fleetJobs ??= new Map();
				deps.state.fleetJobs.set(workflowRunId, workflowJob);
				try {
					persist();
				} catch (error) {
					deps.state.workflowControllers?.delete(workflowRunId);
					deps.state.asyncJobs.delete(workflowRunId);
					deps.state.fleetJobs?.delete(workflowRunId);
					workflowCapacity?.rollback();
					indexPersistence.dispose();
					return { content: [{ type: "text", text: `Failed to create async workflow storage: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "workflow", results: [] } };
				}
				appendWorkflowEvent({ type: "subagent.workflow.started" });
				const { workflowScript, async: _workflowAsync, chatProgress: _chatProgress, ...workflowRequest } = requestParams;
				void Promise.resolve().then(async () => {
					const workflowDeadlineAt = timeout === undefined ? undefined : Date.now() + timeout;
					const workflowResults: SingleResult[] = [];
					const workflowChildRunIds = new Map<string, string>();
					const { action: _action, agent: _agent, task: _task, resume: _resume, tasks: _tasks, chain: _chain, concurrency: _concurrency, foregroundOnly: _foregroundOnly, clarify: _clarify, timeoutMs: _timeoutMs, maxRuntimeMs: _maxRuntimeMs, usageBudget: _usageBudget, missionId: _missionId, mission: _mission, ...workflowChildDefaults } = workflowRequest;
					const workflowOutput = typeof workflowChildDefaults.output === "string" || typeof workflowChildDefaults.output === "boolean" ? workflowChildDefaults.output : undefined;
					const configuredOutputBaseDir = resolveConfiguredSingleRunOutputBaseDir(deps);
					const workflowAggregateOutputPath = resolveWorkflowAggregateOutputPath(workflowOutput, ctx.cwd, workflowCwd, resolveSingleRunOutputBaseDir(deps, workflowArtifactsDir, workflowRunId), configuredOutputBaseDir);
					const claimedOutputPaths = new Map<string, string>();
					const producedChildOutputPaths = new Set<string>();
					const workflowSteps = new Map<string, NonNullable<AsyncStatus["steps"]>[number]>();
					let projectedTraceLength = 0;
					let projectedTraceTail: NonNullable<Details["workflow"]>["trace"][number] | undefined;
					const updateTrace = (trace: NonNullable<Details["workflow"]>["trace"]) => {
						status.workflow = { ...(status.workflow ?? { emits: [], console: [] }), trace };
						const rebuild = trace.length < projectedTraceLength
							|| (projectedTraceLength > 0 && trace[projectedTraceLength - 1] !== projectedTraceTail);
						if (rebuild) {
							workflowSteps.clear();
							for (const step of status.steps ?? []) {
								if (step.workflowKey) workflowSteps.set(step.workflowKey, step);
							}
							projectedTraceLength = 0;
						}
						for (let index = projectedTraceLength; index < trace.length; index += 1) {
							const entry = trace[index]!;
							if (entry.operation !== "run") continue;
							const existing = workflowSteps.get(entry.key);
							if (entry.state === "reused" && existing) continue;
							const mapped = entry.state === "started" || entry.state === "reused"
								? "running"
								: entry.state === "completed"
									? "completed"
									: entry.state === "stopped"
										? "stopped"
										: entry.state === "detached"
											? "paused"
											: "failed";
							if (existing) {
								existing.status = mapped;
								if (entry.agent) existing.agent = entry.agent;
								if (entry.runId) existing.runId = entry.runId;
								if (entry.state === "failed" && !entry.runId && existing.async === undefined) existing.async = false;
								if (entry.state === "detached") existing.activityState = "needs_attention";
								else if (existing.status !== "running") delete existing.activityState;
								if (entry.state === "stopped") existing.stopped = true;
								else delete existing.stopped;
								if (entry.error === undefined) delete existing.error;
								else existing.error = entry.error;
								if (entry.durationMs === undefined) delete existing.durationMs;
								else existing.durationMs = entry.durationMs;
							} else {
								const step: NonNullable<AsyncStatus["steps"]>[number] = {
									agent: entry.agent ?? entry.key,
									label: entry.key,
									workflowKey: entry.key,
									parentWorkflowRunId: workflowRunId,
									status: mapped,
									startedAt: Date.now(),
									...(entry.runId ? { runId: entry.runId } : {}),
									...(entry.state === "failed" && !entry.runId ? { async: false } : {}),
									...(entry.state === "detached" ? { activityState: "needs_attention" as const } : {}),
									...(entry.state === "stopped" ? { stopped: true } : {}),
								};
								status.steps?.push(step);
								workflowSteps.set(entry.key, step);
							}
						}
						projectedTraceLength = trace.length;
						projectedTraceTail = trace.at(-1);
						projectWorkflowActivity();
						persist();
						appendWorkflowEvent({ type: "subagent.workflow.trace", trace });
					};
					try {
						const workflow = await runWorkflowScript({
							script: workflowScript,
							timeoutMs: timeout,
							signal: controller.signal,
							...(workflowState ? { state: workflowState } : {}),
							onTrace: updateTrace,
							admit: (calls) => {
								const outputClaims = workflowChildOutputClaims({ ctxCwd: ctx.cwd, workflowCwd, artifactsDir: workflowArtifactsDir, workflowRunId, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: deps.discoverAgents, workflowAgentScope: workflowChildDefaults.agentScope, claimedOutputPaths, entries: calls });
								if (outputClaims.error) throw new Error(outputClaims.error);
								status.runFanoutBudget = claimRunFanoutBatch(workflowFanoutBudget, calls.map(({ key }) => `workflow[${key}]`));
								if (outputClaims.claims) applyWorkflowChildOutputClaims(claimedOutputPaths, outputClaims.claims);
								persist();
							},
							onEmit: (emits) => {
								// Each emit is validated at the host boundary in runWorkflowScript before onEmit fires.
								status.workflow = { ...(status.workflow ?? { trace: [], console: [] }), emits };
								persist();
								appendWorkflowEvent({ type: "subagent.workflow.emit", value: emits.at(-1) });
							},
							launch: async (key, childParams, workflowSignal, admission) => {
								if (workflowUsageBudget.budget && childParams.async === true) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, "workflow usageBudget does not support async runs.run launches."));
								const budgetState = usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults));
								if (budgetState?.exhausted) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, usageBudgetExceededMessage(budgetState)));
								const childPhase = typeof childParams.phase === "string" && childParams.phase.trim() ? childParams.phase.trim() : undefined;
								const childLabel = typeof childParams.label === "string" && childParams.label.trim() ? childParams.label.trim() : undefined;
								recordMissionWorkflowChild(missionBinding, workflowRunId, key, {
									status: "running",
									...(typeof childParams.agent === "string" && childParams.agent.trim() ? { agent: childParams.agent.trim() } : {}),
									...(childLabel ? { label: childLabel } : {}),
									...(childPhase ? { phase: childPhase } : {}),
									heartbeat: { status: "running", ...(childPhase ? { phase: childPhase } : {}) },
								});
								const result = await runMissionWorkflowChild(missionBinding, workflowRunId, key, childPhase, () => {
									const childRequest = bindMissionWorkflowChildAsyncLaunch(
										{ ...prepareWorkflowChildLaunchParams({ workflowDefaults: workflowChildDefaults, childParams, parentWorkflowRunId: workflowRunId, workflowKey: key, ctxCwd: ctx.cwd, workflowCwd, artifactsDir: workflowArtifactsDir, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: deps.discoverAgents, workflowAgentScope: workflowChildDefaults.agentScope, options: { missionDetached: detachWorkflowChildMissions, runFanoutBudget: workflowFanoutBudget, parentDeadlineAt: workflowDeadlineAt } }), runFanoutAdmitted: admission.admitted },
										missionBinding,
										deps.asyncByDefault,
									);
									workflowLaunchObservers.set(childRequest, (launch) => {
										const step = status.steps?.find((candidate) => candidate.workflowKey === key);
										if (step) {
											step.agent = launch.agent;
											step.sessionFile = launch.sessionFile;
											step.async = launch.async;
											if (launch.runId) step.runId = launch.runId;
											persist();
										}
										recordMissionWorkflowChild(missionBinding, workflowRunId, key, { status: "running", agent: launch.agent, ...(launch.sessionFile ? { sessionPath: launch.sessionFile } : {}) });
									});
									return execute(randomUUID(), childRequest, workflowSignal, (update) => {
										const progress = update.details.progress?.[0];
										const step = status.steps?.find((candidate) => candidate.workflowKey === key);
										if (!progress || !step || step.stopped) return;
										step.status = progress.status === "completed" ? "completed" : progress.status === "failed" ? "failed" : "running";
										step.activityState = progress.activityState;
										step.lastActivityAt = progress.lastActivityAt;
										step.currentTool = progress.currentTool;
										step.currentToolArgs = progress.currentToolArgs;
										step.currentToolStartedAt = progress.currentToolStartedAt;
										step.currentPath = progress.currentPath;
										step.recentTools = progress.recentTools.map((tool) => ({ ...tool }));
										step.recentOutput = [...progress.recentOutput];
										step.turnCount = progress.turnCount;
										step.toolCount = progress.toolCount;
										step.model = progress.model;
										step.thinking = progress.thinking;
										step.error = progress.error;
										projectWorkflowActivity();
										persist();
										recordMissionWorkflowChild(missionBinding, workflowRunId, key, {
											status: step.status,
											heartbeat: { status: step.status, ...(childPhase ? { phase: childPhase } : {}) },
										});
									}, ctx, preserveActiveSession);
								});
								workflowResults.push(...result.details.results);
								for (const childResult of result.details.results) {
									if (childResult.savedOutputPath) producedChildOutputPaths.add(childResult.savedOutputPath);
								}
								const child = workflowChildResult(key, result);
								if (child.runId) workflowChildRunIds.set(key, child.runId);
								const step = status.steps?.find((candidate) => candidate.workflowKey === key);
								if (step) {
									step.async = Boolean(result.details.asyncId || result.details.asyncDir);
									if (child.runId) step.runId = child.runId;
								}
								if (result.details.asyncDir && missionBinding) writeMissionAsyncBinding(result.details.asyncDir, missionBinding);
								const childStatus = missionWorkflowChildStatus(result);
								recordMissionWorkflowChild(missionBinding, workflowRunId, key, {
									status: childStatus,
									...(child.runId ? { runId: child.runId } : {}),
									...(result.details.results[0]?.agent ? { agent: result.details.results[0].agent } : {}),
									...(result.details.results[0]?.sessionFile ? { sessionPath: result.details.results[0].sessionFile } : {}),
									artifactPaths: child.artifactPaths,
									...(["completed", "failed"].includes(childStatus) ? { completedAt: new Date().toISOString() } : {}),
									heartbeat: { status: childStatus, ...(childPhase ? { phase: childPhase } : {}) },
								});
								if (result.details.asyncId) {
									const childJob = deps.state.asyncJobs.get(result.details.asyncId);
									if (childJob) { childJob.parentWorkflowRunId = workflowRunId; childJob.workflowKey = key; }
								}
								return child;
							},
							status: async (keyOrRunId, workflowSignal) => workflowChildResult(keyOrRunId, await execute(randomUUID(), { action: "status", id: keyOrRunId }, workflowSignal, undefined, ctx, preserveActiveSession)),
							steer: (key, message, options, workflowSignal) => steerWorkflowChildByKey({ state: deps.state, workflowRunId, key, message, options, signal: workflowSignal, resolveRunId: () => workflowChildRunIds.get(key) }),
						});
						const returnPreview = formatWorkflowValue(workflow.value).slice(0, 1_000);
						const emitPreview = workflow.emits.length > 0 ? ` Emitted: ${workflow.emits.map(formatWorkflowValue).join(", ").slice(0, 1_000)}` : "";
						const summary = `Workflow completed with ${workflow.children.length} child run(s). Return: ${returnPreview}${emitPreview} Trace: ${workflow.trace.length} event(s).`;
						const outputWarning = writeWorkflowAggregateOutput(workflowAggregateOutputPath, summary, producedChildOutputPaths);
						const resultSummary = appendWorkflowOutputWarning(summary, outputWarning);
						const workflowUsage = sumResultsUsage(workflowResults);
						status = { ...status, state: "complete", endedAt: Date.now(), workflow: { value: workflow.value, trace: workflow.trace, emits: workflow.emits, console: workflow.console }, totalTokens: { input: workflowUsage.input, output: workflowUsage.output, total: workflowUsage.input + workflowUsage.output }, totalCost: sumResultsCost(workflowResults) };
						if (!writeWorkflowResult({ id: workflowRunId, runId: workflowRunId, toolCallId, agent: "workflow", mode: "workflow", success: true, state: "complete", summary: resultSummary, output: resultSummary, results: workflow.children.map((child) => ({ workflowKey: child.key, ...(child.agent ? { agent: child.agent } : {}), ...(child.runId ? { runId: child.runId } : {}), output: child.output, outputState: child.output.trim() || child.structuredOutput !== undefined ? "present" : "absent", structuredOutput: child.structuredOutput, success: child.ok, ...(child.artifactPaths[0] ? { artifactPaths: { outputPath: child.artifactPaths[0] } } : {}) })), workflow: status.workflow, asyncDir, cwd: workflowCwd, sessionId: currentSessionId, completionOwnerId, timestamp: Date.now(), durationMs: Date.now() - startedAt })) return;
						persist();
						appendWorkflowEvent({ type: "subagent.workflow.completed", state: status.state, ...(status.error ? { error: status.error } : {}) });
					} catch (error) {
						const partial = error instanceof WorkflowScriptError ? error.partial : { trace: [], emits: [], console: [], children: [] };
						const stopped = controller.signal.aborted;
						const detachedChildKeys = new Set(partial.children.filter((child) => child.detached).map((child) => child.key));
						const hasRealFailedChild = partial.children.some((child) => !child.ok && !child.detached);
						const pauseForDetached = !stopped && error instanceof WorkflowScriptError && error.errorKind === "detached-child" && detachedChildKeys.size > 0 && !hasRealFailedChild;
						const state = stopped ? "stopped" : pauseForDetached ? "paused" : "failed";
						for (const step of status.steps ?? []) {
							if (step.workflowKey && detachedChildKeys.has(step.workflowKey)) {
								step.status = "paused";
								step.activityState = "needs_attention";
							}
						}
						status = compactOptional<AsyncStatus>({ ...status, state, stopped: stopped || undefined, activityState: pauseForDetached ? "needs_attention" : undefined, error: error instanceof Error ? error.message : String(error), endedAt: Date.now(), workflow: { trace: partial.trace, emits: partial.emits, console: partial.console } });
						const outputWarning = writeWorkflowAggregateOutput(workflowAggregateOutputPath, status.error ?? (pauseForDetached ? "Workflow paused." : "Workflow failed."), producedChildOutputPaths);
						const resultSummary = appendWorkflowOutputWarning(status.error ?? (pauseForDetached ? "Workflow paused." : "Workflow failed."), outputWarning);
						if (!writeWorkflowResult({ id: workflowRunId, runId: workflowRunId, toolCallId, agent: "workflow", mode: "workflow", success: false, state: status.state, summary: resultSummary, error: status.error, stopped: status.stopped, activityState: status.activityState, results: partial.children.map((child) => ({ workflowKey: child.key, ...(child.agent ? { agent: child.agent } : {}), ...(child.runId ? { runId: child.runId } : {}), output: child.output, outputState: child.output.trim() || child.structuredOutput !== undefined ? "present" : "absent", structuredOutput: child.structuredOutput, success: child.ok, ...(child.detached ? { detached: true } : {}), ...(child.artifactPaths[0] ? { artifactPaths: { outputPath: child.artifactPaths[0] } } : {}) })), workflow: status.workflow, asyncDir, cwd: workflowCwd, sessionId: currentSessionId, completionOwnerId, timestamp: Date.now(), durationMs: Date.now() - startedAt })) return;
						persist();
						appendWorkflowEvent({ type: "subagent.workflow.completed", state: status.state, error: status.error, ...(status.activityState ? { activityState: status.activityState } : {}) });
					} finally {
						deps.state.workflowControllers?.delete(workflowRunId);
						deps.state.activeAsyncCapacity = workflowCapacity?.reconcile(new Set(deps.state.workflowControllers?.keys() ?? []))
							?? deps.state.activeAsyncCapacity;
					}
				});
				return attachWorkflowMission(withRunFanoutBudget({
					content: [{ type: "text", text: formatAsyncStartedMessage(`Async workflow [${workflowRunId}]`, ctx.hasUI === true) }],
					details: { mode: "workflow", runId: workflowRunId, toolCallId, asyncId: workflowRunId, asyncDir, results: [], chatProgress, ...(deps.state.activeAsyncCapacity ? { activeAsyncCapacity: deps.state.activeAsyncCapacity } : {}) },
				}, workflowFanoutBudget));
			}
			const { workflowScript: _workflowScript, action: _action, agent: _agent, task: _task, resume: _resume, tasks: _tasks, chain: _chain, concurrency: _concurrency, async: _async, foregroundOnly: _foregroundOnly, clarify: _clarify, timeoutMs: _timeoutMs, maxRuntimeMs: _maxRuntimeMs, usageBudget: _usageBudget, chatProgress: _chatProgress, missionId: _missionId, mission: _mission, ...workflowChildDefaults } = requestParams;
			const workflowOutput = typeof workflowChildDefaults.output === "string" || typeof workflowChildDefaults.output === "boolean" ? workflowChildDefaults.output : undefined;
			const configuredOutputBaseDir = resolveConfiguredSingleRunOutputBaseDir(deps);
			const workflowAggregateOutputPath = resolveWorkflowAggregateOutputPath(workflowOutput, ctx.cwd, workflowCwd, resolveSingleRunOutputBaseDir(deps, workflowArtifactsDir, _id), configuredOutputBaseDir);
			const claimedOutputPaths = new Map<string, string>();
			const producedChildOutputPaths = new Set<string>();
			const workflowResults: SingleResult[] = [];
			const workflowChildRunIds = new Map<string, string>();
			let liveWorkflow: NonNullable<Details["workflow"]> = { trace: [], emits: [], console: [] };
			const workflowDeadlineAt = timeout === undefined ? undefined : Date.now() + timeout;
			const sendWorkflowProgress = () => {
				const update = workflowChatProgressUpdate(_id, chatProgress, liveWorkflow);
				if (update) onUpdate?.(update);
			};
			try {
				const workflow = await runWorkflowScript({
					script: requestParams.workflowScript,
					timeoutMs: timeout,
					signal,
					...(workflowState ? { state: workflowState } : {}),
					onTrace: (trace) => {
						liveWorkflow = { ...liveWorkflow, trace };
						sendWorkflowProgress();
					},
					admit: (calls) => {
						const outputClaims = workflowChildOutputClaims({ ctxCwd: ctx.cwd, workflowCwd, artifactsDir: workflowArtifactsDir, workflowRunId: _id, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: deps.discoverAgents, workflowAgentScope: workflowChildDefaults.agentScope, claimedOutputPaths, entries: calls });
						if (outputClaims.error) throw new Error(outputClaims.error);
						claimRunFanoutBatch(workflowFanoutBudget, calls.map(({ key }) => `workflow[${key}]`));
						if (outputClaims.claims) applyWorkflowChildOutputClaims(claimedOutputPaths, outputClaims.claims);
					},
					onEmit: (emits) => {
						liveWorkflow = { ...liveWorkflow, emits };
						sendWorkflowProgress();
					},
					launch: async (key, childParams, workflowSignal, admission) => {
						if (workflowUsageBudget.budget && childParams.async === true) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, "workflow usageBudget does not support async runs.run launches."));
						const budgetState = usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults));
						if (budgetState?.exhausted) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, usageBudgetExceededMessage(budgetState)));
						const childPhase = typeof childParams.phase === "string" && childParams.phase.trim() ? childParams.phase.trim() : undefined;
						const childLabel = typeof childParams.label === "string" && childParams.label.trim() ? childParams.label.trim() : undefined;
						recordMissionWorkflowChild(missionBinding, _id, key, {
							status: "running",
							...(typeof childParams.agent === "string" && childParams.agent.trim() ? { agent: childParams.agent.trim() } : {}),
							...(childLabel ? { label: childLabel } : {}),
							...(childPhase ? { phase: childPhase } : {}),
							heartbeat: { status: "running", ...(childPhase ? { phase: childPhase } : {}) },
						});
						const result = await runMissionWorkflowChild(missionBinding, _id, key, childPhase, () => {
							const childRequest = bindMissionWorkflowChildAsyncLaunch(
								{ ...prepareWorkflowChildLaunchParams({ workflowDefaults: workflowChildDefaults, childParams, parentWorkflowRunId: _id, workflowKey: key, ctxCwd: ctx.cwd, workflowCwd, artifactsDir: workflowArtifactsDir, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: deps.discoverAgents, workflowAgentScope: workflowChildDefaults.agentScope, options: { missionDetached: detachWorkflowChildMissions, suppressRoutineResultIntercom: chatProgress.mode === "live-card", runFanoutBudget: workflowFanoutBudget, parentDeadlineAt: workflowDeadlineAt } }), runFanoutAdmitted: admission.admitted },
								missionBinding,
								deps.asyncByDefault,
							);
							workflowLaunchObservers.set(childRequest, (launch) => recordMissionWorkflowChild(missionBinding, _id, key, {
								status: "running",
								agent: launch.agent,
								...(launch.sessionFile ? { sessionPath: launch.sessionFile } : {}),
							}));
							return execute(randomUUID(), childRequest, workflowSignal, (update) => {
								const progress = update.details.progress?.[0];
								if (!progress) return;
								const progressStatus = progress.status === "completed" ? "completed" : progress.status === "failed" ? "failed" : "running";
								recordMissionWorkflowChild(missionBinding, _id, key, {
									status: progressStatus,
									heartbeat: { status: progressStatus, ...(childPhase ? { phase: childPhase } : {}) },
								});
							}, ctx, preserveActiveSession);
						});
						workflowResults.push(...result.details.results);
						for (const childResult of result.details.results) {
							if (childResult.savedOutputPath) producedChildOutputPaths.add(childResult.savedOutputPath);
						}
						if (result.details.asyncDir && missionBinding) writeMissionAsyncBinding(result.details.asyncDir, missionBinding);
						const child = workflowChildResult(key, result);
						if (child.runId) workflowChildRunIds.set(key, child.runId);
						const childStatus = missionWorkflowChildStatus(result);
						recordMissionWorkflowChild(missionBinding, _id, key, {
							status: childStatus,
							...(child.runId ? { runId: child.runId } : {}),
							...(result.details.results[0]?.agent ? { agent: result.details.results[0].agent } : {}),
							...(result.details.results[0]?.sessionFile ? { sessionPath: result.details.results[0].sessionFile } : {}),
							artifactPaths: child.artifactPaths,
							...(["completed", "failed"].includes(childStatus) ? { completedAt: new Date().toISOString() } : {}),
							heartbeat: { status: childStatus, ...(childPhase ? { phase: childPhase } : {}) },
						});
						return child;
					},
					status: async (keyOrRunId, workflowSignal) => workflowChildResult(keyOrRunId, await execute(randomUUID(), { action: "status", id: keyOrRunId }, workflowSignal, undefined, ctx, preserveActiveSession)),
					steer: (key, message, options, workflowSignal) => steerWorkflowChildByKey({ state: deps.state, workflowRunId: _id, key, message, options, signal: workflowSignal, resolveRunId: () => workflowChildRunIds.get(key) }),
				});
				const traceLines = workflow.trace.map((entry) => `- ${entry.operation} ${entry.key}: ${entry.state}${entry.runId ? ` (${entry.runId})` : ""}${entry.durationMs !== undefined ? ` in ${entry.durationMs}ms` : ""}${entry.error ? ` — ${entry.error}` : ""}`);
				const sections = ["Workflow completed.", `Return:\n${formatWorkflowValue(workflow.value)}`];
				if (workflow.emits.length > 0) sections.push(`Emitted:\n${workflow.emits.map(formatWorkflowValue).join("\n")}`);
				if (workflow.console.length > 0) sections.push(`Console:\n${workflow.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`);
				if (traceLines.length > 0) sections.push(`Call trace:\n${traceLines.join("\n")}`);
				const workflowText = sections.join("\n\n");
				const outputWarning = writeWorkflowAggregateOutput(workflowAggregateOutputPath, workflowText, producedChildOutputPaths);
				const displayText = appendWorkflowOutputWarning(workflowText, outputWarning);
				return attachWorkflowMission(withRunFanoutBudget({
					content: [{ type: "text", text: displayText }],
					details: compactOptional<Details>({ mode: "workflow", runId: _id, results: workflow.children.flatMap((child) => (child.results ?? []) as SingleResult[]), totalChildUsage: sumResultsUsage(workflowResults), totalCost: sumResultsCost(workflowResults), usageBudget: usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)), workflow: { value: workflow.value, trace: workflow.trace, emits: workflow.emits, console: workflow.console }, chatProgress }),
				}, workflowFanoutBudget));
			} catch (error) {
				const partial = error instanceof WorkflowScriptError ? error.partial : { trace: [], emits: [], console: [], children: [] };
				const text = error instanceof Error ? error.message : String(error);
				const traceLines = partial.trace.map((entry) => `- ${entry.operation} ${entry.key}: ${entry.state}${entry.runId ? ` (${entry.runId})` : ""}${entry.error ? ` — ${entry.error}` : ""}`);
				const sections = [`Workflow failed: ${text}`];
				if (partial.emits.length > 0) sections.push(`Emitted:\n${partial.emits.map(formatWorkflowValue).join("\n")}`);
				if (partial.console.length > 0) sections.push(`Console:\n${partial.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`);
				if (traceLines.length > 0) sections.push(`Call trace:\n${traceLines.join("\n")}`);
				const workflowText = sections.join("\n\n");
				const outputWarning = writeWorkflowAggregateOutput(workflowAggregateOutputPath, workflowText, producedChildOutputPaths);
				const displayText = appendWorkflowOutputWarning(workflowText, outputWarning);
				return attachWorkflowMission(withRunFanoutBudget({
					content: [{ type: "text", text: displayText }],
					isError: true,
					details: compactOptional<Details>({ mode: "workflow", runId: _id, results: partial.children.flatMap((child) => (child.results ?? []) as SingleResult[]), totalChildUsage: sumResultsUsage(workflowResults), totalCost: sumResultsCost(workflowResults), usageBudget: usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)), workflow: { trace: partial.trace, emits: partial.emits, console: partial.console }, chatProgress }),
				}, workflowFanoutBudget));
			}
		}
		const directParams = requestParams;
		const requestCwd = resolveRequestedCwd(ctx.cwd, directParams.cwd);
		const paramsWithResolvedCwd = directParams.cwd === undefined ? directParams : { ...directParams, cwd: requestCwd };
		const action = paramsWithResolvedCwd.action;
		let requestSessionId = "";
		let requestPiSessionId: string | undefined;
		let requestParentModel: ParentModel | undefined;
		try {
			requestSessionId = resolveCurrentSessionId(ctx.sessionManager);
			requestPiSessionId = ctx.sessionManager.getSessionId() ?? undefined;
			requestParentModel = preserveActiveSession
				? normalizeParentModel(ctx.model)
				: rememberParentModel(deps.state, requestSessionId, ctx.model);
		} catch (error) {
			if (action?.toLowerCase() !== "doctor" && action?.toLowerCase() !== "guide") throw error;
			requestParentModel = normalizeParentModel(ctx.model);
		}
		if (action) {
			if (action === "worktree.discard") {
				if (deps.allowMutatingManagementActions === false) {
					return { content: [{ type: "text", text: "Action 'worktree.discard' is not available from child-safe subagent fanout mode." }], isError: true, details: { mode: "management", results: [] } };
				}
				if (!paramsWithResolvedCwd.handoffPath?.trim()) {
					return { content: [{ type: "text", text: "worktree.discard requires handoffPath from parallelHandoff.path or async status." }], isError: true, details: { mode: "management", results: [] } };
				}
				const decision = resolveAuthorityDecision({ action: "discardWorktree", ...(deps.config.authorityPolicy === undefined ? {} : { policy: deps.config.authorityPolicy }) });
				if (decision === "forbid") {
					return { content: [{ type: "text", text: "Authority policy forbids worktree discard." }], isError: true, details: { mode: "management", results: [] } };
				}
				let confirmed = decision === "auto";
				if (decision === "confirm") {
					if (!ctx.hasUI) return { content: [{ type: "text", text: "Authority policy requires user confirmation for worktree discard, but this session has no interactive UI. Preserved worktrees were not changed." }], isError: true, details: { mode: "management", results: [] } };
					confirmed = await ctx.ui.confirm("Discard preserved subagent worktrees?", `This permanently removes preserved worktrees and temporary branches recorded in:\n${paramsWithResolvedCwd.handoffPath}`);
				}
				if (!confirmed) return { content: [{ type: "text", text: "Worktree discard canceled; preserved worktrees were not changed." }], details: { mode: "management", results: [] } };
				try {
					const discarded = discardPreservedWorktrees(
						path.isAbsolute(paramsWithResolvedCwd.handoffPath) ? paramsWithResolvedCwd.handoffPath : path.resolve(requestCwd, paramsWithResolvedCwd.handoffPath),
						{ kind: decision === "confirm" ? "confirmed" : "policy", ...(deps.config.authorityPolicy ? { policy: deps.config.authorityPolicy } : {}) },
					);
					return { content: [{ type: "text", text: discarded.text }], details: { mode: "management", results: [] } };
				} catch (error) {
					return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
				}
			}
			if ((HERDR_PROJECT_PANE_ACTIONS as readonly string[]).includes(action)) {
				if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
					return { content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }], isError: true, details: { mode: "management", results: [] } };
				}
				return handleHerdrProjectPaneAction(action as (typeof HERDR_PROJECT_PANE_ACTIONS)[number], paramsWithResolvedCwd, { cwd: requestCwd, signal });
			}
			if ((HERDR_INSPECTOR_ACTIONS as readonly string[]).includes(action)) {
				if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
					return { content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }], isError: true, details: { mode: "management", results: [] } };
				}
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				return handleHerdrInspectorAction(action as (typeof HERDR_INSPECTOR_ACTIONS)[number], paramsWithResolvedCwd, {
					state: deps.state,
					cwd: requestCwd,
					...(deps.config.missions ? { missions: deps.config.missions } : {}),
					...(deps.config.authorityPolicy ? { authorityPolicy: deps.config.authorityPolicy } : {}),
					signal,
				});
			}
			if ((MISSION_ACTIONS as readonly string[]).includes(action)) {
				if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
					return {
						content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				const currentSessionId = deps.state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined;
				return handleMissionAction(action as (typeof MISSION_ACTIONS)[number], paramsWithResolvedCwd, {
					cwd: requestCwd,
					...(deps.config.missions ? { config: deps.config.missions } : {}),
					...(currentSessionId ? { currentSessionId } : {}),
				});
			}
			const policyAction = action === "stop" ? "stopRun" : action === "steer" ? "steerRun" : action === "schedule.create" ? "scheduleCreate" : undefined;
			if (policyAction) {
				const decision = resolveAuthorityDecision({ action: policyAction, ...(deps.config.authorityPolicy === undefined ? {} : { policy: deps.config.authorityPolicy }) });
				if (decision === "forbid") {
					return { content: [{ type: "text", text: `Authority policy forbids action '${action}'.` }], isError: true, details: { mode: "management", results: [] } };
				}
				if (decision === "confirm") {
					if (!ctx.hasUI) return { content: [{ type: "text", text: `Authority policy requires user confirmation for action '${action}', but this session has no interactive UI.` }], isError: true, details: { mode: "management", results: [] } };
					const confirmed = await ctx.ui.confirm(`Authorize subagent ${action}?`, `Authority policy requires confirmation before '${action}'.`);
					if (!confirmed) return { content: [{ type: "text", text: `Action '${action}' canceled; authority was not granted.` }], details: { mode: "management", results: [] } };
				}
			}
			if ((WATCHDOG_TOOL_ACTIONS as readonly string[]).includes(action)) {
				if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
					return {
						content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
						isError: true,
						details: { mode: "management" as const, results: [] },
					};
				}
				return handleWatchdogToolAction(action, paramsWithResolvedCwd, ctx, deps.watchdog);
			}
			if (action === "refine" || action === "refine.show" || action === "refine.rollback") {
				if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
					return {
						content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				return handleRefinementAction(action, paramsWithResolvedCwd, {
					cwd: requestCwd,
					state: deps.state,
					signal,
					launchProposalChild: (task, outputSchema, proposalSignal) => execute(randomUUID(), {
						agent: "reviewer",
						task,
						context: "fresh",
						async: false,
						artifacts: false,
						outputSchema,
						toolBudget: { hard: 1, block: ["write", "edit", "bash"] },
					}, proposalSignal, undefined, ctx, true),
				});
			}
			if (action === "grant-spawn-budget") {
				if (deps.allowMutatingManagementActions === false || !ctx.hasUI) {
					return {
						content: [{ type: "text", text: "Action 'grant-spawn-budget' is available only from the root interactive parent session." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				if (!deps.state.currentSessionId) {
					return {
						content: [{ type: "text", text: "Action 'grant-spawn-budget' requires an active parent session id." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				if (hasActiveSubagentChildren(deps.state)) {
					const spawnBudget = getSpawnBudgetSnapshot(deps.state, deps.config, deps.state.currentSessionId);
					return {
						content: [{ type: "text", text: "Spawn budget grants are rejected while current-session children are queued or running. Wait for them to settle, then retry the explicit grant." }],
						isError: true,
						details: { mode: "management", results: [], spawnBudget },
					};
				}
				const sessionId = deps.state.currentSessionId;
				const additional = paramsWithResolvedCwd.additional ?? Number.NaN;
				const preview = preflightSpawnBudgetGrant(deps.state, deps.config, sessionId, additional);
				if (preview.error) {
					return {
						content: [{ type: "text", text: preview.error }],
						isError: true,
						details: { mode: "management", results: [], spawnBudget: preview.snapshot },
					};
				}
				const authority = resolveAuthorityDecision({ action: "spawnBudgetGrant", ...(deps.config.authorityPolicy === undefined ? {} : { policy: deps.config.authorityPolicy }) });
				if (authority === "forbid") {
					return {
						content: [{ type: "text", text: "Authority policy forbids spawn budget grants." }],
						isError: true,
						details: { mode: "management", results: [], spawnBudget: preview.snapshot },
					};
				}
				const confirmed = authority === "auto" || await ctx.ui.confirm(
					"Grant subagent spawn budget?",
					`Add ${additional} launches to this logical session?\n\n${formatSpawnBudget(preview.snapshot)}\n\nUsage is not reset. Compaction keeps the same budget; a new parent session starts a fresh one.`,
				);
				if (!confirmed) {
					return {
						content: [{ type: "text", text: "Spawn budget grant canceled; no capacity was added." }],
						details: { mode: "management", results: [], spawnBudget: preview.snapshot },
					};
				}
				const currentBudget = getSpawnBudgetSnapshot(deps.state, deps.config, deps.state.currentSessionId);
				if (
					resolveCurrentSessionId(ctx.sessionManager) !== sessionId
					|| hasActiveSubagentChildren(deps.state)
					|| currentBudget.used !== preview.snapshot.used
					|| currentBudget.granted !== preview.snapshot.granted
				) {
					return {
						content: [{ type: "text", text: "Spawn budget grant was not applied because the session, budget, or active-child state changed while confirmation was open." }],
						isError: true,
						details: { mode: "management", results: [], spawnBudget: currentBudget },
					};
				}
				const granted = grantSpawnBudget(deps.state, deps.config, sessionId, additional);
				return {
					content: [{ type: "text", text: granted.error ?? `Spawn budget grant applied: +${additional}. ${formatSpawnBudget(granted.snapshot)}` }],
					...(granted.error ? { isError: true } : {}),
					details: { mode: "management", results: [], spawnBudget: granted.snapshot },
				};
			}
			if (action === "guide") {
				try {
					return {
						content: [{ type: "text", text: readSubagentGuide(paramsWithResolvedCwd.topic) }],
						details: { mode: "management", results: [] },
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
			}
			if (action === "children.list") {
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const children = listRetainedChildren(DIRS.async, deps.state.currentSessionId);
				return {
					content: [{ type: "text", text: formatRetainedChildren(children) }],
					details: { mode: "management", results: [] },
				};
			}
			if (action === "doctor") {
				let currentSessionFile: string | null = null;
				let currentSessionId = deps.state.currentSessionId;
				let sessionError: string | undefined;
				try {
					currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
					currentSessionId = ctx.sessionManager.getSessionId();
				} catch (error) {
					sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				let orchestratorTarget: string | undefined;
				try {
					orchestratorTarget = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
				} catch (error) {
					if (!sessionError) sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				const spawnBudget = getSpawnBudgetSnapshot(deps.state, deps.config, currentSessionId);
				const activeAsyncCapacity = currentSessionId
					? getActiveAsyncCapacitySnapshot(currentSessionId, resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession), { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []) })
					: { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession) ?? 0 };
				deps.state.activeAsyncCapacity = activeAsyncCapacity;
				return {
					content: [{
						type: "text",
						text: buildDoctorReport(omitUndefinedProperties({
							cwd: requestCwd,
							config: deps.config,
							state: deps.state,
							context: paramsWithResolvedCwd.context,
							requestedSessionDir: paramsWithResolvedCwd.sessionDir,
							currentSessionFile,
							currentSessionId,
							orchestratorTarget,
							sessionError,
							expandTilde: deps.expandTilde,
						})),
					}],
					details: { mode: "management", results: [], spawnBudget, activeAsyncCapacity },
				};
			}
			if (action === "status" || action === "debug.run") {
				if (!preserveActiveSession) deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
				const hasDirectoryTarget = Boolean(paramsWithResolvedCwd.dir);
				const targetLabel = action === "debug.run" ? "Debug run" : formatStatusTargetLabel(paramsWithResolvedCwd, targetRunId);
				const withBudget = (result: AgentToolResult<Details>) => {
					const budgeted = withSpawnBudgetStatus(result, deps.state, deps.config, deps.state.currentSessionId);
					return {
						...budgeted,
						content: budgeted.content.map((item, index) => index === 0 && item.type === "text"
							? { ...item, text: `${targetLabel}\n${item.text}` }
							: item),
					};
				};
				const nestedScope = nestedResolutionScopeForExecutor(deps);
				const sessionRoots = trustedSessionRootsForStatus(ctx, deps);
				if (action === "debug.run") {
					if (!targetRunId && !hasDirectoryTarget) {
						return withBudget({ content: [{ type: "text", text: "action='debug.run' requires id, runId, or dir." }], isError: true, details: { mode: "management", results: [] } });
					}
					if (paramsWithResolvedCwd.view) {
						return withBudget({ content: [{ type: "text", text: "action='debug.run' does not support status views." }], isError: true, details: { mode: "management", results: [] } });
					}
					return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, omitUndefinedProperties({ state: deps.state, nested: nestedScope, sessionRoots })));
				}
				if (paramsWithResolvedCwd.view === "fleet") {
					return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, omitUndefinedProperties({ state: deps.state, nested: nestedScope, sessionRoots })));
				}
				if (targetRunId) {
					try {
						const resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedScope }));
						if (resolved?.kind === "foreground") {
							const foreground = getForegroundControl(deps.state, resolved.id);
							if (foreground) {
								if (paramsWithResolvedCwd.view === "transcript") {
									return withBudget({
										content: [{ type: "text", text: "Live foreground transcript is already visible in the expanded running subagent result. Persisted session transcript becomes inspectable after the foreground run completes when sessions are enabled." }],
										details: { mode: "management", results: [] },
									});
								}
								return withBudget(foregroundStatusResult(foreground));
							}
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return withBudget({ content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } });
					}
				} else if (!hasDirectoryTarget) {
					const foreground = getForegroundControl(deps.state, undefined);
					if (foreground && paramsWithResolvedCwd.view !== "transcript") return withBudget(foregroundStatusResult(foreground));
					if (foreground && paramsWithResolvedCwd.view === "transcript") {
						return withBudget({
							content: [{ type: "text", text: "Live foreground transcript is already visible in the expanded running subagent result. Pass an async run id to inspect a background transcript." }],
							details: { mode: "management", results: [] },
						});
					}
				}
				return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, omitUndefinedProperties({ state: deps.state, nested: nestedScope, sessionRoots })));
			}
			if (action === "resume") {
				return resumeAsyncRun(omitUndefinedProperties({ params: paramsWithResolvedCwd, requestCwd, ctx, deps, parentModel: requestParentModel, signal }));
			}
			if (action === "steer") {
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const message = (paramsWithResolvedCwd.message ?? paramsWithResolvedCwd.task ?? "").trim();
				if (!message) return { content: [{ type: "text", text: "action='steer' requires message." }], isError: true, details: { mode: "management", results: [] } };
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				if (paramsWithResolvedCwd.dir) {
					try {
						const location = resolveAsyncRunLocation(paramsWithResolvedCwd, DIRS.async, DIRS.results);
						const runId = location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? paramsWithResolvedCwd.dir);
						const directoryStatus = location.asyncDir ? readStatus(location.asyncDir) : null;
						if (directoryStatus?.mode === "workflow") {
							const route = resolveWorkflowForegroundSteeringTarget({ state: deps.state, workflowRunId: directoryStatus.runId || runId, asyncDirRoot: DIRS.async });
							if (!route.ok) return { content: [{ type: "text", text: route.message }], isError: true, details: { mode: "management", results: [] } };
							return steerWorkflowForegroundTarget({ target: route.target, message, mode: paramsWithResolvedCwd.mode, index: paramsWithResolvedCwd.index, signal });
						}
						if (location.asyncDir) {
							const unsupported = externalRunnerControlError(location.asyncDir, "steer");
							if (unsupported) return unsupported;
						}
						return steerAsyncRun(compactOptional<Parameters<typeof steerAsyncRun>[0]>({
							state: deps.state,
							runId,
							message,
							mode: paramsWithResolvedCwd.mode,
							index: paramsWithResolvedCwd.index,
							kill: deps.kill,
							location,
							signal,
							...(paramsWithResolvedCwd.steeringRecovery === false
								? {}
								: {
										recover: ({ absoluteDeadlineAt, ...limits }) =>
											resumeAsyncRun(omitUndefinedProperties({ params: { ...limits, action: "resume", id: runId, message }, requestCwd, ctx, deps, parentModel: requestParentModel, absoluteDeadlineAt })),
									}
							),
						}));
					} catch (error) {
						const text = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (!targetRunId) return { content: [{ type: "text", text: "action='steer' requires id or dir." }], isError: true, details: { mode: "management", results: [] } };
				let resolved: ResolvedSubagentRunId | undefined;
				try {
					resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
				}
				if (resolved?.kind === "nested") return steerNestedRun(omitUndefinedProperties({ target: resolved, message, mode: paramsWithResolvedCwd.mode, index: paramsWithResolvedCwd.index, signal }));
				if (resolved?.kind === "foreground") {
					const route = resolveWorkflowForegroundSteeringTarget({ state: deps.state, childRunId: resolved.id, asyncDirRoot: DIRS.async });
					if (!route.ok) return { content: [{ type: "text", text: route.message }], isError: true, details: { mode: "management", results: [] } };
					return steerWorkflowForegroundTarget({ target: route.target, message, mode: paramsWithResolvedCwd.mode, index: paramsWithResolvedCwd.index, signal });
				}
				if (resolved?.kind !== "async") return { content: [{ type: "text", text: `No async run found for '${targetRunId}'.` }], isError: true, details: { mode: "management", results: [] } };
				const resolvedStatus = resolved.location.asyncDir ? readStatus(resolved.location.asyncDir) : null;
				if (resolvedStatus?.mode === "workflow") {
					const route = resolveWorkflowForegroundSteeringTarget({ state: deps.state, workflowRunId: resolvedStatus.runId || resolved.id, asyncDirRoot: DIRS.async });
					if (!route.ok) return { content: [{ type: "text", text: route.message }], isError: true, details: { mode: "management", results: [] } };
					return steerWorkflowForegroundTarget({ target: route.target, message, mode: paramsWithResolvedCwd.mode, index: paramsWithResolvedCwd.index, signal });
				}
				if (resolved.location.asyncDir) {
					const unsupported = externalRunnerControlError(resolved.location.asyncDir, "steer");
					if (unsupported) return unsupported;
				}
				return steerAsyncRun(compactOptional<Parameters<typeof steerAsyncRun>[0]>({
					state: deps.state,
					runId: resolved.id,
					message,
					mode: paramsWithResolvedCwd.mode,
					index: paramsWithResolvedCwd.index,
					kill: deps.kill,
					location: resolved.location,
					signal,
					...(paramsWithResolvedCwd.steeringRecovery === false
						? {}
						: {
								recover: ({ absoluteDeadlineAt, ...limits }) =>
									resumeAsyncRun(omitUndefinedProperties({
										params: { ...limits, action: "resume", id: resolved!.id, message },
										requestCwd,
										ctx,
										deps,
										parentModel: requestParentModel,
										absoluteDeadlineAt,
									})),
							}
					),
				}));
			}
			if (action === "append-step") {
				return appendStepToAsyncChain(omitUndefinedProperties({ params: paramsWithResolvedCwd, requestCwd, ctx, deps, parentModel: requestParentModel }));
			}
			if (action.startsWith("schedule.")) {
				if (!isScheduledRunAction(action)) {
					return { content: [{ type: "text", text: unknownSubagentActionMessage(action) }], isError: true, details: { mode: "management", results: [] } };
				}
				if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
					return {
						content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				if (!deps.handleScheduledRunAction) {
					return {
						content: [{ type: "text", text: `Action '${action}' is not available in this subagent context.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				return deps.handleScheduledRunAction(paramsWithResolvedCwd, ctx);
			}
			if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
				return {
					content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			if (action === "dismiss") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				if (!targetRunId) return { content: [{ type: "text", text: "action='dismiss' requires id." }], isError: true, details: { mode: "management", results: [] } };
				let resolved: ResolvedSubagentRunId | undefined;
				try {
					resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
				}
				if (resolved?.kind !== "async") {
					return { content: [{ type: "text", text: `Run '${targetRunId}' is not a recovered workflow.` }], isError: true, details: { mode: "management", results: [] } };
				}
				return dismissRecoveredWorkflow(deps.state, resolved.location);
			}
			if (action === "stop") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				const workflowController = targetRunId ? deps.state.workflowControllers?.get(targetRunId) : undefined;
				if (workflowController) {
					workflowController.abort(new Error("Workflow stopped by user."));
					return { content: [{ type: "text", text: `Stop requested for async workflow ${targetRunId}.` }], details: { mode: "management", results: [] } };
				}
				let resolved: ResolvedSubagentRunId | undefined;
				if (paramsWithResolvedCwd.dir) {
					try {
						const location = resolveAsyncRunLocation(paramsWithResolvedCwd, DIRS.async, DIRS.results);
						const existingStatus = readStatus(location.asyncDir ?? "");
						if (existingStatus?.mode === "workflow" && existingStatus.state === "running") {
							return { content: [{ type: "text", text: `Workflow ${existingStatus.runId} is not controlled by this extension runtime; reload recovery cannot stop it safely.` }], isError: true, details: { mode: "management", results: [] } };
						}
						const stopResult = stopAsyncRun(deps.state, location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? paramsWithResolvedCwd.dir), deps.kill, location);
						return stopResult ?? { content: [{ type: "text", text: `No running or queued async run was found for '${targetRunId ?? paramsWithResolvedCwd.dir}'.` }], isError: true, details: { mode: "management", results: [] } };
					} catch (error) {
						const text = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (!targetRunId) return { content: [{ type: "text", text: "action='stop' requires id or dir." }], isError: true, details: { mode: "management", results: [] } };
				try {
					resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
				}
				if (resolved?.kind === "nested") return { content: [{ type: "text", text: "action='stop' supports current-session top-level async runs only." }], isError: true, details: { mode: "management", results: [] } };
				if (resolved?.kind === "foreground") return { content: [{ type: "text", text: "action='stop' supports async runs only. Use action='interrupt' for foreground runs." }], isError: true, details: { mode: "management", results: [] } };
				if (resolved?.kind === "async") {
					const existingStatus = readStatus(resolved.location.asyncDir ?? "");
					if (existingStatus?.mode === "workflow" && existingStatus.state === "running") {
						return { content: [{ type: "text", text: `Workflow ${resolved.id} is not controlled by this extension runtime; reload recovery cannot stop it safely.` }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				const stopResult = stopAsyncRun(
					deps.state,
					resolved?.kind === "async" ? resolved.id : targetRunId,
					deps.kill,
					resolved?.kind === "async" ? resolved.location : undefined,
				);
				if (stopResult) return stopResult;
				return {
					content: [{ type: "text", text: "No stoppable async run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (action === "interrupt") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				let resolved: ResolvedSubagentRunId | undefined;
				if (targetRunId) {
					try {
						resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (resolved?.kind === "nested") return interruptNestedRun(resolved);
				const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
				if (foreground?.interrupt) {
					const interrupted = foreground.interrupt();
					if (interrupted) {
						foreground.updatedAt = Date.now();
						delete foreground.currentActivityState;
						return {
							content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
							details: { mode: "management", results: [] },
						};
					}
					return {
						content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				const asyncInterruptResult = interruptAsyncRun(
					deps.state,
					resolved?.kind === "async" ? resolved.id : targetRunId,
					deps.kill,
					resolved?.kind === "async" ? resolved.location : undefined,
				);
				if (asyncInterruptResult) return asyncInterruptResult;
				return {
					content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
				return {
					content: [{ type: "text", text: unknownSubagentActionMessage(action) }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			return handleManagementAction(action, paramsWithResolvedCwd, {
				...ctx,
				cwd: requestCwd,
				config: deps.config,
				currentSessionId: deps.state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined,
			});
		}

		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;

		let effectiveParams = applyForceTopLevelAsyncOverride(
			normalizedParams,
			depth,
			deps.config.forceTopLevelAsync === true,
		);
		const runToolBudget = resolveToolBudget(
			effectiveParams.toolBudget,
			"toolBudget",
			allowZeroToolBudget ? { minimumHard: 0 } : undefined,
		);
		if (runToolBudget.error) return buildRequestedModeError(effectiveParams, runToolBudget.error);
		const configToolBudget = resolveToolBudget(deps.config.toolBudget, "config.toolBudget");
		if (configToolBudget.error) return buildRequestedModeError(effectiveParams, configToolBudget.error);
		const usageBudget = validateUsageBudgetConfig(effectiveParams.usageBudget ?? deps.config.usageBudget, effectiveParams.usageBudget ? "usageBudget" : "config.usageBudget");
		if (usageBudget.error) return buildRequestedModeError(effectiveParams, usageBudget.error);

		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const discovered = deps.discoverAgents(effectiveCwd, scope);
		const discoveredAgents = discovered.agents;
		const canonicalParams = canonicalizeExecutionParams(effectiveParams, discoveredAgents, discovered.agentDiagnostics);
		if (canonicalParams.error) return buildRequestedModeError(effectiveParams, canonicalParams.error);
		effectiveParams = canonicalParams.params!;
		const modelScope = discovered.modelScope;
		effectiveParams = applySingleAgentLaunchDefaults(effectiveParams, discoveredAgents);
		const turnBudget = resolveTurnBudgetConfig(effectiveParams.turnBudget ?? deps.config.turnBudget);
		if (turnBudget.error) return buildRequestedModeError(effectiveParams, turnBudget.error);
		// An agent-level defaultContext is a preference, unlike an explicit request.
		// Prefer fork only when the parent session is persisted and has a current leaf;
		// otherwise use fresh immediately instead of launching a guaranteed-to-fail fork.
		// Explicit context:"fork" remains strict.
		const contextPolicy = resolveAgentDefaultContextPolicy(
			effectiveParams,
			discoveredAgents,
			deps.config.defaultSubagentContext,
			canPreferFork(ctx.sessionManager),
		);
		effectiveParams = contextPolicy.params;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			override: effectiveParams.intercomBridge,
			context: effectiveParams.context ?? (contextPolicy.usesFork ? "fork" : undefined),
			orchestratorTarget: sessionName,
		});
		const agents = intercomBridge.active
			? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
			: discoveredAgents;
		const runId = randomUUID();
		const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
		const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
		const shareEnabled = effectiveParams.share === true;
		const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = !hasChain && !hasTasks && Boolean(effectiveParams.agent);
		const allowClarifyTaskPrompt = hasChain
			&& effectiveParams.clarify === true
			&& ctx.hasUI
			&& !(effectiveParams.chain?.some(isParallelStep) ?? false);

		const validationError = validateExecutionInput(
			effectiveParams,
			agents,
			hasChain,
			hasTasks,
			hasSingle,
			allowClarifyTaskPrompt,
		);
		if (validationError) return validationError;

		const foregroundMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const requestedSpawns = countRequestedSubagentSpawns(effectiveParams, deps.config);
		const spawnPreflight = preflightSpawnBudget(
			deps.state,
			deps.config,
			requestSessionId,
			requestedSpawns,
		);
		if (spawnPreflight.error) return spawnBudgetErrorResult(spawnPreflight.error, foregroundMode);

		let forkSessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		let forkThinkingOverrideForIndex: (idx?: number) => AgentConfig["thinking"] | undefined = () => undefined;
		let prepareForkThinking = (_agentName: string, _index: number, _modelOverride?: string): void => {};
		const forkThinkingRequirements = new Map<number, boolean>();
		const forkThinkingDowngrades = new Map<number, string>();
		try {
			const forkAvailableModels = contextPolicy.usesFork ? ctx.modelRegistry.getAvailable().map(toModelInfo) : [];
			const parentModel = requestParentModel;
			prepareForkThinking = (agentName, index, modelOverride) => {
				const agentConfig = agents.find((agent) => agent.name === agentName);
				if (agentConfig?.runner?.type === "external-cli" || agentConfig?.runner?.type === "external-job") {
					forkThinkingRequirements.set(index, true);
					return;
				}
				const primaryModel = resolveEffectiveSubagentModel(
					modelOverride,
					agentConfig?.model,
					parentModel,
					forkAvailableModels,
					parentModel?.provider,
				);
				const candidates = buildModelCandidates(
					primaryModel,
					agentConfig?.fallbackModels,
					forkAvailableModels,
					parentModel?.provider,
				);
				forkThinkingRequirements.set(
					index,
					candidates.length === 0
						|| candidates.some((candidate) => forkedChildRequiresThinkingOff(candidate, forkAvailableModels, parentModel?.provider)),
				);
			};
			const forkContextResolver = createForkContextResolver(ctx.sessionManager, contextPolicy.usesFork ? "fork" : undefined, {
				forceThinkingOffForIndex: (index) => forkThinkingRequirements.get(index) ?? true,
			});
			forkSessionFileForIndex = forkContextResolver.sessionFileForIndex;
			forkThinkingOverrideForIndex = forkContextResolver.thinkingOverrideForIndex;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
		}
		const requestedAsync = effectiveParams.async ?? deps.asyncByDefault;
		const backgroundRequestedWhileClarifying = (hasChain || hasTasks) && requestedAsync && effectiveParams.clarify === true;
		const effectiveAsync = requestedAsync && effectiveParams.clarify !== true;
		const selectedAgentNames = hasSingle
			? [effectiveParams.agent!]
			: hasTasks
				? (effectiveParams.tasks ?? []).map((task) => task.agent)
				: (effectiveParams.chain ?? []).flatMap((step) => getStepAgents(step as ChainStep));
		const externalAgent = selectedAgentNames
			.map((name) => agents.find((agent) => agent.name === name))
			.find((agent) => agent?.runner?.type === "external-cli" || agent?.runner?.type === "external-job");
		if (externalAgent && (!effectiveAsync || effectiveParams.foregroundOnly === true)) {
			return buildRequestedModeError(effectiveParams, `Agent '${externalAgent.name}' uses runner.type='${externalAgent.runner?.type}', which currently supports async/background execution only. Omit async or pass async:true; clarify and foregroundOnly are unsupported.`);
		}
		const foregroundTimeout = resolveSingleAgentLaunchTimeout(
			effectiveParams,
			effectiveAsync,
			resolveConfigDefaultTimeoutMs(deps.config.timeoutMs),
		);
		if (foregroundTimeout.error) return buildRequestedModeError(effectiveParams, foregroundTimeout.error);
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);
		const requestedWorkflowChildAsyncId = typeof effectiveParams.workflowChildAsyncId === "string" ? effectiveParams.workflowChildAsyncId.trim() : "";
		const asyncRunId = requestedWorkflowChildAsyncId && path.basename(requestedWorkflowChildAsyncId) === requestedWorkflowChildAsyncId
			? requestedWorkflowChildAsyncId
			: randomUUID();
		const topLevelAsyncCapacityEligible = depth === 0 && !inheritedNestedRoute && !effectiveParams.workflowParentRunId;
		const topLevelAsync = effectiveAsync && topLevelAsyncCapacityEligible;
		let activeAsyncCapacity: ActiveAsyncCapacityHandle | undefined;
		if (topLevelAsync) {
			try {
				const activeLimit = resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession);
				activeAsyncCapacity = acquireActiveAsyncCapacity({
					sessionId: requestSessionId,
					limit: activeLimit,
					runId: asyncRunId,
					kind: "runner",
					asyncDir: path.join(DIRS.async, asyncRunId),
				}, { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []) });
				deps.state.activeAsyncCapacity = getActiveAsyncCapacitySnapshot(requestSessionId, activeLimit, { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []) });
			} catch (error) {
				if (error instanceof ActiveAsyncCapacityError) {
					deps.state.activeAsyncCapacity = error.snapshot;
					return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: foregroundMode, results: [], activeAsyncCapacity: error.snapshot } };
				}
				throw error;
			}
		}

		let runFanoutBudget: RunFanoutBudgetDescriptor;
		try {
			const inheritedRunFanoutBudget = effectiveParams.runFanoutBudget ? undefined : decodeRunFanoutBudgetDescriptor(process.env[RUN_FANOUT_BUDGET_ENV]);
			runFanoutBudget = effectiveParams.runFanoutBudget
				?? (inheritedRunFanoutBudget ? { ...inheritedRunFanoutBudget, parentPath: `${inheritedRunFanoutBudget.parentPath ? `${inheritedRunFanoutBudget.parentPath}/` : ""}${runId}` } : undefined)
				?? createRunFanoutBudget(runId, resolveMaxSubagentSpawnsPerRun(deps.config.maxSubagentSpawnsPerRun));
			if (!effectiveParams.runFanoutAdmitted) claimRunFanoutBatch(runFanoutBudget, staticRunFanoutPaths(effectiveParams));
		} catch (error) {
			activeAsyncCapacity?.rollback();
			if (error instanceof RunFanoutLimitError) return runFanoutErrorResult(error, foregroundMode);
			return buildRequestedModeError(effectiveParams, error instanceof Error ? error.message : String(error));
		}
		const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);

		const artifactConfig: ArtifactConfig = omitUndefinedProperties({
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: effectiveParams.artifacts !== false,
			dir: deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
		});
		const artifactsDir = getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);
		if (artifactConfig.dir === "project" && !warnedArtifactPackageDirs.has(effectiveCwd)) {
			warnedArtifactPackageDirs.add(effectiveCwd);
			const warning = getProjectArtifactPackagingWarning(effectiveCwd);
			if (warning) console.warn(`[pi-subagents] ${warning}`);
		}

		let sessionRoot: string;
		if (effectiveParams.sessionDir) {
			sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
		} else {
			const baseSessionRoot = deps.config.defaultSessionDir
				? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
				: deps.getSubagentSessionRoot(parentSessionFile);
			sessionRoot = path.join(baseSessionRoot, runId);
		}
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch (error) {
			activeAsyncCapacity?.rollback();
			const message = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
				contextPolicy.contextSummary,
			);
		}
		const sessionDirForIndex = (idx?: number) =>
			path.join(sessionRoot, `run-${idx ?? 0}`);
		const forkSessionFileForTask: ForkSessionFileForTask = (agentName, idx = 0, modelOverride) => {
			if (!shouldForkAgent(contextPolicy, agentName)) return undefined;
			prepareForkThinking(agentName, idx, modelOverride);
			return forkSessionFileForIndex(idx);
		};
		const forkThinkingOverrideForTask: ForkThinkingOverrideForTask = (agentName, idx = 0, modelOverride) => {
			if (!shouldForkAgent(contextPolicy, agentName)) return delegatedThinkingOverride;
			prepareForkThinking(agentName, idx, modelOverride);
			const override = forkThinkingOverrideForIndex(idx);
			if (override === "off") forkThinkingDowngrades.set(idx, agentName);
			return override ?? delegatedThinkingOverride;
		};
		const childSessionFileForTask: ForkSessionFileForTask = (agentName, idx, modelOverride) =>
			forkSessionFileForTask(agentName, idx, modelOverride) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
		const childSessionFileForIndex = (idx?: number) =>
			path.join(sessionDirForIndex(idx), "session.jsonl");
		try {
			if (!(effectiveParams.clarify === true && ctx.hasUI)) {
				preflightForkSessionsForStaticTasks(effectiveParams, contextPolicy, forkSessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems);
			}
		} catch (error) {
			activeAsyncCapacity?.rollback();
			return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
		}
		const chainBindingsError = validateExecutionChainBindings(effectiveParams, deps.config.chain?.dynamicFanout?.maxItems);
		if (chainBindingsError) {
			activeAsyncCapacity?.rollback();
			return withResolvedContext(chainBindingsError, contextPolicy.contextSummary);
		}

		const onUpdateWithContext = onUpdate
			? (r: AgentToolResult<Details>) => onUpdate(withResolvedContext({
				...r,
				details: { ...r.details, runId },
			}, contextPolicy.contextSummary))
			: undefined;

		let missionBinding: MissionLaunchBinding | undefined;
		let missionWarning: string | undefined;
		const explicitMission = effectiveParams.missionId !== undefined || effectiveParams.mission !== undefined;
		try {
			missionBinding = prepareMissionLaunch({
				params: effectiveParams,
				projectRoot: effectiveCwd,
				...(deps.config.missions ? { config: deps.config.missions } : {}),
				ownerSessionId: requestSessionId,
			});
		} catch (error) {
			if (explicitMission) {
				activeAsyncCapacity?.rollback();
				return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
			}
			missionWarning = `Mission tracking unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}

		const attachMission = (result: AgentToolResult<Details>): AgentToolResult<Details> => {
			if (!missionBinding) return missionWarning ? { ...result, details: { ...result.details, missionWarning } } : result;
			try {
				return attachMissionToLaunchResult({ binding: delegatedExecution ? { ...missionBinding, announceInContent: false } : missionBinding, result });
			} catch (error) {
				const warning = `Mission tracking unavailable after launch: ${error instanceof Error ? error.message : String(error)}`;
				if (explicitMission) {
					return {
						...result,
						isError: true,
						content: [...result.content, { type: "text", text: warning }],
						details: { ...result.details, missionWarning: warning },
					};
				}
				return { ...result, details: { ...result.details, missionWarning: warning } };
			}
		};

		const reservation = reserveSpawnBudget(
			deps.state,
			deps.config,
			requestSessionId,
			requestedSpawns,
		);
		if (reservation.error) {
			activeAsyncCapacity?.rollback();
			return attachMission(spawnBudgetErrorResult(reservation.error, foregroundMode));
		}

		const execData: ExecutionContextData = omitUndefinedProperties({
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
			recoveryAgents: discoveredAgents,
			runId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			sessionFileForIndex: childSessionFileForIndex,
			sessionFileForTask: childSessionFileForTask,
			thinkingOverrideForTask: forkThinkingOverrideForTask,
			artifactConfig,
			artifactsDir,
			backgroundRequestedWhileClarifying,
			effectiveAsync,
			asyncRunId,
			controlConfig,
			intercomBridge,
			nestedRoute,
			timeoutMs: foregroundTimeout.timeoutMs,
			turnBudget: turnBudget.turnBudget,
			toolBudget: runToolBudget.toolBudget,
			usageBudget: usageBudget.budget,
			allowZeroToolBudget,
			configToolBudget: configToolBudget.toolBudget,
			configToolTimeoutMs: deps.config.toolTimeoutMs,
			contextPolicy,
			modelScope,
			parentModel: requestParentModel,
			parentSessionId: requestSessionId,
			parentPiSessionId: requestPiSessionId,
			capabilityCeiling: resolveCurrentSubagentCapabilityCeiling(requestSessionId),
			runFanoutBudget,
			topLevelAsyncCapacityEligible,
			activeAsyncCapacity,
		});

		const foregroundDescription = selectedAgentNames.length === 1
			? `${selectedAgentNames[0]} child`
			: `${selectedAgentNames.length} live children`;
		const parentWorkflowStatus = effectiveParams.workflowParentRunId
			? readStatus(path.join(DIRS.async, effectiveParams.workflowParentRunId))
			: null;
		const workflowSteeringDir = effectiveParams.workflowParentRunId
			&& requestSessionId
			&& deps.state.workflowControllers?.has(effectiveParams.workflowParentRunId)
			&& parentWorkflowStatus?.mode === "workflow"
			&& (parentWorkflowStatus.state === "running" || parentWorkflowStatus.state === "queued")
			&& parentWorkflowStatus.sessionId === requestSessionId
			? workflowForegroundSteeringDir(DIRS.async, effectiveParams.workflowParentRunId, runId)
			: undefined;
		const foregroundControl: ForegroundRunControl | undefined = effectiveAsync
			? undefined
			: compactOptional<ForegroundRunControl>({
				runId,
				sessionId: requestSessionId,
				mode: foregroundMode,
				...(effectiveParams.workflowParentRunId ? { parentWorkflowRunId: effectiveParams.workflowParentRunId } : {}),
				...(effectiveParams.workflowKey ? { workflowKey: effectiveParams.workflowKey } : {}),
				workflowSteeringDir,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				cwd: effectiveCwd,
				currentAgent: undefined,
				currentIndex: undefined,
				description: foregroundDescription,
				currentActivityState: undefined,
				activeChildren: new Map(),
				// The outer executor owns scheduling until its finally block settles.
				schedulingOwners: 1,
				nestedRoute,
				interrupt: undefined,
			});
		if (foregroundControl) {
			foregroundControl.promptAuditRedo = async (index, guidance) => {
				const audit = getLivePromptAudit(foregroundControl, index);
				if (!audit?.rerun) return { text: "Redo is not safe for this prompt in this slice.", isError: true };
				const rewrittenTask = await rewritePromptWithGuidance({
					ctx,
					authoredTask: audit.authoredTask,
					runtimeAdditions: audit.runtimeAdditions,
					finalEffectivePrompt: audit.finalEffectivePrompt,
					guidance,
					signal,
				});
				const redoParams = promptAuditRedoParams(audit.rerun.params, rewrittenTask);
				const previousForegroundId = deps.state.lastForegroundControlId;
				const launch = execute(randomUUID(), redoParams, signal, undefined, ctx, true);
				const newRunId = deps.state.lastForegroundControlId && deps.state.lastForegroundControlId !== previousForegroundId
					? deps.state.lastForegroundControlId
					: undefined;
				if (!newRunId) {
					const result = await launch;
					return { text: result.content.find((item) => item.type === "text")?.text ?? "Prompt redo could not start.", isError: true };
				}
				foregroundControl.supersededByRunId = newRunId;
				const replacement = deps.state.foregroundControls.get(newRunId);
				if (replacement) replacement.sourceRunId = foregroundControl.runId;
				void launch.then((result) => {
					if (result.isError) console.warn(`[pi-subagents] Prompt redo ${newRunId} failed: ${result.content.find((item) => item.type === "text")?.text ?? "unknown error"}`);
				}).catch((error) => {
					console.warn(`[pi-subagents] Prompt redo ${newRunId} failed: ${error instanceof Error ? error.message : String(error)}`);
				});
				return { text: `Prompt redo started ${newRunId}.` };
			};
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
			deps.activateSupervisorTransport?.();
			deps.refreshResultDelivery?.();
		}

		const writeNestedForegroundEvent = (type: "subagent.nested.started" | "subagent.nested.completed", result?: AgentToolResult<Details>): void => {
			if (!inheritedNestedRoute || !nestedParentAddress) return;
			const now = Date.now();
			const details = result?.details;
			const state = type === "subagent.nested.started"
				? "running"
				: details?.results.some((child) => child.interrupted || child.detached)
					? "paused"
					: result?.isError || details?.results.some((child) => child.exitCode !== 0)
						? "failed"
						: "complete";
			const errorText = result?.isError
				? result.content.find((item) => item.type === "text")?.text
				: undefined;
			let startedLaunches: StaticLaunchSummary[];
			try {
				startedLaunches = collectStaticLaunchSummaries({
					params: effectiveParams,
					agents,
					parentModel: requestParentModel,
					availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
					currentProvider: requestParentModel?.provider,
					modelScope,
					thinkingOverrideForTask: forkThinkingOverrideForTask,
					dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
				});
			} catch (error) {
				console.error("Failed to resolve nested foreground launch metadata:", error);
				startedLaunches = selectedAgentNames.map((agent) => ({ agent }));
			}
			const agentsForSummary = startedLaunches.map((launch) => launch.agent);
			const leafIntercomTarget = intercomBridge.active && agentsForSummary[0]
				? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
				: undefined;
			try {
				writeNestedEvent(inheritedNestedRoute, compactOptional<Parameters<typeof writeNestedEvent>[1]>({
					type,
					ts: now,
					parentRunId: nestedParentAddress.parentRunId,
					parentStepIndex: nestedParentAddress.parentStepIndex,
					child: compactOptional<NestedRunSummary>({
						id: runId,
						parentRunId: nestedParentAddress.parentRunId,
						parentStepIndex: nestedParentAddress.parentStepIndex,
						depth: nestedParentAddress.depth,
						path: nestedParentAddress.path,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget,
						intercomTarget: leafIntercomTarget,
						ownerState: state === "running" ? "live" : "gone",
						mode: foregroundMode,
						state,
						agent: agentsForSummary[0],
						agents: agentsForSummary,
						...(agentsForSummary.length === 1 && (type === "subagent.nested.started" ? startedLaunches[0]?.model : details?.results[0]?.model) ? { model: type === "subagent.nested.started" ? startedLaunches[0]?.model : details?.results[0]?.model } : {}),
						...(agentsForSummary.length === 1 && (type === "subagent.nested.started" ? startedLaunches[0]?.thinking : details?.results[0]?.thinking) ? { thinking: type === "subagent.nested.started" ? startedLaunches[0]?.thinking : details?.results[0]?.thinking } : {}),
						startedAt: foregroundControl?.startedAt ?? now,
						...(state !== "running" ? { endedAt: now } : {}),
						lastUpdate: now,
						...(details?.totalCost ? { totalCost: details.totalCost } : {}),
						...(errorText ? { error: errorText } : {}),
						...(type === "subagent.nested.started"
							? { steps: startedLaunches.map((launch) => ({
								agent: launch.agent,
								status: "running" as const,
								...(launch.model ? { model: launch.model } : {}),
								...(launch.thinking ? { thinking: launch.thinking } : {}),
							})) }
							: details?.results.length
								? { steps: details.results.map((child) => ({
									agent: child.agent,
									status: child.interrupted || child.detached ? "paused" as const : child.exitCode === 0 ? "complete" as const : "failed" as const,
									...(child.model ? { model: child.model } : {}),
									...(child.thinking ? { thinking: child.thinking } : {}),
									...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
									...(child.error ? { error: child.error } : {}),
								})) }
								: {}),
					}),
				}));
			} catch (error) {
				console.error("Failed to emit nested foreground status event:", error);
			}
		};

		let nestedForegroundStarted = false;
		let asyncLaunchFailed = false;
		try {
			if (effectiveAsync) {
				deps.state.liveAsyncSessionRoots ??= new Map();
				deps.state.liveAsyncSessionRoots.set(asyncRunId, sessionRoot);
			}
			if (workflowLaunchObserver) {
				const singleTask = hasTasks && effectiveParams.tasks?.length === 1 ? effectiveParams.tasks[0] : undefined;
				const launch = hasSingle
					? { agent: effectiveParams.agent!, sessionFile: childSessionFileForTask(effectiveParams.agent!, 0, effectiveParams.model), async: effectiveAsync, ...(effectiveAsync ? { runId: asyncRunId } : {}) }
					: singleTask
						? { agent: singleTask.agent, sessionFile: childSessionFileForTask(singleTask.agent, 0, singleTask.model), async: effectiveAsync, ...(effectiveAsync ? { runId: asyncRunId } : {}) }
						: undefined;
				if (launch) {
					workflowLaunchObservers.delete(params);
					workflowLaunchObserver(launch);
				}
			}
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) {
				asyncLaunchFailed = asyncResult.isError === true;
				return attachMission(withRunFanoutBudget(withResolvedContext(withForkThinkingNotes(asyncResult, forkThinkingDowngrades), contextPolicy.contextSummary), runFanoutBudget));
			}
			if (foregroundControl) {
				writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			const runFanoutAnnotateContent = !delegatedExecution;
			if (hasSingle) {
				const result = await runSinglePath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return attachMission(withRunFanoutBudget(withResolvedContext(withForkThinkingNotes(result, forkThinkingDowngrades), contextPolicy.contextSummary), runFanoutBudget, { annotateContent: runFanoutAnnotateContent }));
			}
		} catch (error) {
			asyncLaunchFailed = effectiveAsync;
			const errorResult = withForkThinkingNotes(toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary), forkThinkingDowngrades);
			if (nestedForegroundStarted) writeNestedForegroundEvent("subagent.nested.completed", errorResult);
			return attachMission(errorResult);
		} finally {
			if (effectiveAsync && (asyncLaunchFailed || (activeAsyncCapacity && !activeAsyncCapacity.owner.runnerStartedAt))) deps.state.liveAsyncSessionRoots?.delete(asyncRunId);
			if (activeAsyncCapacity && !activeAsyncCapacity.owner.runnerStartedAt) activeAsyncCapacity.rollback();
			if (foregroundControl) {
				settleForegroundSchedulingOwner(foregroundControl);
				removeForegroundControlIfIdle(deps.state, runId);
			}
		}

		return withResolvedContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, contextPolicy.contextSummary);
	};

	const executeWithSingleDispatchGuard = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		const normalizedAction = typeof params.action === "string" ? params.action.trim() : params.action;
		const requestParams = normalizedAction ? { ...params, action: normalizedAction } : params;
		if (normalizedAction) return execute(id, requestParams, signal, onUpdate, ctx);
		const { depth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		const dispatchParams = applyForceTopLevelAsyncOverride(requestParams, depth, deps.config.forceTopLevelAsync === true);
		const runsForeground = dispatchParams.clarify === true || (dispatchParams.async ?? deps.asyncByDefault) !== true;
		if (!runsForeground) return execute(id, requestParams, signal, onUpdate, ctx);
		if (deps.state.subagentInProgress === true) return duplicateSubagentCallResult(requestParams);
		deps.state.subagentInProgress = true;
		try {
			return await execute(id, requestParams, signal, onUpdate, ctx);
		} finally {
			deps.state.subagentInProgress = false;
		}
	};

	const executePublic = (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		const normalized = normalizePublicSubagentExecution(params);
		if (!normalized.ok) {
			return Promise.resolve({ content: [{ type: "text", text: normalized.error }], isError: true, details: { mode: normalized.mode, results: [] } });
		}
		return executeWithSingleDispatchGuard(id, normalized.params, signal, onUpdate, ctx);
	};

	const executeDelegated = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		const delegatedParams = { ...params };
		const privateParams = delegatedParams as SubagentParamsLike & {
			delegatedThinkingOverride?: AgentConfig["thinking"];
			delegatedAllowZeroToolBudget?: true;
		};
		const thinkingOverride = privateParams.delegatedThinkingOverride;
		const allowZeroToolBudget = privateParams.delegatedAllowZeroToolBudget === true;
		delete privateParams.delegatedThinkingOverride;
		delete privateParams.delegatedAllowZeroToolBudget;
		if (thinkingOverride !== undefined) delegatedThinkingOverrides.set(delegatedParams, thinkingOverride);
		if (allowZeroToolBudget) delegatedZeroToolBudgets.add(delegatedParams);
		delegatedExecutions.add(delegatedParams);
		return execute(id, delegatedParams, signal, onUpdate, ctx);
	};

	const executeScheduled = (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		ctx: ExtensionContext,
	) => {
		const ownerSessionId = resolveCurrentSessionId(ctx.sessionManager);
		let ownerExecutor = scheduledOwnerExecutors.get(ownerSessionId);
		if (!ownerExecutor) {
			ownerExecutor = createSubagentExecutor({
				...deps,
				state: createScheduledOwnerState(deps.state, ownerSessionId, ctx),
			});
			scheduledOwnerExecutors.set(ownerSessionId, ownerExecutor);
		}
		return ownerExecutor.execute(id, params, signal, undefined, ctx);
	};

	return { execute: executeWithSingleDispatchGuard, executePublic, executeDelegated, executeScheduled };
}
