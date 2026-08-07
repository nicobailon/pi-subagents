import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.ts";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../shared/formatters.ts";
import { DIRS, type AsyncJobState, type Details, type ForegroundChildControl, type ForegroundResumeChild, type ForegroundResumeRun, type ForegroundRunControl, type SubagentState } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { formatAsyncRunTranscript } from "../runs/background/fleet-view.ts";
import { listAsyncRuns, type AsyncRunSummary } from "../runs/background/async-status.ts";
import { steerAsyncRun } from "../runs/foreground/async-steering-action.ts";
import type { SteerDeliveryMode } from "../runs/background/control-channel.ts";
import { stopAsyncRun } from "../runs/foreground/async-stop-action.ts";
import { contextModeBadge, contextModeLabel } from "../runs/shared/context-mode.ts";
import { FLEET_STATUS_WIDGET_KEY } from "./fleet-status.ts";
import { readFleetTranscript, renderFleetTranscript, type FleetTranscript } from "./fleet-transcript.ts";
import { handleHerdrInspectorAction } from "../inspectors/herdr/actions.ts";

const REFRESH_MS = 750;
const MAX_RECENT_ASYNC_RUNS = 20;
const MAX_FLEET_HISTORY_CANDIDATES = 100;
const TRANSCRIPT_LINES = 200;

type Theme = ExtensionContext["ui"]["theme"];
type FleetTui = {
	terminal?: { rows: number };
	requestRender(): void;
};
type AsyncStep = AsyncRunSummary["steps"][number];

export type FleetItem = (
	| { key: string; kind: "foreground-active"; runId: string; index?: number; agent: string; state: "running"; updatedAt: number; control: ForegroundRunControl; activeChild?: ForegroundChildControl }
	| { key: string; kind: "foreground-recent"; runId: string; index: number; agent: string; state: ForegroundResumeChild["status"]; updatedAt: number; run: ForegroundResumeRun; child: ForegroundResumeChild }
	| { key: string; kind: "async"; runId: string; index?: number; agent: string; state: string; updatedAt: number; run: AsyncRunSummary; step?: AsyncStep }
) & { description?: string };

export interface FleetSnapshot {
	items: FleetItem[];
	error?: string;
}

export interface FleetActionResult {
	text: string;
	isError?: boolean;
}

export interface FleetActionHandlers {
	steer(input: { runId: string; asyncDir: string; index?: number; message: string; mode: SteerDeliveryMode }): Promise<FleetActionResult>;
	stop(input: { runId: string; asyncDir: string; index?: number }): Promise<FleetActionResult> | FleetActionResult;
	inspect?(input: { runId: string; asyncDir: string; index?: number }): Promise<FleetActionResult>;
}

export interface FleetViewOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	refreshMs?: number;
	initialKey?: string;
	markdownTheme?: MarkdownTheme;
	actions?: FleetActionHandlers;
}

function belongsToCurrentSession(sessionId: string | undefined, currentSessionId: string | null): boolean {
	return !currentSessionId || sessionId === currentSessionId;
}

function trackedJobSummary(job: AsyncJobState): AsyncRunSummary {
	const startedAt = job.startedAt ?? job.updatedAt ?? Date.now();
	return {
		id: job.asyncId,
		asyncDir: job.asyncDir,
		...(job.sessionId ? { sessionId: job.sessionId } : {}),
		state: job.status,
		activityState: job.activityState,
		lastActivityAt: job.lastActivityAt,
		currentTool: job.currentTool,
		currentToolStartedAt: job.currentToolStartedAt,
		currentPath: job.currentPath,
		turnCount: job.turnCount,
		toolCount: job.toolCount,
		steering: job.steering,
		mode: job.mode ?? "single",
		...(job.context ? { context: job.context } : {}),
		...(job.cwd ? { cwd: job.cwd } : {}),
		startedAt,
		...(job.updatedAt !== undefined ? { lastUpdate: job.updatedAt } : {}),
		...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
		...(job.deadlineAt !== undefined ? { deadlineAt: job.deadlineAt } : {}),
		...(job.timedOut !== undefined ? { timedOut: job.timedOut } : {}),
		...(job.stopped !== undefined ? { stopped: job.stopped } : {}),
		...(job.turnBudget ? { turnBudget: job.turnBudget } : {}),
		...(job.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: job.turnBudgetExceeded } : {}),
		...(job.wrapUpRequested !== undefined ? { wrapUpRequested: job.wrapUpRequested } : {}),
		...(job.currentStep !== undefined ? { currentStep: job.currentStep } : {}),
		...(job.chainStepCount !== undefined ? { chainStepCount: job.chainStepCount } : {}),
		...(job.parallelGroups?.length ? { parallelGroups: job.parallelGroups } : {}),
		steps: (job.steps ?? job.agents?.map((agent, index) => ({ agent, index, status: job.status === "queued" ? "pending" as const : job.status })) ?? []).map((step, index) => ({
			...step,
			index: step.index ?? index,
		})),
		...(job.sessionDir ? { sessionDir: job.sessionDir } : {}),
		...(job.outputFile ? { outputFile: job.outputFile } : {}),
		...(job.totalTokens ? { totalTokens: job.totalTokens } : {}),
		...(job.sessionFile ? { sessionFile: job.sessionFile } : {}),
		...(job.nestedChildren?.length ? { nestedChildren: job.nestedChildren } : {}),
	};
}

function asyncItems(run: AsyncRunSummary, description?: string): FleetItem[] {
	const updatedAt = run.lastUpdate ?? run.endedAt ?? run.startedAt;
	if (run.steps.length === 0 || run.mode === "workflow") {
		return [{ key: `async:${run.id}`, kind: "async", runId: run.id, agent: run.mode, state: run.state, updatedAt, run, ...(description ? { description } : {}) }];
	}
	return run.steps.map((step) => ({
		key: `async:${run.id}:${step.index}`,
		kind: "async" as const,
		runId: run.id,
		index: step.index,
		agent: step.label ? `${step.label} (${step.agent})` : step.agent,
		state: step.status,
		updatedAt: step.lastActivityAt ?? updatedAt,
		run,
		step,
		...(description ? { description } : {}),
	}));
}

function orderFleetAsyncRuns(runs: AsyncRunSummary[], terminalLimit: number): AsyncRunSummary[] {
	const updatedAt = (run: AsyncRunSummary) => run.lastUpdate ?? run.endedAt ?? run.startedAt;
	const byNewest = (left: AsyncRunSummary, right: AsyncRunSummary) => updatedAt(right) - updatedAt(left);
	const active = runs.filter((run) => run.state === "queued" || run.state === "running").sort(byNewest);
	const terminal = runs.filter((run) => run.state !== "queued" && run.state !== "running").sort(byNewest);
	return [...active, ...terminal.slice(0, terminalLimit)];
}

export function collectFleetSnapshot(
	state: SubagentState,
	options: { asyncDirRoot?: string; resultsDir?: string; limit?: number } = {},
): FleetSnapshot {
	const items: FleetItem[] = [];
	const activeForegroundIds = new Set<string>();
	for (const control of [...state.foregroundControls.values()].sort((left, right) => right.updatedAt - left.updatedAt)) {
		activeForegroundIds.add(control.runId);
		if (control.activeChildren) {
			for (const child of [...control.activeChildren.values()].sort((left, right) => left.index - right.index)) {
				items.push({
					key: `foreground-active:${control.runId}:${child.index}`,
					kind: "foreground-active",
					runId: control.runId,
					index: child.index,
					agent: child.agent,
					state: "running",
					updatedAt: child.updatedAt,
					control,
					activeChild: child,
					...(child.description ? { description: child.description } : {}),
				});
			}
			continue;
		}
		items.push({
			key: `foreground-active:${control.runId}:${control.currentIndex ?? 0}`,
			kind: "foreground-active",
			runId: control.runId,
			...(control.currentIndex !== undefined ? { index: control.currentIndex } : {}),
			agent: control.currentAgent ?? control.mode,
			state: "running",
			updatedAt: control.updatedAt,
			control,
			...(control.description ? { description: control.description } : {}),
		});
	}

	let error: string | undefined;
	try {
		let runs: AsyncRunSummary[];
		const descriptions = new Map<string, string>();
		const tracked = [...(state.fleetJobs ?? state.asyncJobs).values()]
			.filter((job) => belongsToCurrentSession(job.sessionId, state.currentSessionId));
		const byUpdate = (left: AsyncJobState, right: AsyncJobState) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0);
		const active = tracked.filter((job) => job.status === "queued" || job.status === "running").sort(byUpdate);
		const recent = tracked.filter((job) => job.status !== "queued" && job.status !== "running").sort(byUpdate).slice(0, options.limit ?? MAX_RECENT_ASYNC_RUNS);
		const trackedRuns: AsyncRunSummary[] = [];
		for (const job of [...active, ...recent]) {
			try {
				trackedRuns.push(trackedJobSummary(job));
				if (job.description) descriptions.set(job.asyncId, job.description);
			} catch (cause) {
				error = `Failed to inspect async run '${job.asyncId}': ${cause instanceof Error ? cause.message : String(cause)}`;
			}
		}
		if (options.asyncDirRoot !== undefined) {
			const trackedIds = new Set(trackedRuns.map((run) => run.id));
			const history = listAsyncRuns(options.asyncDirRoot, {
				...(state.currentSessionId ? { sessionId: state.currentSessionId } : {}),
				entryLimit: MAX_FLEET_HISTORY_CANDIDATES,
				resultsDir: options.resultsDir ?? DIRS.results,
				reconcile: false,
			}).filter((run) => !trackedIds.has(run.id));
			runs = [...trackedRuns, ...history];
		} else {
			runs = trackedRuns;
		}
		for (const run of orderFleetAsyncRuns(runs, options.limit ?? MAX_RECENT_ASYNC_RUNS)) {
			items.push(...asyncItems(run, descriptions.get(run.id)));
		}
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}

	const recentForeground = [...(state.foregroundRuns?.values() ?? [])]
		.filter((run) => belongsToCurrentSession(run.sessionId, state.currentSessionId) && !activeForegroundIds.has(run.runId))
		.sort((left, right) => right.updatedAt - left.updatedAt);
	for (const run of recentForeground) {
		for (const child of run.children) {
			items.push({
				key: `foreground-recent:${run.runId}:${child.index}`,
				kind: "foreground-recent",
				runId: run.runId,
				index: child.index,
				agent: child.agent,
				state: child.status,
				updatedAt: child.updatedAt ?? run.updatedAt,
				run,
				child,
			});
		}
	}
	return { items, ...(error ? { error } : {}) };
}

function statusGlyph(item: FleetItem, theme: Theme): string {
	if (item.state === "running") return theme.fg("accent", "●");
	if (item.state === "queued" || item.state === "pending") return theme.fg("muted", "◦");
	if (item.state === "complete" || item.state === "completed") return theme.fg("success", "✓");
	if (item.state === "paused" || item.state === "stopped" || item.state === "detached") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function foregroundActiveDetail(item: Extract<FleetItem, { kind: "foreground-active" }>): string[] {
	const { control } = item;
	const live = item.activeChild ?? control;
	const modelThinking = formatModelThinking(live.model, live.thinking);
	const lines = [
		`Run: ${item.runId}`,
		"Source: foreground",
		`State: running`,
		`Mode: ${control.mode}`,
		item.index !== undefined ? `Child: ${item.index} (${item.agent})` : `Agent: ${item.agent}`,
		modelThinking ? `Model: ${modelThinking}` : undefined,
		`Started: ${new Date(live.startedAt).toISOString()}`,
		live.currentTool ? `Current tool: ${live.currentTool}${live.currentPath ? ` · ${shortenPath(live.currentPath)}` : ""}` : undefined,
		live.turnCount !== undefined ? `Turns: ${live.turnCount}` : undefined,
		live.toolCount !== undefined ? `Tools: ${live.toolCount}` : undefined,
		live.tokens !== undefined ? `Tokens: ${formatTokens(live.tokens)}` : undefined,
		"",
		"Transcript",
		"Live foreground output remains in the expanded subagent tool result. Persisted output and session paths appear here after the child settles.",
	];
	return lines.filter((line): line is string => line !== undefined);
}

function foregroundRecentDetail(item: Extract<FleetItem, { kind: "foreground-recent" }>): string[] {
	const { child, run } = item;
	const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
	const modelThinking = formatModelThinking(child.model, child.thinking);
	const lines = [
		`Run: ${item.runId}`,
		"Source: foreground",
		`State: ${child.status}`,
		`Mode: ${run.mode}`,
		`Child: ${child.index} (${child.agent})${contextModeLabel(child.context) ? ` ${contextModeLabel(child.context)}` : ""}`,
		modelThinking ? `Model: ${modelThinking}` : undefined,
		`Updated: ${new Date(child.updatedAt ?? run.updatedAt).toISOString()}`,
		outputPath ? `Output: ${outputPath}` : undefined,
		child.sessionFile ? `Session: ${child.sessionFile}` : undefined,
		child.transcriptPath ? `Transcript file: ${child.transcriptPath}` : undefined,
		child.error ? `Error: ${child.error}` : undefined,
		child.outputSaveError ? `Output warning: ${child.outputSaveError}` : undefined,
		child.transcriptError ? `Transcript warning: ${child.transcriptError}` : undefined,
		"",
		"Result transcript tail",
	];
	const outputLines = (child.finalOutput ?? "").split(/\r?\n/).filter((line) => line.trim()).slice(-TRANSCRIPT_LINES);
	lines.push(...(outputLines.length ? outputLines : ["(no recovered output available)"]));
	return lines.filter((line): line is string => line !== undefined);
}

function asyncDetail(item: Extract<FleetItem, { kind: "async" }>): string[] {
	const status = readStatus(item.run.asyncDir);
	if (status) {
		return formatAsyncRunTranscript(status, item.run.asyncDir, { index: item.index, lines: TRANSCRIPT_LINES }).split("\n");
	}
	const outputPath = item.index !== undefined ? path.join(item.run.asyncDir, `output-${item.index}.log`) : undefined;
	return [
		`Run: ${item.runId}`,
		"Source: async",
		`State: ${item.state}`,
		`Mode: ${item.run.mode}${contextModeLabel(item.run.context) ? ` ${contextModeLabel(item.run.context)}` : ""}`,
		item.index !== undefined ? `Child: ${item.index} (${item.agent})${contextModeLabel(item.step?.context) ? ` ${contextModeLabel(item.step?.context)}` : ""}` : `Agent: ${item.agent}${contextModeLabel(item.run.context) ? ` ${contextModeLabel(item.run.context)}` : ""}`,
		outputPath ? `Output: ${outputPath}` : undefined,
		item.step?.sessionFile ? `Session: ${item.step.sessionFile}` : item.run.sessionFile ? `Session: ${item.run.sessionFile}` : undefined,
		"",
		"Transcript",
		"(status is no longer available)",
	].filter((line): line is string => line !== undefined);
}

function detailLines(item: FleetItem | undefined, error: string | undefined): string[] {
	if (!item) return [error ? `Fleet scan failed: ${error}` : "No current-session foreground or recent async children.", "", "New runs appear here automatically while this inspector remains open."];
	const lines = item.kind === "foreground-active"
		? foregroundActiveDetail(item)
		: item.kind === "foreground-recent"
			? foregroundRecentDetail(item)
			: asyncDetail(item);
	if (error) lines.unshift(`Fleet scan warning: ${error}`, "");
	return lines;
}

function isActionableAsyncState(state: string): boolean {
	return state === "running" || state === "queued" || state === "pending";
}

function firstToolResultText(result: AgentToolResult<Details> | null, fallback: string): FleetActionResult {
	if (!result) return { text: fallback, isError: true };
	const text = result.content.find((item) => item.type === "text")?.text ?? fallback;
	return { text, ...(result.isError ? { isError: true } : {}) };
}

function uniquePaths(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => path.resolve(value)))];
}

function fleetArtifactsRoot(state: SubagentState, cwd: string): string {
	return getArtifactsDir(
		state.parentSessionFile ?? null,
		cwd,
		state.artifactDirPreference ?? "project",
	);
}

function transcriptTarget(item: FleetItem, state: SubagentState): { path: string; trustedRoots: string[] } | undefined {
	if (item.kind === "foreground-active") {
		const artifactsRoot = fleetArtifactsRoot(state, item.control.cwd ?? state.baseCwd);
		return {
			path: getArtifactPaths(artifactsRoot, item.runId, item.agent, item.index ?? 0).transcriptPath,
			trustedRoots: [artifactsRoot],
		};
	}
	if (item.kind === "foreground-recent") {
		if (!item.child.transcriptPath) return undefined;
		const transcriptPath = path.isAbsolute(item.child.transcriptPath)
			? item.child.transcriptPath
			: path.resolve(item.run.cwd, item.child.transcriptPath);
		return {
			path: transcriptPath,
			trustedRoots: uniquePaths([
				fleetArtifactsRoot(state, item.run.cwd),
				fleetArtifactsRoot(state, state.baseCwd),
			]),
		};
	}
	const step = item.step ?? (item.run.steps.length === 1 ? item.run.steps[0] : undefined);
	if (!step?.transcriptPath) return undefined;
	const transcriptPath = path.isAbsolute(step.transcriptPath)
		? step.transcriptPath
		: path.resolve(item.run.asyncDir, step.transcriptPath);
	const trackedJob = state.fleetJobs?.get(item.runId) ?? state.asyncJobs.get(item.runId);
	return {
		path: transcriptPath,
		trustedRoots: uniquePaths([
			item.run.asyncDir,
			fleetArtifactsRoot(state, state.baseCwd),
			trackedJob?.cwd ? fleetArtifactsRoot(state, trackedJob.cwd) : undefined,
		]),
	};
}

function itemContext(item: FleetItem): string | undefined {
	if (item.kind === "async") return contextModeLabel(item.step?.context ?? item.run.context);
	if (item.kind === "foreground-recent") return contextModeLabel(item.child.context);
	return undefined;
}

function itemMode(item: FleetItem): string {
	return item.kind === "foreground-active" ? item.control.mode : item.run.mode;
}

function itemSource(item: FleetItem): string {
	if (item.kind === "async") return "background";
	return item.kind === "foreground-active" ? "foreground · live" : "foreground · recent";
}

function itemStats(item: FleetItem): string[] {
	let model: string | undefined;
	let tokens: number | undefined;
	let tools: number | undefined;
	let durationMs: number | undefined;
	if (item.kind === "foreground-active") {
		const live = item.activeChild ?? item.control;
		model = formatModelThinking(live.model, live.thinking) || undefined;
		tokens = live.tokens;
		tools = live.toolCount;
		durationMs = Math.max(0, Date.now() - live.startedAt);
	} else if (item.kind === "foreground-recent") {
		model = formatModelThinking(item.child.model, item.child.thinking) || undefined;
		tokens = item.child.tokens;
		tools = item.child.toolCount;
	} else {
		model = formatModelThinking(item.step?.model, item.step?.thinking) || undefined;
		tokens = item.step?.tokens?.total ?? (item.index === undefined ? item.run.totalTokens?.total : undefined);
		tools = item.step?.toolCount ?? (item.index === undefined ? item.run.toolCount : undefined);
		const terminalRun = item.state !== "queued" && item.state !== "running" && item.state !== "pending";
		const endTime = item.run.endedAt ?? (terminalRun ? item.run.lastUpdate : undefined) ?? Date.now();
		durationMs = item.step?.durationMs ?? Math.max(0, endTime - item.run.startedAt);
	}
	return [
		model,
		tokens !== undefined ? `${formatTokens(tokens)} tok` : undefined,
		tools !== undefined ? `${tools} tool${tools === 1 ? "" : "s"}` : undefined,
		durationMs !== undefined ? formatDuration(durationMs) : undefined,
	].filter((value): value is string => Boolean(value));
}

function structuredHeader(item: FleetItem, width: number, theme: Theme, conversationState: string): string[] {
	const lines: string[] = [];
	lines.push(rightAligned(` ${statusGlyph(item, theme)} ${theme.bold(item.agent)}`, theme.fg("dim", item.state), width));
	const child = item.index !== undefined ? ` · child ${item.index + 1}` : "";
	const context = itemContext(item);
	const identity = `${itemSource(item)} · ${item.runId.slice(0, 8)}${child} · ${itemMode(item)}${context ? ` ${context}` : ""}`;
	lines.push(`  ${theme.fg("dim", identity)}`);
	const stats = itemStats(item);
	if (stats.length) lines.push(`  ${theme.fg("muted", stats.join(" · "))}`);
	if (item.description) {
		const task = item.description.replace(/\s+/g, " ").trim();
		lines.push(`  ${theme.fg("dim", "Task")}  ${task}`);
	}
	lines.push(`${theme.fg("accent", "Conversation")} ${theme.fg("dim", `· ${conversationState}`)}`);
	return lines.map((line) => truncateToWidth(line, width));
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	return fit(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

interface FleetDetailSections {
	header: string[];
	body: string[];
}

interface FleetTranscriptCache {
	path: string;
	fingerprint: string;
	width: number;
	expandedTools: boolean;
	transcript: FleetTranscript;
	body: string[];
}

function transcriptFingerprint(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

export class SubagentFleetComponent implements Component {
	private snapshot: FleetSnapshot = { items: [] };
	private selected = 0;
	private selectedKey: string | undefined;
	private detailScroll = 0;
	private detailAutoFollow = true;
	private detailLineCount = 0;
	private detailViewportHeight = 8;
	private bodyHeight = 8;
	private expandedTools = false;
	private actionNotice: FleetActionResult | undefined;
	private steerDraft: string | undefined;
	private steerMode: SteerDeliveryMode = "steer";
	private stopConfirming = false;
	private actionBusy = false;
	private transcriptCache: FleetTranscriptCache | undefined;
	private disposed = false;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly tui: FleetTui;
	private readonly theme: Theme;
	private readonly markdownTheme: MarkdownTheme;
	private readonly state: SubagentState;
	private readonly done: (result: undefined) => void;
	private readonly options: FleetViewOptions;

	constructor(
		tui: FleetTui,
		theme: Theme,
		state: SubagentState,
		done: (result: undefined) => void,
		options: FleetViewOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.markdownTheme = options.markdownTheme ?? getMarkdownTheme();
		this.state = state;
		this.done = done;
		this.options = options;
		this.selectedKey = options.initialKey;
		this.refresh();
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.invalidate();
			this.tui.requestRender();
		}, options.refreshMs ?? REFRESH_MS);
		this.timer.unref?.();
	}

	private refresh(): void {
		const previousKey = this.snapshot.items[this.selected]?.key ?? this.selectedKey;
		this.snapshot = collectFleetSnapshot(this.state, this.options);
		const preserved = previousKey ? this.snapshot.items.findIndex((item) => item.key === previousKey) : -1;
		this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.snapshot.items.length - 1));
		this.selectedKey = this.snapshot.items[this.selected]?.key;
	}

	private moveSelection(delta: number): void {
		if (this.snapshot.items.length === 0) return;
		this.selected = Math.max(0, Math.min(this.snapshot.items.length - 1, this.selected + delta));
		this.selectedKey = this.snapshot.items[this.selected]?.key;
		this.detailAutoFollow = true;
		this.resetActionInput();
		this.tui.requestRender();
	}

	private resetActionInput(): void {
		this.steerDraft = undefined;
		this.steerMode = "steer";
		this.stopConfirming = false;
	}

	private selectedAsyncAction(): { item: Extract<FleetItem, { kind: "async" }> } | { reason: string } {
		const item = this.snapshot.items[this.selected];
		if (!item) return { reason: "No child is selected." };
		if (item.kind !== "async") return { reason: "Fleet controls are available for current-session top-level async runs only." };
		if (!isActionableAsyncState(item.run.state) || !isActionableAsyncState(item.state)) return { reason: `Selected child is ${item.state}; controls require a running or queued async child.` };
		return { item };
	}

	private actionLines(): string[] {
		const lines: string[] = [];
		if (this.actionBusy) lines.push(this.theme.fg("accent", "Action pending..."));
		if (this.steerDraft !== undefined) {
			lines.push(this.theme.fg("accent", `Steer message (${this.steerMode}): ${this.steerDraft}${this.theme.fg("dim", "▌")}`));
			lines.push(this.theme.fg("dim", "Enter sends · Tab changes mode · Esc cancels · Backspace edits"));
		} else if (this.stopConfirming) {
			const selected = this.snapshot.items[this.selected];
			lines.push(this.theme.fg("warning", `Confirm stop for async run ${selected?.runId ?? "selected run"}?`));
			lines.push(this.theme.fg("dim", "Stop ends the run; use interrupt for a resumable pause. Enter/Y confirms · N returns · Esc cancels"));
		} else if (this.actionNotice) {
			lines.push(this.theme.fg(this.actionNotice.isError ? "error" : "success", this.actionNotice.text));
		}
		return lines;
	}

	private withActionLines(body: string[]): string[] {
		const actionLines = this.actionLines();
		return actionLines.length ? [...actionLines, "", ...body] : body;
	}

	private setActionNotice(result: FleetActionResult): void {
		this.actionNotice = result;
		this.resetActionInput();
		this.detailAutoFollow = false;
		this.detailScroll = 0;
		this.refresh();
		this.tui.requestRender();
	}

	private runAction(action: () => Promise<FleetActionResult>): void {
		if (this.actionBusy) return;
		this.actionBusy = true;
		this.actionNotice = undefined;
		this.tui.requestRender();
		void action()
			.then((result) => this.setActionNotice(result))
			.catch((error) => this.setActionNotice({ text: error instanceof Error ? error.message : String(error), isError: true }))
			.finally(() => {
				this.actionBusy = false;
				if (!this.disposed) this.tui.requestRender();
			});
	}

	private scrollDetail(delta: number): void {
		const maxScroll = Math.max(0, this.detailLineCount - this.detailViewportHeight);
		this.detailScroll = Math.max(0, Math.min(maxScroll, this.detailScroll + delta));
		this.detailAutoFollow = this.detailScroll >= maxScroll;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.steerDraft !== undefined) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.resetActionInput();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "return") || data === "\r" || data === "\n") {
				const message = this.steerDraft.trim();
				if (!message) {
					this.setActionNotice({ text: "Steer message cannot be empty.", isError: true });
					return;
				}
				const target = this.selectedAsyncAction();
				if ("reason" in target || !this.options.actions) {
					this.setActionNotice({ text: "reason" in target ? target.reason : "Fleet controls are unavailable in this context.", isError: true });
					return;
				}
				this.runAction(() => this.options.actions!.steer({ runId: target.item.runId, asyncDir: target.item.run.asyncDir, ...(target.item.index !== undefined ? { index: target.item.index } : {}), message, mode: this.steerMode }));
				return;
			}
			if (matchesKey(data, "tab") || data === "\t") {
				const modes: SteerDeliveryMode[] = ["steer", "follow_up", "auto"];
				this.steerMode = modes[(modes.indexOf(this.steerMode) + 1) % modes.length]!;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f") {
				this.steerDraft = this.steerDraft.slice(0, -1);
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.steerDraft += data;
				this.tui.requestRender();
			}
			return;
		}
		if (this.stopConfirming) {
			if (matchesKey(data, "return") || data.toLowerCase() === "y") {
				const target = this.selectedAsyncAction();
				if ("reason" in target || !this.options.actions) {
					this.setActionNotice({ text: "reason" in target ? target.reason : "Fleet controls are unavailable in this context.", isError: true });
					return;
				}
				this.runAction(() => Promise.resolve(this.options.actions!.stop({ runId: target.item.runId, asyncDir: target.item.run.asyncDir, ...(target.item.index !== undefined ? { index: target.item.index } : {}) })));
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data.toLowerCase() === "n" || matchesKey(data, "backspace")) {
				this.resetActionInput();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.shift("k"))) return this.scrollDetail(-1);
		if (matchesKey(data, Key.shift("j"))) return this.scrollDetail(1);
		if (matchesKey(data, "up") || matchesKey(data, "k")) return this.moveSelection(-1);
		if (matchesKey(data, "down") || matchesKey(data, "j")) return this.moveSelection(1);
		if (matchesKey(data, "home")) return this.moveSelection(-this.snapshot.items.length);
		if (matchesKey(data, "end")) return this.moveSelection(this.snapshot.items.length);
		if (matchesKey(data, "pageUp")) return this.scrollDetail(-this.detailViewportHeight);
		if (matchesKey(data, "pageDown")) return this.scrollDetail(this.detailViewportHeight);
		if (data.toLowerCase() === "r") {
			this.transcriptCache = undefined;
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (data === "s") {
			const target = this.selectedAsyncAction();
			if ("reason" in target || !this.options.actions) this.setActionNotice({ text: "reason" in target ? target.reason : "Fleet controls are unavailable in this context.", isError: true });
			else {
				this.actionNotice = undefined;
				this.steerDraft = "";
				this.detailAutoFollow = false;
				this.detailScroll = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (data === "H") {
			const target = this.selectedAsyncAction();
			if ("reason" in target || !this.options.actions?.inspect) this.setActionNotice({ text: "reason" in target ? target.reason : "Herdr inspector controls are unavailable in this context.", isError: true });
			else this.runAction(() => this.options.actions!.inspect!({ runId: target.item.runId, asyncDir: target.item.run.asyncDir, ...(target.item.index !== undefined ? { index: target.item.index } : {}) }));
			return;
		}
		if (data === "D") {
			const target = this.selectedAsyncAction();
			if ("reason" in target || !this.options.actions) this.setActionNotice({ text: "reason" in target ? target.reason : "Fleet controls are unavailable in this context.", isError: true });
			else {
				this.actionNotice = undefined;
				this.stopConfirming = true;
				this.detailAutoFollow = false;
				this.detailScroll = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (data.toLowerCase() === "x" || matchesKey(data, "ctrl+o")) {
			this.expandedTools = !this.expandedTools;
			this.transcriptCache = undefined;
			this.tui.requestRender();
		}
	}

	private rosterLines(width: number): string[] {
		if (this.snapshot.items.length === 0) return [this.theme.fg("dim", "No tracked children")];
		const start = Math.max(0, Math.min(this.selected - this.bodyHeight + 1, Math.max(0, this.snapshot.items.length - this.bodyHeight)));
		return this.snapshot.items.slice(start, start + this.bodyHeight).map((item, offset) => {
			const index = start + offset;
			const marker = index === this.selected ? this.theme.fg("accent", "›") : " ";
			const context = item.kind === "async" ? contextModeBadge(this.theme, item.step?.context ?? item.run.context) : item.kind === "foreground-recent" ? contextModeBadge(this.theme, item.child.context) : "";
			const agent = index === this.selected ? this.theme.bold(item.agent) : item.agent;
			const identity = item.description?.replace(/\s+/g, " ").trim() || item.runId.slice(0, 8);
			const left = `${marker} ${statusGlyph(item, this.theme)} ${agent}${context} ${this.theme.fg("dim", `· ${identity}`)}`;
			return rightAligned(left, this.theme.fg("dim", item.state), width);
		});
	}

	private renderedTranscript(target: { path: string; trustedRoots: string[] }, width: number): { transcript: FleetTranscript; body: string[] } {
		const fingerprint = `${target.trustedRoots.join("\0")}|${transcriptFingerprint(target.path)}`;
		if (this.transcriptCache
			&& this.transcriptCache.path === target.path
			&& this.transcriptCache.fingerprint === fingerprint
			&& this.transcriptCache.width === width
			&& this.transcriptCache.expandedTools === this.expandedTools) {
			return { transcript: this.transcriptCache.transcript, body: [...this.transcriptCache.body] };
		}
		const transcript = readFleetTranscript(target.path, { trustedRoots: target.trustedRoots });
		const body = transcript.events.length > 0
			? renderFleetTranscript(transcript, width, this.theme, this.markdownTheme, { expandedTools: this.expandedTools })
			: [];
		this.transcriptCache = { path: target.path, fingerprint, width, expandedTools: this.expandedTools, transcript, body };
		return { transcript, body: [...body] };
	}

	private wrappedDetail(width: number): FleetDetailSections {
		const selected = this.snapshot.items[this.selected];
		let transcriptWarning: string | undefined;
		if (selected) {
			const target = transcriptTarget(selected, this.state);
			if (target) {
				const { transcript, body } = this.renderedTranscript(target, width);
				transcriptWarning = transcript.warning;
				if (transcript.events.length > 0) {
					if (this.snapshot.error) body.unshift(this.theme.fg("warning", `Fleet scan warning: ${this.snapshot.error}`), "");
					const latest = transcript.events.at(-1);
					const conversationState = latest?.kind === "assistant"
						? "assistant response"
						: latest?.kind === "user"
							? "supervisor message"
							: latest?.kind === "tool"
								? `${latest.name} · ${latest.status}`
								: "activity";
					return { header: structuredHeader(selected, width, this.theme, conversationState), body: this.withActionLines(body) };
				}
			}
		}

		const raw = detailLines(selected, this.snapshot.error);
		if (transcriptWarning) raw.unshift(`Transcript preview warning: ${transcriptWarning}`, "");
		const lines: string[] = [];
		for (const line of raw) {
			const styled = /^(Run|State|Mode|Source|Child|Agent|Model):/.test(line)
				? this.theme.bold(line)
				: /^(Transcript|Result transcript tail)/.test(line)
					? this.theme.fg("accent", line)
					: /^(Output|Session|Transcript file|Artifacts):/.test(line)
						? this.theme.fg("muted", line)
						: /^Transcript preview warning:/.test(line)
							? this.theme.fg("warning", line)
							: line;
			const wrapped = wrapTextWithAnsi(styled, Math.max(1, width));
			lines.push(...(wrapped.length ? wrapped : [""]));
		}
		return { header: [], body: this.withActionLines(lines) };
	}

	render(width: number): string[] {
		if (width < 36) return [truncateToWidth("Subagent fleet needs at least 36 columns. Esc closes.", width)];
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 32;
		this.bodyHeight = Math.max(2, Math.floor(rows * 0.85) - 6);
		const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.38)));
		const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
		const roster = this.rosterLines(rosterWidth);
		const detail = this.wrappedDetail(detailWidth);
		const detailHeader = detail.header.slice(0, Math.max(0, this.bodyHeight - 1));
		this.detailViewportHeight = Math.max(1, this.bodyHeight - detailHeader.length);
		this.detailLineCount = detail.body.length;
		const maxDetailScroll = Math.max(0, detail.body.length - this.detailViewportHeight);
		if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
		else if (this.detailScroll > maxDetailScroll) this.detailScroll = maxDetailScroll;
		const visibleDetails = [
			...detailHeader,
			...detail.body.slice(this.detailScroll, this.detailScroll + this.detailViewportHeight),
		];
		const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
		const selected = this.snapshot.items[this.selected];
		const title = ` ${this.theme.bold("Subagent fleet inspector")} ${this.theme.fg("dim", "· live controls")}`;
		const selectedStatus = selected
			? `${statusGlyph(selected, this.theme)} ${selected.agent} · ${selected.state} `
			: this.theme.fg("dim", "no children ");
		lines.push(this.theme.fg("border", "│") + rightAligned(title, selectedStatus, innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
		for (let index = 0; index < this.bodyHeight; index++) {
			lines.push(
				this.theme.fg("border", "│")
				+ fit(roster[index] ?? "", rosterWidth)
				+ this.theme.fg("border", "│")
				+ fit(visibleDetails[index] ?? "", detailWidth)
				+ this.theme.fg("border", "│"),
			);
		}
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
		const position = this.snapshot.items.length ? `${this.selected + 1}/${this.snapshot.items.length}` : "0/0";
		const footer = ` ↑↓/jk agent · H Herdr · s steer · D stop · x/Ctrl+O tools · r refresh · Esc close · ${position}`;
		lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", footer), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.transcriptCache = undefined;
		this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}

export async function openSubagentFleet(ctx: ExtensionContext, state: SubagentState, options: FleetViewOptions = {}): Promise<void> {
	const wasOpen = state.fleetInspectorOpen === true;
	state.fleetInspectorOpen = true;
	if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
	const actions = options.actions ?? {
		steer: async (input: { runId: string; asyncDir: string; index?: number; message: string; mode: SteerDeliveryMode }) => firstToolResultText(await steerAsyncRun({
			state,
			runId: input.runId,
			...(input.index !== undefined ? { index: input.index } : {}),
			message: input.message,
			mode: input.mode,
			location: { asyncDir: input.asyncDir, resolvedId: input.runId } as Parameters<typeof steerAsyncRun>[0]["location"],
		}), `Failed to steer async run ${input.runId}.`),
		stop: (input: { runId: string; asyncDir: string; index?: number }) => firstToolResultText(stopAsyncRun(state, input.runId, undefined, { asyncDir: input.asyncDir, resolvedId: input.runId }), `Failed to stop async run ${input.runId}.`),
		inspect: async (input: { runId: string; asyncDir: string; index?: number }) => firstToolResultText(await handleHerdrInspectorAction("inspector.open", {
			id: input.runId,
			dir: input.asyncDir,
			...(input.index !== undefined ? { index: input.index } : {}),
		}, {
			state,
			cwd: state.baseCwd,
			...(state.authorityPolicy ? { authorityPolicy: state.authorityPolicy } : {}),
			...(state.missionStoreConfig ? { missions: state.missionStoreConfig } : {}),
		}), `Failed to open Herdr inspector for async run ${input.runId}.`),
	} satisfies FleetActionHandlers;
	try {
		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) => new SubagentFleetComponent(tui, theme, state, done, { ...options, actions }),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
			},
		);
	} finally {
		state.fleetInspectorOpen = wasOpen;
	}
}
