import * as fs from "node:fs";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatActivityLabel } from "../shared/status-format.ts";
import type { ActivityState } from "../shared/types.ts";
import type { WatchTab, WatchTarget } from "./watch-types.ts";
import { createWatchScrollState, getVisibleRange, scrollWatchState, type WatchScrollState } from "./watch-scroll.ts";
import { readTranscriptEntries } from "./transcript-reader.ts";
import { renderTranscriptLines } from "./transcript-renderer.ts";

export interface WatchOverlayState {
	tab: WatchTab;
	scroll: WatchScrollState;
}

export type WatchOverlayAction = "handled" | "back" | "close" | "none";

const TABS: WatchTab[] = ["transcript", "status", "log"];

export function collectWatchFiles(target: Pick<WatchTarget, "sessionFile" | "outputLog" | "rootLog" | "eventsFile" | "statusFile">): string[] {
	return [...new Set([target.sessionFile, target.outputLog, target.rootLog, target.eventsFile, target.statusFile].filter((file): file is string => Boolean(file)))];
}

export function createWatchOverlayState(): WatchOverlayState {
	return { tab: "transcript", scroll: createWatchScrollState() };
}

function nextTab(tab: WatchTab, delta: 1 | -1): WatchTab {
	const index = TABS.indexOf(tab);
	return TABS[(index + delta + TABS.length) % TABS.length]!;
}

export function handleWatchOverlayKey(state: WatchOverlayState, data: string, view: { totalLines: number; visibleLines: number }): WatchOverlayAction {
	if (matchesKey(data, Key.escape) || data === "q") return "close";
	if (matchesKey(data, Key.backspace) || data === "b") return "back";
	if (matchesKey(data, Key.tab)) {
		state.tab = nextTab(state.tab, 1);
		state.scroll.scrollOffset = 0;
		return "handled";
	}
	if (matchesKey(data, Key.shift("tab")) || data === "\x1b[Z") {
		state.tab = nextTab(state.tab, -1);
		state.scroll.scrollOffset = 0;
		return "handled";
	}
	if (matchesKey(data, Key.pageUp)) {
		scrollWatchState(state.scroll, "pageUp", view.totalLines, view.visibleLines);
		return "handled";
	}
	if (matchesKey(data, Key.pageDown)) {
		scrollWatchState(state.scroll, "pageDown", view.totalLines, view.visibleLines);
		return "handled";
	}
	if (matchesKey(data, Key.shift("up"))) {
		scrollWatchState(state.scroll, "lineUp", view.totalLines, view.visibleLines);
		return "handled";
	}
	if (matchesKey(data, Key.shift("down"))) {
		scrollWatchState(state.scroll, "lineDown", view.totalLines, view.visibleLines);
		return "handled";
	}
	return "none";
}

function padToWidth(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function readTextFile(file: string | undefined): string[] {
	if (!file) return ["No log file recorded for this agent."];
	try {
		return fs.readFileSync(file, "utf-8").split("\n");
	} catch (error) {
		return [`Log unavailable: ${file} (${error instanceof Error ? error.message : String(error)})`];
	}
}

function statusLines(target: WatchTarget, theme: Theme): string[] {
	return [
		`Agent: ${target.agent}`,
		`Display: ${target.displayName}`,
		`Status: ${target.status}`,
		target.currentTool ? `Current tool: ${target.currentTool}` : undefined,
		target.lastActivityAt !== undefined ? `Activity: ${formatActivityLabel(target.lastActivityAt, target.activityState as ActivityState | undefined)}` : undefined,
		`Root run: ${target.rootRunId}`,
		`Path: ${target.ancestry.join(" › ")}`,
		target.sessionFile ? `Session: ${target.sessionFile}` : undefined,
		target.outputLog ? `Log: ${target.outputLog}` : undefined,
		target.eventsFile ? `Events: ${target.eventsFile}` : undefined,
		target.error ? theme.fg("error", `Error: ${target.error}`) : undefined,
	].filter((line): line is string => Boolean(line));
}

export class WatchOverlay implements Component {
	private state = createWatchOverlayState();
	private totalLines = 0;
	private input: { tui: TUI; theme: Theme; target: WatchTarget; resolveTarget?: () => WatchTarget | undefined; onBack: () => void; onClose: () => void };
	private watchers: Array<{ close: () => void }> = [];
	private poller?: ReturnType<typeof setInterval>;

	constructor(input: { tui: TUI; theme: Theme; target: WatchTarget; resolveTarget?: () => WatchTarget | undefined; onBack: () => void; onClose: () => void }) {
		this.input = input;
		for (const file of collectWatchFiles(input.target)) {
			try {
				this.watchers.push(fs.watch(file, () => input.tui.requestRender()));
			} catch {
				// Missing files are common while a child starts. Polling covers them.
			}
		}
		this.poller = setInterval(() => input.tui.requestRender(), 1000);
		this.poller.unref?.();
	}

	private currentTarget(): WatchTarget {
		const refreshed = this.input.resolveTarget?.();
		if (refreshed) this.input.target = refreshed;
		return this.input.target;
	}

	private contentLines(width: number, target: WatchTarget): string[] {
		const inner = Math.max(1, width - 4);
		if (this.state.tab === "status") return statusLines(target, this.input.theme);
		if (this.state.tab === "log") return readTextFile(target.outputLog ?? target.rootLog).slice(-5000);
		const transcript = readTranscriptEntries(target.sessionFile);
		return renderTranscriptLines(transcript.entries.slice(-1000), { warnings: transcript.warnings }, inner).slice(-5000);
	}

	render(width: number): string[] {
		const { theme } = this.input;
		const target = this.currentTarget();
		if (width < 8) return [" ".repeat(Math.max(0, width))];
		const inner = Math.max(1, width - 4);
		const rows = this.input.tui.terminal.rows ?? process.stdout.rows ?? 24;
		const visibleRows = Math.max(1, rows - 8);
		const content = this.contentLines(width, target);
		this.totalLines = content.length;
		const range = getVisibleRange(this.state.scroll, content.length, visibleRows);
		const visible = content.slice(range.start, range.end);
		const tabText = TABS.map((tab) => tab === this.state.tab ? theme.bold(theme.fg("accent", tab)) : theme.fg("dim", tab)).join(theme.fg("dim", " | "));
		const title = `${target.ancestry.join(" › ")} · ${target.status}`;
		const lines = [
			theme.fg("border", "┌" + "─".repeat(width - 2) + "┐"),
			this.frame(theme.fg("accent", truncateToWidth(title, inner)), width),
			this.frame(tabText, width),
			theme.fg("border", "├" + "─".repeat(width - 2) + "┤"),
			...visible.map((line) => this.frame(line, width)),
			...Array.from({ length: Math.max(0, visibleRows - visible.length) }, () => this.frame("", width)),
			theme.fg("border", "├" + "─".repeat(width - 2) + "┤"),
			this.frame(theme.fg("dim", "Tab/Shift+Tab tabs · Backspace/b selector · PgUp/PgDn page · Shift+↑/↓ line · Esc/q close"), width),
			theme.fg("border", "└" + "─".repeat(width - 2) + "┘"),
		];
		return lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
	}

	private frame(content: string, width: number): string {
		const inner = Math.max(1, width - 4);
		const safe = truncateToWidth(content.replaceAll("\r", " "), inner, "...", true);
		return this.input.theme.fg("border", "│ ") + padToWidth(safe, inner) + this.input.theme.fg("border", " │");
	}

	handleInput(data: string): void {
		const action = handleWatchOverlayKey(this.state, data, { totalLines: this.totalLines, visibleLines: Math.max(1, (this.input.tui.terminal.rows ?? 24) - 8) });
		if (action === "close") {
			this.dispose();
			this.input.onClose();
		} else if (action === "back") {
			this.dispose();
			this.input.onBack();
		} else if (action === "handled") this.input.tui.requestRender();
	}

	dispose(): void {
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (this.poller) clearInterval(this.poller);
		this.poller = undefined;
	}

	invalidate(): void {}
}
