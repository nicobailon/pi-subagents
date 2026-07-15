import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatTokens, shortenPath } from "../shared/formatters.ts";
import { RESULTS_DIR, type AsyncJobState, type ForegroundResumeChild, type ForegroundResumeRun, type SubagentState } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { formatAsyncRunTranscript } from "../runs/background/fleet-view.ts";
import { listAsyncRuns, summarizeAsyncStatus, type AsyncRunSummary } from "../runs/background/async-status.ts";

const REFRESH_MS = 750;
const MAX_RECENT_ASYNC_RUNS = 20;
const TRANSCRIPT_LINES = 200;

type Theme = ExtensionContext["ui"]["theme"];
type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
type AsyncStep = AsyncRunSummary["steps"][number];

export type FleetItem =
	| { key: string; kind: "foreground-active"; runId: string; index?: number; agent: string; state: "running"; updatedAt: number; control: ForegroundControl }
	| { key: string; kind: "foreground-recent"; runId: string; index: number; agent: string; state: ForegroundResumeChild["status"]; updatedAt: number; run: ForegroundResumeRun; child: ForegroundResumeChild }
	| { key: string; kind: "async"; runId: string; index?: number; agent: string; state: string; updatedAt: number; run: AsyncRunSummary; step?: AsyncStep };

export interface FleetSnapshot {
	items: FleetItem[];
	error?: string;
}

function belongsToCurrentSession(sessionId: string | undefined, currentSessionId: string | null): boolean {
	return !currentSessionId || sessionId === currentSessionId;
}

function trackedJobSummary(job: AsyncJobState): AsyncRunSummary {
	const status = readStatus(job.asyncDir);
	if (status) return summarizeAsyncStatus(job.asyncDir, status);
	const startedAt = job.startedAt ?? job.updatedAt ?? Date.now();
	return {
		id: job.asyncId,
		asyncDir: job.asyncDir,
		...(job.sessionId ? { sessionId: job.sessionId } : {}),
		state: job.status,
		mode: job.mode ?? "single",
		startedAt,
		...(job.updatedAt !== undefined ? { lastUpdate: job.updatedAt } : {}),
		...(job.currentStep !== undefined ? { currentStep: job.currentStep } : {}),
		...(job.chainStepCount !== undefined ? { chainStepCount: job.chainStepCount } : {}),
		...(job.parallelGroups?.length ? { parallelGroups: job.parallelGroups } : {}),
		steps: (job.steps ?? job.agents?.map((agent) => ({ agent, status: job.status === "queued" ? "pending" as const : job.status })) ?? []).map((step, index) => ({
			...step,
			index: step.index ?? index,
		})),
		...(job.sessionDir ? { sessionDir: job.sessionDir } : {}),
		...(job.outputFile ? { outputFile: job.outputFile } : {}),
		...(job.totalTokens ? { totalTokens: job.totalTokens } : {}),
		...(job.sessionFile ? { sessionFile: job.sessionFile } : {}),
	};
}

function asyncItems(run: AsyncRunSummary): FleetItem[] {
	const updatedAt = run.lastUpdate ?? run.endedAt ?? run.startedAt;
	if (run.steps.length === 0) {
		return [{ key: `async:${run.id}`, kind: "async", runId: run.id, agent: run.mode, state: run.state, updatedAt, run }];
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
	}));
}

export function collectFleetSnapshot(
	state: SubagentState,
	options: { asyncDirRoot?: string; resultsDir?: string; limit?: number } = {},
): FleetSnapshot {
	const items: FleetItem[] = [];
	const activeForegroundIds = new Set<string>();
	for (const control of [...state.foregroundControls.values()].sort((left, right) => right.updatedAt - left.updatedAt)) {
		activeForegroundIds.add(control.runId);
		items.push({
			key: `foreground-active:${control.runId}:${control.currentIndex ?? 0}`,
			kind: "foreground-active",
			runId: control.runId,
			...(control.currentIndex !== undefined ? { index: control.currentIndex } : {}),
			agent: control.currentAgent ?? control.mode,
			state: "running",
			updatedAt: control.updatedAt,
			control,
		});
	}

	let error: string | undefined;
	try {
		let runs: AsyncRunSummary[];
		if (options.asyncDirRoot !== undefined) {
			runs = listAsyncRuns(options.asyncDirRoot, {
				...(state.currentSessionId ? { sessionId: state.currentSessionId } : {}),
				limit: options.limit ?? MAX_RECENT_ASYNC_RUNS,
				resultsDir: options.resultsDir ?? RESULTS_DIR,
				reconcile: false,
			});
		} else {
			const tracked = [...(state.fleetJobs ?? state.asyncJobs).values()]
				.filter((job) => belongsToCurrentSession(job.sessionId, state.currentSessionId));
			const byUpdate = (left: AsyncJobState, right: AsyncJobState) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0);
			const active = tracked.filter((job) => job.status === "queued" || job.status === "running").sort(byUpdate);
			const recent = tracked.filter((job) => job.status !== "queued" && job.status !== "running").sort(byUpdate).slice(0, options.limit ?? MAX_RECENT_ASYNC_RUNS);
			runs = [];
			for (const job of [...active, ...recent]) {
				try {
					runs.push(trackedJobSummary(job));
				} catch (cause) {
					error = `Failed to inspect async run '${job.asyncId}': ${cause instanceof Error ? cause.message : String(cause)}`;
				}
			}
		}
		for (const run of runs) items.push(...asyncItems(run));
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
	const lines = [
		`Run: ${item.runId}`,
		"Source: foreground",
		`State: running`,
		`Mode: ${control.mode}`,
		item.index !== undefined ? `Child: ${item.index} (${item.agent})` : `Agent: ${item.agent}`,
		`Started: ${new Date(control.startedAt).toISOString()}`,
		control.currentTool ? `Current tool: ${control.currentTool}${control.currentPath ? ` · ${shortenPath(control.currentPath)}` : ""}` : undefined,
		control.turnCount !== undefined ? `Turns: ${control.turnCount}` : undefined,
		control.toolCount !== undefined ? `Tools: ${control.toolCount}` : undefined,
		control.tokens !== undefined ? `Tokens: ${formatTokens(control.tokens)}` : undefined,
		"",
		"Transcript",
		"Live foreground output remains in the expanded subagent tool result. Persisted output and session paths appear here after the child settles.",
	];
	return lines.filter((line): line is string => line !== undefined);
}

function foregroundRecentDetail(item: Extract<FleetItem, { kind: "foreground-recent" }>): string[] {
	const { child, run } = item;
	const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
	const lines = [
		`Run: ${item.runId}`,
		"Source: foreground",
		`State: ${child.status}`,
		`Mode: ${run.mode}`,
		`Child: ${child.index} (${child.agent})`,
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
		`Mode: ${item.run.mode}`,
		item.index !== undefined ? `Child: ${item.index} (${item.agent})` : `Agent: ${item.agent}`,
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

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	return fit(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

export class SubagentFleetComponent implements Component {
	private snapshot: FleetSnapshot = { items: [] };
	private selected = 0;
	private selectedKey: string | undefined;
	private detailScroll = 0;
	private detailAutoFollow = true;
	private detailLineCount = 0;
	private bodyHeight = 8;
	private disposed = false;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly state: SubagentState;
	private readonly done: (result: undefined) => void;
	private readonly options: { asyncDirRoot?: string; resultsDir?: string; refreshMs?: number };

	constructor(
		tui: TUI,
		theme: Theme,
		state: SubagentState,
		done: (result: undefined) => void,
		options: { asyncDirRoot?: string; resultsDir?: string; refreshMs?: number } = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.done = done;
		this.options = options;
		this.refresh();
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.refresh();
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
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) return this.moveSelection(-1);
		if (matchesKey(data, "down") || matchesKey(data, "j")) return this.moveSelection(1);
		if (matchesKey(data, "home")) return this.moveSelection(-this.snapshot.items.length);
		if (matchesKey(data, "end")) return this.moveSelection(this.snapshot.items.length);
		if (matchesKey(data, "pageUp")) {
			this.detailAutoFollow = false;
			this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, this.detailLineCount - this.bodyHeight)) - this.bodyHeight);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxScroll = Math.max(0, this.detailLineCount - this.bodyHeight);
			this.detailScroll = Math.min(maxScroll, this.detailScroll + this.bodyHeight);
			this.detailAutoFollow = this.detailScroll >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (data.toLowerCase() === "r") {
			this.refresh();
			this.tui.requestRender();
		}
	}

	private rosterLines(width: number): string[] {
		if (this.snapshot.items.length === 0) return [this.theme.fg("dim", "No tracked children")];
		const start = Math.max(0, Math.min(this.selected - this.bodyHeight + 1, Math.max(0, this.snapshot.items.length - this.bodyHeight)));
		return this.snapshot.items.slice(start, start + this.bodyHeight).map((item, offset) => {
			const index = start + offset;
			const marker = index === this.selected ? this.theme.fg("accent", "›") : " ";
			const child = item.index !== undefined ? `:${item.index + 1}` : "";
			const source = item.kind === "async" ? "async" : item.kind === "foreground-active" ? "live" : "recent";
			const left = `${marker} ${statusGlyph(item, this.theme)} ${source} ${item.runId.slice(0, 8)}${child} ${item.agent}`;
			return rightAligned(left, this.theme.fg("dim", item.state), width);
		});
	}

	private wrappedDetail(width: number): string[] {
		const selected = this.snapshot.items[this.selected];
		const raw = detailLines(selected, this.snapshot.error);
		const lines: string[] = [];
		for (const line of raw) {
			const styled = /^(Run|State|Mode|Source|Child|Agent):/.test(line)
				? this.theme.bold(line)
				: /^(Transcript|Result transcript tail)/.test(line)
					? this.theme.fg("accent", line)
					: /^(Output|Session|Transcript file|Artifacts):/.test(line)
						? this.theme.fg("muted", line)
						: line;
			const wrapped = wrapTextWithAnsi(styled, Math.max(1, width));
			lines.push(...(wrapped.length ? wrapped : [""]));
		}
		return lines;
	}

	render(width: number): string[] {
		if (width < 36) return [truncateToWidth("Subagent fleet needs at least 36 columns. Esc closes.", width)];
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 32;
		this.bodyHeight = Math.max(2, Math.min(30, Math.floor(rows * 0.85) - 6));
		const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.38)));
		const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
		const roster = this.rosterLines(rosterWidth);
		const details = this.wrappedDetail(detailWidth);
		this.detailLineCount = details.length;
		const maxDetailScroll = Math.max(0, details.length - this.bodyHeight);
		if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
		else if (this.detailScroll > maxDetailScroll) this.detailScroll = maxDetailScroll;
		const visibleDetails = details.slice(this.detailScroll, this.detailScroll + this.bodyHeight);
		const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
		lines.push(this.theme.fg("border", "│") + fit(` ${this.theme.bold("Subagent fleet")} ${this.theme.fg("dim", "· inspection only · live refresh")}`, innerWidth) + this.theme.fg("border", "│"));
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
		const footer = ` ↑↓/jk child · PgUp/PgDn transcript · r refresh · Esc close · ${position}`;
		lines.push(this.theme.fg("border", "│") + fit(this.theme.fg("dim", footer), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}

export async function openSubagentFleet(ctx: ExtensionContext, state: SubagentState): Promise<void> {
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => new SubagentFleetComponent(tui, theme, state, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
		},
	);
}
