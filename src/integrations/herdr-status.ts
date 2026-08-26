import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
} from "../shared/types.ts";
import { previewDisplayText, sanitizeDisplayText } from "../shared/display-text.ts";

const DEFAULT_SOURCE = "pi-subagents:herdr";
const DEFAULT_TTL_MS = 120_000;
const DEFAULT_REFRESH_MS = 45_000;
const MAX_TASK_LABEL_CHARS = 80;
const MAX_TITLE_TASK_CHARS = 42;
const MAX_WORKFLOW_LABEL_NODES = 128;
const MAX_WORKFLOW_LABEL_DEPTH = 8;

let metadataReportSeq = Date.now() * 1000;

function nextMetadataReportSeq(): number {
	metadataReportSeq = Math.max(metadataReportSeq + 1, Date.now() * 1000);
	return metadataReportSeq;
}

export interface HerdrStatusBridgeEvents {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

export interface HerdrStatusRun {
	id: string;
	agent?: string;
	agents?: string[];
	/** Explicit launch/workflow label only; raw prompts never enter pane metadata. */
	taskLabel?: string;
	needsAttention?: boolean;
	attentionLabel?: string;
}

export interface HerdrStatusBridgeOptions {
	events: HerdrStatusBridgeEvents;
	env?: Record<string, string | undefined>;
	/** Current authoritative active-run projection, used before TTL refresh. */
	getRuns?: () => Iterable<HerdrStatusRun>;
	/** Current project panes opened by this Pi session. Views are excluded. */
	getProjectPaneCount?: () => number;
	runHerdr: (args: readonly string[]) => void | Promise<void>;
	ttlMs?: number;
	refreshMs?: number;
	timers?: {
		setInterval: typeof setInterval;
		clearInterval: typeof clearInterval;
	};
}

export interface HerdrStatusBridge {
	/**
	 * Binds the pane owner. Only the root interactive session may publish pane
	 * metadata: headless parents (print/json), non-UI harnesses, and child
	 * runtimes must never fight the pane's lifecycle authority over display
	 * state. Also re-syncs runs that survived a reload/resume.
	 */
	sessionStarted(input: { hasUI: boolean; runs: Iterable<HerdrStatusRun> }): void;
	syncRuns(): void;
	agentStarted(): void;
	flush(): Promise<void>;
	dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedTaskLabel(value: unknown, maxChars = MAX_TASK_LABEL_CHARS): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = sanitizeDisplayText(value).trim();
	if (!normalized) return undefined;
	return previewDisplayText(normalized, maxChars);
}

function workflowTaskLabel(data: Record<string, unknown>): string | undefined {
	const explicit = boundedTaskLabel(data.taskLabel);
	if (explicit) return explicit;
	if (!isRecord(data.workflowGraph) || !Array.isArray(data.workflowGraph.nodes)) return undefined;
	const currentNodeId = typeof data.workflowGraph.currentNodeId === "string" ? data.workflowGraph.currentNodeId : undefined;
	const nodes: Record<string, unknown>[] = [];
	const collect = (values: unknown[], depth: number): void => {
		if (depth > MAX_WORKFLOW_LABEL_DEPTH || nodes.length >= MAX_WORKFLOW_LABEL_NODES) return;
		for (const value of values) {
			if (nodes.length >= MAX_WORKFLOW_LABEL_NODES) return;
			if (!isRecord(value)) continue;
			nodes.push(value);
			if (Array.isArray(value.children)) collect(value.children, depth + 1);
		}
	};
	collect(data.workflowGraph.nodes, 0);
	const current = currentNodeId ? nodes.find((node) => node.id === currentNodeId) : undefined;
	const active = current ?? nodes.find((node) => node.status === "running") ?? nodes.find((node) => node.status === "pending");
	return boundedTaskLabel(active?.label);
}

function startedRun(data: unknown): HerdrStatusRun | undefined {
	if (!isRecord(data) || typeof data.id !== "string" || !data.id) return undefined;
	const taskLabel = workflowTaskLabel(data);
	return {
		id: data.id,
		...(typeof data.agent === "string" ? { agent: data.agent } : {}),
		...(Array.isArray(data.agents) && data.agents.every((agent) => typeof agent === "string") ? { agents: data.agents as string[] } : {}),
		...(taskLabel ? { taskLabel } : {}),
	};
}

function completedRunId(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	const id = typeof data.runId === "string" ? data.runId : data.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function attentionNotice(data: unknown): { runId: string; label: string } | undefined {
	if (!isRecord(data) || data.source !== "async" || !isRecord(data.event)) return undefined;
	if (data.event.type !== "needs_attention" || typeof data.event.runId !== "string" || !data.event.runId) return undefined;
	const label = typeof data.noticeText === "string" && data.noticeText
		? data.noticeText
		: typeof data.event.message === "string" && data.event.message
			? data.event.message
			: "subagent needs attention";
	return { runId: data.event.runId, label };
}

export function registerHerdrStatusBridge(options: HerdrStatusBridgeOptions): HerdrStatusBridge {
	const env = options.env ?? process.env;
	const paneId = env.HERDR_PANE_ID;
	const enabled = env.HERDR_ENV === "1" && typeof paneId === "string" && paneId.length > 0;
	const runHerdr = options.runHerdr;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
	const timers = options.timers ?? { setInterval, clearInterval };
	const runs = new Map<string, HerdrStatusRun>();
	const attentionLabels = new Map<string, string>();
	const acknowledgedAttention = new Set<string>();
	const subscriptions: Array<() => void> = [];
	let rootSession = false;
	let published = false;
	let busyRaised = false;
	let busyLabel: string | undefined;
	let blockedRaised = false;
	let blockedLabel: string | undefined;
	let disposed = false;
	let pendingReport: readonly string[] | undefined;
	let draining = false;
	let drainPromise = Promise.resolve();
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	const activeAgentNames = (): string[] => [...new Set([...runs.values()].flatMap((run) => run.agents?.length ? run.agents : run.agent ? [run.agent] : []))];
	const activeSubagentCount = (): number => [...runs.values()].reduce((total, run) => total + Math.max(1, run.agents?.length ?? (run.agent ? 1 : 0)), 0);
	const activeTaskLabel = (): string | undefined => [...runs.values()].reverse().find((run) => run.taskLabel)?.taskLabel;

	const label = (includeAttention = false): string => {
		const agents = activeAgentNames();
		const activeCount = activeSubagentCount();
		const who = agents.length > 0
			? ` (${agents.slice(0, 3).join(", ")}${agents.length > 3 ? ", …" : ""})`
			: "";
		const panes = Math.max(0, options.getProjectPaneCount?.() ?? 0);
		const paneText = panes > 0 ? ` · ${panes} pane${panes === 1 ? "" : "s"}` : "";
		const task = activeTaskLabel();
		const taskText = task ? ` · ${task}` : "";
		const attention = includeAttention && attentionLabels.size > 0 ? " ⚠" : "";
		return `⏳ ${activeCount} subagent${activeCount === 1 ? "" : "s"}${who}${paneText}${taskText}${attention}`;
	};

	const titleSuffix = (): string | undefined => {
		if (runs.size === 0) return undefined;
		const agentNames = activeAgentNames();
		const activeCount = activeSubagentCount();
		const task = boundedTaskLabel(activeTaskLabel(), MAX_TITLE_TASK_CHARS);
		const target = task ?? (activeCount === 1 && agentNames.length === 1 ? agentNames[0]! : String(activeCount));
		return `⏳${target}${attentionLabels.size > 0 ? "⚠" : ""}`;
	};

	const enqueue = (args: readonly string[]): void => {
		pendingReport = args;
		if (draining) return;
		draining = true;
		drainPromise = (async () => {
			while (pendingReport) {
				const next = pendingReport;
				pendingReport = undefined;
				try {
					await runHerdr(next);
				} catch {
					// Herdr integration is best effort; a later state transition or TTL
					// refresh retries with the newest desired snapshot.
				}
			}
		})().finally(() => {
			draining = false;
		});
	};

	const publish = (): void => {
		if (!enabled || !rootSession || disposed || !paneId) return;
		if (runs.size === 0 && !published) return;
		const seq = String(nextMetadataReportSeq());
		if (runs.size === 0) {
			published = false;
			enqueue([
				"pane", "report-metadata", paneId,
				"--source", DEFAULT_SOURCE,
				"--agent", "pi",
				"--applies-to-source", "herdr:pi",
				"--clear-state-labels",
				"--clear-token", "summary",
				"--clear-token", "title-suffix",
				"--seq", seq,
			]);
			return;
		}
		const text = label(true);
		const suffix = titleSuffix();
		published = true;
		enqueue([
			"pane", "report-metadata", paneId,
			"--source", DEFAULT_SOURCE,
			"--agent", "pi",
			"--applies-to-source", "herdr:pi",
			"--state-label", `idle=${text}`,
			"--state-label", `done=${text}`,
			"--state-label", `working=${text}`,
			"--token", `summary=${text}`,
			...(suffix ? ["--token", `title-suffix=${suffix}`] : []),
			"--ttl-ms", String(ttlMs),
			"--seq", seq,
		]);
	};

	const syncRefreshTimer = (): void => {
		if (runs.size > 0 && refreshMs > 0 && !refreshTimer) {
			refreshTimer = timers.setInterval(() => refresh(), refreshMs);
			refreshTimer.unref?.();
		} else if ((runs.size === 0 || refreshMs <= 0) && refreshTimer) {
			timers.clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	};

	const syncBusy = (): void => {
		if (!enabled || !rootSession || disposed) return;
		if (runs.size > 0) {
			const text = label();
			if (busyRaised && busyLabel === text) return;
			if (busyRaised) options.events.emit("herdr:busy", { active: false });
			busyRaised = true;
			busyLabel = text;
			options.events.emit("herdr:busy", { active: true, label: text });
			return;
		}
		if (busyRaised) {
			busyRaised = false;
			busyLabel = undefined;
			options.events.emit("herdr:busy", { active: false });
		}
	};

	const syncBlocked = (): void => {
		if (!enabled || !rootSession || disposed) return;
		const nextLabel = [...attentionLabels.values()].at(-1);
		if (nextLabel !== undefined) {
			if (blockedRaised && blockedLabel === nextLabel) return;
			// Herdr's sibling overlay contract is counted. Lower before changing
			// the active label so this bridge continues to own exactly one count.
			if (blockedRaised) options.events.emit("herdr:blocked", { active: false });
			blockedRaised = true;
			blockedLabel = nextLabel;
			options.events.emit("herdr:blocked", { active: true, label: nextLabel });
			return;
		}
		if (blockedRaised) {
			blockedRaised = false;
			blockedLabel = undefined;
			options.events.emit("herdr:blocked", { active: false });
		}
	};

	const clearAttention = (): void => {
		attentionLabels.clear();
		syncBlocked();
		publish();
	};

	const raiseAttention = (runId: string, labelText: string): void => {
		if (!rootSession || attentionLabels.has(runId)) return;
		acknowledgedAttention.delete(runId);
		attentionLabels.set(runId, labelText);
		syncBlocked();
		publish();
	};

	const replaceRuns = (nextRuns: Iterable<HerdrStatusRun>): void => {
		const nextAttention = new Map<string, string>();
		const activeIds = new Set<string>();
		runs.clear();
		for (const run of nextRuns) {
			if (!run || typeof run.id !== "string" || !run.id) continue;
			activeIds.add(run.id);
			const taskLabel = boundedTaskLabel(run.taskLabel);
			const { taskLabel: _rawTaskLabel, ...sanitizedRun } = run;
			runs.set(run.id, { ...sanitizedRun, ...(taskLabel ? { taskLabel } : {}) });
			if (!run.needsAttention) {
				acknowledgedAttention.delete(run.id);
			} else if (!acknowledgedAttention.has(run.id)) {
				nextAttention.set(run.id, run.attentionLabel || attentionLabels.get(run.id) || "subagent needs attention");
			}
		}
		for (const id of acknowledgedAttention) {
			if (!activeIds.has(id)) acknowledgedAttention.delete(id);
		}
		attentionLabels.clear();
		for (const [id, labelText] of nextAttention) attentionLabels.set(id, labelText);
		syncBusy();
		syncRefreshTimer();
		syncBlocked();
		publish();
	};

	const refresh = (): void => {
		if (!options.getRuns) {
			publish();
			return;
		}
		try {
			replaceRuns(options.getRuns());
		} catch {
			// Keep the last known active projection and retry on the next refresh.
			publish();
		}
	};

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	if (enabled) {
		subscribe(SUBAGENT_ASYNC_STARTED_EVENT, (data) => {
			if (!rootSession) return;
			const run = startedRun(data);
			if (!run) return;
			acknowledgedAttention.delete(run.id);
			runs.set(run.id, run);
			syncBusy();
			syncRefreshTimer();
			publish();
		});
		subscribe(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
			if (!rootSession) return;
			const id = completedRunId(data);
			if (!id || !runs.delete(id)) return;
			acknowledgedAttention.delete(id);
			if (attentionLabels.delete(id)) syncBlocked();
			syncBusy();
			syncRefreshTimer();
			publish();
		});
		subscribe(SUBAGENT_CONTROL_EVENT, (data) => {
			if (!rootSession) return;
			const notice = attentionNotice(data);
			if (!notice || !runs.has(notice.runId)) return;
			raiseAttention(notice.runId, notice.label);
		});
	}

	return {
		agentStarted() {
			for (const id of attentionLabels.keys()) acknowledgedAttention.add(id);
			clearAttention();
		},
		sessionStarted({ hasUI, runs: restoredRuns }) {
			if (!enabled || disposed || hasUI !== true) return;
			rootSession = true;
			replaceRuns(restoredRuns);
		},
		syncRuns() {
			if (!enabled || !rootSession || disposed) return;
			refresh();
		},
		async flush() {
			while (draining || pendingReport) await drainPromise;
		},
		dispose() {
			if (disposed) return;
			clearAttention();
			acknowledgedAttention.clear();
			runs.clear();
			syncBusy();
			syncRefreshTimer();
			publish();
			for (const unsubscribe of subscriptions) unsubscribe();
			disposed = true;
		},
	};
}
