import * as fs from "node:fs";
import * as path from "node:path";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { previewDisplayText } from "../../shared/display-text.ts";
import { formatActivityLabel, formatParallelOutcome } from "../../shared/status-format.ts";
import { type ActivityState, type AsyncJobStep, type AsyncParallelGroupStatus, type AsyncStatus, type CostSummary, type Details, type HostStepNodeV1, type HostStepState, type LaunchResolvedChildExtensionsV1, type RuntimeAcknowledgedChildExtensionsV1, type NestedRunSummary, type SteeringStatus, type SubagentRunMode, type TimeoutRecoveryProjection, type TokenUsage, type TurnBudgetState, type UsageBudgetState, type WorktreeNaming, type WorkflowPreflightV1, type WorkflowGraphSnapshot } from "../../shared/types.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "../shared/capability-ceiling.ts";
import { readStatus } from "../../shared/utils.ts";
import { attachRootChildrenToSteps, buildNestedRouteIndex, findNestedRouteForRootId, type NestedRoute, projectNestedEvents } from "../shared/nested-events.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { formatRunFanoutBudget, getRunFanoutBudgetSnapshot, readRunFanoutBudgetDescriptor } from "../shared/run-fanout-budget.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { contextModeLabel, summarizeContextModes, type ContextMode, type ContextSummary } from "../shared/context-mode.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { readProcessTerminal, sanitizeProcessTerminal } from "./process-terminal.ts";
import { ACTIVE_RUN_INDEX_DIR, DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS, activeRunMarkerAgeMs, isActiveAsyncState, readActiveRunIndex, releaseActiveRunIndex, updateActiveRunIndex } from "./active-run-index.ts";
import { readRecentTerminalRunIndex, TERMINAL_RUN_INDEX_DIR } from "./terminal-run-index.ts";
import { canScanAsyncRunPrefix } from "./run-id-query.ts";
import { asyncStatusChildIdentity } from "../shared/child-identity.ts";
import { parseWorkflowChildSummary } from "../../workflows/workflow-child-summary.ts";
import { assertWorkflowGraphHostSteps, hostStepReportName, hostStepVerdictLabel, validHostStepNodes } from "../shared/host-step-status.ts";
import { projectAsyncWorkflowRows } from "../shared/async-status-projection.ts";
import { validateAsyncStatusLaneMetadata } from "../shared/lane-metadata.ts";
import { formatWorkflowPreflightPlanSummary, formatWorkflowPreflightWarningSummary } from "../../workflows/workflow-preflight.ts";
import { workflowGraphStageNodes } from "../shared/workflow-graph.ts";
import { formatTimeoutRecoveryLines, projectTimeoutRecovery } from "../shared/mutation-evidence.ts";
import { formatWorkflowChecklistText, projectWorkflowChecklist } from "../../workflows/workflow-checklist.ts";

interface AsyncRunStepSummary {
	index: number;
	childId?: string;
	agent: string;
	/** Human-readable display name for the child session, when derived at launch. */
	sessionName?: string;
	context?: ContextMode;
	label?: string;
	description?: string;
	phase?: string;
	workflowKey?: string;
	lane?: AsyncJobStep["lane"];
	worktreePath?: string;
	branch?: string;
	provider?: "native" | "worktrunk";
	naming?: WorktreeNaming;
	runId?: string;
	outputName?: string;
	structured?: boolean;
	status: AsyncJobStep["status"];
	runner?: AsyncJobStep["runner"];
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
	steering?: SteeringStatus;
	durationMs?: number;
	tokens?: TokenUsage;
	totalCost?: CostSummary;
	skills?: string[];
	model?: string;
	contextLimit?: number;
	thinking?: string;
	attemptedModels?: string[];
	sessionFile?: string;
	transcriptPath?: string;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	toolBudgetBlocked?: boolean;
	wrapUpRequested?: boolean;
	acceptance?: AsyncJobStep["acceptance"];
	agentContract?: AsyncJobStep["agentContract"];
	execution?: AsyncJobStep["execution"];
	review?: AsyncJobStep["review"];
	effects?: AsyncJobStep["effects"];
	processTerminal?: AsyncJobStep["processTerminal"];
	timeoutRecovery?: TimeoutRecoveryProjection;
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	children?: NestedRunSummary[];
}

export interface AsyncRunSummary {
	id: string;
	asyncDir: string;
	toolCallId?: string;
	sessionId?: string;
	state: "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
	error?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steering?: SteeringStatus;
	mode: SubagentRunMode;
	context?: ContextSummary;
	cwd?: string;
	sessionRoot?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	currentStep?: number;
	chainStepCount?: number;
	pendingAppends?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	hostSteps?: HostStepNodeV1[];
	workflowGraph?: AsyncStatus["workflowGraph"];
	steps: AsyncRunStepSummary[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	usageBudget?: UsageBudgetState;
	sessionFile?: string;
	nestedChildren?: NestedRunSummary[];
	nestedWarnings?: string[];
	processTerminal?: AsyncStatus["processTerminal"];
	runFanoutBudget?: AsyncStatus["runFanoutBudget"];
	launchResolvedExtensions?: LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensionsV1;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	parentWorkflowRunId?: string;
	workflowKey?: string;
	lane?: AsyncStatus["lane"];
	workflow?: Details["workflow"];
	workflowChildren?: Details["workflowChildren"];
	preflight?: WorkflowPreflightV1;
}

interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	sessionId?: string;
	limit?: number;
	/** Limits terminal candidates using the timestamp embedded in index marker names. */
	entryLimit?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	reconcile?: boolean;
	runId?: string;
	/** The caller already holds a canonical run id; never interpret a miss as a prefix. */
	exactRunId?: boolean;
	includeNested?: boolean;
	/** Explicit repair/debug escape hatch. Normal runtime paths must not set this. */
	repairScan?: boolean;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAsyncStatusIsolationError(asyncDir: string, error: unknown): boolean {
	const statusPath = path.join(asyncDir, "status.json");
	const message = getErrorMessage(error);
	return /^(?:Failed to (?:inspect|read|parse|validate) async status file|Invalid async status file) '/.test(message)
		|| message.startsWith(`Invalid async status '${statusPath}'`)
		|| message.startsWith(`Invalid host step '${statusPath}`)
		|| /^(workflowChildren|Invalid workflowChildren)/.test(message);
}

function isolateCorruptActiveRun(asyncDir: string, runId: string, error: unknown, now?: () => number): void {
	const statusPath = path.join(asyncDir, "status.json");
	const processTerminal = readProcessTerminal(asyncDir, { runId });
	let markerAge: number | undefined;
	try {
		markerAge = activeRunMarkerAgeMs(asyncDir, now?.());
	} catch (markerError) {
		console.error(`Failed to inspect corrupt async active-run marker for '${runId}':`, markerError);
	}
	const markerCanBeReleased = processTerminal?.state === "observed"
		|| (markerAge !== undefined && markerAge > DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS);
	let markerAction = "active marker retained because runner liveness is unknown";
	if (markerCanBeReleased) {
		try {
			releaseActiveRunIndex(asyncDir);
			markerAction = processTerminal?.state === "observed"
				? "active marker released after observed process-terminal proof"
				: "stale active marker released";
		} catch (releaseError) {
			markerAction = `failed to release active marker: ${getErrorMessage(releaseError)}`;
		}
	}
	console.error(`[pi-subagents] Skipping corrupt active async run '${runId}' at '${statusPath}': ${getErrorMessage(error)}; ${markerAction}.`);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAsyncRunDir(root: string, entry: string): boolean {
	const entryPath = path.join(root, entry);
	try {
		return fs.statSync(entryPath).isDirectory();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new Error(`Failed to inspect async run path '${entryPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

type TargetedAsyncRunResolution =
	| { kind: "exact"; id: string }
	| { kind: "prefix" }
	| { kind: "reject" };

/**
 * Resolve an exact targeted run without following a run-directory symlink or
 * accepting a path whose canonical location escaped the async root.
 */
export function resolveTargetedAsyncRun(asyncDirRoot: string, id: string, sessionId?: string): TargetedAsyncRunResolution {
	if (!id || id === "." || id === ".." || id === ACTIVE_RUN_INDEX_DIR || id === TERMINAL_RUN_INDEX_DIR || path.basename(id) !== id) return { kind: "reject" };
	const asyncDir = path.join(asyncDirRoot, id);
	let entryStat: fs.Stats;
	try {
		entryStat = fs.lstatSync(asyncDir);
	} catch (error) {
		if (isNotFoundError(error)) return canScanAsyncRunPrefix(id) ? { kind: "prefix" } : { kind: "reject" };
		throw new Error(`Failed to inspect async run path '${asyncDir}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) return { kind: "reject" };
	try {
		const canonicalRoot = fs.realpathSync(asyncDirRoot);
		const canonicalDir = fs.realpathSync(asyncDir);
		if (canonicalDir !== canonicalRoot && !canonicalDir.startsWith(`${canonicalRoot}${path.sep}`)) return { kind: "reject" };
	} catch (error) {
		if (isNotFoundError(error)) return { kind: "reject" };
		throw new Error(`Failed to resolve async run path '${asyncDir}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (sessionId !== undefined) {
		const status = readStatus(asyncDir);
		if (status?.sessionId !== sessionId) return canScanAsyncRunPrefix(id) ? { kind: "prefix" } : { kind: "reject" };
	}
	return { kind: "exact", id };
}

function outputFileMtime(outputFile: string | undefined): number | undefined {
	if (!outputFile) return undefined;
	try {
		return fs.statSync(outputFile).mtimeMs;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to inspect async output file '${outputFile}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running") return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	return {
		activityState: status.activityState,
		lastActivityAt: status.lastActivityAt
			?? outputFileMtime(outputPath)
			?? currentStep?.lastActivityAt
			?? (status.mode === "workflow" ? undefined : currentStep?.startedAt ?? status.startedAt),
	};
}

function statusToSummary(asyncDir: string, status: AsyncStatus & { cwd?: string }, nestedWarnings: string[] = [], nestedRoute?: NestedRoute): AsyncRunSummary {
	const statusPath = path.join(asyncDir, "status.json");
	validateAsyncStatusLaneMetadata(status, `Invalid async status '${statusPath}'`);
	const workflowChildren = parseWorkflowChildSummary(status.workflowChildren);
	if (workflowChildren && workflowChildren.workflowRunId !== status.runId) throw new Error(`Invalid async status '${statusPath}': workflowChildren.workflowRunId does not match.`);
	assertWorkflowGraphHostSteps(status.workflowGraph, statusPath, status.runId);
	const hostSteps = validHostStepNodes(status.workflowGraph);
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") {
		throw new Error(`Invalid async status '${statusPath}': sessionId must be a string.`);
	}
	if (status.outputFile !== undefined && typeof status.outputFile !== "string") throw new Error(`Invalid async status '${statusPath}': outputFile must be a string.`);
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const processTerminal = readProcessTerminal(asyncDir, { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId })
		?? sanitizeProcessTerminal(status.processTerminal, { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId }, path.join(asyncDir, "status.json"));
	const nestedProjectionAllowed = nestedWarnings.length === 0;
	// Degrade to the status-stored snapshot when the persisted budget is unavailable (e.g. removed
	// by OS temp cleanup) instead of failing the whole run list; admission paths stay strict.
	let runFanoutBudget: AsyncStatus["runFanoutBudget"] = status.runFanoutBudget;
	try {
		const runFanoutBudgetDescriptor = readRunFanoutBudgetDescriptor(asyncDir);
		if (runFanoutBudgetDescriptor) runFanoutBudget = getRunFanoutBudgetSnapshot(runFanoutBudgetDescriptor);
	} catch (error) {
		nestedWarnings.push(`Run fan-out status unavailable: ${getErrorMessage(error)}`);
	}
	const steps = status.steps ?? [];
	const chainStepCount = status.chainStepCount ?? steps.length;
	const parallelGroups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
	let nestedChildren: NestedRunSummary[] = [];
	if (nestedProjectionAllowed && nestedRoute) {
		try {
			// The route is resolved by the caller via buildNestedRouteIndex, so this
			// avoids a fresh scan of the nested-events directory per run.
			nestedChildren = projectNestedEvents(nestedRoute)?.children ?? [];
		} catch (error) {
			nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
		}
	}
	const summarizedSteps = steps.map((step, index) => {
		const stepActivityState = step.activityState;
		const stepLastActivityAt = step.lastActivityAt;
		const timeoutRecovery = projectTimeoutRecovery(step.timeoutRecovery);
		return {
			index,
			childId: asyncStatusChildIdentity(step, index),
			agent: step.agent,
			...(step.sessionName ? { sessionName: step.sessionName } : {}),
			...(step.context ? { context: step.context } : {}),
			...(step.label ? { label: step.label } : {}),
			...(step.description ? { description: step.description } : {}),
			...(step.phase ? { phase: step.phase } : {}),
			...(step.workflowKey ? { workflowKey: step.workflowKey } : {}),
			...(step.lane ? { lane: step.lane } : {}),
			...(step.worktreePath ? { worktreePath: step.worktreePath } : {}),
			...(step.branch ? { branch: step.branch } : {}),
			...(step.provider ? { provider: step.provider } : {}),
			...(step.naming ? { naming: step.naming } : {}),
			...(step.runId ? { runId: step.runId } : {}),
			...(step.outputName ? { outputName: step.outputName } : {}),
			...(step.structured ? { structured: step.structured } : {}),
			status: step.status,
			...(step.runner ? { runner: step.runner } : {}),
			...(stepActivityState ? { activityState: stepActivityState } : {}),
			...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolArgs ? { currentToolArgs: step.currentToolArgs } : {}),
			...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.recentTools ? { recentTools: step.recentTools.map((tool) => ({ ...tool })) } : {}),
			...(step.recentOutput ? { recentOutput: [...step.recentOutput] } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.steering ? { steering: step.steering } : {}),
			...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
			...(step.tokens ? { tokens: step.tokens } : {}),
			...(step.totalCost ? { totalCost: step.totalCost } : {}),
			...(step.skills ? { skills: step.skills } : {}),
			...(step.model ? { model: step.model } : {}),
			...(step.contextLimit !== undefined ? { contextLimit: step.contextLimit } : {}),
			...(step.thinking ? { thinking: step.thinking } : {}),
			...(step.thinkingCeiling ? { thinkingCeiling: step.thinkingCeiling } : {}),
			...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
			...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
			...(step.transcriptPath ? { transcriptPath: step.transcriptPath } : {}),
			...(step.error ? { error: step.error } : {}),
			...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
			...(step.stopped !== undefined ? { stopped: step.stopped } : {}),
			...(step.stopRequested !== undefined ? { stopRequested: step.stopRequested } : {}),
			...(step.stopRequestedAt !== undefined ? { stopRequestedAt: step.stopRequestedAt } : {}),
			...(step.turnBudget ? { turnBudget: step.turnBudget } : {}),
			...(step.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: step.turnBudgetExceeded } : {}),
			...(step.toolBudgetBlocked !== undefined ? { toolBudgetBlocked: step.toolBudgetBlocked } : {}),
			...(step.wrapUpRequested !== undefined ? { wrapUpRequested: step.wrapUpRequested } : {}),
			...(step.acceptance ? { acceptance: step.acceptance } : {}),
			...(step.agentContract ? { agentContract: step.agentContract } : {}),
			...(step.launchContractDigest ? { launchContractDigest: step.launchContractDigest } : {}),
			...(step.launchResolvedExtensions ? { launchResolvedExtensions: step.launchResolvedExtensions } : {}),
			...(step.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: step.runtimeAcknowledgedExtensions } : {}),
			...(step.execution ? { execution: step.execution } : {}),
			...(step.review ? { review: step.review } : {}),
			...(step.effects ? { effects: step.effects } : {}),
			...(step.watchdog ? { watchdog: step.watchdog } : {}),
			...(step.processTerminal ? { processTerminal: sanitizeProcessTerminal(step.processTerminal, { runId: status.runId, runnerProcessInstanceId: step.processTerminal.runnerProcessInstanceId }, `${path.join(asyncDir, "status.json")} step ${index}`) } : {}),
			...(timeoutRecovery ? { timeoutRecovery } : {}),
			...(step.capabilityCeiling ? { capabilityCeiling: step.capabilityCeiling } : {}),
			...(step.capabilityAudit ? { capabilityAudit: step.capabilityAudit } : {}),
			...(step.children?.length ? { children: step.children } : {}),
		};
	});
	attachRootChildrenToSteps(status.runId || path.basename(asyncDir), summarizedSteps, nestedChildren);
	return {
		id: status.runId || path.basename(asyncDir),
		asyncDir,
		...(status.toolCallId ? { toolCallId: status.toolCallId } : {}),
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		state: status.state,
		...(status.error ? { error: status.error } : {}),
		activityState,
		lastActivityAt,
		currentTool: status.currentTool,
		currentToolStartedAt: status.currentToolStartedAt,
		currentPath: status.currentPath,
		turnCount: status.turnCount,
		toolCount: status.toolCount,
		steering: status.steering,
		mode: status.mode,
		...(summarizeContextModes(summarizedSteps.map((step) => step.context)) ? { context: summarizeContextModes(summarizedSteps.map((step) => step.context)) } : {}),
		cwd: status.cwd,
		...(status.sessionRoot ? { sessionRoot: status.sessionRoot } : {}),
		startedAt: status.startedAt,
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		...(status.timeoutMs !== undefined ? { timeoutMs: status.timeoutMs } : {}),
		...(status.deadlineAt !== undefined ? { deadlineAt: status.deadlineAt } : {}),
		...(status.timedOut !== undefined ? { timedOut: status.timedOut } : {}),
		...(status.stopped !== undefined ? { stopped: status.stopped } : {}),
		...(status.turnBudget ? { turnBudget: status.turnBudget } : {}),
		...(status.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: status.turnBudgetExceeded } : {}),
		...(status.wrapUpRequested !== undefined ? { wrapUpRequested: status.wrapUpRequested } : {}),
		currentStep: status.currentStep,
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(status.pendingAppends !== undefined ? { pendingAppends: status.pendingAppends } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		...(hostSteps.length ? { hostSteps } : {}),
		...(status.mode === "workflow" && status.workflowGraph ? { workflowGraph: status.workflowGraph } : {}),
		steps: summarizedSteps,
		...(nestedChildren.length ? { nestedChildren } : {}),
		...(nestedWarnings.length ? { nestedWarnings } : {}),
		...(processTerminal ? { processTerminal } : {}),
		...(runFanoutBudget ? { runFanoutBudget } : {}),
		...(status.launchContractDigest ? { launchContractDigest: status.launchContractDigest } : {}),
		...(status.launchResolvedExtensions ? { launchResolvedExtensions: status.launchResolvedExtensions } : {}),
		...(status.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: status.runtimeAcknowledgedExtensions } : {}),
		...(status.capabilityCeiling ? { capabilityCeiling: status.capabilityCeiling } : {}),
		...(status.capabilityAudit ? { capabilityAudit: status.capabilityAudit } : {}),
		...(status.parentWorkflowRunId ? { parentWorkflowRunId: status.parentWorkflowRunId } : {}),
		...(status.workflowKey ? { workflowKey: status.workflowKey } : {}),
		...(status.lane ? { lane: status.lane } : {}),
		...(status.workflow ? { workflow: status.workflow } : {}),
		...(workflowChildren ? { workflowChildren } : {}),
		...(status.preflight ? { preflight: status.preflight } : {}),
		...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
		...(status.outputFile ? { outputFile: status.outputFile } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.totalCost ? { totalCost: status.totalCost } : {}),
		...(status.usageBudget ? { usageBudget: status.usageBudget } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

export function summarizeAsyncStatus(asyncDir: string, status: AsyncStatus & { cwd?: string }): AsyncRunSummary {
	return statusToSummary(asyncDir, status);
}

function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running": return 0;
			case "queued": return 1;
			case "failed": return 2;
			case "partial": return 2;
			case "stopped": return 2;
			case "paused": return 2;
			case "complete": return 3;
			default: return 4;
		}
	};
	return [...runs].sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
		const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
		return bTime - aTime;
	});
}

export function listAsyncRuns(asyncDirRoot: string, options: AsyncRunListOptions = {}): AsyncRunSummary[] {
	let entries: string[];
	const activeEntries = new Set<string>();
	const wantsActive = options.states === undefined || options.states.some(isActiveAsyncState);
	const wantsTerminal = options.states === undefined || options.states.some((state) => !isActiveAsyncState(state));
	const includeNested = options.includeNested !== false;
	try {
		if (options.runId !== undefined) {
			const resolution = resolveTargetedAsyncRun(asyncDirRoot, options.runId, options.sessionId);
			entries = resolution.kind === "exact"
				? [resolution.id]
				: resolution.kind === "prefix" && options.exactRunId !== true
					? fs.readdirSync(asyncDirRoot).filter((entry) =>
						(entry === options.runId || entry.startsWith(options.runId!))
						&& resolveTargetedAsyncRun(asyncDirRoot, entry, options.sessionId).kind === "exact"
					)
					: [];
		} else if (options.repairScan === true) {
			entries = fs.readdirSync(asyncDirRoot).filter((entry) => entry !== ACTIVE_RUN_INDEX_DIR && entry !== TERMINAL_RUN_INDEX_DIR && isAsyncRunDir(asyncDirRoot, entry));
		} else {
			const indexed = new Set<string>();
			if (wantsActive) {
				for (const entry of readActiveRunIndex(asyncDirRoot) ?? []) {
					if (resolveTargetedAsyncRun(asyncDirRoot, entry).kind === "exact") {
						indexed.add(entry);
						activeEntries.add(entry);
					} else {
						updateActiveRunIndex(path.join(asyncDirRoot, entry), "failed");
					}
				}
			}
			if (wantsTerminal) {
				for (const entry of readRecentTerminalRunIndex(asyncDirRoot, { sessionId: options.sessionId, ...(options.entryLimit !== undefined ? { limit: options.entryLimit } : {}) })) indexed.add(entry);
			}
			entries = [...indexed];
		}
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	// Route resolution for every run shares a single index built from the
	// nested-events directory, so the per-run lookup is O(1) instead of scanning
	// the directory once per run. The index is built lazily on first use, so
	// load-time restoration (which only wants queued/running runs) skips it
	// entirely when no active runs match.
	let nestedRouteIndex: Map<string, NestedRoute> | undefined;
	const resolveNestedRoute = (rootRunId: string): NestedRoute | undefined => {
		if (!includeNested) return undefined;
		if (activeEntries.has(rootRunId)) return findNestedRouteForRootId(rootRunId);
		if (!nestedRouteIndex) nestedRouteIndex = buildNestedRouteIndex();
		return nestedRouteIndex.get(rootRunId);
	};
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		let status: (AsyncStatus & { cwd?: string }) | null;
		try {
			const reconciliation = options.reconcile === false
				? undefined
				: reconcileAsyncRun(asyncDir, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
			status = (reconciliation?.status ?? readStatus(asyncDir)) as (AsyncStatus & { cwd?: string }) | null;
		} catch (error) {
			if (!activeEntries.has(entry) || !isAsyncStatusIsolationError(asyncDir, error)) throw error;
			isolateCorruptActiveRun(asyncDir, entry, error, options.now);
			continue;
		}
		if (!status) {
			if (activeEntries.has(entry)) updateActiveRunIndex(asyncDir, "failed");
			continue;
		}
		if (activeEntries.has(entry) && !isActiveAsyncState(status.state)) {
			const processTerminal = readProcessTerminal(asyncDir, { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId });
			if (processTerminal?.state === "observed" || (activeRunMarkerAgeMs(asyncDir, options.now?.()) ?? 0) > DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS) releaseActiveRunIndex(asyncDir);
		}
		if (status.displayDismissedAt !== undefined) continue;
		// Filter before the nested-route lookup: the lookup builds an index over
		// the nested-events directory, so deferring it for filtered-out runs keeps
		// restoration at load from scanning that directory when no active runs
		// match.
		if (allowedStates && !allowedStates.has(status.state)) continue;
		if (options.sessionId && status.sessionId !== options.sessionId) continue;
		const nestedWarnings: string[] = [];
		let nestedRoute: NestedRoute | undefined;
		if (options.reconcile !== false && includeNested) {
			try {
				nestedRoute = resolveNestedRoute(status.runId || path.basename(asyncDir));
				if (nestedRoute) reconcileNestedAsyncDescendants(nestedRoute, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
			} catch (error) {
				nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
			}
		}
		let summary: AsyncRunSummary;
		try {
			summary = statusToSummary(asyncDir, status, nestedWarnings, nestedRoute);
		} catch (error) {
			if (!activeEntries.has(entry) || !isAsyncStatusIsolationError(asyncDir, error)) throw error;
			isolateCorruptActiveRun(asyncDir, entry, error, options.now);
			continue;
		}
		runs.push(summary);
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

function formatActivityFacts(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number; currentPath?: string; turnCount?: number; toolCount?: number; steering?: SteeringStatus; turnBudget?: TurnBudgetState; turnBudgetExceeded?: boolean; wrapUpRequested?: boolean }): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.turnBudgetExceeded && input.turnBudget) facts.push(`turn budget exceeded ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}+${input.turnBudget.graceTurns}`);
	else if (input.turnBudget?.outcome === "termination-deferred") facts.push(`turn-budget termination deferred ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}+${input.turnBudget.graceTurns}`);
	else if (input.wrapUpRequested && input.turnBudget) facts.push(`wrap-up requested ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}`);
	else if (input.turnBudget) facts.push(`turn budget ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}+${input.turnBudget.graceTurns}`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (input.steering) facts.push(`steering ${input.steering.scheduled} scheduled, ${input.steering.pending} pending, ${input.steering.delivered} delivered, ${input.steering.failed} failed, ${input.steering.recovered} recovered`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function formatStepLine(step: AsyncRunStepSummary): string {
	const display = step.sessionName?.trim() || (step.label ? `${step.label} (${step.agent})` : step.agent);
	const context = contextModeLabel(step.context);
	const phase = step.phase ? `[${step.phase}] ` : "";
	const parts = [`${step.index + 1}. ${phase}${display}${context ? ` ${context}` : ""}`, step.status];
	const activity = formatActivityFacts(step);
	if (activity) parts.push(activity);
	const modelThinking = formatModelThinking(step.model, step.thinking);
	if (modelThinking) parts.push(modelThinking);
	if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
	if (step.tokens) parts.push(`${formatTokens(step.tokens.total)} tok`);
	if (step.lane) parts.push(`lane ${step.lane.key}`);
	if (step.worktreePath) parts.push(`worktree ${shortenPath(step.worktreePath)} · branch ${step.branch ?? "unknown"}${step.provider ? ` · provider ${step.provider}` : ""}`);
	return parts.join(" | ");
}

function formatHostStepLine(row: ReturnType<typeof projectAsyncWorkflowRows>[number]): string {
	if (!row.kind) return "";
	const state = hostStepVerdictLabel(row.state as HostStepState, row.verdict);
	const details = [
		row.provider ? `provider:${row.provider}` : undefined,
		row.role ? `role:${row.role}` : undefined,
		row.target,
		row.detail,
		row.reasonCode ? `reason:${row.reasonCode}` : undefined,
		row.freshness?.stale ? "stale" : row.freshness?.observedRef ? `ref:${row.freshness.observedRef}` : undefined,
		row.reportPath ? `out:${hostStepReportName(row.reportPath)}` : undefined,
	].filter((value): value is string => Boolean(value));
	return `host ${row.kind}: ${row.name} | ${state}${details.length ? ` | ${details.join(" | ")}` : ""}`;
}

function workflowStageStateLabel(status: WorkflowGraphSnapshot["nodes"][number]["status"]): string {
	switch (status) {
		case "completed":
			return "complete";
		case "detached":
			return "paused";
		default:
			return status;
	}
}

export function formatWorkflowStageLine(node: WorkflowGraphSnapshot["nodes"][number], index: number, total: number): string {
	const state = workflowStageStateLabel(node.status);
	const id = previewDisplayText(node.id, 160);
	const label = node.label ? previewDisplayText(node.label, 160) : "";
	const display = label && label !== id ? ` | ${label}` : "";
	const agent = node.agent ? ` | ${previewDisplayText(node.agent, 80)}` : "";
	const error = node.error ? ` | ${previewDisplayText(node.error, 240)}` : "";
	return `stage ${index + 1}/${total}: ${id}${display}${agent} | ${state}${error}`;
}

export function formatAsyncRunOutputPath(run: Pick<AsyncRunSummary, "asyncDir" | "outputFile">): string | undefined {
	if (!run.outputFile) return undefined;
	return path.isAbsolute(run.outputFile) ? run.outputFile : path.join(run.asyncDir, run.outputFile);
}

export function formatAsyncRunProgressLabel(run: Pick<AsyncRunSummary, "mode" | "state" | "currentStep" | "chainStepCount" | "parallelGroups" | "steps"> & { workflowGraph?: WorkflowGraphSnapshot }): string {
	const graphStages = run.mode === "workflow" ? workflowGraphStageNodes(run.workflowGraph) : [];
	if (graphStages.length > 0) {
		const currentNode = graphStages.find((node) => node.id === run.workflowGraph?.currentNodeId);
		if (currentNode && currentNode.status !== "completed") return `stage ${graphStages.indexOf(currentNode) + 1}/${graphStages.length}`;
		const activeNode = graphStages.find((node) => node.status === "running") ?? graphStages.find((node) => node.status !== "completed");
		if (activeNode) return `stage ${graphStages.indexOf(activeNode) + 1}/${graphStages.length}`;
		return `stage ${graphStages.length}/${graphStages.length}`;
	}
	const stepCount = run.steps.length || 1;
	const chainStepCount = run.chainStepCount ?? stepCount;
	const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, chainStepCount);
	const activeGroup = run.currentStep !== undefined
		? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
		: undefined;
	if (activeGroup) {
		const groupSteps = run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count);
		const groupLabel = formatParallelOutcome(groupSteps, activeGroup.count, { showRunning: run.state === "running" });
		if (run.mode === "parallel") return groupLabel;
		return `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
	}
	if (run.mode === "parallel") return formatParallelOutcome(run.steps, stepCount, { showRunning: run.state === "running" });
	if (run.mode === "chain" && run.currentStep !== undefined && groups.length > 0) {
		const logicalStep = flatToLogicalStepIndex(run.currentStep, chainStepCount, groups);
		return `step ${logicalStep + 1}/${chainStepCount}`;
	}
	return run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
}

function formatRunHeader(run: AsyncRunSummary): string {
	const stepLabel = formatAsyncRunProgressLabel(run);
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
	const activity = formatActivityFacts(run);
	const pending = run.pendingAppends ? ` | ${run.pendingAppends} pending append${run.pendingAppends === 1 ? "" : "s"}` : "";
	const context = contextModeLabel(run.context);
	const lane = run.lane ? ` | lane ${run.lane.key}` : "";
	return `${run.id} | ${run.state}${activity ? ` | ${activity}` : ""} | ${run.mode}${context ? ` ${context}` : ""} | ${stepLabel}${pending}${lane} | ${cwd}`;
}

export function formatAsyncRunList(runs: AsyncRunSummary[], heading = "Active async runs"): string {
	if (runs.length === 0) return `No ${heading.toLowerCase()}.`;

	const lines = [`${heading}: ${runs.length}`, ""];
	for (const run of runs) {
		lines.push(`- ${formatRunHeader(run)}`);
		if (run.preflight) lines.push(formatWorkflowPreflightPlanSummary(run.preflight, { indent: "  " }));
		const preflightWarning = formatWorkflowPreflightWarningSummary(run.workflow?.preflightWarnings, { indent: "  " });
		if (preflightWarning) lines.push(preflightWarning);
		if (run.mode === "workflow") {
			const checklist = projectWorkflowChecklist({
				graph: run.workflowGraph,
				steps: run.steps,
				hostSteps: run.hostSteps,
				preflight: run.preflight,
				trace: run.workflow?.trace,
				now: run.lastUpdate ?? run.endedAt ?? Date.now(),
			});
			lines.push(...formatWorkflowChecklistText(checklist, "  ", { includeItems: false }));
		}
		for (const step of run.steps) {
			lines.push(`  ${formatStepLine(step)}`);
			lines.push(...formatTimeoutRecoveryLines(step.timeoutRecovery, "    "));
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", maxLines: 12 }));
		}
		const loadedWorkflowKeys = new Set(run.steps.flatMap((step) => step.workflowKey ? [step.workflowKey] : []));
		const graphStages = run.mode === "workflow" ? workflowGraphStageNodes(run.workflowGraph) : [];
		for (const [index, node] of graphStages.entries()) {
			if (!loadedWorkflowKeys.has(node.id)) lines.push(`  ${formatWorkflowStageLine(node, index, graphStages.length)}`);
		}
		for (const row of projectAsyncWorkflowRows([], run.hostSteps)) {
			const line = formatHostStepLine(row);
			if (line) lines.push(`  ${line}`);
		}
		const attached = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
		const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
		lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", maxLines: 12 }));
		if (run.runFanoutBudget) lines.push(`  ${formatRunFanoutBudget(run.runFanoutBudget)}`);
		if (run.error) lines.push(`  Error: ${run.error}`);
		for (const warning of run.nestedWarnings ?? []) lines.push(`  Warning: ${warning}`);
		const outputPath = formatAsyncRunOutputPath(run);
		if (outputPath) lines.push(`  output: ${shortenPath(outputPath)}`);
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
