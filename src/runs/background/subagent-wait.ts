/**
 * `subagent_wait` tool: block the current turn until outstanding async runs
 * or a named remembered detached foreground run finishes.
 *
 * Background subagent runs are detached. In an interactive session the parent
 * can end its turn and Pi will wake it with a completion notification. That
 * does not work when the parent is a skill that must run to completion, and it
 * cannot work at all non-interactively (`pi -p ...`), where the run is a single
 * turn: once the turn ends there is nothing left to receive the notification.
 *
 * `subagent_wait` closes that gap. It keeps the turn alive until a tracked async
 * run for this session reaches a terminal state (complete / failed / paused),
 * the caller-supplied timeout elapses, or the turn is aborted. Because it awaits
 * inside the turn, the completion the model was told to wait for is actually
 * observed before the tool returns.
 *
 * By default `subagent_wait` returns as soon as ONE run finishes, so a fleet
 * manager can use it in a rolling-replacement loop: launch N workers, wait for
 * the next one to finish, spawn its replacement, then call `subagent_wait`
 * again — keeping N in flight instead of draining to zero between batches.
 * Pass `all: true` to block until every tracked async run is terminal, or `id`
 * to block on one specific async or remembered detached foreground run.
 *
 * `subagent_wait` also returns when a run needs attention — not just on
 * completion. A child that goes idle or blocks for a decision surfaces
 * `needs_attention` (the same signal Pi shows as a control notice and,
 * interactively, wakes the parent with). Since `subagent_wait` is used exactly
 * where there is no next turn to receive that notice, it must break on it too,
 * or a stuck child would stall the loop until the timeout. Attention runs are
 * reported so the caller can inspect / nudge / resume / interrupt them.
 *
 * Wake mechanism: when given Pi's event bus (`deps.events`), `subagent_wait`
 * subscribes to the subagent completion/control channels and wakes the instant
 * any fires, rather than waiting out a fixed poll interval. A poll still runs
 * on the interval as a reconciliation fallback (crashed runners, missed
 * events), and the poll is the source of truth for what actually changed — the
 * event only ends the sleep early. With no bus, `subagent_wait` degrades to pure
 * polling.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	listBackgroundWorkWakeChannels,
	snapshotBackgroundWork,
	type BackgroundWorkSnapshot,
	type RegisteredBackgroundWorkItem,
} from "../../api/background-work.ts";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type Details,
	type ForegroundResumeRun,
	type SubagentState,
} from "../../shared/types.ts";
import { formatDuration } from "../../shared/formatters.ts";
export { WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, type ResolvedWaitToolConfig } from "./wait-config.ts";

/** States that mean a run is still in flight (not yet resolved). */
const ACTIVE_STATES: ReadonlyArray<AsyncRunSummary["state"]> = ["queued", "running"];

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface SubagentWaitParams {
	/** Optional run id/prefix to wait for. When omitted, waits across every active run in this session. */
	id?: string;
	/**
	 * When true, block until EVERY active run in this session (or matching `id`)
	 * is terminal. Default false: return as soon as the first run finishes, so a
	 * fleet manager can spawn a replacement and wait again. Ignored when `id`
	 * targets a single run.
	 */
	all?: boolean;
	/** Give up after this many milliseconds. Defaults to 30 minutes. */
	timeoutMs?: number;
}

/** Minimal event-bus surface wait subscribes to (matches pi.events). */
export interface WaitEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface SubagentWaitDeps {
	state: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	pollIntervalMs?: number;
	/** False makes the tool return immediately without blocking active async runs. */
	enabled?: boolean;
	/** Injectable sleep for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Internal auto-drain mode waits through needs-attention states. */
	stopOnAttention?: boolean;
	/** Internal auto-drain mode surfaces failed terminal subagent runs as errors. */
	failOnFailedRuns?: boolean;
	/** Injectable provider protocol surfaces for deterministic tests. */
	backgroundWork?: {
		snapshot(sessionId: string, nowMs: number): BackgroundWorkSnapshot;
		wakeChannels(): readonly string[];
	};
	/**
	 * Optional event bus (pi.events). When provided, wait wakes immediately on a
	 * subagent completion/control event instead of waiting out the poll interval;
	 * the poll then remains as a reconciliation fallback (crashed runners, missed
	 * events). Omit in tests that want pure poll behavior.
	 */
	events?: WaitEventBus;
}

/** Bus channels that indicate a run changed state or needs attention. */
const WAKE_CHANNELS = [
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
];

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Sleep up to `ms`, but wake early if a subagent event fires on the bus (or the
 * turn aborts). Returns when the first of those happens. With no bus this is a
 * plain sleep, so the poll interval alone drives progress.
 */
function waitForWake(ms: number, signal: AbortSignal | undefined, deps: SubagentWaitDeps): Promise<void> {
	const sleep = deps.sleep ?? defaultSleep;
	const events = deps.events;
	if (!events) return sleep(ms, signal);
	const providerChannels = deps.backgroundWork?.wakeChannels() ?? listBackgroundWorkWakeChannels();
	return new Promise((resolve, reject) => {
		let settled = false;
		const unsubs: Array<() => void> = [];
		const wakeController = new AbortController();
		const done = () => {
			if (settled) return;
			settled = true;
			wakeController.abort();
			signal?.removeEventListener("abort", done);
			for (const u of unsubs) {
				try { u(); } catch { /* best effort */ }
			}
			resolve();
		};
		if (signal?.aborted) {
			done();
			return;
		}
		signal?.addEventListener("abort", done, { once: true });
		try {
			for (const channel of [...new Set([...WAKE_CHANNELS, ...providerChannels])]) {
				unsubs.push(events.on(channel, done));
			}
		} catch (error) {
			signal?.removeEventListener("abort", done);
			for (const unsubscribe of unsubs) {
				try { unsubscribe(); } catch { /* best effort cleanup */ }
			}
			reject(error);
			return;
		}
		// Poll-interval fallback so we still reconcile even if no event arrives.
		// The local signal cancels that fallback timer when an event wakes us first.
		void sleep(ms, wakeController.signal).then(done);
	});
}

function matchesId(run: AsyncRunSummary, id: string): boolean {
	return run.id === id || run.id.startsWith(id);
}

function activeDetachedForegroundRuns(params: SubagentWaitParams, deps: SubagentWaitDeps): ForegroundResumeRun[] {
	if (!params.id || !deps.state.foregroundRuns) return [];
	const sessionId = deps.state.currentSessionId;
	if (!sessionId) return [];
	return [...deps.state.foregroundRuns.values()].filter((run) =>
		(run.runId === params.id || run.runId.startsWith(params.id!))
		&& run.sessionId === sessionId
		&& run.children.some((child) => child.status === "detached")
	);
}

function summarizeForegroundChildren(run: ForegroundResumeRun, indices: Set<number>): string {
	const counts = new Map<string, number>();
	for (const child of run.children) {
		if (!indices.has(child.index) || child.status === "detached") continue;
		counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
	}
	return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
}

/** A running run that has flagged it needs the parent's attention. */
function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention";
}

function backgroundWorkIdentity(item: RegisteredBackgroundWorkItem): string {
	return `${item.provider}\0${item.sessionId}\0${item.id}`;
}

function backgroundWorkForSession(deps: SubagentWaitDeps, nowMs: number): BackgroundWorkSnapshot {
	const sessionId = deps.state.currentSessionId;
	if (!sessionId) throw new Error("subagent_wait requires an active session identity to scope background work safely.");
	return deps.backgroundWork?.snapshot(sessionId, nowMs) ?? snapshotBackgroundWork(sessionId, nowMs);
}

/** Queued/running runs from this session, including runs that need attention. */
function activeRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const runs = listAsyncRuns(asyncDirRoot, {
		states: [...ACTIVE_STATES],
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
	});
	return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
}

/** Runs (from the initial set) currently flagged needs_attention, for reporting. */
function attentionRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps, initialIds: Set<string>): AsyncRunSummary[] {
	return activeRunsForSession(params, deps).filter((run) => needsAttention(run) && initialIds.has(run.id));
}

/** All runs (any state) for this session, for the final summary. */
function allRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const runs = listAsyncRuns(asyncDirRoot, {
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
	});
	return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
}

function summarizeTerminalRuns(runs: AsyncRunSummary[], providerFinishedCount = 0): string {
	if (runs.length === 0 && providerFinishedCount === 0) return "";
	const counts = { complete: 0, failed: 0, paused: 0 } as Record<string, number>;
	for (const run of runs) {
		if (run.state in counts) counts[run.state] += 1;
	}
	const parts: string[] = [];
	if (counts.complete) parts.push(`${counts.complete} complete`);
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.paused) parts.push(`${counts.paused} paused`);
	if (providerFinishedCount > 0) parts.push(`${providerFinishedCount} provider item(s) finished`);
	return parts.join(", ");
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

async function waitForDetachedForegroundRun(
	run: ForegroundResumeRun,
	signal: AbortSignal | undefined,
	deps: SubagentWaitDeps,
	startedAt: number,
	now: () => number,
	pollIntervalMs: number,
	timeoutMs: number,
): Promise<AgentToolResult<Details>> {
	const initialDetachedIndices = new Set(run.children.filter((child) => child.status === "detached").map((child) => child.index));
	while (true) {
		if (deps.state.currentSessionId !== run.sessionId) {
			return result(`Wait stopped because the active session changed while remembered foreground run "${run.runId}" was still detached. Return to the originating session to inspect or wait for it.`, true);
		}
		const current = deps.state.foregroundRuns?.get(run.runId);
		if (!current || current.sessionId !== run.sessionId) {
			return result(`Remembered foreground run "${run.runId}" disappeared before a terminal child result was recorded. Completion cannot be confirmed; do not launch a replacement without checking the originating child session.`, true);
		}
		const pending = current.children.filter((child) => initialDetachedIndices.has(child.index) && child.status === "detached");
		if (pending.length === 0) {
			const outcome = summarizeForegroundChildren(current, initialDetachedIndices);
			return result(
				`Waited ${formatDuration(now() - startedAt)} for remembered detached foreground run "${run.runId}"; done. Outcome: ${outcome || "no recovered child status"}. Completion event observed; inspect with subagent({ action: "status", id: "${run.runId}" }) for recovered output.`,
			);
		}
		if (signal?.aborted) {
			return result(`Wait aborted after ${formatDuration(now() - startedAt)}. Remembered foreground run "${run.runId}" remains detached.`, true);
		}
		if (now() - startedAt >= timeoutMs) {
			return result(
				`Wait timed out after ${formatDuration(timeoutMs)} with remembered foreground run "${run.runId}" still detached. Reply to any pending supervisor request, then call subagent_wait({ id: "${run.runId}" }) again or inspect status; do not resume or launch a replacement while it remains detached.`,
				true,
			);
		}
		await waitForWake(pollIntervalMs, signal, deps);
	}
}

/**
 * Block until the targeted async or remembered detached foreground run finishes,
 * the timeout elapses, or the turn is aborted. Resolves with a short
 * human-readable summary either way.
 */
export async function waitForSubagents(
	params: SubagentWaitParams,
	signal: AbortSignal | undefined,
	deps: SubagentWaitDeps,
): Promise<AgentToolResult<Details>> {
	if (deps.enabled === false) {
		return result("subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED; returning immediately without blocking background work. Active work keeps going, and you can inspect subagents with subagent({ action: \"status\" }) or rely on completion notifications.");
	}
	if (!deps.state.currentSessionId) {
		return result("subagent_wait requires an active session identity to scope background work safely.", true);
	}

	const now = deps.now ?? Date.now;
	const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
	const startedAt = now();
	const waitForAll = params.id ? true : params.all === true;

	let active: AsyncRunSummary[];
	let foreground: ForegroundResumeRun[];
	let providerSnapshot: BackgroundWorkSnapshot;
	try {
		active = activeRunsForSession(params, deps);
		foreground = activeDetachedForegroundRuns(params, deps);
		providerSnapshot = params.id ? { providers: [], items: [] } : backgroundWorkForSession(deps, startedAt);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	if (params.id) {
		const candidates = [
			...active.map((run) => ({ kind: "async" as const, id: run.id, run })),
			...foreground.map((run) => ({ kind: "foreground" as const, id: run.runId, run })),
		];
		const exact = candidates.filter((candidate) => candidate.id === params.id);
		const matches = exact.length > 0 ? exact : candidates;
		if (matches.length > 1) {
			return result(`Ambiguous subagent run id prefix "${params.id}" matched ${matches.length} active runs: ${matches.map((candidate) => candidate.id).join(", ")}. Pass a longer id.`, true);
		}
		const selected = matches[0];
		if (selected?.kind === "foreground") {
			return waitForDetachedForegroundRun(selected.run, signal, deps, startedAt, now, pollIntervalMs, timeoutMs);
		}
		active = selected?.kind === "async" ? [selected.run] : [];
	}

	let providerActive = providerSnapshot.items;
	if (active.length === 0 && providerActive.length === 0) {
		return result(params.id
			? `No active run matched "${params.id}". Nothing to wait for.`
			: "No active async runs or registered provider work in this session. Nothing to wait for.");
	}
	const waitParams = params.id ? { ...params, id: active[0]!.id } : params;
	const initialAsyncIds = new Set(active.map((run) => run.id));
	const initialProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
	const initialProviderNames = new Set(providerActive.map((item) => item.provider));
	const initialCount = initialAsyncIds.size + initialProviderIds.size;
	const stopOnAttention = deps.stopOnAttention !== false;
	let attention = active.filter((run) => needsAttention(run));

	const isDone = (): boolean => {
		if (stopOnAttention && attention.some((run) => initialAsyncIds.has(run.id))) return true;
		const activeAsyncIds = new Set(active.map((run) => run.id));
		const activeProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
		if (waitForAll) {
			return [...initialAsyncIds].every((id) => !activeAsyncIds.has(id))
				&& [...initialProviderIds].every((id) => !activeProviderIds.has(id));
		}
		return [...initialAsyncIds].some((id) => !activeAsyncIds.has(id))
			|| [...initialProviderIds].some((id) => !activeProviderIds.has(id));
	};

	while (!isDone()) {
		const activeInitialRuns = active.filter((run) => initialAsyncIds.has(run.id));
		const activeInitialProviderItems = providerActive.filter((item) => initialProviderIds.has(backgroundWorkIdentity(item)));
		const stillActive = [
			...activeInitialRuns.map((run) => `${run.id} (${run.state})`),
			...activeInitialProviderItems.map((item) => `${item.provider}/${item.id}`),
		].join(", ");
		if (signal?.aborted) {
			return result(`Wait aborted after ${formatDuration(now() - startedAt)}. Still active: ${stillActive}.`, true);
		}
		if (now() - startedAt >= timeoutMs) {
			return result(
				`Wait timed out after ${formatDuration(timeoutMs)} with ${activeInitialRuns.length} async run(s) and ${activeInitialProviderItems.length} provider item(s) still active: ${stillActive}. The work keeps going; call subagent_wait again or inspect subagent status.`,
				true,
			);
		}
		try {
			await waitForWake(pollIntervalMs, signal, deps);
			active = activeRunsForSession(waitParams, deps);
			attention = attentionRunsForSession(waitParams, deps, initialAsyncIds);
			providerSnapshot = params.id ? providerSnapshot : backgroundWorkForSession(deps, now());
			for (const provider of initialProviderNames) {
				if (!providerSnapshot.providers.includes(provider)) {
					return result(`Background-work provider '${provider}' disappeared while subagent_wait was tracking its active work; completion cannot be confirmed.`, true);
				}
			}
			providerActive = providerSnapshot.items;
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	let terminalSummary: string;
	let finishedAsyncCount: number;
	let failedAsyncCount: number;
	const activeProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
	const providerFinishedCount = [...initialProviderIds].filter((id) => !activeProviderIds.has(id)).length;
	try {
		const allNow = allRunsForSession(waitParams, deps);
		const terminal = allNow.filter((run) => !ACTIVE_STATES.includes(run.state) && initialAsyncIds.has(run.id));
		finishedAsyncCount = terminal.length;
		failedAsyncCount = terminal.filter((run) => run.state === "failed").length;
		terminalSummary = summarizeTerminalRuns(terminal, providerFinishedCount);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	const relevantAttention = attention.filter((run) => initialAsyncIds.has(run.id));
	const attentionNote = relevantAttention.length > 0
		? ` ${relevantAttention.length} run(s) need attention: ${relevantAttention.map((run) => run.id).join(", ")} — inspect with subagent({ action: "status" }) then steer a top-level live async child, resume a paused/completed/failed child, or interrupt explicitly.`
		: "";
	const stillRunning = active.filter((run) => initialAsyncIds.has(run.id)).length
		+ providerActive.filter((item) => initialProviderIds.has(backgroundWorkIdentity(item))).length;
	const elapsed = formatDuration(now() - startedAt);
	const outcome = terminalSummary ? ` Outcome: ${terminalSummary}.` : "";

	if (waitForAll) {
		const scope = params.id
			? `run "${params.id}"`
			: initialProviderIds.size === 0
				? `${initialAsyncIds.size} async run(s)`
				: `${initialAsyncIds.size} async run(s) and ${initialProviderIds.size} provider item(s)`;
		const status = relevantAttention.length > 0 ? "attention required" : "done";
		return result(
			`Waited ${elapsed} for ${scope}; ${status}.${outcome}${attentionNote} Completion/control events have been observed; inspect status if a notification is not visible yet.`,
			deps.failOnFailedRuns === true && failedAsyncCount > 0,
		);
	}

	const finishedCount = finishedAsyncCount + providerFinishedCount;
	const subject = initialProviderIds.size === 0 ? "run(s)" : "item(s)";
	const remainder = stillRunning > 0
		? ` ${stillRunning} ${subject} still in flight — call subagent_wait again to catch the next one.`
		: relevantAttention.length > 0
			? " No other work is waitable until attention is handled."
			: initialProviderIds.size === 0 ? " No runs remain in flight." : " No work remains in flight.";
	const progress = relevantAttention.length > 0 && finishedCount === 0
		? `${relevantAttention.length} of ${initialCount} ${subject} need attention`
		: `${finishedCount} of ${initialCount} ${subject} finished`;
	return result(
		`Waited ${elapsed}; ${progress}.${outcome}${attentionNote}${remainder} Relevant completion/control events have been observed; inspect status if a notification is not visible yet.`,
		deps.failOnFailedRuns === true && failedAsyncCount > 0,
	);
}
