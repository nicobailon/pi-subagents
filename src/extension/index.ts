/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Public execution mode: workflow (workflowScript)
 * Toggle: async parameter (default: true; set asyncByDefault:false in config.json to opt out)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "defaultSubagentContext": "fork", "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyText, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { discoverAgents, discoverAgentsAll, type AgentConfig, type AgentScope } from "../agents/agents.ts";
import { clearRuntimeAgentsForPi, listRuntimeAgentConfigs, mergeRuntimeAgents } from "../agents/runtime-agent-registry.ts";
import { ensureAccessibleDir } from "../shared/accessible-dir.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { currentCompletionOwnerId } from "../shared/completion-owner.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { clearLegacyResultAnimationTimer, renderSubagentResult, renderSubagentSummary } from "../tui/render.ts";
import { openSubagentFleet } from "../tui/fleet.ts";
import { SubagentFleetStatus, resolveFleetViewPlacement } from "../tui/fleet-status.ts";
import { createSubagentParamsSchema } from "./schemas.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { getActiveAsyncCapacitySnapshot, resolveMaxActiveAsyncRunsPerSession } from "../runs/background/active-async-capacity.ts";
import { cleanupResultIndexes, missionObserverResultCandidateFiles } from "../runs/background/result-files.ts";
import { ASYNC_RETENTION_DELAY_MS, cleanupAsyncRetention } from "../runs/background/async-retention.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { createScheduledRunManager } from "../runs/background/scheduled-runs.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";
import { registerMainWatchdog } from "../watchdog/register-main.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.ts";
import { registerHerdrStatusBridge, type HerdrStatusRun } from "../integrations/herdr-status.ts";
import { listHerdrProjectPaneRoots, restoreHerdrProjectPaneSnapshots } from "../inspectors/herdr/project-panes.ts";
import { registerSubagentRpcBridge } from "./rpc.ts";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "../slash/slash-live-state.ts";
import { inspectSubagentStatus } from "../runs/background/run-status.ts";
import { resolveWaitToolConfig } from "../runs/background/subagent-wait.ts";
import { registerWaitTool } from "../runs/background/wait-tool.ts";
import { createWaitSubscriptionManager } from "../runs/background/wait-subscriptions.ts";
import { drainOutstandingWork } from "../runs/background/auto-drain.ts";
import registerSubagentNotify, { parseSubagentNotifyContent, type SubagentNotifyDetails } from "../runs/background/notify.ts";
import { formatSteeringNotice, handleSubagentSteeringNotice, SUBAGENT_STEERING_MESSAGE_TYPE, type SubagentSteeringMessageDetails } from "./steering-notices.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../runs/shared/pi-args.ts";
import { resolveCurrentSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { applyModelExclusionsConfig, loadConfig, resolveAsyncByDefault, resolveScheduledStoreRoot } from "./config.ts";
import { buildSubagentToolDescription, buildSubagentToolPromptMetadata } from "./tool-description.ts";
import { finalizeToolResult } from "./tool-result.ts";
import { collectGoalContinuationNotices } from "../missions/goal-driver.ts";
import { restoreForegroundRunHistory } from "../runs/foreground/foreground-history.ts";
import { resolveMissionStoreLocation } from "../missions/store.ts";
import { listRetainedChildren } from "../runs/background/retained-children.ts";
import {
	type Details,
	type MainWindowRendererConfig,
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
	formatSubagentControlNotice,
	handleSubagentControlNotice,
	SUBAGENT_CONTROL_MESSAGE_TYPE,
	type SubagentControlMessageDetails,
} from "./control-notices.ts";

export { loadConfig, resolveAsyncByDefault } from "./config.ts";

const SLOW_RELOAD_PHASE_MS = 250;
const RUNTIME_REGISTRY_STORE_KEY = "__piSubagentRuntimeRegistry";

interface SubagentRuntimeEntry {
	cleanup(): void;
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

function workflowLaneKeys(script: string): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	const add = (key: string): void => {
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	};
	const isIdentifier = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);
	const skipTrivia = (start: number): number => {
		let index = start;
		while (index < script.length) {
			if (/\s/.test(script[index]!)) index += 1;
			else if (script.startsWith("//", index)) {
				const end = script.indexOf("\n", index + 2);
				index = end === -1 ? script.length : end + 1;
			} else if (script.startsWith("/*", index)) {
				const end = script.indexOf("*/", index + 2);
				index = end === -1 ? script.length : end + 2;
			} else break;
		}
		return index;
	};
	const readLiteral = (start: number): { key?: string; end: number } | undefined => {
		const quote = script[start];
		if (quote !== "'" && quote !== '"' && quote !== "`") return undefined;
		let index = start + 1;
		let dynamicTemplate = false;
		while (index < script.length) {
			if (script[index] === "\\") {
				index += 2;
				continue;
			}
			if (quote === "`" && script.startsWith("${", index)) dynamicTemplate = true;
			if (script[index] === quote) return { key: dynamicTemplate ? undefined : script.slice(start + 1, index), end: index + 1 };
			if (quote !== "`" && /[\r\n]/.test(script[index]!)) return { end: index + 1 };
			index += 1;
		}
		return { end: script.length };
	};

	const collectRunsAllKeys = (start: number): number => {
		let index = skipTrivia(start);
		if (script[index] !== "(") return start;
		index = skipTrivia(index + 1);
		if (script[index] !== "[") return start;
		let arrayDepth = 1;
		let objectDepth = 0;
		let directChildObject = false;
		let expectingElement = true;
		for (index += 1; index < script.length; index += 1) {
			index = skipTrivia(index);
			const literal = readLiteral(index);
			if (literal) {
				index = literal.end - 1;
				continue;
			}
			if (script[index] === "[") {
				arrayDepth += 1;
				expectingElement = false;
				continue;
			}
			if (script[index] === "]") {
				arrayDepth -= 1;
				if (arrayDepth === 0) return index + 1;
				continue;
			}
			if (script[index] === "{") {
				objectDepth += 1;
				if (objectDepth === 1) directChildObject = arrayDepth === 1 && expectingElement;
				expectingElement = false;
				continue;
			}
			if (script[index] === "}") {
				objectDepth -= 1;
				if (objectDepth === 0) directChildObject = false;
				continue;
			}
			if (script[index] === "," && arrayDepth === 1 && objectDepth === 0) {
				expectingElement = true;
				continue;
			}
			if (directChildObject && objectDepth === 1 && !isIdentifier(script[index - 1]) && script.startsWith("key", index) && !isIdentifier(script[index + 3])) {
				const colon = skipTrivia(index + 3);
				const key = script[colon] === ":" ? readLiteral(skipTrivia(colon + 1)) : undefined;
				if (key) {
					const next = skipTrivia(key.end);
					if (key.key !== undefined && (script[next] === "," || script[next] === "}")) add(key.key);
					index = key.end - 1;
				}
			}
		}
		return index;
	};

	for (let index = 0; index < script.length;) {
		index = skipTrivia(index);
		const literal = readLiteral(index);
		if (literal) {
			index = literal.end;
			continue;
		}
		if (!isIdentifier(script[index - 1]) && script.startsWith("runs.run", index) && !isIdentifier(script[index + 8])) {
			const open = skipTrivia(index + 8);
			const key = script[open] === "(" ? readLiteral(skipTrivia(open + 1)) : undefined;
			if (key) {
				const next = skipTrivia(key.end);
				if (key.key !== undefined && (script[next] === "," || script[next] === ")")) add(key.key);
				index = key.end;
				continue;
			}
		}
		if (!isIdentifier(script[index - 1]) && script.startsWith("runs.all", index) && !isIdentifier(script[index + 8])) {
			index = collectRunsAllKeys(index + 8);
			continue;
		}
		index += 1;
	}
	return keys;
}

function formatWorkflowManifest(script: string, async: unknown, clarify: unknown): string {
	if (clarify === true) return "workflow script · rejected: clarify UI unsupported";
	const keys = workflowLaneKeys(script);
	// The workflow executor starts background work unless callers pass async:false.
	const mode = async === false ? "foreground" : "background";
	if (keys.length === 0) return `workflow script · ${mode}`;
	const visibleKeys = keys.slice(0, 4).join(", ");
	const remainder = keys.length > 4 ? `, +${keys.length - 4}` : "";
	return `workflow · ${mode} · ${keys.length} lane${keys.length === 1 ? "" : "s"}: ${visibleKeys}${remainder}`;
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

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Extension context no longer active");
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
): Container {
	const container = new Container();
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		if (snapshot.version !== lastVersion || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme, rendererConfig, foregroundDetachShortcut);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

class SubagentControlNoticeComponent implements Component {
	private readonly details: SubagentControlMessageDetails;
	private readonly theme: ExtensionContext["ui"]["theme"];

	constructor(details: SubagentControlMessageDetails, theme: ExtensionContext["ui"]["theme"]) {
		this.details = details;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const eventLabel = this.details.event.type.replaceAll("_", " ");
		if (width < 3) return [truncateToWidth(`Subagent ${eventLabel}`, width)];
		const bodyWidth = Math.max(1, width - 2);
		const borderChar = "─";
		const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		const lines = [this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`)];

		for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
			const text = truncateToWidth(line, bodyWidth, "");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}
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
	return [...state.asyncJobs.values()]
		.filter((job) => active(job.status))
		.map((job) => {
			const children = job.mode === "workflow" ? foregroundChildrenByWorkflow.get(job.asyncId) : undefined;
			return {
				id: job.asyncId,
				agents: children?.length ? children.map((child) => child.agent) : job.agents,
				needsAttention: job.activityState === "needs_attention" || children?.some((child) => child.needsAttention),
			};
		});
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") {
		return;
	}
	const runtimeRegistry = getRuntimeRegistry();

	DIRS.results = ensureAccessibleDir(DIRS.results);
	DIRS.async = ensureAccessibleDir(DIRS.async);
	cleanupOldChainDirs();

	const config = loadConfig();
	// Apply the process-wide exclusion TTL before any child launch can record a model failure.
	applyModelExclusionsConfig(config);
	const waitToolConfig = resolveWaitToolConfig(config.waitTool);
	const asyncByDefault = resolveAsyncByDefault(config);
	const fleetViewEnabled = config.fleetView !== false;
	const fleetViewPlacement = resolveFleetViewPlacement(config.fleetViewPlacement);
	const asyncWidgetEnabled = config.asyncWidget !== false;
	const summaryInlineToolDisplay = config.inlineToolDisplay === "summary";
	const tempArtifactsDir = getArtifactsDir(null);
	const artifactCleanupDays = config.artifactConfig?.cleanupDays ?? DEFAULT_ARTIFACT_CONFIG.cleanupDays;
	cleanupAllArtifactDirs(artifactCleanupDays);
	const resultIndexCleanupTimer = setTimeout(() => {
		try {
			cleanupResultIndexes(DIRS.results);
		} catch (error) {
			console.error("Failed to clean stale subagent result indexes:", error);
		}
	}, 30_000);
	resultIndexCleanupTimer.unref?.();

	const state: SubagentState = {
		baseCwd: "",
		currentSessionId: null,
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

	const supervisorChannel = createNativeSupervisorChannel(pi, state);
	const waitSubscriptionManager = createWaitSubscriptionManager(pi, state);
	const mainWatchdog = registerMainWatchdog(pi);
	const completionNotifier = registerSubagentNotify(pi, state, { batchConfig: config.completionBatch });
	const fleetStatus = fleetViewEnabled
		? new SubagentFleetStatus(state, async (itemKey) => {
			const ctx = state.lastUiContext;
			if (!ctx?.hasUI) return;
			await openSubagentFleet(ctx, state, { initialKey: itemKey, asyncDirRoot: DIRS.async, resultsDir: DIRS.results, fleetKeybindings: config.fleetKeybindings });
		}, { placement: fleetViewPlacement })
		: undefined;
	let executorScheduled: ((id: string, params: SubagentParamsLike, signal: AbortSignal, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>) | undefined;
	let goalTurnId = 0;
	let parentSessionEnvValue: string | null = null;
	const scheduledStoreRoot = config.scheduledRuns?.storeRoot === undefined ? undefined : resolveScheduledStoreRoot(config.scheduledRuns.storeRoot);
	const scheduledRunManager = createScheduledRunManager({
		config,
		storeRoot: scheduledStoreRoot,
		launch: (params, ctx, signal) => {
			if (!executorScheduled) {
				return Promise.resolve({
					content: [{ type: "text", text: "Scheduled subagent launch is unavailable (executor not ready)." }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				});
			}
			return executorScheduled(randomUUID(), params, signal, ctx);
		},
		resolveCapabilityCeiling: (sessionId) => resolveCurrentSubagentCapabilityCeiling(sessionId),
	});
	let refreshResultDelivery = () => {};
	const hasResultDeliveryDemand = () => {
		if ([...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running")) return true;
		if (state.foregroundControls.size > 0) return true;
		if (scheduledRunManager.observedCompletionRunIds().size > 0) return true;
		return missionObserverResultCandidateFiles(DIRS.results).length > 0;
	};
	const discoverAgentsForRuntime = (cwd: string, scope: AgentScope) => {
		const discovered = discoverAgents(cwd, scope);
		if (listRuntimeAgentConfigs(pi).length === 0) return discovered;
		const all = discoverAgentsAll(cwd);
		const configuredAgents: AgentConfig[] = [
			...all.builtin,
			...all.package,
			...all.user,
			...all.project,
		];
		const merged = mergeRuntimeAgents(pi, discovered, configuredAgents);
		if (discovered.maxThinking === undefined) return merged;
		return {
			...merged,
			agents: merged.agents.map((agent) => agent.maxThinking === discovered.maxThinking ? agent : { ...agent, maxThinking: discovered.maxThinking }),
		};
	};
	const { ensurePoller, refreshWidget, handleStarted, handleComplete, resetJobs, restoreActiveJobs, dispose: disposeAsyncJobTracker } = createAsyncJobTracker(pi, state, DIRS.async, {
		widgetEnabled: asyncWidgetEnabled,
		onJobTerminal: () => refreshResultDelivery(),
	});
	const resultWatcher = createResultWatcher(
		pi,
		state,
		DIRS.results,
		10 * 60 * 1000,
		{
			notifier: completionNotifier,
			observeCompletion: (result) => scheduledRunManager.handleAsyncCompletion(result),
			observedCompletionRunIds: () => scheduledRunManager.observedCompletionRunIds(),
			hasDeliveryDemand: hasResultDeliveryDemand,
			deliverIntercomResults: config.intercomBridge?.resultDelivery === true,
			resultScanLogging: config.resultScanLogging,
		},
	);
	const { startResultWatcher, primeExistingResults, stopResultWatcher } = resultWatcher;
	refreshResultDelivery = resultWatcher.refreshResultDelivery;
	const asyncRetentionAbort = new AbortController();
	const asyncRetentionTimer = setTimeout(async () => {
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

	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		waitToolEnabled: waitToolConfig.enabled,
		handleScheduledRunAction: (params, ctx) => scheduledRunManager.handleToolCall(params, ctx),
		watchdog: mainWatchdog,
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents: discoverAgentsForRuntime,
		activateSupervisorTransport: () => supervisorChannel.activateTransport(),
		refreshResultDelivery: () => refreshResultDelivery(),
	});
	executorScheduled = executor.executeScheduled;

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme, config.mainWindowRenderer, config.foregroundDetachShortcut);
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

	pi.registerMessageRenderer<SubagentNotifyDetails>("subagent-notify", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const details = (message.details as SubagentNotifyDetails | undefined) ?? parseSubagentNotifyContent(content);
		if (!details) return new Text(content, 0, 0);
		const icon = details.status === "completed"
			? theme.fg("success", "✓")
			: details.status === "paused"
				? theme.fg("warning", "■")
				: theme.fg("error", "✗");
		const parts: string[] = [];
		if (details.taskInfo) parts.push(details.taskInfo);
		if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
		let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
		if (parts.length > 0) text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
		const trimmedPreview = details.resultPreview.trim();
		const previewLines = options.expanded
			? trimmedPreview.split("\n").filter((line) => line.trim())
			: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
		for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
			text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
		}
		if (!options.expanded && trimmedPreview.includes("\n")) {
			const expandKey = keyText("app.tools.expand");
			text += `\n  ${theme.fg("dim", `${expandKey} full notification`)}`;
		}
		if (details.workflowRunId) {
			text += `\n  ${theme.fg("muted", `workflow: ${details.workflowRunId}`)}`;
		}
		if (details.childRuns?.length) {
			text += `\n  ${theme.fg("muted", `children: ${details.childRuns.map((child) => `${child.workflowKey ?? child.agent ?? "child"}=${child.runId}`).join(", ")}`)}`;
		}
		if (details.reconciledFromDetachedChild) {
			text += `\n  ${theme.fg("muted", `reconciled child: ${details.reconciledFromDetachedChild}`)}`;
		}
		if (details.sessionLabel && details.sessionValue) {
			text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer<SubagentSteeringMessageDetails>(SUBAGENT_STEERING_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as SubagentSteeringMessageDetails | undefined;
		if (!details) return undefined;
		return new Text(theme.fg(details.state === "recovered" ? "warning" : "error", formatSteeringNotice(details)), 0, 0);
	});

	pi.registerMessageRenderer<SubagentControlMessageDetails>(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as SubagentControlMessageDetails | undefined;
		if (!details?.event) return undefined;
		const content = typeof message.content === "string" ? message.content : undefined;
		return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
	});

	const executeSubagentCollapsed = (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
		return executor.executePublic(id, params, signal, onUpdate, ctx);
	};

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		asyncByDefault,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executeSubagentCollapsed(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (requestId, params, signal, ctx, onUpdate) =>
			executeSubagentCollapsed(requestId, params, signal, onUpdate, ctx),
		executeStructured: (requestId, params, signal, ctx, onUpdate) => {
			if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
			return executor.executeDelegated(requestId, params, signal, onUpdate, ctx);
		},
	});

	const rpcBridge = registerSubagentRpcBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) => executor.executePublic(id, params, signal, onUpdate, ctx),
		state,
	});


	const parameters = createSubagentParamsSchema();
	const tool: ToolDefinition<typeof parameters, Details> = {
		name: "subagent",
		label: "Subagent",
		description: buildSubagentToolDescription(config),
		...buildSubagentToolPromptMetadata(config),
		parameters,

		async execute(id, params, signal, onUpdate, ctx) {
			return finalizeToolResult(await executeSubagentCollapsed(id, params as SubagentParamsLike, signal ?? new AbortController().signal, onUpdate, ctx));
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
			if (args.workflowScript)
				return new Text(
					`${title}${gap}${formatWorkflowManifest(args.workflowScript, args.async, false)}`,
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

	pi.registerTool(tool);

	registerWaitTool(pi, state, waitToolConfig.enabled, waitSubscriptionManager);

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) await drainOutstandingWork({ state, events: pi.events });
		const ownerSessionId = state.currentSessionId;
		if (!ownerSessionId) return;
		goalTurnId += 1;
		try {
			const location = resolveMissionStoreLocation({ projectRoot: state.baseCwd, ...(config.missions ? { config: config.missions } : {}) });
			const retainedChildren = listRetainedChildren(DIRS.async, ownerSessionId);
			for (const notice of collectGoalContinuationNotices({ location, ownerSessionId, retainedChildren, turnId: goalTurnId })) {
				handleSubagentControlNotice({
					pi,
					state,
					visibleControlNotices: new Set(),
					details: { source: "goal", event: notice.event, noticeText: notice.message },
				});
			}
		} catch (error) {
			console.error("Failed to evaluate goal missions:", error);
		}
	});

	registerSlashCommands(pi, state, {
		fleetKeybindings: config.fleetKeybindings,
		foregroundDetachShortcut: config.foregroundDetachShortcut,
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
			pi,
			state,
			visibleControlNotices,
			details: payload as SubagentControlMessageDetails,
		});
	};
	const steeringNoticeHandler = (payload: unknown) => {
		handleSubagentSteeringNotice({ pi, state, details: payload as SubagentSteeringMessageDetails });
	};
	const asyncStartedHandler = (payload: unknown) => {
		handleStarted(payload);
		supervisorChannel.activateTransport();
		refreshResultDelivery();
		fleetStatus?.refresh();
	};
	const asyncCompleteHandler = (payload: unknown) => {
		handleComplete(payload);
		refreshResultDelivery();
		refreshActiveAsyncCapacity();
		scheduledRunManager.handleAsyncCompletion(payload);
		fleetStatus?.refresh();
	};
	const eventUnsubscribes = [
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
		restoreActiveJobs(ctx);
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
		if (state.lastUiContext?.hasUI) state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		fleetStatus?.refresh();
	};
	const resumeWidgetsAfterCompaction = () => {
		if (!state.widgetsSuspended) return;
		state.widgetsSuspended = false;
		const ctx = state.lastUiContext;
		if (ctx?.hasUI) refreshWidget(ctx);
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
			{ liveWorkflowRunIds: new Set(state.workflowControllers?.keys() ?? []) },
		);
	};

	const resetSessionState = (ctx: ExtensionContext, recovering: boolean) => {
		state.widgetsSuspended = false;
		state.baseCwd = ctx.cwd;
		goalTurnId = 0;
		state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		state.parentSessionFile = ctx.sessionManager.getSessionFile();
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
		// Set PI_SUBAGENT_PARENT_SESSION for permission-system forwarding.
		// Only set in the root session (the interactive UI session), not in
		// child subagent processes — children inherit the parent's value
		// through the process environment at spawn time and must not overwrite
		// it with their own session identity.
		if (!process.env[SUBAGENT_CHILD_ENV]) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) {
				process.env[SUBAGENT_PARENT_SESSION_ENV] = sessionId;
				parentSessionEnvValue = sessionId;
			}
		}
		state.lastUiContext = ctx;
		let phaseStartedAt = Date.now();
		refreshActiveAsyncCapacity();
		logSlowPhase("active-capacity", phaseStartedAt);
		phaseStartedAt = Date.now();
		cleanupSessionArtifacts(ctx);
		logSlowPhase("session-artifact-cleanup", phaseStartedAt);
		state.foregroundControls.clear();
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
		cleanup() {
			if (runtimeCleaned) return;
			runtimeCleaned = true;
			const shuttingDownParentSession = parentSessionEnvValue;
			clearRuntimeAgentsForPi(pi);
			clearTimeout(resultIndexCleanupTimer);
			clearTimeout(asyncRetentionTimer);
			asyncRetentionAbort.abort();
			stopResultWatcher();
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
			for (const unsubscribe of eventUnsubscribes) {
				try {
					unsubscribe();
				} catch {
					// Best effort cleanup during shutdown or reload.
				}
			}
			slashBridge.cancelAll();
			slashBridge.dispose();
			promptTemplateBridge.cancelAll();
			promptTemplateBridge.dispose();
			state.widgetsSuspended = false;
			state.currentSessionId = null;
			state.parentSessionFile = null;
			parentSessionEnvValue = null;
			if (shuttingDownParentSession && process.env[SUBAGENT_PARENT_SESSION_ENV] === shuttingDownParentSession) {
				delete process.env[SUBAGENT_PARENT_SESSION_ENV];
			}
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
		resumeWidgetsAfterCompaction();
		herdrStatusBridge.agentStarted();
	});

	pi.on("agent_settled", () => {
		resumeWidgetsAfterCompaction();
	});

	pi.on("session_before_compact", (event) => {
		if (event.reason !== "manual") suspendWidgetsForCompaction();
	});

	pi.on("session_compact", () => {
		const hasActiveAsyncWork = [...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running");
		if (!hasActiveAsyncWork || state.lastUiContext?.hasUI !== true) return;
		pi.sendMessage(
			{
				customType: "subagent-compaction-resume",
				content: "Compaction is complete. Resume the parent task now; background subagent results will arrive separately when ready.",
				display: false,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("session_start", (event, ctx) => {
		installRuntime(ctx);
		const recovering = event.reason === "startup" || event.reason === "reload" || event.reason === "resume";
		resetSessionState(ctx, recovering);
		herdrStatusBridge.sessionStarted({
			hasUI: ctx.hasUI === true,
			runs: activeHerdrRuns(),
		});
		rpcBridge.emitReady(ctx);
		supervisorChannel.start();
		supervisorChannel.activateTransport();
	});

	pi.on("session_shutdown", async () => {
		runtimeEntry.cleanup();
		await herdrStatusBridge.flush();
	});
}
