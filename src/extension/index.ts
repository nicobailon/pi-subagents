/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Public execution mode: workflow (workflow: true reply block, script path, or named resource)
 * Toggle: async parameter (default: true; set asyncByDefault:false in config.json to opt out)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "defaultSubagentContext": "fork", "forkContext": { "mode": "pruned", "model": "provider/model" }, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { clearAgentDiscoveryCache, discoverAgentSnapshot, discoverAgents, discoverAgentsAll, type AgentConfig, type AgentScope } from "../agents/agents.ts";
import { resolveGlobalNpmRoot } from "../agents/global-npm-root.ts";
import { buildAdvertisedAgentCatalog, buildAdvertisedAgentPrompt } from "../agents/advertised-agent-prompt.ts";
import { clearRuntimeAgentsForPi, listRuntimeAgentConfigs, mergeRuntimeAgents } from "../agents/runtime-agent-registry.ts";
import { registerRuntimeAgentEventListener } from "../agents/runtime-agent-events.ts";
import { ensureAccessibleDir } from "../shared/accessible-dir.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { getAgentDir } from "../shared/utils.ts";
import { isStaleExtensionContextError, MODEL_ONLY_TOOL, withCachedUiContext } from "../shared/extension-context.ts";
import { currentCompletionOwnerId } from "../shared/completion-owner.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { clearLegacyResultAnimationTimer, renderSubagentResult, renderSubagentSummary, setInlineWorkflowCoverage } from "../tui/render.ts";
import { getInspectorPlugins, registerInspectorEventListener } from "../inspectors/plugins.ts";
import { SubagentFleetStatus, resolveFleetViewPlacement } from "../tui/fleet-status.ts";
import { readMainThinkingLevel, setMainThinkingLevelSource } from "../tui/running-tone.ts";
import { createSubagentParamsSchema } from "./schemas.ts";
import { resolveDisabledFeatureSurface } from "../shared/disabled-features.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { getActiveAsyncCapacitySnapshot, resolveAbandonedSlotReleaseAfterMs, resolveMaxActiveAsyncRunsPerSession } from "../runs/background/active-async-capacity.ts";
import { cleanupResultIndexes, missionObserverResultCandidateFiles, resultFilePath } from "../runs/background/result-files.ts";
import { ASYNC_RETENTION_DELAY_MS, cleanupAsyncRetention } from "../runs/background/async-retention.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { createResultDeliveryOwnership } from "../runs/background/result-delivery-ownership.ts";
import { createScheduledRunManager } from "../runs/background/scheduled-runs.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";
import { registerMainWatchdog } from "../watchdog/register-main.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.ts";
import { renderSubagentEntry, renderSubagentMessage, SUBAGENT_ENTRY_TYPES, SUBAGENT_MESSAGE_TYPES } from "../tui/subagent-messages.ts";
import { registerHerdrStatusBridge, type HerdrStatusRun } from "../integrations/herdr-status.ts";
import { registerProgramStatusReporter } from "../integrations/program-status.ts";
import { hasLiveSubagentWork, registerPiWebSessionLiveness } from "../integrations/pi-web-session-liveness.ts";
import { createRetainedNestedRouteTracker } from "../runs/background/retained-nested-route-tracker.ts";
import { listHerdrProjectPaneRoots, restoreHerdrProjectPaneSnapshots } from "../inspectors/herdr/project-panes.ts";
import { registerSubagentRpcBridge } from "./rpc.ts";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "../slash/slash-live-state.ts";
import { resolveWaitToolConfig } from "../runs/background/subagent-wait.ts";
import { registerWaitTool } from "../runs/background/wait-tool.ts";
import { registerSubagentToolActivation } from "./tool-activation.ts";
import { recordedPromptSection, registerPinnedTool } from "./declaration-pinning.ts";
import { createWaitSubscriptionManager } from "../runs/background/wait-subscriptions.ts";
import { drainOutstandingWork } from "../runs/background/auto-drain.ts";
import registerSubagentNotify from "../runs/background/notify.ts";
import { createParentWake } from "../shared/parent-wake.ts";
import { handleSubagentSteeringNotice, type SubagentSteeringMessageDetails } from "./steering-notices.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../runs/shared/child-runtime-config.ts";
import { disposeChildSessions } from "../runs/shared/child-session.ts";
import { resolveCurrentSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { loadConfig, resolveAsyncByDefault, resolveScheduledStoreRoot } from "./config.ts";
import { buildSubagentToolDescription, buildSubagentToolPromptMetadata } from "./tool-description.ts";
import { formatWorkflowPreflightSummary, normalizeWorkflowPreflight } from "../workflows/workflow-preflight.ts";
import { runtimeReplacedAbortReason } from "../workflows/workflow-reuse.ts";
import { finalizeToolResult } from "./tool-result.ts";
import { flattenSubagentToolOptions } from "./subagent-options.ts";
import { collectGoalContinuationNotices } from "../missions/goal-driver.ts";
import { restoreForegroundRunHistory } from "../runs/foreground/foreground-history.ts";
import { resolveMissionStoreLocation } from "../missions/store.ts";
import { listRetainedChildren } from "../runs/background/retained-children.ts";
import {
	type Details,
	type MainWindowRendererConfig,
	type AsyncJobState,
	type SubagentState,
	DIRS,
	DEFAULT_ARTIFACT_CONFIG,
	SLASH_RESULT_TYPE,
	SLASH_TEXT_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_STEERING_NOTICE_EVENT,
	WIDGET_KEY,
	resolveMaxSubagentSpawnsPerSession,
} from "../shared/types.ts";
import {
	handleSubagentControlNotice,
	type SubagentControlMessageDetails,
} from "./control-notices.ts";
import { showUpgradeNotice } from "./upgrade-notice.ts";

export { loadConfig, resolveAsyncByDefault } from "./config.ts";

const SLOW_RELOAD_PHASE_MS = 250;
// Long enough for Pi to finish starting; loading the executor blocks the event loop for tens of ms.
const MODULE_PRELOAD_DELAY_MS = 1_000;
const RUNTIME_REGISTRY_STORE_KEY = "__piSubagentRuntimeRegistry";

type SubagentExecutorModule = typeof import("../runs/foreground/subagent-executor.ts");
type SubagentExecutor = ReturnType<SubagentExecutorModule["createSubagentExecutor"]>;
type SubagentExecutorDeps = Parameters<SubagentExecutorModule["createSubagentExecutor"]>[0];

interface SubagentRuntimeEntry {
	cleanup(shutdownReason?: string): void;
	sessionManager: object | null;
	visibleControlNotices: Set<string>;
}

interface SubagentRuntimeRegistry {
	bySessionManager: WeakMap<object, SubagentRuntimeEntry>;
	visibleControlNoticesBySessionManager: WeakMap<object, Set<string>>;
	activeEntries: Set<SubagentRuntimeEntry>;
}

function getRuntimeRegistry(): SubagentRuntimeRegistry {
	const globalStore = globalThis as Record<string, unknown>;
	const existing = globalStore[RUNTIME_REGISTRY_STORE_KEY] as Partial<SubagentRuntimeRegistry> | undefined;
	if (existing?.bySessionManager instanceof WeakMap && existing.activeEntries instanceof Set) {
		if (!(existing.visibleControlNoticesBySessionManager instanceof WeakMap)) {
			existing.visibleControlNoticesBySessionManager = new WeakMap();
		}
		return existing as SubagentRuntimeRegistry;
	}
	const registry: SubagentRuntimeRegistry = {
		bySessionManager: new WeakMap(),
		visibleControlNoticesBySessionManager: new WeakMap(),
		activeEntries: new Set(),
	};
	globalStore[RUNTIME_REGISTRY_STORE_KEY] = registry;
	return registry;
}

function logSlowPhase(label: string, startedAt: number): void {
	const elapsed = Date.now() - startedAt;
	if (elapsed >= SLOW_RELOAD_PHASE_MS) console.error(`Subagent reload phase '${label}' took ${elapsed}ms.`);
}

function formatWorkflowPreflightCall(input: unknown): string {
	if (input === undefined) return "";
	try {
		return formatWorkflowPreflightSummary(normalizeWorkflowPreflight(input));
	} catch (error) {
		return `preflight · rejected: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function isSlashResultRunning(result: { details?: Details }): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function isSlashResultError(result: { details?: Details }): boolean {
	return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
}

function rebuildSlashResultContainer(
	container: Container,
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
	rendererConfig?: MainWindowRendererConfig,
	foregroundDetachShortcut?: string,
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result) ? "toolPendingBg" : isSlashResultError(result) ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result, options, theme, undefined, rendererConfig, foregroundDetachShortcut));
	container.addChild(box);
}

function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
	rendererConfig?: MainWindowRendererConfig,
	foregroundDetachShortcut?: string,
	getCurrentTheme: () => ExtensionContext["ui"]["theme"] = () => theme,
): Container {
	const container = new Container();
	let lastVersion = -1;
	let lastTheme: ExtensionContext["ui"]["theme"] | undefined;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		const currentTheme = getCurrentTheme();
		if (snapshot.version !== lastVersion || currentTheme !== lastTheme || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			lastTheme = currentTheme;
			rebuildSlashResultContainer(container, snapshot.result, options, currentTheme, rendererConfig, foregroundDetachShortcut);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

export function projectActiveHerdrRuns(state: SubagentState): HerdrStatusRun[] {
	const active = (status: string) => status === "queued" || status === "running";
	const foregroundChildrenByWorkflow = new Map<string, Array<{ agent: string; needsAttention: boolean }>>();
	for (const control of state.foregroundControls.values()) {
		if (!control.parentWorkflowRunId) continue;
		const children = control.activeChildren?.size
			? [...control.activeChildren.values()].map((child) => ({
				agent: child.agent,
				needsAttention: child.currentActivityState === "needs_attention",
			}))
			: control.currentAgent
				? [{ agent: control.currentAgent, needsAttention: control.currentActivityState === "needs_attention" }]
				: [];
		if (children.length === 0) continue;
		const existing = foregroundChildrenByWorkflow.get(control.parentWorkflowRunId) ?? [];
		existing.push(...children);
		foregroundChildrenByWorkflow.set(control.parentWorkflowRunId, existing);
	}

	// Keep each async child under its own ID: completion and attention events
	// address that ID directly. The workflow row accounts only for foreground
	// children; its own coordinator and step summaries are not leaf agents.
	return [...state.asyncJobs.values()]
		.filter((job) => active(job.status))
		.map((job) => {
			const currentStep = job.steps?.find((step) => step.status === "running")
				?? (job.currentStep !== undefined ? job.steps?.[job.currentStep] : undefined)
				?? job.steps?.find((step) => step.status === "pending");
			if (job.mode === "workflow") {
				const children = foregroundChildrenByWorkflow.get(job.asyncId) ?? [];
				return {
					id: job.asyncId,
					coordinator: true as const,
					agents: children.map((child) => child.agent),
					...(currentStep?.label ? { taskLabel: currentStep.label } : {}),
					needsAttention: job.activityState === "needs_attention" || children.some((child) => child.needsAttention),
				};
			}
			return {
				id: job.asyncId,
				agents: job.agents,
				...(currentStep?.label ? { taskLabel: currentStep.label } : {}),
				needsAttention: job.activityState === "needs_attention",
			};
		});
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") {
		return;
	}
	const runtimeRegistry = getRuntimeRegistry();
	setMainThinkingLevelSource(() => readMainThinkingLevel(() => pi.getThinkingLevel()));

	DIRS.results = ensureAccessibleDir(DIRS.results);
	DIRS.async = ensureAccessibleDir(DIRS.async);
	cleanupOldChainDirs();

	const config = loadConfig();
	const waitToolConfig = resolveWaitToolConfig(config.waitTool);
	const asyncByDefault = resolveAsyncByDefault(config);
	const fleetViewEnabled = config.fleetView !== false;
	const fleetViewPlacement = resolveFleetViewPlacement(config.fleetViewPlacement);
	const asyncWidgetEnabled = config.asyncWidget !== false;
	const asyncWidgetCollapsed = config.asyncWidgetCollapsed === true;
	const asyncWidgetLayout = config.asyncWidgetLayout ?? "adaptive";
	const summaryInlineToolDisplay = config.inlineToolDisplay === "summary";
	const tempArtifactsDir = getArtifactsDir(null);
	const artifactCleanupDays = config.artifactConfig?.cleanupDays ?? DEFAULT_ARTIFACT_CONFIG.cleanupDays;
	cleanupAllArtifactDirs(artifactCleanupDays);
	let resultIndexCleanupTimer: ReturnType<typeof setTimeout> | undefined;

	const state: SubagentState = {
		baseCwd: "",
		currentSessionId: null,
		statusProjectionSessionId: null,
		completionOwnerId: currentCompletionOwnerId(),
		artifactDirPreference: config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
		...(config.authorityPolicy ? { authorityPolicy: config.authorityPolicy } : {}),
		...(config.missions ? { missionStoreConfig: config.missions } : {}),
		parentSessionFile: null,
		trustedSessionRoots: [],
		subagentInProgress: false,
		subagentSpawns: {
			sessionId: null,
			count: 0,
			configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
			granted: 0,
			grantHistory: [],
		},
		activeAsyncCapacity: { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession) ?? 0 },
		herdrProjectPanes: new Map(),
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		widgetsSuspended: false,
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
	const withLastUiContext = <T>(run: (ctx: ExtensionContext) => T): T | undefined => {
		const cached = state.lastUiContext;
		return withCachedUiContext(cached, () => {
			if (state.lastUiContext === cached) state.lastUiContext = null;
		}, run);
	};

	// Every notice that wakes the parent goes through parentWake; the watchdog wakes only inside a run.
	const parentWake = createParentWake(pi);
	const wakingPi = { events: pi.events, sendMessage: parentWake.sendMessage, on: pi.on };
	const supervisorChannel = createNativeSupervisorChannel(pi, state, {
		// Owner states are created only by scheduled execution, which loads the executor first.
		getCurrentOwnerStates: () => executor?.getCurrentSupervisorOwnerStates() ?? [],
		parentWake,
	});
	const waitSubscriptionManager = createWaitSubscriptionManager(wakingPi, state);
	const mainWatchdog = registerMainWatchdog(pi);
	const resultDeliveryOwnership = createResultDeliveryOwnership(state);
	const completionNotifier = registerSubagentNotify(wakingPi, state, { batchConfig: config.completionBatch, ownership: resultDeliveryOwnership });
	// Ended async runs whose result has not reached the notifier yet.
	const owedResultRunIds = new Set<string>();
	// Tracked runs whose result was already delivered, so a later terminal
	// transition (the tracker can see the end after the result) holds nothing.
	const deliveredRunIds = new Set<string>();
	const holdOwedResult = (job: AsyncJobState) => {
		if (!job.parentWorkflowRunId && !deliveredRunIds.has(job.asyncId) && job.sessionId
			&& resultDeliveryOwnership.owns(job.sessionId, job.completionOwnerId)) owedResultRunIds.add(job.asyncId);
	};
	let retainedNestedRouteTracker: ReturnType<typeof createRetainedNestedRouteTracker> | undefined;
	const fleetStatus = fleetViewEnabled
		? new SubagentFleetStatus(state, async (itemKey) => {
			const ctx = withLastUiContext((current) => current);
			if (!ctx) return;
			try {
				const { openSubagentFleet } = await import("../tui/fleet.ts");
				await openSubagentFleet(ctx, state, { initialKey: itemKey, asyncDirRoot: DIRS.async, resultsDir: DIRS.results, fleetKeybindings: config.fleetKeybindings, inspectorPlugins: () => getInspectorPlugins(pi) });
			} catch (error) {
				if (isStaleExtensionContextError(error)) {
					if (state.lastUiContext === ctx) state.lastUiContext = null;
					return;
				}
				throw error;
			}
		}, { placement: fleetViewPlacement, onWorkflowCoverageChange: setInlineWorkflowCoverage })
		: undefined;
	let goalTurnId = 0;
	let releaseHostSessionLiveness = () => {};
	const scheduledStoreRoot = config.scheduledRuns?.storeRoot === undefined ? undefined : resolveScheduledStoreRoot(config.scheduledRuns.storeRoot);
	const scheduledRunManager = createScheduledRunManager({
		config,
		storeRoot: scheduledStoreRoot,
		launch: async (params, ctx, signal) => {
			await waitForAdvertisement();
			return (await getExecutor()).executeScheduled(randomUUID(), params, signal, ctx);
		},
		resolveCapabilityCeiling: (sessionId) => resolveCurrentSubagentCapabilityCeiling(sessionId),
	});
	let refreshResultDelivery = () => {};
	let advertisedAgents: AgentConfig[] = [];
	let advertisedContext: Pick<ExtensionContext, "cwd" | "model"> & { projectTrusted?: boolean } | undefined;
	let advertisementGeneration = 0;
	let globalRoot: string | null = null;
	let advertisementReady: Promise<void | { error: unknown }> = Promise.resolve();
	let notifySessionChange = () => {};
	let sessionChanged: Promise<void> = Promise.resolve();
	const waitForAdvertisement = async () => {
		let pending: typeof advertisementReady;
		do {
			pending = advertisementReady;
			const result = await Promise.race([pending, sessionChanged]);
			if (pending === advertisementReady && result) throw result.error;
		} while (pending !== advertisementReady);
	};
	const refreshAdvertisedAgents = () => {
		advertisedAgents = [];
		if (!advertisedContext) return;
		clearAgentDiscoveryCache();
		advertisedAgents = discoverAgents(advertisedContext.cwd, "both", advertisedContext.model?.provider, { globalNpmRoot: globalRoot, projectTrusted: advertisedContext.projectTrusted }).agents
			.filter((agent) => agent.advertise === true);
	};
	const beginAdvertisement = (ctx: ExtensionContext) => {
		const generation = ++advertisementGeneration;
		notifySessionChange();
		sessionChanged = new Promise<void>((resolve) => { notifySessionChange = resolve; });
		advertisedAgents = [];
		advertisedContext = { cwd: ctx.cwd, model: ctx.model, projectTrusted: typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined };
		globalRoot = null;
		advertisementReady = resolveGlobalNpmRoot().then((root) => {
			if (generation !== advertisementGeneration) return;
			globalRoot = root;
			refreshAdvertisedAgents();
		}).catch((error) => {
			if (generation !== advertisementGeneration) return;
			// Settle without an unhandled rejection if no turn follows session_start.
			console.error("Failed to refresh advertised agents:", error);
			return { error };
		});
	};
	const hasResultDeliveryDemand = () => {
		if (owedResultRunIds.size > 0) return true;
		if ([...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running")) return true;
		if (state.foregroundControls.size > 0) return true;
		if (scheduledRunManager.observedCompletionRunIds().size > 0) return true;
		return missionObserverResultCandidateFiles(DIRS.results).length > 0;
	};
	const discoverAgentsForRuntime = (cwd: string, scope: AgentScope, preferredModelProvider?: string, options: { projectTrusted?: boolean } = {}) => {
		if (listRuntimeAgentConfigs(pi).length === 0) return discoverAgents(cwd, scope, preferredModelProvider, { globalNpmRoot: globalRoot, projectTrusted: options.projectTrusted });
		const snapshot = discoverAgentSnapshot(cwd, scope, preferredModelProvider, { includeChains: false, globalNpmRoot: globalRoot, projectTrusted: options.projectTrusted });
		const discovered = snapshot.effective;
		const all = snapshot.all;
		const configuredAgents: AgentConfig[] = [
			...all.builtin,
			...all.package,
			...all.user,
			...all.project,
		];
		// Runtime agents take model settings from the scope discovery actually used.
		const merged = mergeRuntimeAgents(pi, discovered, configuredAgents, { cwd, scope: discovered.scope, preferredModelProvider });
		if (discovered.maxThinking === undefined) return merged;
		return {
			...merged,
			agents: merged.agents.map((agent) => agent.maxThinking === discovered.maxThinking ? agent : { ...agent, maxThinking: discovered.maxThinking }),
		};
	};
	const programStatus = registerProgramStatusReporter({
		enabled: config.programStatus !== false,
		// Fleet history keeps recent finished runs after the widget drops them.
		getJobs: () => new Map([...(state.fleetJobs ?? []), ...state.asyncJobs]).values(),
		getPendingRequests: () => supervisorChannel.pending.values(),
	});
	const { ensurePoller, refreshWidget, handleStarted, handleComplete, resetJobs, restoreActiveJobs, dispose: disposeAsyncJobTracker } = createAsyncJobTracker(pi, state, DIRS.async, {
		widgetEnabled: asyncWidgetEnabled,
		widgetCollapsed: asyncWidgetCollapsed,
		widgetLayout: asyncWidgetLayout,
		onJobTerminal: (job) => {
			holdOwedResult(job);
			refreshResultDelivery();
		},
		onJobCleanup: (asyncId) => deliveredRunIds.delete(asyncId),
		supervisorRequestState: supervisorChannel.getSupervisorRequestState,
		onJobsChanged: programStatus.sync,
	});
	const resultWatcher = createResultWatcher(
		pi,
		state,
		DIRS.results,
		10 * 60 * 1000,
		{
			notifier: completionNotifier,
			ownership: resultDeliveryOwnership,
			onResultDelivered: (runId) => {
				owedResultRunIds.delete(runId);
				if (state.asyncJobs.has(runId)) deliveredRunIds.add(runId);
			},
			observeCompletion: (result) => scheduledRunManager.handleAsyncCompletion(result),
			observedCompletionRunIds: () => scheduledRunManager.observedCompletionRunIds(),
			hasDeliveryDemand: hasResultDeliveryDemand,
			deliverIntercomResults: config.intercomBridge?.resultDelivery === true,
			resultScanLogging: config.resultScanLogging,
		},
	);
	const { startResultWatcher, transitionResultDelivery, primeExistingResults, stopResultWatcher } = resultWatcher;
	refreshResultDelivery = resultWatcher.refreshResultDelivery;
	const asyncRetentionAbort = new AbortController();
	let asyncRetentionTimer: ReturnType<typeof setTimeout> | undefined;
	const startSessionMaintenance = () => {
		if (!resultIndexCleanupTimer) {
			resultIndexCleanupTimer = setTimeout(() => {
				try {
					cleanupResultIndexes(DIRS.results);
				} catch (error) {
					console.error("Failed to clean stale subagent result indexes:", error);
				}
			}, 30_000);
			resultIndexCleanupTimer.unref?.();
		}
		waitSubscriptionManager.start();
		if (!asyncRetentionTimer) {
			asyncRetentionTimer = setTimeout(async () => {
				try {
					await cleanupAsyncRetention({
						asyncDirRoot: DIRS.async,
						resultsDir: DIRS.results,
						signal: asyncRetentionAbort.signal,
						protectedRunIds: new Set([
							...state.asyncJobs.keys(),
							...(state.workflowControllers?.keys() ?? []),
							...scheduledRunManager.referencedAsyncRunIds(),
						]),
					});
				} catch (error) {
					console.error("Failed to clean retained async subagent state:", error);
				}
			}, ASYNC_RETENTION_DELAY_MS);
			asyncRetentionTimer.unref?.();
		}
	};

	const executorDeps: SubagentExecutorDeps = {
		pi,
		parentWake,
		state,
		config,
		asyncByDefault,
		waitToolEnabled: waitToolConfig.enabled,
		waitToolDefaultTimeoutMs: waitToolConfig.defaultTimeoutMs,
		handleScheduledRunAction: (params, ctx) => scheduledRunManager.handleToolCall(params, ctx),
		watchdog: mainWatchdog,
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents: discoverAgentsForRuntime,
		discoverAgentsAll: (cwd, provider) => discoverAgentsAll(cwd, provider, { globalNpmRoot: globalRoot }),
		onAgentsChanged: () => {
			try {
				refreshAdvertisedAgents();
			} catch (error) {
				// The mutation already persisted. Withdraw stale guidance, not its result.
				console.error("Failed to refresh advertised agents; catalog withdrawn until refresh:", error);
			}
		},
		activateSupervisorTransport: () => supervisorChannel.activateTransport(),
		findPendingAsks: (target) => supervisorChannel.findPendingAsks(target),
		refreshResultDelivery: () => refreshResultDelivery(),
		trackRetainedNestedRoute: undefined,
	};
	let executor: SubagentExecutor | undefined;
	let executorPromise: Promise<SubagentExecutor> | undefined;
	let executorModulePromise: Promise<SubagentExecutorModule> | undefined;
	const loadExecutorModule = () => executorModulePromise ??= import("../runs/foreground/subagent-executor.ts");
	const getExecutor = (): Promise<SubagentExecutor> => {
		executorPromise ??= loadExecutorModule().then(({ createSubagentExecutor }) => {
			executor = createSubagentExecutor(executorDeps);
			return executor;
		});
		return executorPromise;
	};
	// Loading these on first use could happen days after startup, when pi-subagents may have
	// changed on disk and the new files would import stale cached copies of modules loaded at
	// startup. Load them shortly after a session starts instead, off Pi's startup path; child
	// runtimes return before registration and never schedule this.
	let modulePreloadTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleModulePreload = () => {
		if (executorModulePromise || modulePreloadTimer) return;
		modulePreloadTimer = setTimeout(() => {
			// Errors surface from the first call that needs the module.
			loadExecutorModule().catch(() => {});
			if (fleetViewEnabled) import("../tui/fleet.ts").catch(() => {});
		}, MODULE_PRELOAD_DELAY_MS);
		modulePreloadTimer.unref?.();
	};

	for (const customType of SUBAGENT_MESSAGE_TYPES) pi.registerMessageRenderer(customType, renderSubagentMessage);
	const registerEntryRenderer = (pi as unknown as {
		registerEntryRenderer?: (customType: string, renderer: (entry: { customType: string; data?: unknown }, options: { expanded: boolean }, theme: ExtensionContext["ui"]["theme"]) => Component | undefined) => void;
	}).registerEntryRenderer;
	if (typeof registerEntryRenderer === "function") {
		for (const customType of SUBAGENT_ENTRY_TYPES) registerEntryRenderer.call(pi, customType, renderSubagentEntry);
	}

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(
			details,
			options,
			theme,
			config.mainWindowRenderer,
			config.foregroundDetachShortcut,
			() => state.lastUiContext?.ui.theme ?? theme,
		);
	});

	pi.registerMessageRenderer<undefined>(SLASH_TEXT_RESULT_TYPE, (message, _options, _theme) => {
		const content = typeof message.content === "string"
			? message.content
			: message.content
				.filter((entry) => entry.type === "text")
				.map((entry) => entry.text)
				.join("\n");
		return new Text(content, 0, 0);
	});

	const executeSubagentReady = async (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => {
		await waitForAdvertisement();
		return (await getExecutor()).executePublic(id, params, signal, onUpdate, ctx);
	};
	const executeSubagentCollapsed = (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
		return executeSubagentReady(id, params, signal, onUpdate, ctx);
	};

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executeSubagentCollapsed(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (requestId, params, signal, ctx, onUpdate) =>
			executeSubagentCollapsed(requestId, params, signal, onUpdate, ctx),
		executeStructured: async (requestId, params, signal, ctx, onUpdate) => {
			if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
			await waitForAdvertisement();
			return (await getExecutor()).executeDelegated(requestId, params, signal, onUpdate, ctx);
		},
	});

	const disabledFeatures = resolveDisabledFeatureSurface(config);
	const rpcBridge = registerSubagentRpcBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: executeSubagentReady,
		state,
		disabledFeatures,
	});


	const parameters = createSubagentParamsSchema(disabledFeatures);
	const tool: ToolDefinition<typeof parameters, Details> = {
		name: "subagent",
		...MODEL_ONLY_TOOL,
		label: "Subagent",
		description: buildSubagentToolDescription(config, { disabledFeatures }),
		...buildSubagentToolPromptMetadata(config, disabledFeatures),
		parameters,

		async execute(id, params, signal, onUpdate, ctx) {
			return finalizeToolResult(await executeSubagentCollapsed(id, flattenSubagentToolOptions(params, disabledFeatures), signal ?? new AbortController().signal, onUpdate, ctx));
		},

		renderCall(args, theme) {
			const gap = " ".repeat(config.mainWindowRenderer?.horizontalSpacing ?? 1);
			const title = theme.fg("toolTitle", theme.bold("subagent"));
			if (args.action) {
				const target = args.agent || "";
				return new Text(
					`${title}${gap}${args.action}${target ? `${gap}${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const preflight = args.options?.preflight ?? (args as { preflight?: unknown }).preflight;
			if (args.workflow !== undefined)
				return new Text(
					`${title}${gap}${theme.fg("accent", args.workflow === true || args.workflow === "true" ? "workflow (reply block)" : `workflow ${String(args.workflow)}`)}${args.async === true ? `${gap}${theme.fg("warning", "[async]")}` : ""}${preflight !== undefined ? `${gap}${theme.fg("dim", formatWorkflowPreflightCall(preflight))}` : ""}`,
					0,
					0,
				);
			const asyncLabel = args.async === true ? `${gap}${theme.fg("warning", "[async]")}` : "";
			return new Text(
				`${title}${gap}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			clearLegacyResultAnimationTimer(context);
			const renderedResult = { ...result, isError: context.isError };
			return summaryInlineToolDisplay
				? renderSubagentSummary(renderedResult, options, theme)
				: renderSubagentResult(renderedResult, options, theme, undefined, config.mainWindowRenderer, config.foregroundDetachShortcut);
		},

	};

	registerPinnedTool(pi, tool);

	pi.on("before_agent_start", async (event, ctx) => {
		await waitForAdvertisement();
		if (!event.systemPromptOptions.selectedTools.includes("subagent")) return;
		const sessionId = state.currentSessionId ?? resolveCurrentSessionId(ctx.sessionManager);
		// Structured sections let Pi append a transcript delta instead of replacing the
		// cached system prompt. Set the section on every turn it applies: Pi rebuilds the
		// options each turn, and an unset turn records a removal.
		const catalog = buildAdvertisedAgentCatalog(advertisedAgents, resolveCurrentSubagentCapabilityCeiling(sessionId), recordedPromptSection(pi, "advertised_subagents"));
		if (catalog) event.systemPromptOptions.sections.advertised_subagents = catalog;
	});

	registerWaitTool(pi, state, waitToolConfig.enabled, waitSubscriptionManager, waitToolConfig.defaultTimeoutMs, undefined, supervisorChannel.hasPendingRequests);

	pi.on("agent_end", async (_event, ctx) => {
		try {
			// A headless host may dispose the session as soon as this turn settles, so hand
			// finished results to Pi now; Pi runs the queued completion turn after agent_end.
			// A failed drain rejects without this step so its deadline stays exact.
			if (!ctx.hasUI) await drainOutstandingWork({ state, events: pi.events, hasPendingSupervisorRequest: supervisorChannel.hasPendingRequests }).then(resultWatcher.deliverPendingResults);
		} finally {
			// Deliver notices after a failed drain without suppressing its rejection.
			const ownerSessionId = state.currentSessionId;
			if (ownerSessionId) {
				goalTurnId += 1;
				try {
					const location = resolveMissionStoreLocation({ projectRoot: state.baseCwd, ...(config.missions ? { config: config.missions } : {}) });
					const retainedChildren = listRetainedChildren(DIRS.async, ownerSessionId);
					for (const notice of collectGoalContinuationNotices({ location, ownerSessionId, retainedChildren, turnId: goalTurnId })) {
						handleSubagentControlNotice({
							pi: parentWake,
							state,
							visibleControlNotices: new Set(),
							details: { source: "goal", event: notice.event, noticeText: notice.message },
						});
					}
				} catch (error) {
					console.error("Failed to evaluate goal missions:", error);
				}
			}
		}
	});

	const disposeSlashCommands = registerSlashCommands(pi, state, {
		fleetKeybindings: config.fleetKeybindings,
		foregroundDetachShortcut: config.foregroundDetachShortcut,
		workflowScriptsDisabled: disabledFeatures.features.has("workflow-scripts"),
	});

	let visibleControlNotices = new Set<string>();
	const activeHerdrRuns = () => projectActiveHerdrRuns(state);
	const herdrStatusBridge = registerHerdrStatusBridge({
		events: pi.events,
		getRuns: activeHerdrRuns,
		getProjectPaneCount: () => [...(state.herdrProjectPanes?.values() ?? [])].filter((pane) => pane.state === "open").length,
		async runHerdr(args) {
			await pi.exec(process.env.HERDR_BIN || "herdr", [...args], { timeout: 5_000 });
		},
	});
	const controlEventHandler = (payload: unknown) => {
		handleSubagentControlNotice({
			pi: parentWake,
			state,
			visibleControlNotices,
			details: payload as SubagentControlMessageDetails,
		});
	};
	const steeringNoticeHandler = (payload: unknown) => {
		handleSubagentSteeringNotice({ pi: parentWake, state, details: payload as SubagentSteeringMessageDetails });
	};
	const asyncStartedHandler = (payload: unknown) => {
		handleStarted(payload);
		supervisorChannel.activateTransport();
		refreshResultDelivery();
		fleetStatus?.refresh();
	};
	const asyncCompleteHandler = (payload: unknown) => {
		handleComplete(payload);
		// Detached-workflow reconciliation publishes the result, then ends the job
		// with this event; the next status refresh sees it already terminal.
		const job = state.asyncJobs.get((payload as { id?: string } | null)?.id ?? "");
		if (job && job.status !== "queued" && job.status !== "running"
			&& fs.existsSync(resultFilePath(DIRS.results, job.asyncId))) holdOwedResult(job);
		refreshResultDelivery();
		refreshActiveAsyncCapacity();
		scheduledRunManager.handleAsyncCompletion(payload);
		fleetStatus?.refresh();
	};
	const eventUnsubscribes = [
		registerRuntimeAgentEventListener(pi),
		registerInspectorEventListener(pi),
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, asyncStartedHandler),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, asyncCompleteHandler),
		pi.events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, () => {
			refreshActiveAsyncCapacity();
			fleetStatus?.refresh();
		}),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
		pi.events.on(SUBAGENT_STEERING_NOTICE_EVENT, steeringNoticeHandler),
		herdrStatusBridge.dispose,
		rpcBridge.dispose,
	];

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		const activeJobCount = state.asyncJobs.size;
		restoreActiveJobs(ctx);
		if (state.asyncJobs.size > activeJobCount) herdrStatusBridge.syncRuns();
		fleetStatus?.setContext(ctx);
		fleetStatus?.refresh();
		if (state.asyncJobs.size > 0) {
			refreshWidget(ctx);
			ensurePoller();
		}
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), artifactCleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const suspendWidgetsForCompaction = () => {
		if (state.widgetsSuspended) return;
		state.widgetsSuspended = true;
		withLastUiContext((ctx) => ctx.ui.setWidget(WIDGET_KEY, undefined));
		fleetStatus?.refresh();
	};
	const resumeWidgetsAfterCompaction = () => {
		if (!state.widgetsSuspended) return;
		state.widgetsSuspended = false;
		withLastUiContext((ctx) => refreshWidget(ctx));
		fleetStatus?.refresh();
	};

	const refreshActiveAsyncCapacity = () => {
		if (!state.currentSessionId) {
			state.activeAsyncCapacity = { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession) ?? 0 };
			return;
		}
		state.activeAsyncCapacity = getActiveAsyncCapacitySnapshot(
			state.currentSessionId,
			resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession),
			{ liveWorkflowRunIds: new Set(state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(config.capacity?.abandonedSlotReleaseAfterMs) },
		);
	};

	const resetSessionState = (ctx: ExtensionContext, recovering: boolean, previousSessionFile?: string) => {
		state.widgetsSuspended = false;
		state.baseCwd = ctx.cwd;
		goalTurnId = 0;
		const previousRuntimeSessionId = state.currentSessionId;
		resultDeliveryOwnership.claimPredecessor(previousSessionFile, previousRuntimeSessionId);
		state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		state.supervisorOwnerSessionId = ctx.sessionManager.getSessionId() || null;
		transitionResultDelivery();
		owedResultRunIds.clear();
		deliveredRunIds.clear();
		state.parentSessionFile = ctx.sessionManager.getSessionFile();
		state.trustedSessionFileRoot = state.parentSessionFile ? path.join(getAgentDir(), "sessions") : undefined;
		state.trustedSessionRoots = [...new Set([
			...(config.defaultSessionDir ? [path.resolve(expandTilde(config.defaultSessionDir))] : []),
			...(state.parentSessionFile ? [getSubagentSessionRoot(state.parentSessionFile)] : []),
		])];
		state.subagentSpawns = {
			sessionId: state.currentSessionId,
			count: 0,
			configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
			granted: 0,
			grantHistory: [],
		};
		const projectPaneOwnerRoot = path.resolve(ctx.cwd);
		restoreHerdrProjectPaneSnapshots(state, [...new Set([...(state.herdrProjectPanes?.keys() ?? []), ...listHerdrProjectPaneRoots(projectPaneOwnerRoot), projectPaneOwnerRoot])]);
		// Root hosts may contain independent sessions, so a process-global parent
		// identity is unsafe. Dedicated child runners retain their launch-owned value.
		if (!process.env[SUBAGENT_CHILD_ENV]) {
			delete process.env[SUBAGENT_PARENT_SESSION_ENV];
		}
		state.lastUiContext = ctx;
		let phaseStartedAt = Date.now();
		refreshActiveAsyncCapacity();
		logSlowPhase("active-capacity", phaseStartedAt);
		phaseStartedAt = Date.now();
		cleanupSessionArtifacts(ctx);
		logSlowPhase("session-artifact-cleanup", phaseStartedAt);
		state.foregroundControls.clear();
		retainedNestedRouteTracker?.clear();
		retainedNestedRouteTracker = undefined;
		executorDeps.trackRetainedNestedRoute = undefined;
		state.lastForegroundControlId = null;
		phaseStartedAt = Date.now();
		resetJobs(ctx);
		logSlowPhase("reset-jobs", phaseStartedAt);
		phaseStartedAt = Date.now();
		restoreForegroundRunHistory(state, { resultsDir: DIRS.results });
		logSlowPhase("foreground-history", phaseStartedAt);
		phaseStartedAt = Date.now();
		restoreActiveJobs(ctx);
		logSlowPhase("active-job-restore", phaseStartedAt);
		phaseStartedAt = Date.now();
		scheduledRunManager.bindSession(ctx);
		logSlowPhase("scheduled-runs", phaseStartedAt);
		phaseStartedAt = Date.now();
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
		logSlowPhase("slash-snapshots", phaseStartedAt);
		phaseStartedAt = Date.now();
		waitSubscriptionManager.restore();
		logSlowPhase("wait-subscriptions", phaseStartedAt);
		phaseStartedAt = Date.now();
		startResultWatcher();
		logSlowPhase("result-watcher-start", phaseStartedAt);
		phaseStartedAt = Date.now();
		primeExistingResults({ triggerTurn: !recovering });
		logSlowPhase("result-prime", phaseStartedAt);
		fleetStatus?.setContext(ctx);
	};

	let runtimeCleaned = false;
	const runtimeEntry: SubagentRuntimeEntry = {
		sessionManager: null,
		visibleControlNotices,
		cleanup(shutdownReason) {
			if (runtimeCleaned) return;
			runtimeCleaned = true;
			programStatus.dispose(shutdownReason);
			releaseHostSessionLiveness();
			releaseHostSessionLiveness = () => {};
			// Detached foreground children run in this runtime's memory, and the next runtime
			// cannot see or control them, so stop each one and record it as stopped.
			for (const control of state.foregroundControls.values()) {
				try {
					control.stopForRuntimeReplacement?.();
				} catch (error) {
					console.error(`Failed to stop detached foreground run ${control.runId}:`, error);
				}
			}
			// Workflow continuations retain their launch context; abort them before
			// teardown so a reload cannot launch through a stale context.
			for (const controller of state.workflowControllers?.values() ?? []) {
				if (!controller.signal.aborted) controller.abort(runtimeReplacedAbortReason());
			}
			state.workflowControllers?.clear();
			state.workflowChildStops?.clear();
			clearRuntimeAgentsForPi(pi);
			if (resultIndexCleanupTimer) clearTimeout(resultIndexCleanupTimer);
			resultIndexCleanupTimer = undefined;
			if (asyncRetentionTimer) clearTimeout(asyncRetentionTimer);
			asyncRetentionTimer = undefined;
			if (modulePreloadTimer) clearTimeout(modulePreloadTimer);
			modulePreloadTimer = undefined;
			asyncRetentionAbort.abort();
			stopResultWatcher();
			resultDeliveryOwnership.clear();
			completionNotifier.dispose();
			mainWatchdog.dispose();
			scheduledRunManager.stop();
			supervisorChannel.dispose();
			waitSubscriptionManager.dispose();
			fleetStatus?.dispose();
			disposeAsyncJobTracker();
			for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
			state.cleanupTimers.clear();
			state.asyncJobs.clear();
			retainedNestedRouteTracker?.clear();
			retainedNestedRouteTracker = undefined;
			executorDeps.trackRetainedNestedRoute = undefined;
			for (const unsubscribe of eventUnsubscribes) {
				try {
					unsubscribe();
				} catch {
					// Best effort cleanup during shutdown or reload.
				}
			}
			disposeSlashCommands.dispose();
			slashBridge.cancelAll();
			slashBridge.dispose();
			promptTemplateBridge.cancelAll();
			promptTemplateBridge.dispose();
			state.widgetsSuspended = false;
			state.currentSessionId = null;
			state.supervisorOwnerSessionId = null;
			state.statusProjectionSessionId = null;
			state.parentSessionFile = null;
			if (runtimeEntry.sessionManager && runtimeRegistry.bySessionManager.get(runtimeEntry.sessionManager) === runtimeEntry) {
				runtimeRegistry.bySessionManager.delete(runtimeEntry.sessionManager);
			}
			runtimeRegistry.activeEntries.delete(runtimeEntry);
			if (runtimeRegistry.activeEntries.size === 0) clearSlashSnapshots();
			try {
				if (state.lastUiContext?.hasUI) state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) throw error;
			}
			state.lastUiContext = null;
		},
	};

	const installRuntime = (ctx: ExtensionContext) => {
		if (runtimeCleaned) {
			throw new Error("Cannot restart a cleaned pi-subagents extension runtime; register a new extension instance.");
		}
		const sessionManager = ctx.sessionManager as object;
		const previousRuntime = runtimeRegistry.bySessionManager.get(sessionManager);
		const existingVisibleControlNotices = runtimeRegistry.visibleControlNoticesBySessionManager.get(sessionManager);
		if (existingVisibleControlNotices) {
			visibleControlNotices = existingVisibleControlNotices;
		} else {
			runtimeRegistry.visibleControlNoticesBySessionManager.set(sessionManager, visibleControlNotices);
		}
		runtimeEntry.visibleControlNotices = visibleControlNotices;
		if (runtimeEntry.sessionManager && runtimeEntry.sessionManager !== sessionManager
			&& runtimeRegistry.bySessionManager.get(runtimeEntry.sessionManager) === runtimeEntry) {
			runtimeRegistry.bySessionManager.delete(runtimeEntry.sessionManager);
		}
		runtimeEntry.sessionManager = sessionManager;
		runtimeRegistry.bySessionManager.set(sessionManager, runtimeEntry);
		runtimeRegistry.activeEntries.add(runtimeEntry);
		if (previousRuntime && previousRuntime !== runtimeEntry) {
			try {
				previousRuntime.cleanup();
			} catch {
				// Best effort cleanup for stale resources from the replaced runtime.
			}
		}
	};

	pi.on("agent_start", () => {
		parentWake.agentStarted();
		resumeWidgetsAfterCompaction();
		herdrStatusBridge.agentStarted();
		programStatus.agentStarted();
	});

	pi.on("message_start", (event) => completionNotifier.messageStarted(event.message));

	pi.on("agent_settled", () => {
		resumeWidgetsAfterCompaction();
		programStatus.agentSettled();
	});

	pi.on("session_before_compact", (event) => {
		if (event.reason !== "manual") suspendWidgetsForCompaction();
	});

	pi.on("session_compact", (event) => {
		if (event.reason !== "manual") return;
		const hasActiveAsyncWork = [...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running");
		if (!hasActiveAsyncWork || !withLastUiContext(() => true)) return;
		parentWake.sendMessage(
			{
				customType: "subagent-compaction-resume",
				content: "Compaction is complete. Resume the parent task now; background subagent results will arrive separately when ready.",
				display: false,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("session_start", (event, ctx) => {
		parentWake.bindSession(ctx);
		completionNotifier.bindSession(ctx.sessionManager);
		installRuntime(ctx);
		startSessionMaintenance();
		scheduleModulePreload();
		const recovering = event.reason === "startup" || event.reason === "reload" || event.reason === "resume";
		resetSessionState(ctx, recovering, event.previousSessionFile);
		releaseHostSessionLiveness();
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const liveness = sessionId
			? registerPiWebSessionLiveness({
				sessionId,
				...(sessionFile ? { sessionFile } : {}),
				isActive: () => owedResultRunIds.size > 0 || hasLiveSubagentWork(state) || completionNotifier.hasPendingDelivery() || parentWake.isPending(),
			})
			: { registered: false, release: () => {} };
		releaseHostSessionLiveness = liveness.release;
		if (liveness.registered) {
			retainedNestedRouteTracker = createRetainedNestedRouteTracker(state);
			executorDeps.trackRetainedNestedRoute = retainedNestedRouteTracker.track;
		}
		herdrStatusBridge.sessionStarted({
			hasUI: ctx.hasUI === true,
			runs: activeHerdrRuns(),
		});
		programStatus.sessionStarted({ hasUI: ctx.hasUI === true, mode: ctx.mode });
		rpcBridge.emitReady(ctx);
		supervisorChannel.start();
		supervisorChannel.activateTransport();
	});

	pi.on("session_shutdown", async (event) => {
		completionNotifier.sessionShutdown(event?.reason);
		parentWake.sessionShutdown(event?.reason);
		runtimeEntry.cleanup(event?.reason);
		try {
			await disposeChildSessions();
		} catch (error) {
			console.error("Failed to dispose in-process child sessions:", error);
		}
		await herdrStatusBridge.flush();
	});

	// Child processes and Herdr panes never load this module; in-process children have no UI.
	pi.on("session_start", (_event, ctx) => void showUpgradeNotice(ctx).catch((error) => console.error("Failed to show the pi-subagents upgrade notice:", error)));
	pi.on("session_start", (_event, ctx) => beginAdvertisement(ctx));

	registerSubagentToolActivation(pi, {
		mode: config.toolActivation,
		advertisedPrompt: async () => {
			await waitForAdvertisement();
			return buildAdvertisedAgentPrompt(advertisedAgents, resolveCurrentSubagentCapabilityCeiling(state.currentSessionId ?? undefined));
		},
	});
}
