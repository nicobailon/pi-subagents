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
	type WaitToolConfig,
} from "../../shared/types.ts";
import { formatDuration } from "../../shared/formatters.ts";
import { totalLiveBackgroundWork, backgroundWorkWakeChannels, reconcileBackgroundWork } from "./bg-providers.ts";

/** States that mean a run is still in flight (not yet resolved). */
const ACTIVE_STATES: ReadonlyArray<AsyncRunSummary["state"]> = ["queued", "running"];

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export const WAIT_TOOL_ENABLED_ENV = "PI_SUBAGENT_WAIT_TOOL_ENABLED";

export interface ResolvedWaitToolConfig {
	enabled: boolean;
}

const WAIT_TOOL_TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const WAIT_TOOL_FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function parseWaitToolEnabledEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (WAIT_TOOL_TRUE_VALUES.has(normalized)) return true;
	if (WAIT_TOOL_FALSE_VALUES.has(normalized)) return false;
	throw new Error(`${WAIT_TOOL_ENABLED_ENV} must be one of true/false, 1/0, yes/no, on/off, or enabled/disabled.`);
}

function configWaitToolEnabled(config: unknown): boolean | undefined {
	if (config === undefined) return undefined;
	if (typeof config === "boolean") return config;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("config.waitTool must be a boolean or an object with optional enabled boolean.");
	}
	const enabled = (config as { enabled?: unknown }).enabled;
	if (enabled === undefined) return undefined;
	if (typeof enabled !== "boolean") throw new Error("config.waitTool.enabled must be a boolean.");
	return enabled;
}

export function resolveWaitToolConfig(config?: WaitToolConfig, env: Record<string, string | undefined> = process.env): ResolvedWaitToolConfig {
	return {
		enabled: parseWaitToolEnabledEnv(env[WAIT_TOOL_ENABLED_ENV]) ?? configWaitToolEnabled(config) ?? true,
	};
}

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
	/**
	 * Optional event bus (pi.events). When provided, subagent_wait wakes immediately on a
	 * subagent completion/control event instead of waiting out the poll interval;
	 * the poll then remains as a reconciliation fallback (crashed runners, missed
	 * events). Omit in tests that want pure poll behavior.
	 */
	events?: WaitEventBus;
	/**
	 * Count of in-flight background work across all registered providers. Defaults
	 * to summing every provider's liveCount() (see bg-providers.ts); injectable
	 * for tests.
	 */
	bgTaskCount?: () => number;
	/**
	 * Run registered providers' health checks (reconcile) once per poll tick, so a
	 * wedged/dead provider unit is resolved instead of blocking subagent_wait forever.
	 * Defaults to reconcileBackgroundWork; injectable for tests.
	 */
	reconcileBg?: (nowMs: number) => void;
}

/** Subagent-run bus channels that indicate a run changed state or needs attention. */
const SUBAGENT_WAKE_CHANNELS = [
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
];

/**
 * All channels subagent_wait wakes on: the subagent channels above plus whatever wake
 * channels registered background-work providers contribute (e.g. a job-finished
 * event from pi-patty-bg-tasks or any other provider). Computed per call so
 * providers that register after module load are still honored.
 */
function wakeChannels(): string[] {
	return [...SUBAGENT_WAKE_CHANNELS, ...backgroundWorkWakeChannels()];
}

/**
 * Count of in-flight background work across every registered provider.
 * Dependency-free: providers publish themselves on a shared process-global
 * registry, so this returns 0 when nothing is registered. See bg-providers.ts.
 */
function liveBgTaskCount(): number {
	return totalLiveBackgroundWork();
}

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
	return new Promise((resolve) => {
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
		for (const channel of wakeChannels()) {
			try { unsubs.push(events.on(channel, done)); } catch { /* ignore bad channel */ }
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

function summarizeTerminalRuns(runs: AsyncRunSummary[]): string {
	if (runs.length === 0) return "";
	const counts = { complete: 0, failed: 0, paused: 0 } as Record<string, number>;
	for (const run of runs) {
		if (run.state in counts) counts[run.state] += 1;
	}
	const parts: string[] = [];
	if (counts.complete) parts.push(`${counts.complete} complete`);
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.paused) parts.push(`${counts.paused} paused`);
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
		return result("subagent_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED; returning immediately without blocking background subagent runs. Active runs keep going, and you can inspect them with subagent({ action: \"status\" }) or wait for completion notifications.");
	}
	const now = deps.now ?? Date.now;
	const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
	const startedAt = now();

	// A single named run always means "wait until that one is done", regardless
	// of `all`. Otherwise `all` decides: true → every run terminal; false → the
	// first run to finish.
	const waitForAll = params.id ? true : params.all === true;

	// Background work from registered providers (e.g. pi-patty-bg-tasks) is
	// tracked only for an unscoped wait — an `id` targets a specific async run.
	const bgCountFn = deps.bgTaskCount ?? liveBgTaskCount;
	const reconcileBg = deps.reconcileBg ?? reconcileBackgroundWork;
	const trackBg = !params.id;
	// Health-check providers before the first count so a unit that is already
	// dead/wedged at wait entry isn't counted as outstanding.
	if (trackBg) reconcileBg(now());
	const initialBgCount = trackBg ? bgCountFn() : 0;

	let active: AsyncRunSummary[];
	let foreground: ForegroundResumeRun[];
	try {
		active = activeRunsForSession(params, deps);
		foreground = activeDetachedForegroundRuns(params, deps);
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

	if (active.length === 0 && initialBgCount === 0) {
		const finished = params.id
			? `No active run matched "${params.id}". Nothing to wait for.`
			: "No active async runs or background jobs in this session. Nothing to wait for.";
		return result(finished);
	}
	const waitParams = params.id ? { ...params, id: active[0]!.id } : params;

	// The set of runs in flight when the wait began. In first-completion mode we
	// return as soon as any of THESE leaves the active set — a run spawned by a
	// concurrent turn shouldn't satisfy this wait.
	const initialIds = new Set(active.map((run) => run.id));
	const initialCount = initialIds.size;
	let pending = active.filter((run) => !needsAttention(run));

	const done = (active: AsyncRunSummary[], attention: AsyncRunSummary[]): boolean => {
		// A run needing attention always breaks the wait, in either mode: the
		// caller has to act on it (nudge/resume/interrupt) and blocking longer
		// helps nothing.
		if (attention.length > 0) return true;
		const bgNow = trackBg ? bgCountFn() : 0;
		if (waitForAll) {
			// Everything must be terminal: no initial async runs still active AND
			// no background jobs left running.
			return active.every((run) => !initialIds.has(run.id)) && bgNow === 0;
		}
		// First-completion: satisfied once any initially-pending async run is gone,
		// OR any background job has finished (bg count dropped).
		const stillActiveInitial = active.filter((run) => initialIds.has(run.id));
		if (stillActiveInitial.length < initialCount) return true;
		return bgNow < initialBgCount;
	};

	let attention = active.filter((run) => needsAttention(run));

	while (!done(pending, attention)) {
		if (signal?.aborted) {
			const stillActive = pending.map((run) => `${run.id} (${run.state})`).join(", ");
			return result(`Wait aborted after ${formatDuration(now() - startedAt)}. Still active: ${stillActive}.`, true);
		}
		if (now() - startedAt >= timeoutMs) {
			const stillActive = pending.map((run) => `${run.id} (${run.state})`).join(", ");
			return result(
				`Wait timed out after ${formatDuration(timeoutMs)} with ${pending.length} run(s) still active: ${stillActive}. `
					+ `The runs are detached and keep going; call subagent_wait again or inspect with subagent({ action: "status" }).`,
				true,
			);
		}
		await waitForWake(pollIntervalMs, signal, deps);
		// Reconcile provider health each tick: a background unit whose process died
		// or wedged is resolved here (e.g. terminated) so its live count drops and
		// subagent_wait can make progress instead of blocking on a unit that never finishes.
		if (trackBg) reconcileBg(now());
		try {
			active = activeRunsForSession(waitParams, deps);
			pending = active.filter((run) => !needsAttention(run));
			attention = attentionRunsForSession(waitParams, deps, initialIds);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	// Report how the finished run(s) came out. In first-completion mode, name the
	// runs from the initial set that are now terminal.
	let terminalSummary = "";
	let finishedCount = 0;
	try {
		const allNow = allRunsForSession(waitParams, deps);
		const terminal = allNow.filter((run) => !ACTIVE_STATES.includes(run.state) && initialIds.has(run.id));
		finishedCount = terminal.length;
		terminalSummary = summarizeTerminalRuns(terminal);
	} catch {
		// Summary is best-effort; the important part is that the wait resolved.
	}

	const attentionNote = attention.length > 0
		? ` ${attention.length} run(s) need attention: ${attention.map((r) => r.id).join(", ")} — inspect with subagent({ action: "status" }) then nudge/resume/interrupt.`
		: "";

	const stillRunning = pending.filter((run) => initialIds.has(run.id)).length;
	const elapsed = formatDuration(now() - startedAt);
	const outcome = terminalSummary ? ` Outcome: ${terminalSummary}.` : "";

	// Background-job accounting (registered background-work providers).
	const bgNow = trackBg ? bgCountFn() : 0;
	const bgFinished = Math.max(0, initialBgCount - bgNow);
	const bgNote = initialBgCount > 0
		? ` ${bgFinished} of ${initialBgCount} background job(s) finished` + (bgNow > 0 ? `, ${bgNow} still running.` : ".")
		: "";

	if (waitForAll) {
		const parts: string[] = [];
		if (initialCount > 0) parts.push(`${initialCount} async run(s)`);
		if (initialBgCount > 0) parts.push(`${initialBgCount} background job(s)`);
		const scope = params.id ? `run "${params.id}"` : (parts.join(" + ") || "0 runs");
		const status = attention.length > 0 ? "attention required" : "done";
		const notificationText = attention.length > 0
			? "Relevant completion/control events have been observed; inspect status if the notification is not visible yet."
			: "Completion events have been observed; inspect status if the notification is not visible yet.";
		return result(
			`Waited ${elapsed} for ${scope}; ${status}.${outcome}${bgNote}${attentionNote} ${notificationText}`,
		);
	}

	// First-completion mode.
	const remainder = (stillRunning > 0 || bgNow > 0)
		? ` ${stillRunning} run(s) + ${bgNow} background job(s) still in flight — call subagent_wait again to catch the next one.`
		: attention.length > 0
			? " No other runs are waitable until attention is handled."
			: " Nothing remains in flight.";
	const progress = attention.length > 0 && finishedCount === 0
		? `${attention.length} of ${initialCount} run(s) need attention`
		: initialCount > 0
			? `${finishedCount} of ${initialCount} run(s) finished`
			: "no async runs tracked";
	const notificationText = (finishedCount > 0 || bgFinished > 0)
		? " Completion events for the finished work have been observed; inspect status if the notification is not visible yet."
		: " Relevant control events have been observed; inspect status if the notification is not visible yet.";
	return result(
		`Waited ${elapsed}; ${progress}.${outcome}${bgNote}${attentionNote}${remainder}${notificationText}`,
	);
}
