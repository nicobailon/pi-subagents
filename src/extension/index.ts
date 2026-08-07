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
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyText, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { discoverAgents } from "../agents/agents.ts";
import { ensureAccessibleDir } from "../shared/accessible-dir.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { clearLegacyResultAnimationTimer, renderSubagentResult, renderSubagentSummary } from "../tui/render.ts";
import { openSubagentFleet } from "../tui/fleet.ts";
import { SubagentFleetStatus, resolveFleetViewPlacement } from "../tui/fleet-status.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { createScheduledRunManager } from "../runs/background/scheduled-runs.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";
import { registerMainWatchdog } from "../watchdog/register-main.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.ts";
import { registerHerdrStatusBridge } from "../integrations/herdr-status.ts";
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
import { loadConfig, resolveAsyncByDefault, resolveScheduledStoreRoot } from "./config.ts";
import { buildSubagentToolDescription } from "./tool-description.ts";
import { collectGoalContinuationNotices } from "../missions/goal-driver.ts";
import { syncMissionFromAsyncCompletion } from "../missions/lifecycle.ts";
import { resolveMissionStoreLocation } from "../missions/store.ts";
import { listRetainedChildren } from "../runs/background/retained-children.ts";
import {
	type Details,
	type SubagentState,
	DIRS,
	DEFAULT_ARTIFACT_CONFIG,
	SLASH_RESULT_TYPE,
	SLASH_TEXT_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
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
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result) ? "toolPendingBg" : isSlashResultError(result) ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result, options, theme));
	container.addChild(box);
}

function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): Container {
	const container = new Container();
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		if (snapshot.version !== lastVersion || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme);
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

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") {
		return;
	}
	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
	const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch {
			// Best effort cleanup for stale timers from an older reload.
		}
	}

	DIRS.results = ensureAccessibleDir(DIRS.results);
	DIRS.async = ensureAccessibleDir(DIRS.async);
	cleanupOldChainDirs();

	const config = loadConfig();
	const waitToolConfig = resolveWaitToolConfig(config.waitTool);
	const asyncByDefault = resolveAsyncByDefault(config);
	const fleetViewEnabled = config.fleetView !== false;
	const fleetViewPlacement = resolveFleetViewPlacement(config.fleetViewPlacement);
	const asyncWidgetEnabled = config.asyncWidget !== false;
	const summaryInlineToolDisplay = config.inlineToolDisplay === "summary";
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: SubagentState = {
		baseCwd: "",
		currentSessionId: null,
		artifactDirPreference: config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
		...(config.authorityPolicy ? { authorityPolicy: config.authorityPolicy } : {}),
		...(config.missions ? { missionStoreConfig: config.missions } : {}),
		parentSessionFile: null,
		subagentInProgress: false,
		subagentSpawns: {
			sessionId: null,
			count: 0,
			configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
			granted: 0,
			grantHistory: [],
		},
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
			await openSubagentFleet(ctx, state, { initialKey: itemKey, asyncDirRoot: DIRS.async, resultsDir: DIRS.results });
		}, { placement: fleetViewPlacement })
		: undefined;
	let executorScheduled: ((id: string, params: SubagentParamsLike, signal: AbortSignal, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>) | undefined;
	let goalTurnId = 0;
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
	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		DIRS.results,
		10 * 60 * 1000,
		{
			notifier: completionNotifier,
			observeCompletion: (result) => scheduledRunManager.handleAsyncCompletion(result),
			deliverIntercomResults: config.intercomBridge?.resultDelivery === true,
		},
	);

	const runtimeCleanup = () => {
		stopResultWatcher();
		state.currentSessionId = null;
		completionNotifier.dispose();
		mainWatchdog.dispose();
		scheduledRunManager.stop();
		supervisorChannel.dispose();
		waitSubscriptionManager.dispose();
		fleetStatus?.dispose();
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
	};
	globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

	const { ensurePoller, refreshWidget, handleStarted, handleComplete, resetJobs, restoreActiveJobs } = createAsyncJobTracker(pi, state, DIRS.async, {
		widgetEnabled: asyncWidgetEnabled,
	});
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
		discoverAgents,
	});
	executorScheduled = executor.executeScheduled;

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme);
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


	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: buildSubagentToolDescription(config),
		parameters: SubagentParams,

		execute(id, params, signal, onUpdate, ctx) {
			return executeSubagentCollapsed(id, params as SubagentParamsLike, signal ?? new AbortController().signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			if (args.workflowScript)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${formatWorkflowManifest(args.workflowScript, args.async, false)}`,
					0,
					0,
				);
			const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			clearLegacyResultAnimationTimer(context);
			const renderedResult = { ...result, isError: context.isError };
			return summaryInlineToolDisplay
				? renderSubagentSummary(renderedResult, options, theme)
				: renderSubagentResult(renderedResult, options, theme);
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

	registerSlashCommands(pi, state);

	const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
	const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
	const previousEventUnsubscribes = globalStore[eventUnsubscribeStoreKey];
	if (Array.isArray(previousEventUnsubscribes)) {
		for (const unsubscribe of previousEventUnsubscribes) {
			if (typeof unsubscribe !== "function") continue;
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup for stale handlers from an older reload.
			}
		}
	}
	const existingVisibleControlNotices = globalStore[controlNoticeSeenStoreKey];
	const visibleControlNotices = existingVisibleControlNotices instanceof Set ? existingVisibleControlNotices as Set<string> : new Set<string>();
	globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
	const activeHerdrRuns = () => [...state.asyncJobs.values()]
		.filter((job) => job.status === "queued" || job.status === "running")
		.map((job) => ({
			id: job.asyncId,
			agents: job.agents,
			needsAttention: job.activityState === "needs_attention",
		}));
	const herdrStatusBridge = registerHerdrStatusBridge({
		events: pi.events,
		getRuns: activeHerdrRuns,
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
		fleetStatus?.refresh();
	};
	const asyncCompleteHandler = (payload: unknown) => {
		handleComplete(payload);
		scheduledRunManager.handleAsyncCompletion(payload);
		try {
			syncMissionFromAsyncCompletion(payload);
		} catch (error) {
			console.error("Failed to update mission from async completion:", error);
		}
		fleetStatus?.refresh();
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, asyncStartedHandler),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, asyncCompleteHandler),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
		pi.events.on(SUBAGENT_STEERING_NOTICE_EVENT, steeringNoticeHandler),
		herdrStatusBridge.dispose,
		rpcBridge.dispose,
	];
	globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

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
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext, recovering: boolean) => {
		state.baseCwd = ctx.cwd;
		goalTurnId = 0;
		state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		state.parentSessionFile = ctx.sessionManager.getSessionFile();
		state.subagentSpawns = {
			sessionId: state.currentSessionId,
			count: 0,
			configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
			granted: 0,
			grantHistory: [],
		};
		// Set PI_SUBAGENT_PARENT_SESSION for permission-system forwarding.
		// Only set in the root session (the interactive UI session), not in
		// child subagent processes — children inherit the parent's value
		// through the process environment at spawn time and must not overwrite
		// it with their own session identity.
		if (!process.env[SUBAGENT_CHILD_ENV]) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) {
				process.env[SUBAGENT_PARENT_SESSION_ENV] = sessionId;
			}
		}
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		state.foregroundControls.clear();
		state.lastForegroundControlId = null;
		resetJobs(ctx);
		restoreActiveJobs(ctx);
		scheduledRunManager.bindSession(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
		waitSubscriptionManager.restore();
		startResultWatcher();
		primeExistingResults({ triggerTurn: !recovering });
		fleetStatus?.setContext(ctx);
	};

	pi.on("agent_start", () => {
		herdrStatusBridge.agentStarted();
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
		const recovering = event.reason === "startup" || event.reason === "reload" || event.reason === "resume";
		resetSessionState(ctx, recovering);
		herdrStatusBridge.sessionStarted({
			hasUI: ctx.hasUI === true,
			runs: activeHerdrRuns(),
		});
		rpcBridge.emitReady(ctx);
		supervisorChannel.start();
	});

	pi.on("session_shutdown", async () => {
		stopResultWatcher();
		state.currentSessionId = null;
		state.parentSessionFile = null;
		completionNotifier.dispose();
		delete process.env[SUBAGENT_PARENT_SESSION_ENV];
		for (const unsubscribe of eventUnsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup during shutdown.
			}
		}
		if (globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes) {
			delete globalStore[eventUnsubscribeStoreKey];
		}
		scheduledRunManager.stop();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		promptTemplateBridge.cancelAll();
		promptTemplateBridge.dispose();
		supervisorChannel.dispose();
		fleetStatus?.dispose();
		if (globalStore[runtimeCleanupStoreKey] === runtimeCleanup) {
			delete globalStore[runtimeCleanupStoreKey];
		}
		try {
			if (state.lastUiContext?.hasUI) {
				state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
			}
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
		await herdrStatusBridge.flush();
	});
}
