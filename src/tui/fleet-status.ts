import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { snapshotExternalRuns } from "../api/external-runs.ts";
import { formatModelThinking } from "../shared/formatters.ts";
import type { AsyncJobStep, FleetViewPlacement, NestedRunSummary, NestedStepSummary, SubagentState } from "../shared/types.ts";
import { formatWorkflowJsonPreview } from "../workflows/scripted-workflow.ts";

export const FLEET_STATUS_WIDGET_KEY = "subagent-fleet-status";

// Six rows fit the accepted collapsed hierarchy: one owner, four visible descendants, and overflow.
const MAX_AGENT_ROWS = 6;
const REFRESH_MS = 500;

type Theme = ExtensionContext["ui"]["theme"];
type FleetStatusTui = {
	requestRender(): void;
};
type FleetStatusEntry = {
	key: string;
	parentKey?: string;
	workflowWrapper?: boolean;
	agent: string;
	modelThinking?: string;
	description?: string;
	startedAt: number;
	tokens: number;
	state: string;
	external?: true;
	nestedChildren?: NestedRunSummary[];
};

type FleetNestedRow = {
	name: string;
	state: NestedRunSummary["state"] | NestedStepSummary["status"];
	modelThinking?: string;
	activity?: string;
	startedAt?: number;
	depth: number;
	overflow?: number;
};

type FleetTreeRow =
	| { kind: "owner"; entry: FleetStatusEntry }
	| { kind: "child"; entry: FleetStatusEntry; last: boolean }
	| { kind: "nested"; ownerKey: string; row: FleetNestedRow; last: boolean };

export interface FleetStatusOptions {
	refreshMs?: number;
	maxAgentRows?: number;
	placement?: FleetViewPlacement;
}

export function resolveFleetViewPlacement(value: unknown): FleetViewPlacement {
	return value === "aboveEditor" ? "aboveEditor" : "belowEditor";
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

function nestedRunLabel(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.length === 1 ? run.agents[0]! : `${run.agents.slice(0, 2).join(", ")}${run.agents.length > 2 ? ` +${run.agents.length - 2}` : ""}`;
	return run.id;
}

function nestedActivity(node: NestedRunSummary | NestedStepSummary): string | undefined {
	if (node.currentTool) return `tool ${node.currentTool}`;
	if (node.currentPath) return node.currentPath.split(/[\\/]/).at(-1);
	if (node.activityState === "needs_attention") return "needs attention";
	if (node.activityState === "active_long_running") return "long-running";
	return undefined;
}

function nestedStatusGlyph(state: FleetNestedRow["state"], theme: Theme): string {
	if (state === "running") return theme.fg("accent", "●");
	if (state === "queued" || state === "pending") return theme.fg("muted", "◦");
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed" || state === "rejected") return theme.fg("error", "✗");
	return theme.fg("warning", "■");
}

function nestedStepDisplayCount(steps: NestedStepSummary[] | undefined, start = 0): number {
	let count = 0;
	for (let index = start; index < (steps?.length ?? 0); index++) {
		count += 1 + nestedDisplayCount(steps![index]!.children);
	}
	return count;
}

function nestedDisplayCount(children: NestedRunSummary[] | undefined, start = 0): number {
	let count = 0;
	for (let index = start; index < (children?.length ?? 0); index++) {
		const child = children![index]!;
		const steps = (child.mode === "parallel" || child.mode === "chain") ? child.steps ?? [] : [];
		count += steps.length > 0 ? nestedStepDisplayCount(steps) : 1;
		count += nestedDisplayCount(child.children);
	}
	return count;
}

function nestedFleetRows(children: NestedRunSummary[] | undefined, visibleLimit: number): FleetNestedRow[] {
	const rows: FleetNestedRow[] = [];
	let omitted = 0;
	const appendRuns = (runs: NestedRunSummary[] | undefined, depth: number): boolean => {
		for (let runIndex = 0; runIndex < (runs?.length ?? 0); runIndex++) {
			const child = runs![runIndex]!;
			const steps = (child.mode === "parallel" || child.mode === "chain") ? child.steps ?? [] : [];
			if (steps.length > 0) {
				for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
					if (rows.length >= visibleLimit) {
						omitted += nestedStepDisplayCount(steps, stepIndex);
						omitted += nestedDisplayCount(child.children);
						omitted += nestedDisplayCount(runs, runIndex + 1);
						return false;
					}
					const step = steps[stepIndex]!;
					const modelThinking = formatModelThinking(step.model, step.thinking) || undefined;
					const activity = nestedActivity(step);
					rows.push({
						name: step.agent,
						state: step.status,
						depth,
						...(modelThinking ? { modelThinking } : {}),
						...(activity ? { activity } : {}),
						...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
					});
					if (!appendRuns(step.children, depth + 1)) {
						omitted += nestedStepDisplayCount(steps, stepIndex + 1);
						omitted += nestedDisplayCount(child.children);
						omitted += nestedDisplayCount(runs, runIndex + 1);
						return false;
					}
				}
			} else {
				if (rows.length >= visibleLimit) {
					omitted += nestedDisplayCount(runs, runIndex);
					return false;
				}
				const modelThinking = formatModelThinking(child.model, child.thinking) || undefined;
				const activity = nestedActivity(child);
				rows.push({
					name: nestedRunLabel(child),
					state: child.state,
					depth,
					...(modelThinking ? { modelThinking } : {}),
					...(activity ? { activity } : {}),
					...(child.startedAt !== undefined ? { startedAt: child.startedAt } : {}),
				});
			}
			if (!appendRuns(child.children, depth + 1)) {
				omitted += nestedDisplayCount(runs, runIndex + 1);
				return false;
			}
		}
		return true;
	};
	appendRuns(children, 0);
	if (omitted > 0) rows.push({ name: `… +${omitted} more nested leaves`, state: "complete", depth: 0, overflow: omitted });
	return rows;
}

function fleetTreeRows(entries: FleetStatusEntry[]): FleetTreeRow[] {
	const rows: FleetTreeRow[] = [];
	const entryKeys = new Set(entries.map((entry) => entry.key));
	const childrenByParent = new Map<string, FleetStatusEntry[]>();
	for (const entry of entries) {
		if (!entry.parentKey || !entryKeys.has(entry.parentKey)) continue;
		const children = childrenByParent.get(entry.parentKey) ?? [];
		children.push(entry);
		childrenByParent.set(entry.parentKey, children);
	}
	for (const entry of entries) {
		if (entry.parentKey && entryKeys.has(entry.parentKey)) continue;
		rows.push({ kind: "owner", entry });
		const attached = childrenByParent.get(entry.key) ?? [];
		for (const [index, child] of attached.entries()) {
			const nested = nestedFleetRows(child.nestedChildren, 3);
			const laterRows = index < attached.length - 1 || Boolean(entry.nestedChildren?.length);
			rows.push({ kind: "child", entry: child, last: !laterRows && nested.length === 0 });
			for (const [nestedIndex, row] of nested.entries()) rows.push({
				kind: "nested",
				ownerKey: child.key,
				row: { ...row, depth: row.depth + 1 },
				last: nestedIndex === nested.length - 1 && !laterRows,
			});
		}
		const nested = nestedFleetRows(entry.nestedChildren, attached.length > 0 ? 3 : 4);
		for (const [index, row] of nested.entries()) rows.push({ kind: "nested", ownerKey: entry.key, row, last: index === nested.length - 1 });
	}
	return rows;
}

function isStaleExtensionContextError(error: unknown): boolean {
	// Pi currently exposes stale contexts as plain Errors without a stable code or subtype.
	return error instanceof Error
		&& (error.message.includes("This extension ctx is stale")
			|| error.message.includes("Extension context no longer active"));
}

function foregroundDescription(control: { parentWorkflowRunId?: string; workflowKey?: string }, description: string | undefined): string | undefined {
	if (!control.parentWorkflowRunId) return description;
	const workflow = `workflow child: ${control.parentWorkflowRunId}${control.workflowKey ? ` (${control.workflowKey})` : ""}`;
	return description ? `${workflow} · ${description}` : workflow;
}

function activeLeafAgentCount(entries: FleetStatusEntry[]): number {
	return entries.filter((entry) => !entry.workflowWrapper).length;
}

export function collectFleetStatusEntries(state: SubagentState): FleetStatusEntry[] {
	const entries: FleetStatusEntry[] = [];
	const activeWorkflowKeys = new Set([...state.asyncJobs.values()]
		.filter((job) => job.mode === "workflow" && isActiveState(job.status))
		.map((job) => `async:${job.asyncId}`));
	for (const control of state.foregroundControls.values()) {
		const parentKey = control.parentWorkflowRunId ? `async:${control.parentWorkflowRunId}` : undefined;
		const linkedParentKey = parentKey && activeWorkflowKeys.has(parentKey) ? parentKey : undefined;
		if (control.activeChildren) {
			for (const child of [...control.activeChildren.values()].sort((left, right) => left.index - right.index)) {
				const modelThinking = formatModelThinking(child.model, child.thinking) || undefined;
				entries.push({
					key: `foreground-active:${control.runId}:${child.index}`,
					...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
					agent: child.agent,
					...(modelThinking ? { modelThinking } : {}),
					description: foregroundDescription(control, child.description),
					startedAt: child.startedAt,
					tokens: child.tokens ?? 0,
					state: "running",
					...((control.nestedChildren?.filter((nested) => nested.parentStepIndex === child.index).length ?? 0) > 0
						? { nestedChildren: control.nestedChildren!.filter((nested) => nested.parentStepIndex === child.index) }
						: control.activeChildren.size === 1 && control.nestedChildren?.length ? { nestedChildren: control.nestedChildren } : {}),
				});
			}
			continue;
		}
		const modelThinking = formatModelThinking(control.model, control.thinking) || undefined;
		entries.push({
			key: `foreground-active:${control.runId}:${control.currentIndex ?? 0}`,
			...(linkedParentKey ? { parentKey: linkedParentKey } : {}),
			agent: control.currentAgent ?? control.mode,
			...(modelThinking ? { modelThinking } : {}),
			description: foregroundDescription(control, control.description),
			startedAt: control.startedAt,
			tokens: control.tokens ?? 0,
			state: "running",
			...(control.nestedChildren?.length ? { nestedChildren: control.nestedChildren } : {}),
		});
	}

	for (const job of state.asyncJobs.values()) {
		if (!isActiveState(job.status)) continue;
		const startedAt = job.startedAt ?? job.updatedAt ?? Date.now();
		if (job.mode === "workflow") {
			const latestEmit = job.workflow?.emits?.length ? formatWorkflowJsonPreview(job.workflow.emits.at(-1), 120) : undefined;
			entries.push({
				key: `async:${job.asyncId}`,
				workflowWrapper: true,
				agent: "workflow",
				description: latestEmit !== undefined ? `latest emit: ${latestEmit}` : job.description,
				startedAt,
				tokens: job.totalTokens?.total ?? 0,
				state: job.status,
				...(job.nestedChildren?.length ? { nestedChildren: job.nestedChildren } : {}),
			});
			continue;
		}
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
				state: job.status,
				...(job.nestedChildren?.length ? { nestedChildren: job.nestedChildren } : {}),
			});
			continue;
		}
		for (const [offset, step] of steps.entries()) {
			if (!isActiveState(step.status)) continue;
			const index = step.index ?? offset;
			if (step.status === "pending" && job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0)) continue;
			const modelThinking = formatModelThinking(step.model, step.thinking) || undefined;
			entries.push({
				key: `async:${job.asyncId}:${index}`,
				agent: step.label ? `${step.label} (${step.agent})` : step.agent,
				...(modelThinking ? { modelThinking } : {}),
				description: step.description ?? job.description,
				startedAt: step.startedAt ?? startedAt,
				tokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),
				state: step.status,
				...((step.children?.length ?? 0) > 0
					? { nestedChildren: step.children }
					: job.nestedChildren?.filter((nested) => nested.parentStepIndex === index).length
						? { nestedChildren: job.nestedChildren.filter((nested) => nested.parentStepIndex === index) }
						: {}),
			});
		}
	}

	if (state.currentSessionId) {
		try {
			for (const run of snapshotExternalRuns(state.currentSessionId, { ignoreMalformed: true, onMalformedRecord: (message) => console.warn(`[pi-subagents] Removed ${message}`) })) {
				if (!isActiveState(run.state)) continue;
				entries.push({
					key: `external:${run.id}`,
					agent: `external · ${run.label}`,
					description: run.currentAction ?? `source: ${run.source}`,
					startedAt: run.startedAt,
					tokens: 0,
					state: run.state,
					external: true,
				});
			}
		} catch (cause) {
			console.warn(`[pi-subagents] Failed to inspect external jobs: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}

	return entries.sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key));
}

export class SubagentFleetStatus {
	private ctx: ExtensionContext | undefined;
	private ui: ExtensionContext["ui"] | undefined;
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
	private readonly placement: FleetViewPlacement;

	constructor(
		state: SubagentState,
		openInspector: (itemKey: string) => Promise<void> | void,
		options: FleetStatusOptions = {},
	) {
		this.state = state;
		this.openInspector = openInspector;
		this.refreshMs = options.refreshMs ?? REFRESH_MS;
		this.maxAgentRows = options.maxAgentRows ?? MAX_AGENT_ROWS;
		this.placement = options.placement ?? "belowEditor";
	}

	setContext(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const ui = ctx.ui;
		if (this.ui === ui) {
			this.ctx = ctx;
			this.refresh();
			return;
		}
		this.clearUiRegistration();
		this.ctx = ctx;
		this.ui = ui;
		if (typeof ui.onTerminalInput === "function") {
			this.inputUnsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
		}
		this.timer = setInterval(() => this.refresh(), this.refreshMs);
		this.timer.unref?.();
		this.refresh();
	}

	dispose(): void {
		this.clearUiRegistration();
		this.ctx = undefined;
		this.ui = undefined;
		this.entries = [];
		this.active = false;
		this.selectedKey = "main";
		this.inspectorOpen = false;
		this.lastRenderKey = "";
	}

	refresh(): void {
		const ctx = this.getActiveUiContext();
		if (!ctx) return;
		if (this.state.widgetsSuspended) {
			this.clearWidget();
			return;
		}
		this.entries = collectFleetStatusEntries(this.state);
		this.clampSelection();
		if (this.inspectorOpen || this.state.fleetInspectorOpen) {
			this.lastRenderKey = "";
			this.clearWidget();
			return;
		}
		if (this.entries.length === 0 && !(this.state.activeAsyncCapacity?.used)) {
			this.active = false;
			this.selectedKey = "main";
			this.lastRenderKey = "";
			this.clearWidget();
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
			}, { placement: this.placement });
			this.widgetRegistered = true;
			this.lastRenderKey = renderKey;
			return;
		}
		if (renderKey === this.lastRenderKey) return;
		this.lastRenderKey = renderKey;
		this.tui?.requestRender();
	}

	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (this.state.widgetsSuspended) return undefined;
		const ctx = this.getActiveUiContext();
		if (!ctx || this.entries.length === 0 || isKeyRelease(data)) return undefined;
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
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedKey = roster[Math.min(roster.length - 1, selectedIndex + 1)] ?? "main";
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
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
		if (this.entries.length === 0 && !(this.state.activeAsyncCapacity?.used)) return [];
		if (!this.active) {
			const tokens = this.entries.reduce((total, entry) => total + entry.tokens, 0);
			const capacity = this.state.activeAsyncCapacity;
			const hasNativeRows = this.entries.some((entry) => !entry.external);
			const showNativeSummary = hasNativeRows || Boolean(capacity?.used);
			const asyncRuns = capacity && showNativeSummary ? `Async runs ${capacity.used}/${capacity.limit || "∞"}` : "";
			const activeEntries = activeLeafAgentCount(this.entries);
			const noun = this.entries.some((entry) => entry.external) ? "job" : "agent";
			const agents = activeEntries > 0 ? `${activeEntries} active ${noun}${activeEntries === 1 ? "" : "s"}` : "";
			const label = [agents, asyncRuns].filter(Boolean).join(" · ");
			const detail = [showNativeSummary ? formatFleetTokens(tokens) : undefined, "↓/← to inspect"].filter(Boolean).join(" · ");
			return [truncateToWidth(`  ${theme.fg("muted", label)} · ${theme.fg("dim", detail)}`, width)];
		}
		const roster = this.rosterKeys();
		const selectedIndex = Math.max(0, roster.indexOf(this.selectedKey));
		const lines = [truncateToWidth(`  ${theme.fg("dim", "↑↓/jk select · enter inspect · esc back")}`, width), ""];
		lines.push(truncateToWidth(`  ${this.bullet(0, selectedIndex, theme)} main`, width));

		const tree = fleetTreeRows(this.entries);
		const selectedTreeIndex = Math.max(0, tree.findIndex((row) => (row.kind === "owner" || row.kind === "child") && row.entry.key === this.selectedKey));
		const visibleCount = Math.min(this.maxAgentRows, tree.length);
		const start = selectedTreeIndex < visibleCount ? 0 : selectedTreeIndex - visibleCount + 1;
		const hiddenBelow = tree.length - (start + visibleCount);
		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let index = start; index < start + visibleCount; index++) {
			const row = tree[index]!;
			if (row.kind === "owner" || row.kind === "child") {
				const ownerIndex = this.entries.findIndex((entry) => entry.key === row.entry.key);
				lines.push(this.renderEntry(ownerIndex + 1, selectedIndex, row.entry, width, theme, row.kind === "child" ? (row.last ? "└─" : "├─") : undefined));
			} else {
				lines.push(this.renderNestedRow(row.row, row.last, width, theme));
			}
		}
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
		return lines;
	}

	private renderEntry(rosterIndex: number, selectedIndex: number, entry: FleetStatusEntry, width: number, theme: Theme, branch?: string): string {
		const agent = entry.modelThinking ? `${entry.agent} (${entry.modelThinking})` : entry.agent;
		const prefix = branch ? `    ${branch}` : " ";
		const left = `${prefix} ${this.bullet(rosterIndex, selectedIndex, theme)} ${theme.fg("muted", agent)} · ${entry.state}`;
		const elapsed = Date.now() - entry.startedAt;
		const right = theme.fg("dim", entry.external ? formatFleetElapsed(elapsed) : `${formatFleetElapsed(elapsed)} · ${formatFleetTokens(entry.tokens)}`);
		return rightAlign(left, right, width);
	}

	private renderNestedRow(row: FleetNestedRow, last: boolean, width: number, theme: Theme): string {
		const marker = last ? "└─" : "├─";
		const indent = "    ".repeat(row.depth + 1);
		if (row.overflow !== undefined) return truncateToWidth(`${indent}${marker} ${theme.fg("dim", `+${row.overflow} nested leaves`)}`, width);
		const modelThinking = row.modelThinking ? ` (${row.modelThinking})` : "";
		const activity = row.activity ? ` · ${row.activity}` : "";
		const left = `${indent}${marker} ${nestedStatusGlyph(row.state, theme)} ${theme.fg("muted", `${row.name}${modelThinking}`)} · ${row.state}${activity}`;
		const elapsed = row.startedAt !== undefined ? ` · ${formatFleetElapsed(Date.now() - row.startedAt)}` : "";
		return truncateToWidth(`${left}${theme.fg("dim", elapsed)}`, width);
	}

	private bullet(rosterIndex: number, selectedIndex: number, theme: Theme): string {
		return rosterIndex === selectedIndex ? theme.fg("accent", ">") : " ";
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
		// pi-tui exposes focus mutation but no focus getter, so inspect the focused
		// component structurally. instanceof is unreliable across jiti module boundaries.
		const focused = (this.tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		if (!focused || typeof focused !== "object") return false;
		const candidate = focused as Partial<EditorComponent>;
		return typeof candidate.render === "function"
			&& typeof candidate.invalidate === "function"
			&& typeof candidate.handleInput === "function"
			&& typeof candidate.getText === "function"
			&& typeof candidate.setText === "function";
	}

	private getRenderKey(): string {
		const now = Date.now();
		return JSON.stringify({
			active: this.active,
			selected: this.selectedKey,
			inspectorOpen: this.inspectorOpen,
			entries: this.entries.map((entry) => this.active
				? [
					entry.key,
					entry.parentKey,
					entry.agent,
					entry.state,
					entry.modelThinking,
					entry.description,
					entry.external,
					Math.round((now - entry.startedAt) / 1000),
					entry.tokens,
					nestedFleetRows(entry.nestedChildren, entry.parentKey ? 3 : 4).map((row) => [
						row.name,
						row.state,
						row.modelThinking,
						row.activity,
						row.startedAt,
						row.depth,
						row.overflow,
					]),
				]
				: [entry.key, entry.state, entry.external, entry.tokens]),
		});
	}

	private getActiveUiContext(): ExtensionContext | undefined {
		const ctx = this.ctx;
		if (!ctx) return undefined;
		try {
			return ctx.hasUI ? ctx : undefined;
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			this.clearUiRegistration();
			return undefined;
		}
	}

	private clearWidget(): void {
		if (!this.widgetRegistered) return;
		this.ui?.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private clearUiRegistration(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;

		const inputUnsubscribe = this.inputUnsubscribe;
		const ui = this.ui;
		const widgetRegistered = this.widgetRegistered;
		this.inputUnsubscribe = undefined;
		this.ctx = undefined;
		this.ui = undefined;
		this.widgetRegistered = false;
		this.tui = undefined;

		const cleanupErrors: unknown[] = [];
		try {
			inputUnsubscribe?.();
		} catch (error) {
			if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
		}
		if (ui && widgetRegistered) {
			try {
				ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) {
			throw new AggregateError(cleanupErrors, "Failed to clean up FleetView UI registration");
		}
	}
}
