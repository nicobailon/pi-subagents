import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { type AsyncRunOverlayData, type AsyncRunOverlayOptions, type AsyncRunSummary, formatAsyncRunProgressLabel, listAsyncRunsForOverlay } from "../runs/background/async-status.ts";
import { ASYNC_DIR } from "../shared/types.ts";
import { formatDuration, formatTokens, shortenPath } from "../shared/formatters.ts";
import { formatScrollInfo, renderFooter, renderHeader, row } from "./render-helpers.ts";

const AUTO_REFRESH_MS = 2000;
const DETAIL_EVENT_LIMIT = 8;
const OUTPUT_TAIL_LINES = 20;
const DETAIL_FILE_TAIL_BYTES = 64 * 1024;
const DETAIL_VIEWPORT_HEIGHT = 18;

interface StatusRow {
	kind: "section" | "run";
	label: string;
	run?: AsyncRunSummary;
}

interface StatusOverlayDeps {
	sessionId: string;
	listRunsForOverlay?: (asyncDirRoot: string, options?: AsyncRunOverlayOptions) => AsyncRunOverlayData;
	refreshMs?: number;
}

function statusColor(theme: Theme, status: AsyncRunSummary["state"]): string {
	switch (status) {
		case "running": return theme.fg("warning", status);
		case "queued": return theme.fg("accent", status);
		case "complete": return theme.fg("success", status);
		case "failed": return theme.fg("error", status);
		case "paused": return theme.fg("warning", status);
	}
}

function stepStatusColor(theme: Theme, status: string): string {
	if (status === "running") return theme.fg("warning", status);
	if (status === "pending") return theme.fg("dim", status);
	if (status === "complete" || status === "completed") return theme.fg("success", status);
	if (status === "failed") return theme.fg("error", status);
	if (status === "paused") return theme.fg("warning", status);
	return status;
}

function runLabel(theme: Theme, run: AsyncRunSummary, selected: boolean): string {
	const prefix = selected ? theme.fg("accent", ">") : " ";
	const stepLabel = formatAsyncRunProgressLabel(run);
	const cwd = shortenPath(run.cwd ?? run.asyncDir);
	return `${prefix} ${run.id.slice(0, 8)} ${statusColor(theme, run.state)} | ${run.mode} | ${stepLabel} | ${cwd}`;
}

function selectedIndex(rows: StatusRow[], cursor: number): number {
	const runRows = rows.filter((row) => row.kind === "run");
	if (runRows.length === 0) return -1;
	return Math.max(0, Math.min(cursor, runRows.length - 1));
}

function selectedRun(rows: StatusRow[], cursor: number): AsyncRunSummary | undefined {
	const runRows = rows.filter((row) => row.kind === "run");
	const index = selectedIndex(rows, cursor);
	return index >= 0 ? runRows[index]?.run : undefined;
}

function buildRows(active: AsyncRunSummary[], recent: AsyncRunSummary[]): StatusRow[] {
	const rows: StatusRow[] = [];
	if (active.length > 0) {
		rows.push({ kind: "section", label: "Active" });
		for (const run of active) rows.push({ kind: "run", label: run.id, run });
	}
	if (recent.length > 0) {
		rows.push({ kind: "section", label: "Recent" });
		for (const run of recent) rows.push({ kind: "run", label: run.id, run });
	}
	return rows;
}

function resolveRunPath(asyncDir: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(asyncDir, filePath);
}

function readTailText(filePath: string): { text?: string; warning?: string } {
	let fd: number | undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return { warning: `not a file: ${filePath}` };
		const start = Math.max(0, stat.size - DETAIL_FILE_TAIL_BYTES);
		const length = stat.size - start;
		const buffer = Buffer.alloc(length);
		fd = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, length, start);
		return { text: buffer.subarray(0, bytesRead).toString("utf-8") };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		return { warning: code === "ENOENT" ? `missing ${path.basename(filePath)}: ${filePath}` : `failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Best effort cleanup after a bounded detail-view read.
			}
		}
	}
}

function readTailLines(filePath: string, maxLines: number): { lines: string[]; warning?: string } {
	const tail = readTailText(filePath);
	if (tail.warning) return { lines: [], warning: tail.warning };
	const lines = (tail.text ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
	return { lines: lines.slice(Math.max(0, lines.length - maxLines)) };
}

function formatEventTimestamp(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return new Date(value).toISOString();
}

function formatEventLine(value: Record<string, unknown>): string {
	const type = typeof value.type === "string" ? value.type : "event";
	const ts = formatEventTimestamp(value.ts ?? value.observedAt);
	const stepIndex = typeof value.stepIndex === "number" ? ` step ${value.stepIndex + 1}` : "";
	const agent = typeof value.agent === "string"
		? value.agent
		: typeof value.subagentAgent === "string"
			? value.subagentAgent
			: undefined;
	const status = typeof value.status === "string" ? value.status : undefined;
	const exitCode = typeof value.exitCode === "number" ? `exit ${value.exitCode}` : undefined;
	const event = value.event && typeof value.event === "object" && !Array.isArray(value.event)
		? value.event as { message?: unknown }
		: undefined;
	const message = typeof value.message === "string"
		? value.message
		: typeof value.error === "string"
			? value.error
			: typeof event?.message === "string"
				? event.message
				: undefined;
	return [ts, type, agent ? `${agent}${stepIndex}` : stepIndex.trim(), status, exitCode, message].filter(Boolean).join(" | ");
}

function detailRows(content: string, width: number, innerW: number, theme: Theme): string[] {
	const normalized = content.replace(/\t/g, "  ");
	const wrapped = wrapTextWithAnsi(normalized, innerW);
	return (wrapped.length > 0 ? wrapped : [""]).map((line) => row(line, width, theme));
}

function warningDetailRows(content: string, width: number, innerW: number, theme: Theme): string[] {
	const normalized = content.replace(/\t/g, "  ");
	const wrapped = wrapTextWithAnsi(normalized, innerW);
	return (wrapped.length > 0 ? wrapped : [""]).map((line) => row(theme.fg("warning", line), width, theme));
}

function readRecentEvents(eventsPath: string, limit: number): { events: string[]; warning?: string } {
	const tail = readTailText(eventsPath);
	if (tail.warning) {
		return tail.warning.startsWith("missing ") ? { events: [] } : { events: [], warning: tail.warning };
	}

	const events: string[] = [];
	const lines = (tail.text ?? "").split("\n").filter((line) => line.trim());
	for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
		try {
			const parsed = JSON.parse(lines[i]!);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			events.push(formatEventLine(parsed as Record<string, unknown>));
		} catch {
			// Skip malformed event records; async writers can be interrupted mid-line.
		}
	}
	return { events: events.reverse() };
}

export class SubagentsStatusComponent implements Component {
	private readonly width = 84;
	private readonly viewportHeight = 12;
	private readonly listRunsForOverlay: (asyncDirRoot: string, options?: AsyncRunOverlayOptions) => AsyncRunOverlayData;
	private readonly sessionId: string;
	private readonly refreshTimer: NodeJS.Timeout;
	private screen: "list" | "detail" = "list";
	private cursor = 0;
	private scrollOffset = 0;
	private detailScrollOffset = 0;
	private detailRunId: string | undefined;
	private active: AsyncRunSummary[] = [];
	private recent: AsyncRunSummary[] = [];
	private rows: StatusRow[] = [];
	private errorMessage?: string;
	private tui: TUI;
	private theme: Theme;
	private done: () => void;

	constructor(
		tui: TUI,
		theme: Theme,
		done: () => void,
		deps: StatusOverlayDeps,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.listRunsForOverlay = deps.listRunsForOverlay ?? listAsyncRunsForOverlay;
		this.sessionId = deps.sessionId;
		const refreshMs = deps.refreshMs ?? AUTO_REFRESH_MS;
		this.reload();
		this.refreshTimer = setInterval(() => {
			this.reload();
			this.tui.requestRender();
		}, refreshMs);
		this.refreshTimer.unref?.();
	}

	private reload(): void {
		const previousSelectedId = selectedRun(this.rows, this.cursor)?.id;
		try {
			const overlayData = this.listRunsForOverlay(ASYNC_DIR, { recentLimit: 5, sessionId: this.sessionId });
			this.active = overlayData.active;
			this.recent = overlayData.recent;
			this.rows = buildRows(this.active, this.recent);
			this.errorMessage = undefined;
			this.restoreSelection(previousSelectedId);
			this.ensureScrollVisible();
		} catch (error) {
			this.active = [];
			this.recent = [];
			this.rows = [];
			this.cursor = 0;
			this.scrollOffset = 0;
			this.errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	private restoreSelection(previousSelectedId?: string): void {
		const runRows = this.rows.filter((row) => row.kind === "run");
		if (runRows.length === 0) {
			this.cursor = 0;
			return;
		}
		if (!previousSelectedId) {
			this.cursor = Math.min(this.cursor, runRows.length - 1);
			return;
		}
		const nextIndex = runRows.findIndex((row) => row.run?.id === previousSelectedId);
		if (nextIndex !== -1) {
			this.cursor = nextIndex;
			return;
		}
		this.cursor = Math.min(this.cursor, runRows.length - 1);
	}

	private ensureScrollVisible(): void {
		if (this.rows.length <= this.viewportHeight) {
			this.scrollOffset = 0;
			return;
		}
		const selected = selectedRun(this.rows, this.cursor);
		if (!selected) {
			this.scrollOffset = 0;
			return;
		}
		const rowIndex = this.rows.findIndex((row) => row.kind === "run" && row.run?.id === selected.id);
		if (rowIndex === -1) return;
		if (rowIndex < this.scrollOffset) this.scrollOffset = rowIndex;
		if (rowIndex >= this.scrollOffset + this.viewportHeight) {
			this.scrollOffset = rowIndex - this.viewportHeight + 1;
		}
	}

	private renderRunDetails(run: AsyncRunSummary, width: number, innerW: number): string[] {
		const lines = [
			row(`cwd: ${truncateToWidth(shortenPath(run.cwd ?? run.asyncDir), innerW - 5)}`, width, this.theme),
		];
		if (run.outputFile) {
			lines.push(row(`output: ${truncateToWidth(shortenPath(run.outputFile), innerW - 8)}`, width, this.theme));
		}
		if (run.sessionFile) {
			lines.push(row(`session: ${truncateToWidth(shortenPath(run.sessionFile), innerW - 9)}`, width, this.theme));
		}
		lines.push(...this.renderStepRows(run, width, innerW));
		return lines;
	}

	private renderStepRows(run: AsyncRunSummary, width: number, innerW: number, options: { wrap?: boolean } = {}): string[] {
		const lines: string[] = [];
		for (const step of run.steps) {
			const model = step.model ? ` | ${step.model}` : "";
			const attempts = step.attemptedModels && step.attemptedModels.length > 1
				? ` | attempts ${step.attemptedModels.length}`
				: "";
			const duration = step.durationMs !== undefined ? ` | ${formatDuration(step.durationMs)}` : "";
			const tokens = step.tokens ? ` | ${formatTokens(step.tokens.total)} tok` : "";
			const activity = step.lastActivityAt
				? step.activityState === "needs_attention"
					? ` | no activity for ${formatDuration(Math.max(0, Date.now() - step.lastActivityAt))}`
					: step.activityState === "active_long_running"
						? ` | active but long-running; last activity ${formatDuration(Math.max(0, Date.now() - step.lastActivityAt))} ago`
						: ` | active ${formatDuration(Math.max(0, Date.now() - step.lastActivityAt))} ago`
				: "";
			const line = `  ${step.index + 1}. ${step.agent} | ${stepStatusColor(this.theme, step.status)}${activity}${model}${attempts}${duration}${tokens}`;
			if (options.wrap) {
				lines.push(...detailRows(line, width, innerW, this.theme));
			} else {
				lines.push(row(truncateToWidth(line, innerW), width, this.theme));
			}
			if (step.error) {
				if (options.wrap) {
					lines.push(...detailRows(`     ${step.error}`, width, innerW, this.theme));
				} else {
					lines.push(row(truncateToWidth(`     ${step.error}`, innerW), width, this.theme));
				}
			}
		}
		if (run.steps.length === 0) {
			lines.push(row(this.theme.fg("dim", "  No step details available yet."), width, this.theme));
		}
		return lines;
	}

	private renderDetail(run: AsyncRunSummary, width: number, innerW: number): string[] {
		const stepLabel = formatAsyncRunProgressLabel(run);
		const duration = run.endedAt !== undefined
			? formatDuration(Math.max(0, run.endedAt - run.startedAt))
			: formatDuration(Math.max(0, Date.now() - run.startedAt));
		const activity = run.lastActivityAt
			? run.activityState === "needs_attention"
				? `no activity for ${formatDuration(Math.max(0, Date.now() - run.lastActivityAt))}`
				: run.activityState === "active_long_running"
					? `active but long-running; last activity ${formatDuration(Math.max(0, Date.now() - run.lastActivityAt))} ago`
					: `active ${formatDuration(Math.max(0, Date.now() - run.lastActivityAt))} ago`
			: undefined;

		const body: string[] = [];
		body.push(...detailRows(`${run.id} | ${statusColor(this.theme, run.state)} | ${run.mode} | ${stepLabel} | ${duration}`, width, innerW, this.theme));
		if (activity) body.push(...detailRows(activity, width, innerW, this.theme));
		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Steps"), width, this.theme));
		body.push(...this.renderStepRows(run, width, innerW, { wrap: true }));

		const eventsPath = path.join(run.asyncDir, "events.jsonl");
		const eventResult = readRecentEvents(eventsPath, DETAIL_EVENT_LIMIT);
		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Recent events"), width, this.theme));
		if (eventResult.warning) body.push(...warningDetailRows(eventResult.warning, width, innerW, this.theme));
		if (eventResult.events.length === 0 && !eventResult.warning) body.push(row(this.theme.fg("dim", "  No events recorded."), width, this.theme));
		for (const event of eventResult.events) {
			body.push(...detailRows(`  ${event}`, width, innerW, this.theme));
		}

		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Output tail"), width, this.theme));
		if (run.outputFile) {
			const outputPath = resolveRunPath(run.asyncDir, run.outputFile);
			const tail = readTailLines(outputPath, OUTPUT_TAIL_LINES);
			if (tail.warning) body.push(...warningDetailRows(tail.warning, width, innerW, this.theme));
			else if (tail.lines.length === 0) body.push(row(this.theme.fg("dim", "  No output yet."), width, this.theme));
			for (const line of tail.lines) body.push(...detailRows(`  ${line}`, width, innerW, this.theme));
		} else {
			body.push(row(this.theme.fg("dim", "  No output file recorded."), width, this.theme));
		}

		body.push(row("", width, this.theme));
		body.push(row(this.theme.fg("accent", "Paths"), width, this.theme));
		body.push(row(truncateToWidth(`  cwd: ${shortenPath(run.cwd ?? run.asyncDir)}`, innerW), width, this.theme));
		body.push(row(truncateToWidth(`  asyncDir: ${shortenPath(run.asyncDir)}`, innerW), width, this.theme));
		if (run.outputFile) body.push(row(truncateToWidth(`  outputFile: ${shortenPath(resolveRunPath(run.asyncDir, run.outputFile))}`, innerW), width, this.theme));
		if (run.sessionFile) body.push(row(truncateToWidth(`  sessionFile: ${shortenPath(run.sessionFile)}`, innerW), width, this.theme));
		if (run.sessionDir) body.push(row(truncateToWidth(`  sessionDir: ${shortenPath(run.sessionDir)}`, innerW), width, this.theme));
		const logPath = path.join(run.asyncDir, `subagent-log-${run.id}.md`);
		if (fs.existsSync(logPath)) body.push(row(truncateToWidth(`  runLog: ${shortenPath(logPath)}`, innerW), width, this.theme));

		const maxOffset = Math.max(0, body.length - DETAIL_VIEWPORT_HEIGHT);
		this.detailScrollOffset = Math.min(this.detailScrollOffset, maxOffset);
		const visibleBody = body.slice(this.detailScrollOffset, this.detailScrollOffset + DETAIL_VIEWPORT_HEIGHT);
		const above = this.detailScrollOffset;
		const below = Math.max(0, body.length - (this.detailScrollOffset + visibleBody.length));
		const scrollInfo = formatScrollInfo(above, below);
		return [
			renderHeader(`Subagent Run ${run.id.slice(0, 8)}`, width, this.theme),
			...visibleBody,
			scrollInfo ? row(this.theme.fg("dim", scrollInfo), width, this.theme) : row("", width, this.theme),
			renderFooter(" ↑↓ scroll  esc summary  q close  read-only detail ", width, this.theme),
		];
	}

	handleInput(data: string): void {
		if (this.screen === "detail" && matchesKey(data, "escape")) {
			this.screen = "list";
			this.detailRunId = undefined;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (this.screen === "detail") {
			if (matchesKey(data, "up")) {
				this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				this.detailScrollOffset++;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "pageup")) {
				this.detailScrollOffset = Math.max(0, this.detailScrollOffset - DETAIL_VIEWPORT_HEIGHT);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "pagedown")) {
				this.detailScrollOffset += DETAIL_VIEWPORT_HEIGHT;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "return")) {
			const selected = selectedRun(this.rows, this.cursor);
			if (selected) {
				this.screen = "detail";
				this.detailRunId = selected.id;
				this.detailScrollOffset = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.ensureScrollVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			const maxCursor = Math.max(0, this.rows.filter((row) => row.kind === "run").length - 1);
			this.cursor = Math.min(maxCursor, this.cursor + 1);
			this.ensureScrollVisible();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const w = Math.min(width, this.width);
		const innerW = w - 2;
		const selected = selectedRun(this.rows, this.cursor);
		if (this.screen === "detail") {
			const detailRun = this.rows.find((row) => row.kind === "run" && row.run?.id === this.detailRunId)?.run;
			if (detailRun) return this.renderDetail(detailRun, w, innerW);
			return [
				renderHeader("Subagent Run", w, this.theme),
				row(this.theme.fg("warning", "Selected run is no longer available."), w, this.theme),
				renderFooter(" esc summary  q close ", w, this.theme),
			];
		}
		const lines: string[] = [renderHeader("Subagents Status", w, this.theme)];
		const rows = this.rows.length > 0 ? this.rows : [{ kind: "section" as const, label: "No async runs found" }];
		const visibleRows = rows.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
		for (const statusRow of visibleRows) {
			if (statusRow.kind === "section") {
				lines.push(row(this.theme.fg("accent", statusRow.label), w, this.theme));
				continue;
			}
			const isSelected = selected?.id === statusRow.run?.id;
			lines.push(row(truncateToWidth(runLabel(this.theme, statusRow.run!, isSelected), innerW), w, this.theme));
		}

		const above = this.scrollOffset;
		const below = Math.max(0, rows.length - (this.scrollOffset + visibleRows.length));
		const scrollInfo = formatScrollInfo(above, below);
		if (scrollInfo) lines.push(row(this.theme.fg("dim", scrollInfo), w, this.theme));
		else lines.push(row("", w, this.theme));

		if (this.errorMessage) {
			lines.push(row(this.theme.fg("error", truncateToWidth(this.errorMessage, innerW)), w, this.theme));
		} else if (selected) {
			lines.push(row(this.theme.fg("accent", `Selected: ${selected.id}`), w, this.theme));
			lines.push(...this.renderRunDetails(selected, w, innerW));
		} else {
			lines.push(row(this.theme.fg("dim", "No runs selected."), w, this.theme));
		}

		const footer = `↑↓ select  enter detail  esc close  summary view  ${this.active.length} active / ${this.recent.length} recent`;
		lines.push(renderFooter(truncateToWidth(footer, innerW), w, this.theme));
		return lines;
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}
}
