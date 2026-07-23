import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AsyncJobStep, SubagentState } from "../shared/types.ts";

export const FLEET_STATUS_WIDGET_KEY = "subagent-fleet-status";
const MAX_AGENT_ROWS = 5;
const REFRESH_MS = 500;

type Theme = ExtensionContext["ui"]["theme"];
type FleetStatusTui = {
	requestRender(): void;
};
type FleetStatusEntry = {
	key: string;
	agent: string;
	description?: string;
	startedAt: number;
	tokens: number;
};

export interface FleetStatusOptions {
	refreshMs?: number;
	maxAgentRows?: number;
}

export function formatFleetElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function formatFleetTokens(count: number): string {
	let compact: string;
	if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
	else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
	else compact = `${Math.max(0, Math.round(count))}`;
	return `↓ ${compact} tokens`;
}

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = Math.max(0, width - rightWidth - 1);
	const leftClamped = truncateToWidth(left, maxLeftWidth);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

function isActiveState(value: string): boolean {
	return value === "running" || value === "queued" || value === "pending";
}

export function collectFleetStatusEntries(state: SubagentState): FleetStatusEntry[] {
	const entries: FleetStatusEntry[] = [];
	for (const control of state.foregroundControls.values()) {
		if (control.activeChildren) {
			for (const child of [...control.activeChildren.values()].sort((left, right) => left.index - right.index)) {
				entries.push({
					key: `foreground-active:${control.runId}:${child.index}`,
					agent: child.agent,
					description: child.description,
					startedAt: child.startedAt,
					tokens: child.tokens ?? 0,
				});
			}
			continue;
		}
		entries.push({
			key: `foreground-active:${control.runId}:${control.currentIndex ?? 0}`,
			agent: control.currentAgent ?? control.mode,
			description: control.description,
			startedAt: control.startedAt,
			tokens: control.tokens ?? 0,
		});
	}

	for (const job of state.asyncJobs.values()) {
		if (!isActiveState(job.status)) continue;
		const startedAt = job.startedAt ?? job.updatedAt ?? Date.now();
		const steps: AsyncJobStep[] | undefined = job.steps?.length
			? job.steps
			: job.agents?.map((agent, index) => {
				const pending = job.status === "queued"
					|| (job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0));
				return { agent, index, status: pending ? "pending" : "running" };
			});
		if (!steps?.length) {
			entries.push({
				key: `async:${job.asyncId}`,
				agent: job.mode ?? "subagent",
				description: job.description,
				startedAt,
				tokens: job.totalTokens?.total ?? 0,
			});
			continue;
		}
		for (const [offset, step] of steps.entries()) {
			if (!isActiveState(step.status)) continue;
			const index = step.index ?? offset;
			if (step.status === "pending" && job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0)) continue;
			entries.push({
				key: `async:${job.asyncId}:${index}`,
				agent: step.label ? `${step.label} (${step.agent})` : step.agent,
				description: job.description,
				startedAt: step.startedAt ?? startedAt,
				tokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),
			});
		}
	}

	return entries.sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key));
}

export class SubagentFleetStatus {
	private ctx: ExtensionContext | undefined;
	private tui: FleetStatusTui | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private active = false;
	private selectedKey = "main";
	private inspectorOpen = false;
	private lastRenderKey = "";
	private entries: FleetStatusEntry[] = [];
	private readonly state: SubagentState;
	private readonly openInspector: (itemKey: string) => Promise<void> | void;
	private readonly refreshMs: number;
	private readonly maxAgentRows: number;

	constructor(
		state: SubagentState,
		openInspector: (itemKey: string) => Promise<void> | void,
		options: FleetStatusOptions = {},
	) {
		this.state = state;
		this.openInspector = openInspector;
		this.refreshMs = options.refreshMs ?? REFRESH_MS;
		this.maxAgentRows = options.maxAgentRows ?? MAX_AGENT_ROWS;
	}

	setContext(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (this.ctx?.ui === ctx.ui) {
			this.ctx = ctx;
			this.refresh();
			return;
		}
		this.clearUiRegistration();
		this.ctx = ctx;
		if (typeof ctx.ui.onTerminalInput === "function") {
			this.inputUnsubscribe = ctx.ui.onTerminalInput((data) => this.handleKey(data));
		}
		this.timer = setInterval(() => this.refresh(), this.refreshMs);
		this.timer.unref?.();
		this.refresh();
	}

	dispose(): void {
		this.clearUiRegistration();
		this.ctx = undefined;
		this.entries = [];
		this.active = false;
		this.selectedKey = "main";
		this.inspectorOpen = false;
		this.lastRenderKey = "";
	}

	refresh(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		this.entries = collectFleetStatusEntries(this.state);
		this.clampSelection();
		if (this.entries.length === 0) {
			this.active = false;
			this.selectedKey = "main";
			this.lastRenderKey = "";
			if (this.widgetRegistered) {
				ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		const renderKey = this.getRenderKey();
		if (!this.widgetRegistered) {
			ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					invalidate: () => {
						this.lastRenderKey = "";
					},
					dispose: () => {
						if (this.tui !== tui) return;
						this.widgetRegistered = false;
						this.tui = undefined;
					},
				};
			}, { placement: "belowEditor" });
			this.widgetRegistered = true;
			this.lastRenderKey = renderKey;
			return;
		}
		if (renderKey === this.lastRenderKey) return;
		this.lastRenderKey = renderKey;
		this.tui?.requestRender();
	}

	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		const ctx = this.ctx;
		if (!ctx?.hasUI || this.entries.length === 0 || isKeyRelease(data)) return undefined;
		if (this.inspectorOpen) return undefined;
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}

		if (!this.active) {
			const activates = matchesKey(data, "down") || matchesKey(data, "left");
			if (!activates || ctx.ui.getEditorText() !== "") return undefined;
			this.active = true;
			this.selectedKey = "main";
			this.refresh();
			return { consume: true };
		}

		const roster = this.rosterKeys();
		const selectedIndex = Math.max(0, roster.indexOf(this.selectedKey));
		if (matchesKey(data, "down")) {
			this.selectedKey = roster[Math.min(roster.length - 1, selectedIndex + 1)] ?? "main";
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			if (selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedKey = roster[selectedIndex - 1] ?? "main";
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedKey === "main") {
				this.deactivate();
				return { consume: true };
			}
			this.inspectorOpen = true;
			this.refresh();
			const selectedKey = this.selectedKey;
			void Promise.resolve()
				.then(() => this.openInspector(selectedKey))
				.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
				.finally(() => {
					this.inspectorOpen = false;
					this.refresh();
				});
			return { consume: true };
		}

		this.deactivate();
		return undefined;
	}

	render(width: number, theme: Theme): string[] {
		if (this.entries.length === 0) return [];
		const roster = this.rosterKeys();
		const selectedIndex = Math.max(0, roster.indexOf(this.selectedKey));
		const hint = this.active
			? "↑↓ select · enter inspect · esc back"
			: "esc to interrupt · ← for agents · ↓ to manage";
		const lines = [truncateToWidth(`  ${theme.fg("dim", hint)}`, width), ""];
		lines.push(truncateToWidth(`  ${this.bullet(0, selectedIndex, theme)} main`, width));

		const visibleCount = Math.min(this.maxAgentRows, this.entries.length);
		const selectedAgentIndex = Math.max(0, selectedIndex - 1);
		const start = selectedAgentIndex < visibleCount ? 0 : selectedAgentIndex - visibleCount + 1;
		const hiddenBelow = this.entries.length - (start + visibleCount);
		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let index = start; index < start + visibleCount; index++) {
			lines.push(this.renderEntry(index + 1, selectedIndex, this.entries[index]!, width, theme));
		}
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
		return lines;
	}

	private renderEntry(rosterIndex: number, selectedIndex: number, entry: FleetStatusEntry, width: number, theme: Theme): string {
		const description = entry.description?.replace(/\s+/g, " ").trim();
		const left = `  ${this.bullet(rosterIndex, selectedIndex, theme)} ${theme.fg("muted", entry.agent)}${description ? `  ${description}` : ""}`;
		const elapsed = Date.now() - entry.startedAt;
		const right = theme.fg("dim", `${formatFleetElapsed(elapsed)} · ${formatFleetTokens(entry.tokens)}`);
		return rightAlign(left, right, width);
	}

	private bullet(rosterIndex: number, selectedIndex: number, theme: Theme): string {
		return rosterIndex === selectedIndex ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
	}

	private rosterKeys(): string[] {
		return ["main", ...this.entries.map((entry) => entry.key)];
	}

	private clampSelection(): void {
		if (!this.rosterKeys().includes(this.selectedKey)) this.selectedKey = "main";
	}

	private deactivate(): void {
		this.active = false;
		this.selectedKey = "main";
		this.refresh();
	}

	private editorHasFocus(): boolean {
		// pi-tui exposes focus mutation but no focus getter; fail closed if this compatibility seam disappears.
		const focused = (this.tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		return focused instanceof Editor;
	}

	private getRenderKey(): string {
		const now = Date.now();
		return JSON.stringify({
			active: this.active,
			selected: this.selectedKey,
			inspectorOpen: this.inspectorOpen,
			entries: this.entries.map((entry) => [
				entry.key,
				entry.agent,
				entry.description,
				Math.round((now - entry.startedAt) / 1000),
				entry.tokens,
			]),
		});
	}

	private clearUiRegistration(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inputUnsubscribe?.();
		this.inputUnsubscribe = undefined;
		if (this.ctx?.hasUI && this.widgetRegistered) {
			try {
				this.ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
			} catch {
				// The previous extension context may already be stale during reload/session replacement.
			}
		}
		this.widgetRegistered = false;
		this.tui = undefined;
	}
}
