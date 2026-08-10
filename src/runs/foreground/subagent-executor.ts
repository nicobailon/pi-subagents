import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentName, type AgentConfig, type AgentScope } from "../../agents/agents.ts";
import { getArtifactsDir, getChainRunsDir, getProjectArtifactPackagingWarning } from "../../shared/artifacts.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { resolveEffectiveThinking, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { executeChain } from "./chain-execution.ts";
import {
	beginForegroundChild,
	finishForegroundChild,
	foregroundSchedulingSettled,
	retainForegroundSchedulingOwner,
	settleForegroundSchedulingOwner,
	updateForegroundChild,
} from "./foreground-control.ts";
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
import { buildAsyncRunnerSteps, executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../background/async-execution.ts";
import { isScheduledRunAction, type ScheduledRunAction } from "../background/scheduled-runs.ts";
import { enqueueChainAppendRequest, readPendingChainAppendRequests, runnerStepOutputNames } from "../background/chain-append.ts";
import { ChainOutputValidationError, validateChainOutputBindingsWithContext } from "../shared/chain-outputs.ts";
import { normalizeGateAcceptance, validateExecutionAcceptance } from "../shared/acceptance.ts";
import { createForkContextResolver, forkedChildRequiresThinkingOff } from "../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { applyIntercomBridgeToAgent, INTERCOM_BRIDGE_MARKER, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "../shared/subagent-control.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";
import { formatSpawnBudget, getSpawnBudgetSnapshot, grantSpawnBudget, preflightSpawnBudget, preflightSpawnBudgetGrant, reserveSpawnBudget } from "../shared/spawn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { usageBudgetExceededMessage, usageBudgetState, validateUsageBudgetConfig } from "../shared/usage-budget.ts";
import { intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling, type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { isAgentContractV1 } from "../shared/agent-contract.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { cleanupStructuredOutputRuntime, createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd, sumResultsCost, sumResultsUsage } from "../../shared/utils.ts";
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
import { deliverCheckpointDecisionRequest, deliverInterruptRequest, readRevivalBriefs, requestAsyncSteer, type SteerDeliveryMode } from "../background/control-channel.ts";
import { updateSteeringTarget, waitForSteeringAction } from "../background/steering.ts";
import { steerAsyncRun } from "./async-steering-action.ts";
import { stopAsyncRun } from "./async-stop-action.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { resolveAsyncRootResultPath } from "../background/chain-root-attachment.ts";
import { attachRootChildrenToSteps, createNestedRoute, findNestedControlResult, resolveInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, snapshotNestedEventFiles, updateForegroundNestedProjection, writeNestedControlRequest, writeNestedEvent, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import { handleMissionAction, MISSION_ACTIONS } from "../../missions/actions.ts";
import { attachMissionToLaunchResult, prepareMissionLaunch, writeMissionAsyncBinding, type MissionLaunchBinding } from "../../missions/lifecycle.ts";
import { updateMission } from "../../missions/store.ts";
import type { MissionWorkflowChildUpdate } from "../../missions/types.ts";
import { createMissionWorkflowState } from "../../missions/workflow-state.ts";
import { resolveAuthorityDecision } from "../../policy/authority.ts";
import { handleHerdrInspectorAction, HERDR_INSPECTOR_ACTIONS } from "../../inspectors/herdr/actions.ts";
import { handleHerdrProjectPaneAction, HERDR_PROJECT_PANE_ACTIONS } from "../../inspectors/herdr/project-panes.ts";
import { previewSimpleWorkflowRun, runWorkflowScript, WorkflowScriptError, type WorkflowScriptChildResult } from "../../workflows/scripted-workflow.ts";
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
	type IntercomEventBus,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
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
	wrapForkTask,
} from "../../shared/types.ts";

const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete", "eject", "disable", "enable", "reset", "grant-spawn-budget", "watchdog.configure", "mission.create", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close", "inspector.open", "inspector.close", "project.open", "project.close", "worktree.discard", "refine", "refine.rollback", "schedule.create", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"]);
const DESTRUCTIVE_MANAGEMENT_ACTIONS = new Set(["delete", "eject", "disable", "reset", "mission.close", "worktree.discard", "refine.rollback", "inspector.close", "project.close", "stop", "interrupt", "reject-checkpoint", "schedule.delete"]);

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
	step?: ChainStep;
	/** Internal workflow ownership metadata; not part of the public schema. */
	workflowParentRunId?: string;
	workflowKey?: string;
	workflowChildAsyncId?: string;
	suppressRoutineResultIntercom?: boolean;
	/** Internal durable-run compatibility fields. Public callers must use workflowScript. */
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	foregroundOnly?: boolean;
	timeoutMs?: number;
	maxRuntimeMs?: number;
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
	schedule?: string;
	scheduleName?: string;
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
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[]; modelScope?: ModelScopeConfig };
	allowMutatingManagementActions?: boolean;
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
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
	timeoutMs?: number;
	deadlineAt?: number;
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
}

function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

function removeForegroundControlIfIdle(state: SubagentState, runId: string): boolean {
	const control = state.foregroundControls.get(runId);
	if (control && (!foregroundSchedulingSettled(control) || (control.activeChildren?.size ?? 0) > 0)) return false;
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
	return {
		...result,
		content: result.content.map((item, index) => index === 0 && item.type === "text"
			? { ...item, text: `${formatSpawnBudget(spawnBudget)}\n${item.text}` }
			: item),
		details: { ...result.details, spawnBudget },
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
	while (state.foregroundRuns.size > 50) {
		const oldestTerminal = [...state.foregroundRuns.values()]
			.filter((run) => !run.children.some((child) => child.status === "detached"))
			.sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (!oldestTerminal) break;
		state.foregroundRuns.delete(oldestTerminal.runId);
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

function rememberForegroundRun(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; sessionId: string | null; results: SingleResult[]; checkpoint?: Details["checkpoint"] }): void {
	state.foregroundRuns ??= new Map();
	const previous = state.foregroundRuns.get(input.runId);
	const updatedAt = Date.now();
	state.foregroundRuns.set(input.runId, {
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		updatedAt,
		...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
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
	if (activeSteps.length > 0 && activeSteps.every((step) => step.runner?.type === "external-cli")) {
		return {
			content: [{ type: "text", text: `Interrupt is unsupported for one-shot external CLI async run ${target.asyncId}; use stop instead.` }],
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
		const result = enqueueChainAppendRequest({
			asyncDir: resolved.location.asyncDir,
			runId: resolved.id,
			steps: built.steps,
		});
		const stepText = built.steps.length === 1 ? "step" : "steps";
		return {
			content: [{
				type: "text",
				text: `Append queued for chain run ${resolved.id}: ${built.steps.length} ${stepText}. It becomes eligible after the chain's already-queued steps finish. Pending appends: ${result.pendingCount}.`,
			}],
			details: { mode: "management", results: [], asyncId: resolved.id, asyncDir: resolved.location.asyncDir },
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
		return { content: [{ type: "text", text: `Steering scheduled for nested async run ${run.id} (request ${requestId}).` }], details: { mode: "management", results: [], steering: scheduled } };
	}
	const waited = await waitForSteeringAction(omitUndefinedProperties({ asyncDir, sourceRunId: run.id, requestId, timeoutMs: 3_000, signal: input.signal }));
	const result = waited ?? { requestId, state: "pending" as const, deliveryStatus: "queued" as const, sourceRunId: run.id, targets };
	const stateText = result.state === "failed" ? "failed" : result.state === "partial" ? "partial" : result.deliveryStatus === "queued" ? "queued" : result.state === "delivered" ? "delivered" : "pending";
	return { content: [{ type: "text", text: `Steering ${stateText} for nested async run ${run.id} (request ${requestId}).` }], ...(result.state === "failed" || result.state === "partial" ? { isError: true } : {}), details: { mode: "management", results: [], steering: result } };
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
	if (!status?.steps?.length || !status.steps.every((step) => step.runner?.type === "external-cli")) return undefined;
	const message = action === "steer"
		? "One-shot external CLI runners do not accept live steer messages."
		: "One-shot external CLI runners do not persist sessions and cannot be resumed.";
	return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
}

async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
	parentModel?: ParentModel;
	absoluteDeadlineAt?: number;
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
	const intercomBridge = resolveIntercomBridge({
		config: input.deps.config.intercomBridge,
		context: input.params.context,
		orchestratorTarget: sessionName,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const recoveryDescriptor = "recoveryDescriptor" in target ? target.recoveryDescriptor : undefined;
	const discoveredAgentConfig = agents.find((agent) => agent.name === target.agent);
	const agentConfig: AgentConfig | undefined = discoveredAgentConfig ?? (recoveryDescriptor ? {
		name: recoveryDescriptor.agent,
		description: "Persisted async recovery contract",
		systemPrompt: "",
		systemPromptMode: recoveryDescriptor.systemPromptMode,
		inheritProjectContext: recoveryDescriptor.inheritProjectContext,
		inheritSkills: recoveryDescriptor.inheritSkills,
		source: "project",
		filePath: recoveryDescriptor.agentFilePath ?? path.join(recoveryDescriptor.cwd, ".pi-subagents-recovery-agent"),
	} : undefined);
	if (!agentConfig) {
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
		const runId = randomUUID().slice(0, 8);
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
			capabilityCeiling: intersectSubagentCapabilityCeilings("capabilityCeiling" in target ? target.capabilityCeiling : undefined, resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId)),
		}));
		if (result.isError) return result;
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
	const runId = randomUUID().slice(0, 8);
	const recoveryAgentConfig = recoveryDescriptor ? applySteeringRecoveryAgentConfig(agentConfig, recoveryDescriptor) : agentConfig;
	const artifactConfig: ArtifactConfig = recoveryDescriptor?.artifactConfig ?? omitUndefinedProperties({ ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir });
	const artifactsDir = recoveryDescriptor?.artifactsDir ?? getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);
	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const parentModel = input.parentModel;
	const result = executeAsyncSingle(runId, compactOptional<Parameters<typeof executeAsyncSingle>[1]>({
		agent: target.agent,
		task: buildRevivedAsyncTask(target as Parameters<typeof buildRevivedAsyncTask>[0], effectiveFollowUp),
		goal: effectiveFollowUp,
		agentConfig: recoveryAgentConfig,
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
		controlConfig: recoveryDescriptor?.controlConfig ?? resolveControlConfig(input.deps.config.control, input.params.control),
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
		parentWorkflowRunId: input.params.workflowParentRunId,
		workflowKey: input.params.workflowKey,
	}));
	if (result.isError) return result;
	for (const brief of queuedBriefs) fs.rmSync(brief.path, { force: true });
	if (queuedBriefs.length > 0 && sourceAsyncDir) {
		const sourceStatus = readStatus(sourceAsyncDir);
		if (sourceStatus?.steering) {
			for (const brief of queuedBriefs) updateSteeringTarget(sourceStatus.steering, brief.request.id, target.index, "delivered", Date.now());
			writeAtomicJson(path.join(sourceAsyncDir, "status.json"), sourceStatus);
		}
	}

	const revivedId = result.details.asyncId ?? runId;
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

function canonicalizeAgentName(name: string, agents: AgentConfig[]): { name?: string; error?: string } {
	const resolved = resolveAgentName(name, agents);
	if (resolved.error) return { error: resolved.error };
	if (!resolved.agent) return { error: `Unknown agent: ${name}` };
	return { name: resolved.agent.name };
}

function canonicalizeExecutionParams(params: SubagentParamsLike, agents: AgentConfig[]): { params?: SubagentParamsLike; error?: string } {
	const resolve = (name: string, location?: string): { name?: string; error?: string } => {
		const result = canonicalizeAgentName(name, agents);
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

function resolveAgentDefaultContextPolicy(params: SubagentParamsLike, agents: AgentConfig[]): AgentDefaultContextPolicy {
	if (params.context !== undefined) {
		return resolveExplicitContextPolicy(params);
	}
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const contextForAgent = (agentName: string): ContextMode =>
		byName.get(agentName)?.defaultContext === "fork" ? "fork" : "fresh";
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
	const context = params.context === "fork" ? "fork" : "fresh";
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
	return {
		...params,
		...(params.async === undefined && agent.defaultAsync !== undefined ? { async: agent.defaultAsync } : {}),
		...(params.timeoutMs === undefined && params.maxRuntimeMs === undefined && agent.defaultTimeoutMs !== undefined
			? { timeoutMs: agent.defaultTimeoutMs }
			: {}),
		...(params.turnBudget === undefined && agent.defaultTurnBudget !== undefined
			? { turnBudget: agent.defaultTurnBudget }
			: {}),
		...(params.acceptance === undefined && agent.defaultAcceptance !== undefined
			? { acceptance: agent.defaultAcceptance }
			: {}),
	};
}

export const DEFAULT_FOREGROUND_TIMEOUT_MS = 30 * 60 * 1000;

function resolveForegroundTimeout(params: SubagentParamsLike, defaultTimeoutMs?: number): { timeoutMs?: number; error?: string } {
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
	const model = resolveEffectiveSubagentModel(
		input.explicitModel,
		agentConfig?.model,
		input.parentModel,
		input.availableModels,
		input.currentProvider,
		input.modelScope === undefined ? {} : { scope: input.modelScope },
	);
	const thinkingOverride = input.thinkingOverrideForTask(input.agent, input.index, model);
	const thinking = resolveEffectiveThinking(model, thinkingOverride ?? agentConfig?.thinking);
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

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return {
				content: [{ type: "text", text: chainWorktreeTaskCwdError }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		}
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}

	if (!isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const requestedWorkflowChildAsyncId = typeof params.workflowChildAsyncId === "string" ? params.workflowChildAsyncId.trim() : "";
	const id = requestedWorkflowChildAsyncId && path.basename(requestedWorkflowChildAsyncId) === requestedWorkflowChildAsyncId ? requestedWorkflowChildAsyncId : randomUUID();
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

	if (hasTasks && params.tasks) {
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => compactOptional<ParallelTaskItem>({
			agent: task.agent,
			task: shouldForkAgent(contextPolicy, task.agent) ? wrapForkTask(task.task) : task.task,
			cwd: task.cwd,
			...(task.model !== undefined ? { model: task.model } : {}),
			...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
			...(task.output !== undefined && task.output !== true ? { output: task.output } : {}),
			...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
			...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
			...(task.progress !== undefined ? { progress: task.progress } : {}),
			...(task.toolBudget !== undefined ? { toolBudget: task.toolBudget } : {}),
			...(task.outputSchema !== undefined ? { outputSchema: task.outputSchema } : {}),
			...(task.agentContract !== undefined ? { agentContract: task.agentContract } : {}),
			...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
		}));
		return executeAsyncChain(id, compactOptional<Parameters<typeof executeAsyncChain>[1]>({
			chain: [compactOptional<ParallelStep>({
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			})],
			resultMode: "parallel",
			goal: params.tasks[0]?.task ?? "",
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: [],
			sessionFilesByFlatIndex: params.tasks.map((task, index) => sessionFileForTask(task.agent, index, task.model)),
			thinkingOverridesByFlatIndex: params.tasks.map((task, index) => thinkingOverrideForTask(task.agent, index, task.model)),
			contextForAgent: contextPolicy.contextForAgent,
			maxSubagentDepth: currentMaxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			agentContract: params.agentContract,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			capabilityCeiling: data.capabilityCeiling,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
			parentWorkflowRunId: params.workflowParentRunId,
			workflowKey: params.workflowKey,
		}));
	}

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		const rawChain = params.chain as ChainStep[];
		const chain = wrapChainTasksForFork(rawChain, contextPolicy);
		return executeAsyncChain(id, compactOptional<Parameters<typeof executeAsyncChain>[1]>({
			chain,
			task: params.task,
			goal: resolveAsyncEventGoal(params.task, rawChain),
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(chain, sessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems),
			thinkingOverridesByFlatIndex: collectChainThinkingOverrides(chain, thinkingOverrideForTask, deps.config.chain?.dynamicFanout?.maxItems),
			contextForAgent: contextPolicy.contextForAgent,
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			agentContract: params.agentContract,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			capabilityCeiling: data.capabilityCeiling,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
			parentWorkflowRunId: params.workflowParentRunId,
			workflowKey: params.workflowKey,
		}));
	}

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
		const modelOverride = resolveEffectiveSubagentModel(params.model as string | undefined, a.model, parentModel, availableModels, currentProvider, data.modelScope === undefined ? {} : { scope: data.modelScope });
		return executeAsyncSingle(id, compactOptional<Parameters<typeof executeAsyncSingle>[1]>({
			agent: params.agent!,
			task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			goal: params.task ?? "",
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForTask(params.agent!, 0, modelOverride),
			context: contextPolicy.contextForAgent(params.agent!),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			...(params.reads !== undefined ? { reads: params.reads } : {}),
			outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
			modelOverride,
			thinkingOverride: thinkingOverrideForTask(params.agent!, 0, modelOverride),
			maxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
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
			capabilityCeiling: data.capabilityCeiling,
			parentWorkflowRunId: params.workflowParentRunId,
			workflowKey: params.workflowKey,
		}));
	}

	return null;
}

async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactsDir,
		artifactConfig,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForFork(params.chain as ChainStep[], contextPolicy);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const chainCtx = normalizeParentModel(ctx.model) || !data.parentModel ? ctx : ({ ...ctx, model: data.parentModel } as ExtensionContext);
	const chainResult = await executeChain(compactOptional<Parameters<typeof executeChain>[0]>({
		chain,
		task: params.task,
		agents,
		ctx: chainCtx,
		modelScope: data.modelScope,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		contextForAgent: contextPolicy.contextForAgent,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		agentContract: params.agentContract,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		foregroundControl,
		nestedRoute: foregroundControl?.nestedRoute,
		chainSkills,
		chainDir: params.chainDir ?? getChainRunsDir(effectiveCwd, artifactConfig.dir),
		dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: currentMaxSubagentDepth,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
		worktreeBaseDir: deps.config.worktreeBaseDir,
		timeoutMs: data.timeoutMs,
		deadlineAt: data.deadlineAt,
		turnBudget: data.turnBudget,
		onDetachedExit: (index, result) => {
			try {
				updateRememberedForegroundChild(deps.state, { runId, mode: "chain", cwd: effectiveCwd, sessionId: data.parentSessionId, index, result, events: deps.pi.events });
			} finally {
				removeForegroundControlIfIdle(deps.state, runId);
			}
		},
		onForegroundChildSettled: () => {
			removeForegroundControlIfIdle(deps.state, runId);
		},
		toolBudget: data.toolBudget,
		usageBudget: data.usageBudget,
		configToolBudget: data.configToolBudget,
		permissions: deps.config.permissions,
		globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		capabilityCeiling: data.capabilityCeiling,
	}));

	if (chainResult.requestedAsync) {
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const id = randomUUID();
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
		const rawAsyncChain = chainResult.requestedAsync.chain;
		const asyncChain = wrapChainTasksForFork(rawAsyncChain, contextPolicy);
		const firstAgent = firstChainAgent(rawAsyncChain);
		return executeAsyncChain(id, compactOptional<Parameters<typeof executeAsyncChain>[1]>({
			chain: asyncChain,
			task: params.task,
			goal: resolveAsyncEventGoal(params.task, rawAsyncChain, firstAgent ? shouldForkAgent(contextPolicy, firstAgent) : false),
			agents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems),
			thinkingOverridesByFlatIndex: collectChainThinkingOverrides(asyncChain, thinkingOverrideForTask, deps.config.chain?.dynamicFanout?.maxItems),
			contextForAgent: contextPolicy.contextForAgent,
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			agentContract: params.agentContract,
			controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			nestedRoute: data.nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			capabilityCeiling: data.capabilityCeiling,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		}));
	}

	const rawChainDetails = chainResult.details ? compactOptional<Details>({ ...chainResult.details, runId, timeoutMs: data.timeoutMs }) : undefined;
	if (foregroundControl && rawChainDetails) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, rawChainDetails.results, foregroundControl.nestedChildren);
		rawChainDetails.totalCost = sumResultsCost(rawChainDetails.results);
		const usageBudget = usageBudgetState(data.usageBudget, rawChainDetails.totalCost);
		if (usageBudget === undefined) delete rawChainDetails.usageBudget;
		else rawChainDetails.usageBudget = usageBudget;
	}
	const chainDetails = rawChainDetails ? compactForegroundDetails(rawChainDetails) : undefined;
	if (chainDetails) rememberForegroundRun(deps.state, { runId, mode: "chain", cwd: effectiveCwd, sessionId: data.parentSessionId, results: chainDetails.results, checkpoint: chainDetails.checkpoint });
	const intercomReceipt = chainDetails && !chainDetails.results.some((result) => result.interrupted || result.detached)
		? await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "chain",
			details: chainDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		})
		: null;
	if (intercomReceipt) {
		return {
			...chainResult,
			content: [{ type: "text", text: intercomReceipt.text }],
			details: intercomReceipt.details,
		};
	}

	return chainDetails ? { ...chainResult, details: chainDetails } : chainResult;
}

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	taskDescriptions: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	state: SubagentState;
	intercomEvents: IntercomEventBus;
	parentSessionId: string | null;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: ForkSessionFileForTask;
	thinkingOverrideForTask: ForkThinkingOverrideForTask;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	outputBaseDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd: string;
	progressDir: string;
	maxSubagentDepths: number[];
	waitToolEnabled?: boolean;
	availableModels: ModelInfo[];
	modelScope?: ModelScopeConfig;
	parentModel?: ParentModel;
	modelOverrides: (string | undefined)[];
	behaviors: Array<ReturnType<typeof resolveStepBehavior>>;
	firstProgressIndex: number;
	controlConfig: ResolvedControlConfig;
	contextPolicy: AgentDefaultContextPolicy;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	globalSemaphore?: Semaphore;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: AgentToolResult<Details>) => void;
	worktreeSetup?: WorktreeSetup;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	usageBudget?: UsageBudgetConfig;
	toolBudgets: (ResolvedToolBudget | undefined)[];
	agentContract?: AgentContract;
	permissions?: ExtensionConfig["permissions"];
}
function buildParallelModeError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
	baseDir: ExtensionConfig["worktreeBaseDir"],
): { setup?: WorktreeSetup; errorResult?: AgentToolResult<Details> } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, omitUndefinedProperties({
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook
					? { hookPath: setupHook, ...(setupHookTimeoutMs === undefined ? {} : { timeoutMs: setupHookTimeoutMs }) }
					: undefined,
				baseDir,
			})),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

function resolveSingleRunOutputBaseDir(deps: ExecutorDeps, artifactsDir: string, runId: string): string {
	return deps.config.singleRunOutputBaseDir
		? path.resolve(deps.expandTilde(deps.config.singleRunOutputBaseDir))
		: path.join(artifactsDir, "outputs", runId);
}

function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step) || !step.worktree) continue;
		const stepCwd = resolveChildCwd(sharedCwd, step.cwd);
		const conflict = findWorktreeTaskCwdConflict(step.parallel, stepCwd);
		if (!conflict) continue;
		const detail = formatWorktreeTaskCwdConflict(conflict, stepCwd);
		return `parallel chain step ${stepIndex + 1}: ${detail}`;
	}
	return undefined;
}

function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

function finalizeParallelWorktreeHandoff(input: {
	worktreeSetup: WorktreeSetup;
	artifactsDir: string;
	runId: string;
	cwd: string;
	tasks: TaskParam[];
	results: SingleResult[];
}): { suffix: string; reference?: NonNullable<Details["parallelHandoff"]> } {
	const diffsDir = path.join(input.artifactsDir, "worktree-diffs", input.runId);
	const diffs = diffWorktrees(input.worktreeSetup, input.tasks.map((task) => task.agent), diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	const manifestPath = parallelHandoffPath(input.artifactsDir, input.runId);
	const handoff = {
		manifestPath,
		runId: input.runId,
		mode: "parallel" as const,
		source: "foreground" as const,
		cwd: input.cwd,
		stepIndex: 0,
		flatStartIndex: 0,
		setup: input.worktreeSetup,
		diffs,
		results: input.results.map((result) => ({
			agent: result.agent,
			status: resolveSubagentResultStatus(omitUndefinedProperties({
				exitCode: result.exitCode,
				interrupted: result.interrupted,
				detached: result.detached,
				state: result.stopped ? "stopped" : undefined,
				processSignal: result.processSignal,
				timedOut: result.timedOut,
				stopped: result.stopped,
				turnBudgetExceeded: result.turnBudgetExceeded,
			})),
			summary: resultSummaryForIntercom(result),
			...(result.artifactPaths?.outputPath ? { outputPath: result.artifactPaths.outputPath } : {}),
			...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
			...(result.structuredOutputPath ? { structuredOutputPath: result.structuredOutputPath } : {}),
			...(result.sessionFile ? { sessionPath: result.sessionFile } : {}),
		})),
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

function findDuplicateParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
	paramsCwd: string;
	ctxCwd: string;
	outputBaseDir: string;
	worktreeSetup?: WorktreeSetup;
}): string | undefined {
	const seen = new Map<string, { index: number; agent: string }>();
	for (let index = 0; index < input.tasks.length; index++) {
		const behavior = input.behaviors[index];
		if (!behavior?.output) continue;
		const task = input.tasks[index]!;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const outputPath = resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd, input.outputBaseDir);
		if (!outputPath) continue;
		const previous = seen.get(outputPath);
		if (previous) {
			return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
		}
		seen.set(outputPath, { index, agent: task.agent });
	}
	return undefined;
}

async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	// Pre-warm fork session files sequentially before concurrent dispatch to avoid
	// races where multiple workers simultaneously try to branch the same parent session.
	for (let i = 0; i < input.tasks.length; i++) {
		input.sessionFileForTask(input.tasks[i]!.agent, i, input.modelOverrides[i]);
	}
	const completedResults: SingleResult[] = [];
	if (input.foregroundControl) retainForegroundSchedulingOwner(input.foregroundControl);
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		const budgetState = usageBudgetState(input.usageBudget, sumResultsCost(completedResults));
		if (budgetState?.exhausted) {
			return {
				index,
				agent: task.agent,
				task: input.taskTexts[index] ?? "(skipped)",
				exitCode: 1,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				error: usageBudgetExceededMessage(budgetState),
				skipped: true,
			} as SingleResult;
		}
		const behavior = input.behaviors[index];
		const effectiveSkills = behavior?.skills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const readInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
			: { prefix: "", suffix: "" };
		const progressInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, reads: false }, input.progressDir, index === input.firstProgressIndex)
			: { prefix: "", suffix: "" };
		const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd, input.outputBaseDir);
		const agentConfig = input.agents.find((agent) => agent.name === task.agent);
		const taskText = injectSingleOutputInstruction(
			`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
			outputPath,
			agentConfig,
		);
		const interruptController = new AbortController();
		if (input.foregroundControl) {
			const model = input.modelOverrides[index];
			const thinking = resolveEffectiveThinking(model, input.thinkingOverrideForTask(task.agent, index, model));
			beginForegroundChild(input.foregroundControl, {
				index,
				agent: task.agent,
				...(input.taskDescriptions[index] === undefined ? {} : { description: input.taskDescriptions[index] }),
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
				interrupt: () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					return true;
				},
			});
		}
		const structuredRuntime = task.outputSchema
			? createStructuredOutputRuntime(task.outputSchema, path.join(input.artifactsDir, "structured-output", input.runId))
			: undefined;
		let detachedReceipt = false;
		const result = await runSync(input.ctx.cwd, input.agents, task.agent, taskText, compactOptional<Parameters<typeof runSync>[4]>({
			permissions: input.permissions,
			parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
			context: input.contextPolicy.contextForAgent(task.agent),
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: input.intercomEvents,
			runId: input.runId,
			index,
			sessionDir: input.sessionDirForIndex(index),
			sessionFile: input.sessionFileForTask(task.agent, index, input.modelOverrides[index]),
			share: input.shareEnabled,
			artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
			artifactConfig: input.artifactConfig,
			maxOutput: input.maxOutput,
			outputPath,
			outputMode: behavior?.outputMode,
			maxSubagentDepth: input.maxSubagentDepths[index],
			waitToolEnabled: input.waitToolEnabled,
			capabilityCeiling: input.capabilityCeiling,
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			onDetachedExit: (result) => {
				try {
					updateRememberedForegroundChild(input.state, { runId: input.runId, mode: "parallel", cwd: taskCwd, sessionId: input.parentSessionId, index, result, events: input.intercomEvents });
				} finally {
					try {
						if (input.foregroundControl) finishForegroundChild(input.foregroundControl, index);
					} finally {
						removeForegroundControlIfIdle(input.state, input.runId);
					}
				}
			},
			intercomSessionName: input.childIntercomTarget?.(task.agent, index),
			orchestratorIntercomTarget: input.orchestratorIntercomTarget,
			nestedRoute: input.foregroundControl?.nestedRoute,
			modelOverride: input.modelOverrides[index],
			thinkingOverride: input.thinkingOverrideForTask(task.agent, index, input.modelOverrides[index]),
			availableModels: input.availableModels,
			preferredModelProvider: input.parentModel?.provider,
			modelScope: input.modelScope,
			skills: effectiveSkills === false ? [] : effectiveSkills,
			structuredOutput: structuredRuntime,
			agentContract: task.agentContract ?? input.agentContract,
			acceptance: task.acceptance,
			acceptanceContext: { mode: "parallel" },
			timeoutMs: input.timeoutMs,
			deadlineAt: input.deadlineAt,
			turnBudget: input.turnBudget,
			toolBudget: input.toolBudgets[index],
			onUpdate: input.onUpdate
				? (progressUpdate) => {
					const stepResults = progressUpdate.details?.results || [];
					const stepProgress = progressUpdate.details?.progress || [];
					if (input.foregroundControl && stepProgress.length > 0) {
						updateForegroundChild(input.foregroundControl, index, stepProgress[0]);
					}
					if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
					if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
					const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
					const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
					input.onUpdate?.({
						content: progressUpdate.content,
						details: compactOptional<Details>({
							mode: "parallel",
							results: mergedResults,
							progress: mergedProgress,
							controlEvents: progressUpdate.details?.controlEvents,
							totalSteps: input.tasks.length,
						}),
					});
				}
				: undefined,
		})).then((result) => {
			detachedReceipt = result.detached === true;
			return result;
		}).finally(() => {
			// mapConcurrent rejects before siblings settle, so every attached child
			// attempts idle removal after releasing its own control. Detached receipts
			// transfer both responsibilities to the authoritative exit callback.
			if (!detachedReceipt) {
				if (input.foregroundControl) finishForegroundChild(input.foregroundControl, index);
				removeForegroundControlIfIdle(input.state, input.runId);
			}
		});
		completedResults.push(result);
		return result;
	}, input.globalSemaphore, () => {
		if (input.foregroundControl) settleForegroundSchedulingOwner(input.foregroundControl);
		removeForegroundControlIfIdle(input.state, input.runId);
	});
}

async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);
	const toolBudgets: (ResolvedToolBudget | undefined)[] = [];
	for (let index = 0; index < tasks.length; index++) {
		const resolved = resolveEffectiveToolBudget(omitUndefinedProperties({ stepBudget: tasks[index]?.toolBudget, runBudget: data.toolBudget, agentBudget: agentConfigs[index]?.toolBudget, configBudget: data.configToolBudget }));
		if (resolved.error) return buildParallelModeError(resolved.error);
		toolBudgets.push(resolved.toolBudget);
	}

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const parentModel = data.parentModel;
	const currentProvider = parentModel?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined && task.output !== true ? { output: task.output } : {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model !== undefined ? { model: task.model } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveEffectiveSubagentModel(behaviorOverrides[i]?.model, agentConfigs[i]?.model, parentModel, availableModels, currentProvider, data.modelScope === undefined ? {} : { scope: data.modelScope }),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, behaviorOverrides[i]!),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model !== undefined) {
				modelOverrides[i] = resolveEffectiveSubagentModel(override.model, agentConfigs[i]?.model, parentModel, availableModels, currentProvider, data.modelScope === undefined ? {} : { scope: data.modelScope });
				behaviorOverrides[i]!.model = override.model;
			}
			if (override?.output !== undefined) behaviorOverrides[i]!.output = override.output;
			if (override?.reads !== undefined) behaviorOverrides[i]!.reads = override.reads;
			if (override?.progress !== undefined) behaviorOverrides[i]!.progress = override.progress;
			if (override?.skills !== undefined) {
				skillOverrides[i] = override.skills;
				behaviorOverrides[i]!.skills = override.skills;
			}
		}

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			const id = randomUUID();
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
			const parallelTasks = tasks.map((t, i) => {
				const taskText = shouldForkAgent(contextPolicy, t.agent) ? wrapForkTask(taskTexts[i]!) : taskTexts[i]!;
				const progress = taskDisallowsFileUpdates(taskText) ? false : behaviorOverrides[i]?.progress;
				return compactOptional<ParallelTaskItem>({
					agent: t.agent,
					task: taskText,
					cwd: t.cwd,
					...(behaviorOverrides[i]?.model !== undefined ? { model: behaviorOverrides[i]!.model } : {}),
					...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
					...(behaviorOverrides[i]?.output !== undefined ? { output: behaviorOverrides[i]!.output } : {}),
					...(behaviorOverrides[i]?.outputMode !== undefined ? { outputMode: behaviorOverrides[i]!.outputMode } : {}),
					...(behaviorOverrides[i]?.reads !== undefined ? { reads: behaviorOverrides[i]!.reads } : {}),
					...(progress !== undefined ? { progress } : {}),
					...(t.toolBudget !== undefined ? { toolBudget: t.toolBudget } : {}),
					...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
					...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
					...(t.agentContract !== undefined ? { agentContract: t.agentContract } : {}),
				});
			});
			return executeAsyncChain(id, compactOptional<Parameters<typeof executeAsyncChain>[1]>({
				chain: [compactOptional<ParallelStep>({ parallel: parallelTasks, concurrency: parallelConcurrency, worktree: params.worktree })],
				resultMode: "parallel",
				goal: taskTexts[0] ?? "",
				agents,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				chainSkills: [],
				sessionFilesByFlatIndex: tasks.map((task, index) => sessionFileForTask(task.agent, index, modelOverrides[index])),
				thinkingOverridesByFlatIndex: tasks.map((task, index) => thinkingOverrideForTask(task.agent, index, modelOverrides[index])),
				contextForAgent: contextPolicy.contextForAgent,
				maxSubagentDepth: currentMaxSubagentDepth,
				waitToolEnabled: deps.waitToolEnabled,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				worktreeBaseDir: deps.config.worktreeBaseDir,
				controlConfig,
				agentContract: params.agentContract,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				nestedRoute: data.nestedRoute,
				timeoutMs: data.timeoutMs,
				turnBudget: data.turnBudget,
				usageBudget: data.usageBudget,
				toolBudget: data.toolBudget,
				configToolBudget: data.configToolBudget,
				globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
			}));
		}
	}

	const behaviors = tasks.map((task, index) => {
		let behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agentConfigs[index]!, behaviorOverrides[index]!), taskTexts[index]);
		if (behaviorOverrides[index]?.output === undefined && typeof behavior.output === "string" && !path.isAbsolute(behavior.output)) {
			behavior = { ...behavior, output: path.join("parallel-0", `${index}-${task.agent}`, behavior.output) };
		}
		return behavior;
	});
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
		deps.config.worktreeBaseDir,
	);
	if (errorResult) return errorResult;

	let worktreeCleanupHandled = false;
	let pendingHandoff: Details["parallelHandoff"];
	try {
		if (worktreeSetup) {
			pendingHandoff = writePendingParallelHandoff({
				manifestPath: parallelHandoffPath(artifactsDir, runId),
				runId,
				mode: "parallel",
				source: "foreground",
				cwd: effectiveCwd,
				stepIndex: 0,
				flatStartIndex: 0,
				setup: worktreeSetup,
			});
		}
		const outputBaseDir = path.join(artifactsDir, "outputs", runId);
		const duplicateOutputError = findDuplicateParallelOutputPath(omitUndefinedProperties({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			outputBaseDir,
			worktreeSetup,
		}));
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		for (let index = 0; index < tasks.length; index++) {
			const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, worktreeSetup, index);
			const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd, outputBaseDir);
			const validationError = validateFileOnlyOutputMode(behaviors[index]?.outputMode, outputPath, `Parallel task ${index + 1} (${tasks[index]!.agent})`);
			if (validationError) return buildParallelModeError(validationError);
		}

		const parallelProgressPrecreated = firstProgressIndex !== -1;
		const parallelProgressDir = path.join(artifactsDir, "progress", runId);
		if (parallelProgressPrecreated) writeInitialProgressFile(parallelProgressDir);

		const taskDescriptions = taskTexts.map((taskText) => taskText.trim());
		for (let i = 0; i < taskTexts.length; i++) {
			if (shouldForkAgent(contextPolicy, tasks[i]!.agent)) taskTexts[i] = wrapForkTask(taskTexts[i]!);
		}

		const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
		const results = await runForegroundParallelTasks(compactOptional<ForegroundParallelRunInput>({
			tasks,
			permissions: deps.config.permissions,
			taskTexts,
			taskDescriptions,
			agents,
			ctx,
			state: deps.state,
			intercomEvents: deps.pi.events,
			parentSessionId: data.parentSessionId,
			capabilityCeiling: data.capabilityCeiling,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			sessionFileForTask,
			thinkingOverrideForTask,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			outputBaseDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			progressDir: parallelProgressDir,
			availableModels,
			modelScope: data.modelScope,
			parentModel,
			modelOverrides,
			behaviors,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			contextPolicy,
			onControlEvent,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			globalSemaphore: new Semaphore(deps.config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT),
			maxSubagentDepths,
			waitToolEnabled: deps.waitToolEnabled,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
			timeoutMs: data.timeoutMs,
			deadlineAt,
			turnBudget: data.turnBudget,
			usageBudget: data.usageBudget,
			toolBudgets,
			agentContract: params.agentContract,
		}));
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		if (foregroundControl) {
			updateForegroundNestedProjection(foregroundControl);
			attachRootChildrenToSteps(runId, results, foregroundControl.nestedChildren);
		}
		const detached = results.find((result) => result.detached);
		let handoff: ReturnType<typeof finalizeParallelWorktreeHandoff> | undefined;
		if (worktreeSetup) {
			worktreeCleanupHandled = true;
			handoff = detached
				? { suffix: pendingHandoff ? formatParallelHandoffReference(pendingHandoff) : "", reference: pendingHandoff }
				: finalizeParallelWorktreeHandoff({ worktreeSetup, artifactsDir, runId, cwd: effectiveCwd, tasks, results });
		}
		const interrupted = results.find((result) => result.interrupted);
		const totalCost = sumResultsCost(results);
		const details = compactForegroundDetails(compactOptional<Details>({
			mode: "parallel",
			runId,
			timeoutMs: data.timeoutMs,
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			totalChildUsage: sumResultsUsage(results),
			totalCost,
			usageBudget: usageBudgetState(data.usageBudget, totalCost),
			...(handoff?.reference ? { parallelHandoff: handoff.reference } : {}),
		}));
		rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, sessionId: data.parentSessionId, results: details.results });
		if (interrupted) {
			return {
				content: [{ type: "text", text: `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.` }],
				details,
			};
		}
		if (detached) {
			const handoffSuffix = handoff?.suffix ? `\n\n${handoff.suffix}` : "";
			return {
				content: [{ type: "text", text: `Parallel run detached for intercom coordination (${detached.agent}). Reply to the supervisor request first, then wait with subagent_wait({ id: "${runId}" }). Use subagent({ action: "status", id: "${runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.${handoffSuffix}` }],
				details,
			};
		}

		const suppressRoutineResultIntercom = shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: params.suppressRoutineResultIntercom, results });
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		if (!suppressRoutineResultIntercom) {
			const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
				pi: deps.pi,
				intercomBridge: data.intercomBridge,
				runId,
				mode: "parallel",
				details,
				...(params.workflowParentRunId !== undefined ? { preserveDetailsOutputs: true } : {}),
				...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
			});
			if (intercomReceipt) {
				return {
					content: [{ type: "text", text: intercomReceipt.text }],
					details: intercomReceipt.details,
				};
			}
		}

		const worktreeSuffix = handoff?.suffix ?? "";
		const ok = results.filter((result) => result.exitCode === 0).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				...(result.error === undefined ? {} : { error: result.error }),
				...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
		};
	} finally {
		if (worktreeSetup && !worktreeCleanupHandled) cleanupWorktrees(worktreeSetup);
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

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, omitUndefinedProperties({ output: effectiveOutput, skills: skillOverride }));
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model !== undefined) modelOverride = resolveEffectiveSubagentModel(override.model, agentConfig.model, parentModel, availableModels, currentProvider, data.modelScope === undefined ? {} : { scope: data.modelScope });
		if (override?.output !== undefined) effectiveOutput = normalizeSingleOutputOverride(override.output, agentConfig.output);
		if (override?.skills !== undefined) skillOverride = override.skills;
		if (override?.reads !== undefined) readsOverride = override.reads;

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const id = randomUUID();
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
			return executeAsyncSingle(id, compactOptional<Parameters<typeof executeAsyncSingle>[1]>({
				agent: params.agent!,
				task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(task) : task,
				goal: task,
				agentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForTask(params.agent!, 0, modelOverride),
				context: contextPolicy.contextForAgent(params.agent!),
				skills: skillOverride === false ? [] : skillOverride,
				output: effectiveOutput,
				outputMode: effectiveOutputMode,
				...(readsOverride !== undefined ? { reads: readsOverride } : {}),
				outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
				modelOverride,
				thinkingOverride: thinkingOverrideForTask(params.agent!, 0, modelOverride),
				maxSubagentDepth,
				waitToolEnabled: deps.waitToolEnabled,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				worktreeBaseDir: deps.config.worktreeBaseDir,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				nestedRoute: data.nestedRoute,
				agentContract: params.agentContract,
				structuredOutputSchema: params.outputSchema,
				acceptance: params.acceptance,
				timeoutMs: data.timeoutMs,
				turnBudget: data.turnBudget,
				toolBudget: effectiveToolBudget.toolBudget,
				usageBudget: data.usageBudget,
				allowZeroToolBudget: data.allowZeroToolBudget && effectiveToolBudget.toolBudget === data.toolBudget,
			}));
		}
	}

	if (shouldForkAgent(contextPolicy, params.agent!)) {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd, resolveSingleRunOutputBaseDir(deps, artifactsDir, runId));
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	const structuredRuntime = params.outputSchema
		? createStructuredOutputRuntime(params.outputSchema, artifactConfig.enabled ? path.join(artifactsDir, "structured-output", runId) : undefined)
		: undefined;
	// Reads: caller override > agent defaultReads > none. `~`/`~/` expand to home;
	// absolute paths pass through; relative paths resolve against the child cwd.
	const reads = readsOverride !== undefined ? readsOverride : agentConfig.defaultReads ?? false;
	const readsInstruction = Array.isArray(reads) && reads.length > 0
		? `[Read from: ${reads.map((f) => resolveChainPath(f, effectiveCwd)).join(", ")}]\n\n`
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
			context: data.contextPolicy.contextForAgent(params.agent!),
			cwd: effectiveCwd,
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
			onDetachReady: (detach) => {
				detachForeground = detach;
			},
			onDetachedExit: (result) => {
				try {
					try {
						updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: effectiveCwd, sessionId: data.parentSessionId, index: 0, result, events: deps.pi.events, notify: params.workflowParentRunId === undefined });
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
			turnBudget: data.turnBudget,
			enforceHardTurnLimit: params.enforceHardTurnLimit,
			toolBudget: effectiveToolBudget.toolBudget,
			capabilityCeiling: data.capabilityCeiling,
			allowZeroToolBudget: data.allowZeroToolBudget && effectiveToolBudget.toolBudget === data.toolBudget,
		}));
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

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput(omitUndefinedProperties({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
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
	}));
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, sessionId: data.parentSessionId, results: details.results });

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

	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first, then wait with subagent_wait({ id: "${runId}" }). Use subagent({ action: "status", id: "${runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.` }],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details,
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: formatFailedSingleRunOutput(r, finalizedOutput.displayOutput) }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
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

const workflowLaunchObservers = new WeakMap<object, (launch: { agent: string; sessionFile?: string }) => void>();

function recordMissionWorkflowChild(
	binding: MissionLaunchBinding | undefined,
	workflowRunId: string,
	key: string,
	update: Omit<MissionWorkflowChildUpdate, "workflowRunId" | "key">,
): void {
	if (!binding) return;
	try {
		updateMission(binding.location, binding.missionId, { upsertWorkflowChildren: [{ workflowRunId, key, ...update }] });
	} catch (error) {
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
	return {
		key,
		ok,
		...(result.details.runId || result.details.asyncId ? { runId: result.details.runId ?? result.details.asyncId } : {}),
		output,
		...(!ok ? { error: receiptOutput || output || "Child run failed." } : {}),
		...(structured.length === 1 ? { structuredOutput: structured[0] } : structured.length > 1 ? { structuredOutput: structured } : {}),
		artifactPaths: [...artifactPaths],
		results: result.details.results,
	};
}

export function prepareWorkflowLaunchParams(
	workflowDefaults: SubagentParamsLike,
	childParams: Record<string, unknown>,
	parentWorkflowRunId: string,
	workflowKey: string,
	options: { missionDetached?: boolean; suppressRoutineResultIntercom?: boolean } = {},
): SubagentParamsLike {
	if (typeof childParams.resume === "string") {
		if (childParams.gate !== undefined || workflowDefaults.gate !== undefined) {
			throw new Error("gate is not supported with retained resume; resume uses the retained child contract.");
		}
		const timeoutMs = childParams.timeoutMs ?? childParams.maxRuntimeMs ?? workflowDefaults.timeoutMs ?? workflowDefaults.maxRuntimeMs;
		const turnBudget = childParams.turnBudget ?? workflowDefaults.turnBudget;
		const toolBudget = childParams.toolBudget ?? workflowDefaults.toolBudget;
		return {
			action: "resume",
			id: childParams.resume.trim(),
			message: typeof childParams.task === "string" ? childParams.task.trim() : "",
			workflowParentRunId: parentWorkflowRunId,
			workflowKey,
			...(options.missionDetached ? { mission: false } : {}),
			...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
			...(turnBudget !== undefined ? { turnBudget: turnBudget as TurnBudgetConfig } : {}),
			...(toolBudget !== undefined ? { toolBudget: toolBudget as ToolBudgetConfig } : {}),
		};
	}
	const launchParams = {
		...workflowDefaults,
		...childParams,
		...(options.missionDetached ? { mission: false } : {}),
		workflowParentRunId: parentWorkflowRunId,
		workflowKey,
		...(options.suppressRoutineResultIntercom ? { suppressRoutineResultIntercom: true } : {}),
	} as SubagentParamsLike;
	const normalizedGate = normalizeGateParams(launchParams);
	if (!normalizedGate.ok) throw new Error(normalizedGate.error);
	return prepareWorkflowChildParams(normalizedGate.params);
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

function prepareWorkflowChildParams(params: SubagentParamsLike): SubagentParamsLike {
	if (params.worktree !== true || !params.agent) return params;
	const {
		agent,
		task = "",
		model,
		skill,
		output,
		outputMode,
		outputSchema,
		acceptance,
		agentContract,
		toolBudget,
		reads,
		...runParams
	} = params;
	return {
		...runParams,
		worktree: true,
		tasks: [{
			agent,
			task,
			...(model !== undefined ? { model } : {}),
			...(skill !== undefined ? { skill } : {}),
			...(output !== undefined ? { output } : {}),
			...(reads !== undefined ? { reads } : {}),
			...(outputMode !== undefined ? { outputMode } : {}),
			...(outputSchema !== undefined ? { outputSchema } : {}),
			...(acceptance !== undefined ? { acceptance } : {}),
			...(agentContract !== undefined ? { agentContract } : {}),
			...(toolBudget !== undefined ? { toolBudget } : {}),
		}],
	};
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
			const timeout = requestParams.timeoutMs ?? requestParams.maxRuntimeMs ?? (requestParams.async === false ? DEFAULT_FOREGROUND_TIMEOUT_MS : undefined);
			const workflowUsageBudget = validateUsageBudgetConfig(requestParams.usageBudget ?? deps.config.usageBudget, requestParams.usageBudget ? "usageBudget" : "config.usageBudget");
			if (workflowUsageBudget.error) return buildRequestedModeError(requestParams, workflowUsageBudget.error);
			const workflowCwd = resolveRequestedCwd(parentCwd, requestParams.cwd);
			const chatProgressResult = resolveWorkflowChatProgress({ requested: requestParams.chatProgress, parentCwd, workflowCwd, background: requestParams.async !== false });
			if (chatProgressResult.error) return { content: [{ type: "text", text: chatProgressResult.error }], isError: true, details: { mode: "workflow", results: [] } };
			const chatProgress = chatProgressResult.projection!;
			const explicitMission = requestParams.missionId !== undefined || requestParams.mission !== undefined;
			const autoMission = !explicitMission;
			const workflowPreview = autoMission ? previewSimpleWorkflowRun(requestParams.workflowScript) : undefined;
			const previewTask = workflowPreview?.task?.trim() || undefined;
			const previewAgent = workflowPreview?.agent?.trim() || undefined;
			const scriptFirstLine = requestParams.workflowScript.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Workflow";
			const boundedScriptPreview = scriptFirstLine.length > 100 ? `${scriptFirstLine.slice(0, 97)}...` : scriptFirstLine;
			const derivedObjective = previewTask || (previewAgent ? `Workflow: ${previewAgent}` : boundedScriptPreview);
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
				if (explicitMission) return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "workflow", results: [] } };
				missionWarning = `Mission tracking unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}
			let shouldPatchMissionObjective = autoMission && previewTask === undefined && missionBinding !== undefined;
			const patchMissionObjective = (task: unknown): void => {
				if (!shouldPatchMissionObjective || !missionBinding || typeof task !== "string" || !task.trim()) return;
				shouldPatchMissionObjective = false;
				const objective = task.trim();
				const firstLine = objective.split(/\r?\n/, 1)[0]?.trim() || objective;
				const title = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
				try {
					updateMission(missionBinding.location, missionBinding.missionId, { title, objective });
				} catch (error) {
					console.warn(`[pi-subagents] Failed to update automatic mission objective: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
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
			if (requestParams.async !== false) {
				const toolCallId = _id;
				const workflowRunId = randomUUID();
				const asyncDir = path.join(DIRS.async, workflowRunId);
				const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
				const statusPath = path.join(asyncDir, "status.json");
				const eventsPath = path.join(asyncDir, "events.jsonl");
				const startedAt = Date.now();
				const currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.mkdirSync(DIRS.results, { recursive: true });
				const controller = new AbortController();
				deps.state.workflowControllers ??= new Map();
				deps.state.workflowControllers.set(workflowRunId, controller);
				let status: AsyncStatus = {
					runId: workflowRunId,
					toolCallId,
					sessionId: currentSessionId ?? undefined,
					mode: "workflow",
					state: "running",
					startedAt,
					lastUpdate: startedAt,
					...(timeout !== undefined ? { deadlineAt: startedAt + timeout, timeoutMs: timeout } : {}),
					cwd: workflowCwd,
					pid: process.pid,
					steps: [],
					workflow: { trace: [], emits: [], console: [] },
				};
				const appendWorkflowEvent = (event: Record<string, unknown>) => fs.appendFileSync(eventsPath, `${JSON.stringify({ ts: Date.now(), runId: workflowRunId, ...event })}\n`, "utf-8");
				const persist = () => {
					status.lastUpdate = Date.now();
					writeAtomicJson(statusPath, status);
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
				const workflowJob: AsyncJobState = { asyncId: workflowRunId, asyncDir, cwd: workflowCwd, status: "running", sessionId: currentSessionId ?? undefined, mode: "workflow", agents: [], steps: [], startedAt, updatedAt: startedAt, ...(timeout !== undefined ? { timeoutMs: timeout, deadlineAt: startedAt + timeout } : {}), workflow: status.workflow };
				deps.state.asyncJobs.set(workflowRunId, workflowJob);
				deps.state.fleetJobs ??= new Map();
				deps.state.fleetJobs.set(workflowRunId, workflowJob);
				persist();
				appendWorkflowEvent({ type: "subagent.workflow.started" });
				const { workflowScript, async: _workflowAsync, chatProgress: _chatProgress, ...workflowRequest } = requestParams;
				void Promise.resolve().then(async () => {
					const workflowResults: SingleResult[] = [];
					const { action: _action, agent: _agent, task: _task, resume: _resume, tasks: _tasks, chain: _chain, concurrency: _concurrency, foregroundOnly: _foregroundOnly, clarify: _clarify, timeoutMs: _timeoutMs, maxRuntimeMs: _maxRuntimeMs, usageBudget: _usageBudget, missionId: _missionId, mission: _mission, ...workflowChildDefaults } = workflowRequest;
					const updateTrace = (trace: NonNullable<Details["workflow"]>["trace"]) => {
						status.workflow = { ...(status.workflow ?? { emits: [], console: [] }), trace };
						for (const entry of trace.filter((candidate) => candidate.operation === "run")) {
							const existing = status.steps?.find((step) => step.workflowKey === entry.key);
							if (entry.state === "reused" && existing) continue;
							const mapped = entry.state === "started" || entry.state === "reused" ? "running" : entry.state === "completed" ? "completed" : "failed";
							if (existing) {
								existing.status = mapped;
								if (entry.error === undefined) delete existing.error;
								else existing.error = entry.error;
								if (entry.durationMs === undefined) delete existing.durationMs;
								else existing.durationMs = entry.durationMs;
							} else {
								status.steps?.push({ agent: entry.key, label: entry.key, workflowKey: entry.key, parentWorkflowRunId: workflowRunId, status: mapped, startedAt: Date.now() });
							}
						}
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
							onEmit: (emits) => {
								// Each emit is validated at the host boundary in runWorkflowScript before onEmit fires.
								status.workflow = { ...(status.workflow ?? { trace: [], console: [] }), emits };
								persist();
								appendWorkflowEvent({ type: "subagent.workflow.emit", value: emits.at(-1) });
							},
							launch: async (key, childParams, workflowSignal) => {
								if (workflowUsageBudget.budget && childParams.async === true) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, "workflow usageBudget does not support async runs.run launches."));
								const budgetState = usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults));
								if (budgetState?.exhausted) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, usageBudgetExceededMessage(budgetState)));
								patchMissionObjective(childParams.task);
								const childPhase = typeof childParams.phase === "string" && childParams.phase.trim() ? childParams.phase.trim() : undefined;
								const childLabel = typeof childParams.label === "string" && childParams.label.trim() ? childParams.label.trim() : undefined;
								recordMissionWorkflowChild(missionBinding, workflowRunId, key, {
									status: "running",
									...(typeof childParams.agent === "string" && childParams.agent.trim() ? { agent: childParams.agent.trim() } : {}),
									...(typeof childParams.task === "string" && childParams.task.trim() ? { task: childParams.task.trim() } : {}),
									...(childLabel ? { label: childLabel } : {}),
									...(childPhase ? { phase: childPhase } : {}),
									heartbeat: { status: "running", ...(childPhase ? { phase: childPhase } : {}) },
								});
								const result = await runMissionWorkflowChild(missionBinding, workflowRunId, key, childPhase, () => {
									const childRequest = bindMissionWorkflowChildAsyncLaunch(
										prepareWorkflowLaunchParams(workflowChildDefaults, childParams, workflowRunId, key, { missionDetached: detachWorkflowChildMissions }),
										missionBinding,
										deps.asyncByDefault,
									);
									workflowLaunchObservers.set(childRequest, (launch) => {
										const step = status.steps?.find((candidate) => candidate.workflowKey === key);
										if (step) {
											step.agent = launch.agent;
											step.sessionFile = launch.sessionFile;
											persist();
										}
										recordMissionWorkflowChild(missionBinding, workflowRunId, key, { status: "running", agent: launch.agent, ...(launch.sessionFile ? { sessionPath: launch.sessionFile } : {}) });
									});
									return execute(randomUUID(), childRequest, workflowSignal, (update) => {
										const progress = update.details.progress?.[0];
										const step = status.steps?.find((candidate) => candidate.workflowKey === key);
										if (!progress || !step) return;
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
								if (result.details.asyncDir && missionBinding) writeMissionAsyncBinding(result.details.asyncDir, missionBinding);
								const child = workflowChildResult(key, result);
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
						});
						const returnPreview = formatWorkflowValue(workflow.value).slice(0, 1_000);
						const emitPreview = workflow.emits.length > 0 ? ` Emitted: ${workflow.emits.map(formatWorkflowValue).join(", ").slice(0, 1_000)}` : "";
						const summary = `Workflow completed with ${workflow.children.length} child run(s). Return: ${returnPreview}${emitPreview} Trace: ${workflow.trace.length} event(s).`;
						const workflowUsage = sumResultsUsage(workflowResults);
						status = { ...status, state: "complete", endedAt: Date.now(), workflow: { value: workflow.value, trace: workflow.trace, emits: workflow.emits, console: workflow.console }, totalTokens: { input: workflowUsage.input, output: workflowUsage.output, total: workflowUsage.input + workflowUsage.output }, totalCost: sumResultsCost(workflowResults) };
						writeAtomicJson(resultPath, { id: workflowRunId, runId: workflowRunId, toolCallId, agent: "workflow", mode: "workflow", success: true, state: "complete", summary, output: summary, results: workflow.children.map((child) => ({ agent: child.key, ...(child.runId ? { runId: child.runId } : {}), output: child.output, outputState: child.output.trim() || child.structuredOutput !== undefined ? "present" : "absent", structuredOutput: child.structuredOutput, success: child.ok, ...(child.artifactPaths[0] ? { artifactPaths: { outputPath: child.artifactPaths[0] } } : {}) })), workflow: status.workflow, asyncDir, cwd: workflowCwd, sessionId: currentSessionId, timestamp: Date.now(), durationMs: Date.now() - startedAt });
						persist();
						appendWorkflowEvent({ type: "subagent.workflow.completed", state: "complete" });
					} catch (error) {
						const partial = error instanceof WorkflowScriptError ? error.partial : { trace: [], emits: [], console: [], children: [] };
						const stopped = controller.signal.aborted;
						status = compactOptional<AsyncStatus>({ ...status, state: stopped ? "stopped" : "failed", stopped: stopped || undefined, error: error instanceof Error ? error.message : String(error), endedAt: Date.now(), workflow: { trace: partial.trace, emits: partial.emits, console: partial.console } });
						writeAtomicJson(resultPath, { id: workflowRunId, runId: workflowRunId, toolCallId, agent: "workflow", mode: "workflow", success: false, state: status.state, summary: status.error, error: status.error, stopped: status.stopped, results: partial.children.map((child) => ({ agent: child.key, ...(child.runId ? { runId: child.runId } : {}), output: child.output, outputState: child.output.trim() || child.structuredOutput !== undefined ? "present" : "absent", structuredOutput: child.structuredOutput, success: child.ok, ...(child.artifactPaths[0] ? { artifactPaths: { outputPath: child.artifactPaths[0] } } : {}) })), workflow: status.workflow, asyncDir, cwd: workflowCwd, sessionId: currentSessionId, timestamp: Date.now(), durationMs: Date.now() - startedAt });
						persist();
						appendWorkflowEvent({ type: "subagent.workflow.completed", state: status.state, error: status.error });
					} finally {
						deps.state.workflowControllers?.delete(workflowRunId);
					}
				});
				return attachWorkflowMission({
					content: [{ type: "text", text: formatAsyncStartedMessage(`Async workflow [${workflowRunId}]`, ctx.hasUI === true) }],
					details: { mode: "workflow", runId: workflowRunId, toolCallId, asyncId: workflowRunId, asyncDir, results: [], chatProgress },
				});
			}
			const { workflowScript: _workflowScript, action: _action, agent: _agent, task: _task, resume: _resume, tasks: _tasks, chain: _chain, concurrency: _concurrency, async: _async, foregroundOnly: _foregroundOnly, clarify: _clarify, timeoutMs: _timeoutMs, maxRuntimeMs: _maxRuntimeMs, usageBudget: _usageBudget, chatProgress: _chatProgress, missionId: _missionId, mission: _mission, ...workflowChildDefaults } = requestParams;
			const workflowResults: SingleResult[] = [];
			let liveWorkflow: NonNullable<Details["workflow"]> = { trace: [], emits: [], console: [] };
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
					onEmit: (emits) => {
						liveWorkflow = { ...liveWorkflow, emits };
						sendWorkflowProgress();
					},
					launch: async (key, childParams, workflowSignal) => {
						if (workflowUsageBudget.budget && childParams.async === true) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, "workflow usageBudget does not support async runs.run launches."));
						const budgetState = usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults));
						if (budgetState?.exhausted) return workflowChildResult(key, buildRequestedModeError(childParams as SubagentParamsLike, usageBudgetExceededMessage(budgetState)));
						patchMissionObjective(childParams.task);
						const childPhase = typeof childParams.phase === "string" && childParams.phase.trim() ? childParams.phase.trim() : undefined;
						const childLabel = typeof childParams.label === "string" && childParams.label.trim() ? childParams.label.trim() : undefined;
						recordMissionWorkflowChild(missionBinding, _id, key, {
							status: "running",
							...(typeof childParams.agent === "string" && childParams.agent.trim() ? { agent: childParams.agent.trim() } : {}),
							...(typeof childParams.task === "string" && childParams.task.trim() ? { task: childParams.task.trim() } : {}),
							...(childLabel ? { label: childLabel } : {}),
							...(childPhase ? { phase: childPhase } : {}),
							heartbeat: { status: "running", ...(childPhase ? { phase: childPhase } : {}) },
						});
						const result = await runMissionWorkflowChild(missionBinding, _id, key, childPhase, () => {
							const childRequest = bindMissionWorkflowChildAsyncLaunch(
								prepareWorkflowLaunchParams(workflowChildDefaults, childParams, _id, key, { missionDetached: detachWorkflowChildMissions, suppressRoutineResultIntercom: chatProgress.mode === "live-card" }),
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
						if (result.details.asyncDir && missionBinding) writeMissionAsyncBinding(result.details.asyncDir, missionBinding);
						const child = workflowChildResult(key, result);
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
				});
				const traceLines = workflow.trace.map((entry) => `- ${entry.operation} ${entry.key}: ${entry.state}${entry.runId ? ` (${entry.runId})` : ""}${entry.durationMs !== undefined ? ` in ${entry.durationMs}ms` : ""}${entry.error ? ` — ${entry.error}` : ""}`);
				const sections = ["Workflow completed.", `Return:\n${formatWorkflowValue(workflow.value)}`];
				if (workflow.emits.length > 0) sections.push(`Emitted:\n${workflow.emits.map(formatWorkflowValue).join("\n")}`);
				if (workflow.console.length > 0) sections.push(`Console:\n${workflow.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`);
				if (traceLines.length > 0) sections.push(`Call trace:\n${traceLines.join("\n")}`);
				return attachWorkflowMission({
					content: [{ type: "text", text: sections.join("\n\n") }],
					details: compactOptional<Details>({ mode: "workflow", runId: _id, results: workflow.children.flatMap((child) => (child.results ?? []) as SingleResult[]), totalChildUsage: sumResultsUsage(workflowResults), totalCost: sumResultsCost(workflowResults), usageBudget: usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)), workflow: { value: workflow.value, trace: workflow.trace, emits: workflow.emits, console: workflow.console }, chatProgress }),
				});
			} catch (error) {
				const partial = error instanceof WorkflowScriptError ? error.partial : { trace: [], emits: [], console: [], children: [] };
				const text = error instanceof Error ? error.message : String(error);
				const traceLines = partial.trace.map((entry) => `- ${entry.operation} ${entry.key}: ${entry.state}${entry.runId ? ` (${entry.runId})` : ""}${entry.error ? ` — ${entry.error}` : ""}`);
				const sections = [`Workflow failed: ${text}`];
				if (partial.emits.length > 0) sections.push(`Emitted:\n${partial.emits.map(formatWorkflowValue).join("\n")}`);
				if (partial.console.length > 0) sections.push(`Console:\n${partial.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`);
				if (traceLines.length > 0) sections.push(`Call trace:\n${traceLines.join("\n")}`);
				return attachWorkflowMission({
					content: [{ type: "text", text: sections.join("\n\n") }],
					isError: true,
					details: compactOptional<Details>({ mode: "workflow", runId: _id, results: partial.children.flatMap((child) => (child.results ?? []) as SingleResult[]), totalChildUsage: sumResultsUsage(workflowResults), totalCost: sumResultsCost(workflowResults), usageBudget: usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)), workflow: { trace: partial.trace, emits: partial.emits, console: partial.console }, chatProgress }),
				});
			}
		}
		const directParams = prepareWorkflowChildParams(requestParams);
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
					details: { mode: "management", results: [], spawnBudget },
				};
			}
			if (action === "status") {
				if (!preserveActiveSession) deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
				const hasDirectoryTarget = Boolean(paramsWithResolvedCwd.dir);
				const targetLabel = formatStatusTargetLabel(paramsWithResolvedCwd, targetRunId);
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

			if (action === "approve-checkpoint" || action === "reject-checkpoint") {
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				if (!targetRunId && !paramsWithResolvedCwd.dir) {
					return { content: [{ type: "text", text: `action='${action}' requires id or dir.` }], isError: true, details: { mode: "management", results: [] } };
				}
				try {
					const resolved = targetRunId ? resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) })) : undefined;
					const decision = action === "approve-checkpoint" ? "approved" : "rejected";
					if (resolved?.kind === "foreground") {
						const run = deps.state.foregroundRuns?.get(resolved.id);
						if (!run?.checkpoint || run.checkpoint.status !== "pending") {
							return { content: [{ type: "text", text: `Run '${resolved.id}' is not paused at an approval checkpoint.` }], isError: true, details: { mode: "management", results: [] } };
						}
						if (deps.state.currentSessionId && run.sessionId !== deps.state.currentSessionId) {
							return { content: [{ type: "text", text: `Run '${resolved.id}' was not found in the active session.` }], isError: true, details: { mode: "management", results: [] } };
						}
						const decidedAt = Date.now();
						const checkpoint: NonNullable<Details["checkpoint"]> = decision === "approved"
							? { ...run.checkpoint, status: "approved", approvedAt: decidedAt }
							: { ...run.checkpoint, status: "rejected", rejectedAt: decidedAt };
						run.checkpoint = checkpoint;
						run.updatedAt = decidedAt;
						return {
							content: [{ type: "text", text: `Checkpoint '${checkpoint.name}' ${decision} for foreground run ${resolved.id}.` }],
							details: { mode: "management", results: [], checkpoint },
						};
					}
					const location = paramsWithResolvedCwd.dir
						? resolveAsyncRunLocation(paramsWithResolvedCwd, DIRS.async, DIRS.results)
						: resolved?.kind === "async"
							? resolved.location
							: undefined;
					if (!location?.asyncDir) {
						return { content: [{ type: "text", text: `action='${action}' targets paused foreground or async checkpoints. No matching run found.` }], isError: true, details: { mode: "management", results: [] } };
					}
					const status = readStatus(location.asyncDir);
					const runId = status?.runId ?? location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir);
					if (!status?.checkpoint || status.state !== "paused") {
						return { content: [{ type: "text", text: `Run '${runId}' is not paused at an approval checkpoint.` }], isError: true, details: { mode: "management", results: [] } };
					}
					if (deps.state.currentSessionId && status.sessionId !== deps.state.currentSessionId) {
						return { content: [{ type: "text", text: `Run '${runId}' was not found in the active session.` }], isError: true, details: { mode: "management", results: [] } };
					}
					deliverCheckpointDecisionRequest({ asyncDir: location.asyncDir, decision, source: "subagent-action", ...(paramsWithResolvedCwd.message ? { reason: paramsWithResolvedCwd.message } : {}) });
					return {
						content: [{ type: "text", text: `Checkpoint '${status.checkpoint.name}' ${decision} for run ${runId}.` }],
						details: { mode: "management", results: [], checkpoint: { ...status.checkpoint, status: decision } },
					};
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
				}
			}
			if (action === "resume") {
				return resumeAsyncRun(omitUndefinedProperties({ params: paramsWithResolvedCwd, requestCwd, ctx, deps, parentModel: requestParentModel }));
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
				if (resolved?.kind === "foreground") return { content: [{ type: "text", text: "action='steer' currently supports live async Pi child sessions only; use action='interrupt' or action='resume' for foreground runs." }], isError: true, details: { mode: "management", results: [] } };
				if (resolved?.kind !== "async") return { content: [{ type: "text", text: `No async run found for '${targetRunId}'.` }], isError: true, details: { mode: "management", results: [] } };
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
			if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
				return {
					content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
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
		const canonicalParams = canonicalizeExecutionParams(effectiveParams, discoveredAgents);
		if (canonicalParams.error) return buildRequestedModeError(effectiveParams, canonicalParams.error);
		effectiveParams = canonicalParams.params!;
		const modelScope = discovered.modelScope;
		effectiveParams = applySingleAgentLaunchDefaults(effectiveParams, discoveredAgents);
		const turnBudget = resolveTurnBudgetConfig(effectiveParams.turnBudget ?? deps.config.turnBudget);
		if (turnBudget.error) return buildRequestedModeError(effectiveParams, turnBudget.error);
		const contextPolicy = resolveAgentDefaultContextPolicy(effectiveParams, discoveredAgents);
		effectiveParams = contextPolicy.params;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			context: effectiveParams.context ?? (contextPolicy.usesFork ? "fork" : undefined),
			orchestratorTarget: sessionName,
		});
		const agents = intercomBridge.active
			? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
			: discoveredAgents;
		const runId = randomUUID().slice(0, 8);
		const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
		const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
		const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
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
			.find((agent) => agent?.runner?.type === "external-cli");
		if (externalAgent && (!effectiveAsync || effectiveParams.foregroundOnly === true)) {
			return buildRequestedModeError(effectiveParams, `Agent '${externalAgent.name}' uses runner.type='external-cli', which currently supports async/background execution only. Omit async or pass async:true; clarify and foregroundOnly are unsupported.`);
		}
		const foregroundTimeout = resolveForegroundTimeout(
			effectiveParams,
			effectiveAsync ? undefined : DEFAULT_FOREGROUND_TIMEOUT_MS,
		);
		if (foregroundTimeout.error) return buildRequestedModeError(effectiveParams, foregroundTimeout.error);
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

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
			return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
		}
		const chainBindingsError = validateExecutionChainBindings(effectiveParams, deps.config.chain?.dynamicFanout?.maxItems);
		if (chainBindingsError) return withResolvedContext(chainBindingsError, contextPolicy.contextSummary);

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
			if (explicitMission) return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
			missionWarning = `Mission tracking unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}

		const attachMission = (result: AgentToolResult<Details>): AgentToolResult<Details> => {
			if (!missionBinding) return missionWarning ? { ...result, details: { ...result.details, missionWarning } } : result;
			try {
				return attachMissionToLaunchResult({ binding: missionBinding, result });
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
		if (reservation.error) return attachMission(spawnBudgetErrorResult(reservation.error, foregroundMode));

		const execData: ExecutionContextData = omitUndefinedProperties({
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
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
			controlConfig,
			intercomBridge,
			nestedRoute,
			timeoutMs: foregroundTimeout.timeoutMs,
			turnBudget: turnBudget.turnBudget,
			toolBudget: runToolBudget.toolBudget,
			usageBudget: usageBudget.budget,
			allowZeroToolBudget,
			configToolBudget: configToolBudget.toolBudget,
			contextPolicy,
			modelScope,
			parentModel: requestParentModel,
			parentSessionId: requestSessionId,
			parentPiSessionId: requestPiSessionId,
			capabilityCeiling: resolveCurrentSubagentCapabilityCeiling(requestSessionId),
		});

		const foregroundDescription = effectiveParams.task?.trim()
			|| effectiveParams.tasks?.[0]?.task?.trim()
			|| (effectiveParams.chain ? firstRawChainTask(effectiveParams.chain)?.trim() : undefined);
		const foregroundControl: ForegroundRunControl | undefined = effectiveAsync
			? undefined
			: compactOptional<ForegroundRunControl>({
				runId,
				sessionId: requestSessionId,
				mode: foregroundMode,
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
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
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
		try {
			if (workflowLaunchObserver) {
				const singleTask = hasTasks && effectiveParams.tasks?.length === 1 ? effectiveParams.tasks[0] : undefined;
				const launch = hasSingle
					? { agent: effectiveParams.agent!, sessionFile: childSessionFileForTask(effectiveParams.agent!, 0, effectiveParams.model) }
					: singleTask
						? { agent: singleTask.agent, sessionFile: childSessionFileForTask(singleTask.agent, 0, singleTask.model) }
						: undefined;
				if (launch) {
					workflowLaunchObservers.delete(params);
					workflowLaunchObserver(launch);
				}
			}
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return attachMission(withResolvedContext(withForkThinkingNotes(asyncResult, forkThinkingDowngrades), contextPolicy.contextSummary));
			if (foregroundControl) {
				writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			if (hasChain && effectiveParams.chain) {
				const result = await runChainPath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return attachMission(withResolvedContext(withForkThinkingNotes(result, forkThinkingDowngrades), contextPolicy.contextSummary));
			}
			if (hasTasks && effectiveParams.tasks) {
				const result = await runParallelPath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return attachMission(withResolvedContext(withForkThinkingNotes(result, forkThinkingDowngrades), contextPolicy.contextSummary));
			}
			if (hasSingle) {
				const result = await runSinglePath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return attachMission(withResolvedContext(withForkThinkingNotes(result, forkThinkingDowngrades), contextPolicy.contextSummary));
			}
		} catch (error) {
			const errorResult = withForkThinkingNotes(toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary), forkThinkingDowngrades);
			if (nestedForegroundStarted) writeNestedForegroundEvent("subagent.nested.completed", errorResult);
			return attachMission(errorResult);
		} finally {
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
