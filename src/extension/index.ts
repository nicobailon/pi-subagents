/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "agentManager": { "newShortcut": "shift+ctrl+n" }, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import { discoverAgents } from "../agents/agents.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { renderWidget, renderSubagentResult, stopResultAnimations, stopWidgetAnimation, syncResultAnimation } from "../tui/render.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "../slash/slash-live-state.ts";
import { inspectSubagentStatus } from "../runs/background/run-status.ts";
import registerSubagentNotify, { type SubagentNotifyDetails } from "../runs/background/notify.ts";
import { SUBAGENT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import {
	type Details,
	type ExtensionConfig,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SLASH_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	WIDGET_KEY,
} from "../shared/types.ts";
import {
	clearPendingForegroundControlNotices,
	formatSubagentControlNotice,
	handleSubagentControlNotice,
	SUBAGENT_CONTROL_MESSAGE_TYPE,
	type SubagentControlMessageDetails,
} from "./control-notices.ts";

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

function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Create a directory and verify it is actually accessible.
 * On Windows with Azure AD/Entra ID, directories created shortly after
 * wake-from-sleep can end up with broken NTFS ACLs (null DACL) when the
 * cloud SID cannot be resolved without network connectivity. This leaves
 * the directory completely inaccessible to the creating user.
 */
function ensureAccessibleDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Best effort: retry mkdir/access even if cleanup fails.
		}
		fs.mkdirSync(dirPath, { recursive: true });
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}
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
	requestRender: () => void,
): Container {
	const container = new Container();
	const animationState: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } = {};
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		syncResultAnimation(snapshot.result, { state: animationState, invalidate: requestRender });
		if (snapshot.version !== lastVersion || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const match = header.match(/^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const resultPreview = resultLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[2]!,
		status: match[1] as SubagentNotifyDetails["status"],
		...(match[3] ? { taskInfo: match[3] } : {}),
		resultPreview,
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}

class SubagentControlNoticeComponent implements Component {
	constructor(
		private readonly details: SubagentControlMessageDetails,
		private readonly theme: ExtensionContext["ui"]["theme"],
	) {}

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
	if (process.env[SUBAGENT_CHILD_ENV] === "1") return;
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

	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);
	cleanupOldChainDirs();

	const config = loadConfig();
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: SubagentState = {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
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

	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		RESULTS_DIR,
		10 * 60 * 1000,
	);
	startResultWatcher();
	primeExistingResults();

	const runtimeCleanup = () => {
		stopWidgetAnimation();
		stopResultAnimations();
		stopResultWatcher();
		clearPendingForegroundControlNotices(state);
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
	};
	globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

	const { ensurePoller, handleStarted, handleComplete, resetJobs } = createAsyncJobTracker(pi, state, ASYNC_DIR);
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
	});

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme, () => state.lastUiContext?.ui.requestRender?.());
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
			text += `\n  ${theme.fg("dim", "Ctrl+O full notification")}`;
		}
		if (details.sessionLabel && details.sessionValue) {
			text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer<SubagentControlMessageDetails>(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as SubagentControlMessageDetails | undefined;
		if (!details?.event) return undefined;
		const content = typeof message.content === "string" ? message.content : undefined;
		return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
	});

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executor.execute(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: async (requestId, request, signal, ctx, onUpdate) => {
			if (request.tasks && request.tasks.length > 0) {
				return executor.execute(
					requestId,
					{
						tasks: request.tasks,
						context: request.context,
						cwd: request.cwd,
						worktree: request.worktree,
						async: false,
						clarify: false,
					},
					signal,
					onUpdate,
					ctx,
				);
			}
			return executor.execute(
				requestId,
				{
					agent: request.agent,
					task: request.task,
					context: request.context,
					cwd: request.cwd,
					model: request.model,
					async: false,
					clarify: false,
				},
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
		if (!tasks || tasks.length === 0) return 0;
		return tasks.reduce((total, task) => {
			const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return total + count;
		}, 0);
	}

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: `Delegate to subagents or manage agent definitions.

EXECUTION (use exactly ONE mode):
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task? } - one task; omit task for self-contained agents
• CHAIN: { chain: [{agent:"agent-a"}, {parallel:[{agent:"agent-b",count:3}]}] } - sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?}, ...], concurrency?: number, worktree?: true } - concurrent execution (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (default: if any requested agent has defaultContext: "fork", the whole invocation uses fork; otherwise "fresh"; inspect agent defaults via { action: "list" })

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

Example: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {agent:"agent-b", task:"Plan based on {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover executable agents/chains
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, ... } }
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
• Use chainName for chain operations; packaged chains also use dotted runtime names

CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused
• { action: "resume", id: "...", message: "..." } - follow up with a live async child or revive a completed single-child async run from its session

DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, discovery, sessions, and intercom`,
		parameters: SubagentParams,

		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			const asyncLabel = args.async === true && !isParallel ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			syncResultAnimation(result, context);
			return renderSubagentResult(result, options, theme);
		},

	};

	pi.registerTool(tool);
	registerSlashCommands(pi, state, config);

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
	registerSubagentNotify(pi);

	const existingVisibleControlNotices = globalStore[controlNoticeSeenStoreKey];
	const visibleControlNotices = existingVisibleControlNotices instanceof Set ? existingVisibleControlNotices as Set<string> : new Set<string>();
	globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
	const controlEventHandler = (payload: unknown) => {
		handleSubagentControlNotice({
			pi,
			state,
			visibleControlNotices,
			details: payload as SubagentControlMessageDetails,
		});
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
	];
	globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		if (state.asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(state.asyncJobs.values()));
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

	const resetSessionState = (ctx: ExtensionContext) => {
		state.baseCwd = ctx.cwd;
		state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		clearPendingForegroundControlNotices(state);
		resetJobs(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
		primeExistingResults();
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState(ctx);
	});

	pi.on("session_shutdown", () => {
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
		stopResultWatcher();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		clearPendingForegroundControlNotices(state);
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
		stopWidgetAnimation();
		stopResultAnimations();
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
	});
}
