import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { snapshotExternalRuns, type ExternalRun } from "../api/external-runs.ts";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.ts";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../shared/formatters.ts";
import { DIRS, type AsyncJobState, type Details, type FleetKeybindingAction, type FleetKeybindingsConfig, type ForegroundChildControl, type ForegroundResumeChild, type ForegroundResumeRun, type ForegroundRunControl, type SubagentState } from "../shared/types.ts";
import { decodeUtf8Tail } from "../shared/utf8.ts";
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
import { getLivePromptAudit, type LivePromptAudit, type PromptAuditView } from "../runs/foreground/prompt-audit.ts";

const REFRESH_MS = 750;
const MIN_REFRESH_MS = 250;
const MAX_RECENT_ASYNC_RUNS = 20;
const MAX_FLEET_HISTORY_CANDIDATES = 100;
const TRANSCRIPT_LINES = 200;
const OUTPUT_TAIL_BYTES = 64 * 1024;
const PROMPT_AUDIT_SUMMARY_WIDTH = 160;

export const DEFAULT_FLEET_KEYBINDINGS: Record<FleetKeybindingAction, string[]> = {
	close: ["escape", "ctrl+c", "q"],
	scrollUp: ["K"],
	scrollDown: ["J"],
	selectUp: ["up", "k"],
	selectDown: ["down", "j"],
	selectFirst: ["home"],
	selectLast: ["end"],
	pageUp: ["pageUp"],
	pageDown: ["pageDown"],
	refresh: ["r", "R"],
	steer: ["s"],
	inspect: ["H"],
	stop: ["D"],
	toggleTools: ["x", "X", "ctrl+o"],
};

type ResolvedFleetKeybindings = Record<FleetKeybindingAction, string[]>;

export function resolveFleetKeybindings(config: FleetKeybindingsConfig | undefined): ResolvedFleetKeybindings {
	return Object.fromEntries(
		Object.entries(DEFAULT_FLEET_KEYBINDINGS).map(([action, defaults]) => [action, config?.[action as FleetKeybindingAction] ?? defaults]),
	) as ResolvedFleetKeybindings;
}

function matchesFleetBinding(data: string, binding: string): boolean {
	const key = /^[A-Z]$/.test(binding) ? `shift+${binding.toLowerCase()}` : binding;
	return matchesKey(data, key as Parameters<typeof matchesKey>[1]);
}

function matchesFleetAction(data: string, bindings: ResolvedFleetKeybindings, action: FleetKeybindingAction): boolean {
	return bindings[action].some((binding) => matchesFleetBinding(data, binding));
}

function bindingLabel(bindings: ResolvedFleetKeybindings, action: FleetKeybindingAction): string {
	return bindings[action]
		.map((binding) => binding === "up" ? "↑" : binding === "down" ? "↓" : binding === "escape" ? "Esc" : binding === "return" ? "Enter" : binding)
		.join("/");
}

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
	| { key: string; kind: "external"; runId: string; agent: string; state: ExternalRun["state"]; updatedAt: number; run: ExternalRun }
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
	redoPrompt?(input: { runId: string; index: number; guidance: string; control?: ForegroundRunControl }): Promise<FleetActionResult>;
}

export interface FleetViewOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	refreshMs?: number;
	initialKey?: string;
	markdownTheme?: MarkdownTheme;
	fleetKeybindings?: FleetKeybindingsConfig;
	actions?: FleetActionHandlers;
	copyText?: (text: string) => Promise<void> | void;
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
	const trackedJobs = state.fleetJobs ?? state.asyncJobs;
	const workflowParentIds = new Set([...trackedJobs.values()]
		.filter((job) => job.mode === "workflow" && belongsToCurrentSession(job.sessionId, state.currentSessionId))
		.map((job) => job.asyncId));
	for (const control of [...state.foregroundControls.values()].sort((left, right) => right.updatedAt - left.updatedAt)) {
		activeForegroundIds.add(control.runId);
		if (control.parentWorkflowRunId && workflowParentIds.has(control.parentWorkflowRunId)) continue;
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
		const tracked = [...trackedJobs.values()]
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

	if (state.currentSessionId) {
		try {
			for (const run of snapshotExternalRuns(state.currentSessionId, { ignoreMalformed: true, onMalformedRecord: (message) => console.warn(`[pi-subagents] Removed ${message}`) })) {
				items.push({
					key: `external:${run.id}`,
					kind: "external",
					runId: run.id,
					agent: run.label,
					state: run.state,
					updatedAt: run.updatedAt ?? run.endedAt ?? run.startedAt,
					run,
					...(run.currentAction ? { description: run.currentAction } : {}),
				});
			}
		} catch (cause) {
			const message = `Failed to inspect external jobs: ${cause instanceof Error ? cause.message : String(cause)}`;
			error = error ? `${error}; ${message}` : message;
		}
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

function visibleWorkflowParentKeyForForegroundKey(state: SubagentState, key: string, items: FleetItem[]): string | undefined {
	for (const control of state.foregroundControls.values()) {
		if (!control.parentWorkflowRunId) continue;
		let matches = false;
		if (control.activeChildren) {
			for (const child of control.activeChildren.values()) {
				if (`foreground-active:${control.runId}:${child.index}` === key) {
					matches = true;
					break;
				}
			}
		} else {
			matches = `foreground-active:${control.runId}:${control.currentIndex ?? 0}` === key;
		}
		if (!matches) continue;
		const parentKey = `async:${control.parentWorkflowRunId}`;
		return items.some((item) => item.key === parentKey) ? parentKey : undefined;
	}
	return undefined;
}

function statusGlyph(item: FleetItem, theme: Theme): string {
	if (item.state === "running") return theme.fg("accent", "●");
	if (item.state === "queued" || item.state === "pending") return theme.fg("muted", "◦");
	if (item.state === "complete" || item.state === "completed") return theme.fg("success", "✓");
	if (item.state === "paused" || item.state === "stopped" || item.state === "detached") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function foregroundPromptAuditCount(item: Extract<FleetItem, { kind: "foreground-active" }>, state: SubagentState): number {
	if (!state.currentSessionId || item.control.sessionId !== state.currentSessionId) return 0;
	if (!item.control.activeChildren) return getLivePromptAudit(item.control, item.index ?? 0) ? 1 : 0;
	return [...item.control.activeChildren.keys()].filter((index) => getLivePromptAudit(item.control, index)).length;
}

function authoredPromptSummary(text: string): string | undefined {
	const summary = text.replace(/\s+/g, " ").trim();
	return summary ? truncateToWidth(summary, PROMPT_AUDIT_SUMMARY_WIDTH, "…") : undefined;
}

function foregroundAuthoredPromptSummary(item: Extract<FleetItem, { kind: "foreground-active" }>, state: SubagentState): string | undefined {
	if (!state.currentSessionId || item.control.sessionId !== state.currentSessionId) return undefined;
	const prompt = getLivePromptAudit(item.control, item.index ?? 0);
	return prompt ? authoredPromptSummary(prompt.authoredTask) : undefined;
}

function promptAuditText(prompt: LivePromptAudit, view: PromptAuditView): string {
	switch (view) {
		case "authored": return prompt.authoredTask;
		case "runtime": return prompt.runtimeAdditions;
		case "effective": return prompt.finalEffectivePrompt;
	}
}

function promptAuditViewLabel(view: PromptAuditView): string {
	switch (view) {
		case "authored": return "[1] Authored task";
		case "runtime": return "[2] Runtime additions";
		case "effective": return "[3] Final effective prompt";
	}
}

function foregroundActiveDetail(item: Extract<FleetItem, { kind: "foreground-active" }>, state: SubagentState): string[] {
	const { control } = item;
	const live = item.activeChild ?? control;
	const modelThinking = formatModelThinking(live.model, live.thinking);
	const promptAuditCount = foregroundPromptAuditCount(item, state);
	const promptSummary = foregroundAuthoredPromptSummary(item, state);
	const lines = [
		`Run: ${item.runId}`,
		"Source: foreground",
		`State: running`,
		`Mode: ${control.mode}`,
		control.parentWorkflowRunId ? `Workflow child of: ${control.parentWorkflowRunId}${control.workflowKey ? ` (${control.workflowKey})` : ""}` : undefined,
		control.sourceRunId ? `Redo source: ${control.sourceRunId}` : undefined,
		control.supersededByRunId ? `Superseded by: ${control.supersededByRunId}` : undefined,
		item.index !== undefined ? `Child: ${item.index} (${item.agent})` : `Agent: ${item.agent}`,
		modelThinking ? `Model: ${modelThinking}` : undefined,
		promptSummary ? `Task: ${promptSummary}` : undefined,
		`Started: ${new Date(live.startedAt).toISOString()}`,
		live.currentTool ? `Current tool: ${live.currentTool}${live.currentPath ? ` · ${shortenPath(live.currentPath)}` : ""}` : undefined,
		live.turnCount !== undefined ? `Turns: ${live.turnCount}` : undefined,
		live.toolCount !== undefined ? `Tools: ${live.toolCount}` : undefined,
		live.tokens !== undefined ? `Tokens: ${formatTokens(live.tokens)}` : undefined,
		promptAuditCount > 0 ? `Prompt audit: ${promptAuditCount} live · 3 views · p opens` : undefined,
		"",
		"Transcript",
		"Live foreground output remains in the expanded subagent tool result. Persisted output and session paths appear here after the child settles.",
	];
	return lines.filter((line): line is string => line !== undefined);
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function trustedFileTail(filePath: string, trustedRoots: string[]): { text?: string; warning?: string; unavailable?: string } {
	const resolvedPath = path.resolve(filePath);
	if (trustedRoots.length === 0 || !trustedRoots.some((root) => pathWithin(root, resolvedPath))) return { warning: `output artifact is outside trusted roots: ${filePath}` };
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolvedPath);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { unavailable: `output artifact unavailable: ${filePath}` };
		return { warning: `output artifact could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (stat.isSymbolicLink()) return { warning: `output artifact refused a symlink: ${filePath}` };
	if (!stat.isFile()) return { warning: `output artifact is not a file: ${filePath}` };
	try {
		const realPath = fs.realpathSync(resolvedPath);
		const realRoots = trustedRoots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
		if (!realRoots.some((root) => pathWithin(root, realPath))) return { warning: `output artifact resolves outside trusted roots: ${filePath}` };
		const fd = fs.openSync(realPath, "r");
		try {
			const bytes = Math.min(stat.size, OUTPUT_TAIL_BYTES);
			const buffer = Buffer.alloc(bytes);
			fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
			return { text: decodeUtf8Tail(buffer) };
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		return { warning: `output artifact could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function foregroundRecentOutputLines(item: Extract<FleetItem, { kind: "foreground-recent" }>, state: SubagentState): string[] {
	const outputPath = item.child.artifactPaths?.outputPath ?? item.child.savedOutputPath;
	const output = item.child.finalOutput
		? { text: item.child.finalOutput }
		: outputPath
			? trustedFileTail(path.isAbsolute(outputPath) ? outputPath : path.resolve(item.run.cwd, outputPath), uniquePaths([
				fleetArtifactsRoot(state, item.run.cwd),
				fleetArtifactsRoot(state, state.baseCwd),
			]))
			: undefined;
	if (output?.warning) return [`(${output.warning})`];
	if (output?.unavailable) return [`(${output.unavailable})`];
	const outputLines = (output?.text ?? "").split(/\r?\n/).filter((line) => line.trim()).slice(-TRANSCRIPT_LINES);
	return outputLines.length ? outputLines : ["(no recovered output available)"];
}

function foregroundRecentDetail(item: Extract<FleetItem, { kind: "foreground-recent" }>, state: SubagentState): string[] {
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
	lines.push(...foregroundRecentOutputLines(item, state));
	return lines.filter((line): line is string => line !== undefined);
}

function externalElapsedEnd(run: ExternalRun): number {
	const terminal = run.state !== "queued" && run.state !== "running";
	return terminal ? (run.endedAt ?? run.updatedAt ?? Date.now()) : Date.now();
}

function asyncDetail(item: Extract<FleetItem, { kind: "async" }>, state: SubagentState): string[] {
	const status = readStatus(item.run.asyncDir);
	if (status) {
		const trackedJob = state.fleetJobs?.get(item.runId) ?? state.asyncJobs.get(item.runId);
		return formatAsyncRunTranscript(status, item.run.asyncDir, {
			index: item.index,
			lines: TRANSCRIPT_LINES,
			sessionRoots: uniquePaths([...(state.trustedSessionRoots ?? []), trackedJob?.sessionRoot]),
		}).split("\n");
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

function externalDetail(item: Extract<FleetItem, { kind: "external" }>): string[] {
	return [
		`Run: ${item.runId}`,
		"Source: external · display-only",
		`Owner: ${item.run.source}`,
		`State: ${item.state}`,
		`Started: ${new Date(item.run.startedAt).toISOString()}`,
		item.run.updatedAt !== undefined ? `Updated: ${new Date(item.run.updatedAt).toISOString()}` : undefined,
		item.run.endedAt !== undefined ? `Ended: ${new Date(item.run.endedAt).toISOString()}` : undefined,
		`Elapsed: ${formatDuration(Math.max(0, externalElapsedEnd(item.run) - item.run.startedAt))}`,
		item.run.currentAction ? `Current action: ${item.run.currentAction}` : undefined,
		item.run.reportPath ? `Report path: ${item.run.reportPath}` : undefined,
		item.run.transcriptPath ? `Transcript path: ${item.run.transcriptPath}` : undefined,
		"",
		"Preview",
		item.run.preview ?? "(no preview supplied)",
		"",
		"The owning extension controls execution, persistence, cancellation, and results.",
	].filter((line): line is string => line !== undefined);
}

function detailLines(item: FleetItem | undefined, error: string | undefined, state: SubagentState): string[] {
	if (!item) return [error ? `Fleet scan failed: ${error}` : "No current-session Fleet jobs.", "", "New jobs appear here automatically while this inspector remains open."];
	const lines = item.kind === "foreground-active"
		? foregroundActiveDetail(item, state)
		: item.kind === "foreground-recent"
			? foregroundRecentDetail(item, state)
			: item.kind === "external"
				? externalDetail(item)
				: asyncDetail(item, state);
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
		state.artifactDirPreference,
	);
}

function transcriptTarget(item: FleetItem, state: SubagentState): { path: string; trustedRoots: string[] } | undefined {
	if (item.kind === "external") return undefined;
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
			item.run.sessionFile ? getArtifactsDir(item.run.sessionFile, item.run.cwd ?? state.baseCwd, state.artifactDirPreference) : undefined,
		]),
	};
}

function itemContext(item: FleetItem): string | undefined {
	if (item.kind === "async") return contextModeLabel(item.step?.context ?? item.run.context);
	if (item.kind === "foreground-recent") return contextModeLabel(item.child.context);
	return undefined;
}

function itemMode(item: FleetItem): string {
	if (item.kind === "external") return "display-only";
	return item.kind === "foreground-active" ? item.control.mode : item.run.mode;
}

function itemSource(item: FleetItem): string {
	if (item.kind === "external") return `external · ${item.run.source}`;
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
	} else if (item.kind === "external") {
		durationMs = Math.max(0, externalElapsedEnd(item.run) - item.run.startedAt);
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

function structuredHeader(item: FleetItem, width: number, theme: Theme, conversationState: string, promptSummary?: string): string[] {
	const lines: string[] = [];
	lines.push(rightAligned(` ${statusGlyph(item, theme)} ${theme.bold(item.agent)}`, theme.fg("dim", item.state), width));
	const child = "index" in item && item.index !== undefined ? ` · child ${item.index + 1}` : "";
	const context = itemContext(item);
	const identity = `${itemSource(item)} · ${item.runId.slice(0, 8)}${child} · ${itemMode(item)}${context ? ` ${context}` : ""}`;
	lines.push(`  ${theme.fg("dim", identity)}`);
	const stats = itemStats(item);
	if (stats.length) lines.push(`  ${theme.fg("muted", stats.join(" · "))}`);
	if (promptSummary) lines.push(`  ${theme.fg("muted", `Task: ${promptSummary}`)}`);
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
	private promptAuditOpen = false;
	private promptAuditView: PromptAuditView = "authored";
	private actionNotice: FleetActionResult | undefined;
	private steerDraft: string | undefined;
	private redoGuidanceDraft: string | undefined;
	private steerMode: SteerDeliveryMode = "steer";
	private stopConfirming = false;
	private actionBusy = false;
	private transcriptCache: FleetTranscriptCache | undefined;
	private disposed = false;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly refreshMs: number;
	private readonly tui: FleetTui;
	private readonly theme: Theme;
	private readonly markdownTheme: MarkdownTheme;
	private readonly state: SubagentState;
	private readonly done: (result: undefined) => void;
	private readonly options: FleetViewOptions;
	private readonly keybindings: ResolvedFleetKeybindings;

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
		this.keybindings = resolveFleetKeybindings(options.fleetKeybindings);
		this.refreshMs = Math.max(MIN_REFRESH_MS, options.refreshMs ?? REFRESH_MS);
		this.selectedKey = options.initialKey;
		this.refresh();
		this.scheduleRefresh();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			if (this.disposed) return;
			try {
				this.invalidate();
				this.tui.requestRender();
			} finally {
				this.scheduleRefresh();
			}
		}, this.refreshMs);
		this.refreshTimer.unref?.();
	}

	private stopRefresh(): void {
		this.disposed = true;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private refresh(): void {
		const previousKey = this.snapshot.items[this.selected]?.key ?? this.selectedKey;
		this.snapshot = collectFleetSnapshot(this.state, this.options);
		let preserved = previousKey ? this.snapshot.items.findIndex((item) => item.key === previousKey) : -1;
		if (preserved < 0 && previousKey) {
			const parentKey = visibleWorkflowParentKeyForForegroundKey(this.state, previousKey, this.snapshot.items);
			if (parentKey) preserved = this.snapshot.items.findIndex((item) => item.key === parentKey);
		}
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

	private selectedPromptAudit(): LivePromptAudit | undefined {
		const item = this.snapshot.items[this.selected];
		if (item?.kind !== "foreground-active") return undefined;
		if (!this.state.currentSessionId || item.control.sessionId !== this.state.currentSessionId) return undefined;
		return getLivePromptAudit(item.control, item.index ?? 0);
	}

	private promptAuditItems(): Array<{ item: Extract<FleetItem, { kind: "foreground-active" }>; prompt: LivePromptAudit }> {
		const selected = this.snapshot.items[this.selected];
		if (selected?.kind !== "foreground-active" || !this.state.currentSessionId || selected.control.sessionId !== this.state.currentSessionId) return [];
		return this.snapshot.items.flatMap((item) => {
			if (item.kind !== "foreground-active" || item.control !== selected.control) return [];
			const prompt = getLivePromptAudit(item.control, item.index ?? 0);
			return prompt ? [{ item, prompt }] : [];
		});
	}

	private selectedPromptText(): string | undefined {
		const prompt = this.selectedPromptAudit();
		return prompt ? promptAuditText(prompt, this.promptAuditView) : undefined;
	}

	private movePromptSelection(delta: number): void {
		const items = this.promptAuditItems();
		if (items.length === 0) return;
		const currentKey = this.snapshot.items[this.selected]?.key;
		const current = Math.max(0, items.findIndex(({ item }) => item.key === currentKey));
		const target = items[Math.max(0, Math.min(items.length - 1, current + delta))]?.item;
		if (!target) return;
		this.selected = this.snapshot.items.findIndex((item) => item.key === target.key);
		this.selectedKey = target.key;
		this.detailScroll = 0;
		this.detailAutoFollow = false;
		this.tui.requestRender();
	}

	private resetActionInput(): void {
		this.steerDraft = undefined;
		this.redoGuidanceDraft = undefined;
		this.steerMode = "steer";
		this.stopConfirming = false;
	}

	private selectedAsyncAction(): { item: Extract<FleetItem, { kind: "async" }> } | { reason: string } {
		const item = this.snapshot.items[this.selected];
		if (!item) return { reason: "No child is selected." };
		if (item.kind === "external") return { reason: "External jobs are display-only and remain controlled by their owning extension." };
		if (item.kind !== "async") return { reason: "Fleet controls are available for current-session top-level async runs only." };
		if (!isActionableAsyncState(item.run.state) || !isActionableAsyncState(item.state)) return { reason: `Selected child is ${item.state}; controls require a running or queued async child.` };
		return { item };
	}

	private selectedHerdrInspectAction(): { runId: string; asyncDir: string; index?: number } | { reason: string } {
		const item = this.snapshot.items[this.selected];
		if (!item) return { reason: "No child is selected." };
		if (item.kind === "external") return { reason: "External jobs are display-only and have no Herdr controls." };
		if (item.kind === "async") {
			if (!isActionableAsyncState(item.run.state) || !isActionableAsyncState(item.state)) return { reason: `Selected child is ${item.state}; controls require a running or queued async child.` };
			return { runId: item.runId, asyncDir: item.run.asyncDir, ...(item.index !== undefined ? { index: item.index } : {}) };
		}
		if (item.kind !== "foreground-active" || !item.control.parentWorkflowRunId) return { reason: "Fleet controls are available for current-session top-level async runs only." };
		const parent = this.state.asyncJobs.get(item.control.parentWorkflowRunId) ?? this.state.fleetJobs?.get(item.control.parentWorkflowRunId);
		if (!parent || !isActionableAsyncState(parent.status)) return { reason: "The parent workflow is no longer available for Herdr inspection." };
		return { runId: parent.asyncId, asyncDir: parent.asyncDir };
	}

	private actionLines(): string[] {
		const lines: string[] = [];
		if (this.actionBusy) lines.push(this.theme.fg("accent", "Action pending..."));
		if (this.steerDraft !== undefined) {
			lines.push(this.theme.fg("accent", `Steer message (${this.steerMode}): ${this.steerDraft}${this.theme.fg("dim", "▌")}`));
			lines.push(this.theme.fg("dim", "Enter sends · Tab changes mode · Esc cancels · Backspace edits"));
		} else if (this.redoGuidanceDraft !== undefined) {
			lines.push(this.theme.fg("accent", `Redo guidance: ${this.redoGuidanceDraft}${this.theme.fg("dim", "▌")}`));
			lines.push(this.theme.fg("dim", "Enter rewrites and reruns · Esc cancels · Backspace edits"));
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
		if (this.promptAuditOpen && this.redoGuidanceDraft !== undefined) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.resetActionInput();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "return") || data === "\r" || data === "\n") {
				const guidance = this.redoGuidanceDraft.trim();
				if (!guidance) {
					this.setActionNotice({ text: "Redo guidance cannot be empty.", isError: true });
					return;
				}
				const selected = this.snapshot.items[this.selected];
				if (selected?.kind !== "foreground-active" || !this.options.actions?.redoPrompt) {
					this.setActionNotice({ text: "Redo is unavailable for this prompt.", isError: true });
					return;
				}
				this.runAction(() => this.options.actions!.redoPrompt!({ runId: selected.runId, index: selected.index ?? 0, guidance, control: selected.control }));
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f") {
				this.redoGuidanceDraft = this.redoGuidanceDraft.slice(0, -1);
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.redoGuidanceDraft += data;
				this.tui.requestRender();
			}
			return;
		}
		if (this.promptAuditOpen) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.promptAuditOpen = false;
				this.detailAutoFollow = true;
				this.tui.requestRender();
				return;
			}
			if (data === "j") return this.movePromptSelection(1);
			if (data === "k") return this.movePromptSelection(-1);
			if (data === "1" || data === "2" || data === "3") {
				this.promptAuditView = data === "1" ? "authored" : data === "2" ? "runtime" : "effective";
				this.detailScroll = 0;
				this.tui.requestRender();
				return;
			}
			if (data === "g") {
				const prompt = this.selectedPromptAudit();
				if (!prompt) this.setActionNotice({ text: "Prompt Audit is available only for a live child owned by this session.", isError: true });
				else if (!prompt.rerun) this.setActionNotice({ text: "Redo is not safe for this prompt in this slice.", isError: true });
				else if (!this.options.actions?.redoPrompt) this.setActionNotice({ text: "Redo controls are unavailable in this context.", isError: true });
				else {
					this.actionNotice = undefined;
					this.redoGuidanceDraft = "";
					this.detailAutoFollow = false;
					this.detailScroll = 0;
					this.tui.requestRender();
				}
				return;
			}
			if (data === "c") {
				const text = this.selectedPromptText();
				if (!text) this.setActionNotice({ text: "No prompt view is available to copy.", isError: true });
				else if (!this.options.copyText) this.setActionNotice({ text: "Clipboard is unavailable in this context.", isError: true });
				else this.runAction(async () => {
					await this.options.copyText!(text);
					return { text: "Copied visible prompt view." };
				});
				return;
			}
			if (matchesFleetAction(data, this.keybindings, "scrollUp")) return this.scrollDetail(-1);
			if (matchesFleetAction(data, this.keybindings, "scrollDown")) return this.scrollDetail(1);
			if (matchesFleetAction(data, this.keybindings, "pageUp")) return this.scrollDetail(-this.detailViewportHeight);
			if (matchesFleetAction(data, this.keybindings, "pageDown")) return this.scrollDetail(this.detailViewportHeight);
			return;
		}
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
		if (matchesFleetAction(data, this.keybindings, "close")) {
			this.stopRefresh();
			this.done(undefined);
			return;
		}
		if (matchesFleetAction(data, this.keybindings, "scrollUp")) return this.scrollDetail(-1);
		if (matchesFleetAction(data, this.keybindings, "scrollDown")) return this.scrollDetail(1);
		if (matchesFleetAction(data, this.keybindings, "selectUp")) return this.moveSelection(-1);
		if (matchesFleetAction(data, this.keybindings, "selectDown")) return this.moveSelection(1);
		if (matchesFleetAction(data, this.keybindings, "selectFirst")) return this.moveSelection(-this.snapshot.items.length);
		if (matchesFleetAction(data, this.keybindings, "selectLast")) return this.moveSelection(this.snapshot.items.length);
		if (matchesFleetAction(data, this.keybindings, "pageUp")) return this.scrollDetail(-this.detailViewportHeight);
		if (matchesFleetAction(data, this.keybindings, "pageDown")) return this.scrollDetail(this.detailViewportHeight);
		if (matchesFleetAction(data, this.keybindings, "refresh")) {
			this.transcriptCache = undefined;
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (data === "p") {
			if (!this.selectedPromptAudit()) this.setActionNotice({ text: "Prompt Audit is available only for a live child owned by this session.", isError: true });
			else {
				this.promptAuditOpen = true;
				this.promptAuditView = "authored";
				this.detailScroll = 0;
				this.detailAutoFollow = false;
				this.actionNotice = undefined;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesFleetAction(data, this.keybindings, "steer")) {
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
		if (matchesFleetAction(data, this.keybindings, "inspect")) {
			const target = this.selectedHerdrInspectAction();
			if ("reason" in target || !this.options.actions?.inspect) this.setActionNotice({ text: "reason" in target ? target.reason : "Herdr inspector controls are unavailable in this context.", isError: true });
			else this.runAction(() => this.options.actions!.inspect!(target));
			return;
		}
		if (matchesFleetAction(data, this.keybindings, "stop")) {
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
		if (matchesFleetAction(data, this.keybindings, "toggleTools")) {
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
			const identity = item.runId.slice(0, 8);
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

	private promptAuditDetail(width: number): FleetDetailSections {
		const selected = this.snapshot.items[this.selected];
		const prompt = this.selectedPromptAudit();
		const items = this.promptAuditItems();
		const selectedPosition = selected ? items.findIndex(({ item }) => item.key === selected.key) : -1;
		const live = selected?.kind === "foreground-active" ? selected.activeChild ?? selected.control : undefined;
		const viewLabel = promptAuditViewLabel(this.promptAuditView);
		const promptText = this.selectedPromptText()
			?? this.theme.fg("muted", "Selected prompt unavailable.");
		const raw = [
			this.theme.bold("Prompt Audit"),
			this.theme.fg("dim", "Retention: live memory only · no storage"),
			selected?.kind === "foreground-active" ? `Run: ${selected.runId}${selected.index !== undefined ? ` · Child: ${selected.index}` : ""} · Agent: ${selected.agent}` : "Selected prompt unavailable",
			live ? `Started: ${new Date(live.startedAt).toISOString()}` : undefined,
			live ? `Model: ${formatModelThinking(live.model, live.thinking) || "default"}` : undefined,
			prompt?.cwd ? `Cwd: ${prompt.cwd}` : undefined,
			prompt?.outputPath ? `Output: ${prompt.outputPath}` : undefined,
			this.theme.fg("dim", `Live children: ${items.map(({ item }) => item.agent).join(", ") || "none"}`),
			this.theme.fg("dim", selectedPosition >= 0 ? `Selected: ${selectedPosition + 1}/${items.length}` : "Selected prompt unavailable"),
			"",
			this.theme.fg("accent", viewLabel),
			promptText,
		];
		const body = raw.filter((line): line is string => line !== undefined).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		return { header: [], body: this.withActionLines(body) };
	}

	private wrappedDetail(width: number): FleetDetailSections {
		if (this.promptAuditOpen) return this.promptAuditDetail(width);
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
					const promptSummary = selected.kind === "foreground-active" ? foregroundAuthoredPromptSummary(selected, this.state) : undefined;
					return { header: structuredHeader(selected, width, this.theme, conversationState, promptSummary), body: this.withActionLines(body) };
				}
			}
		}

		const raw = detailLines(selected, this.snapshot.error, this.state);
		if (transcriptWarning) raw.unshift(`Transcript preview warning: ${transcriptWarning}`, "");
		const lines: string[] = [];
		for (const line of raw) {
			const styled = /^(Run|State|Mode|Source|Child|Agent|Model|Task):/.test(line)
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
		const title = selected?.kind === "external"
			? ` ${this.theme.bold("Fleet inspector")} ${this.theme.fg("dim", "· external display-only")}`
			: ` ${this.theme.bold("Subagent fleet inspector")} ${this.theme.fg("dim", "· live controls")}`;
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
		const footer = this.promptAuditOpen
			? ` j/k child · 1/2/3 view · g redo with guidance · c copy · Esc close Prompt Audit · ${position}`
			: selected?.kind === "external"
				? ` ${bindingLabel(this.keybindings, "selectUp")}/${bindingLabel(this.keybindings, "selectDown")} job · display-only · ${bindingLabel(this.keybindings, "refresh")} refresh · ${bindingLabel(this.keybindings, "close")} close · ${position}`
				: ` ${bindingLabel(this.keybindings, "selectUp")}/${bindingLabel(this.keybindings, "selectDown")} agent · p Prompt Audit · ${bindingLabel(this.keybindings, "inspect")} Herdr · ${bindingLabel(this.keybindings, "steer")} steer · ${bindingLabel(this.keybindings, "stop")} stop · ${bindingLabel(this.keybindings, "toggleTools")} tools · ${bindingLabel(this.keybindings, "refresh")} refresh · ${bindingLabel(this.keybindings, "close")} close · ${position}`;
		lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", footer), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.transcriptCache = undefined;
		this.refresh();
	}

	dispose(): void {
		this.stopRefresh();
	}
}

export async function openSubagentFleet(ctx: ExtensionContext, state: SubagentState, options: FleetViewOptions = {}): Promise<void> {
	const wasOpen = state.fleetInspectorOpen === true;
	state.fleetInspectorOpen = true;
	if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
	const copyText = options.copyText ?? (async (text: string) => {
		const module = await import("@earendil-works/pi-coding-agent");
		const copyToClipboard = (module as { copyToClipboard?: (value: string) => Promise<void> | void }).copyToClipboard;
		if (!copyToClipboard) throw new Error("Clipboard is unavailable in this Pi version.");
		await copyToClipboard(text);
	});
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
			sessionRoots: state.trustedSessionRoots,
			cwd: state.baseCwd,
			...(state.authorityPolicy ? { authorityPolicy: state.authorityPolicy } : {}),
			...(state.missionStoreConfig ? { missions: state.missionStoreConfig } : {}),
		}), `Failed to open Herdr inspector for async run ${input.runId}.`),
		redoPrompt: async (input: { runId: string; index: number; guidance: string; control?: ForegroundRunControl }) => {
			const control = input.control ?? state.foregroundControls.get(input.runId);
			if (!control?.promptAuditRedo) return { text: "Redo is not available for this live child.", isError: true };
			return control.promptAuditRedo(input.index, input.guidance);
		},
	} satisfies FleetActionHandlers;
	try {
		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) => new SubagentFleetComponent(tui, theme, state, done, { ...options, actions, copyText }),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
			},
		);
	} finally {
		state.fleetInspectorOpen = wasOpen;
	}
}
