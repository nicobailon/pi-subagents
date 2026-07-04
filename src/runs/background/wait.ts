/**
 * `wait` tool: block the current turn until outstanding async subagent runs
 * finish (or another completion notification arrives).
 *
 * Background subagent runs are detached. In an interactive session the parent
 * can end its turn and Pi will wake it with a completion notification. That
 * does not work when the parent is a skill that must run to completion, and it
 * cannot work at all non-interactively (`pi -p ...`), where the run is a single
 * turn: once the turn ends there is nothing left to receive the notification.
 *
 * `wait` closes that gap. It keeps the turn alive until a tracked async run for
 * this session reaches a terminal state (complete / failed / paused), the
 * caller-supplied timeout elapses, or the turn is aborted. Because it awaits
 * inside the turn, the completion the model was told to wait for is actually
 * observed before the tool returns.
 *
 * By default `wait` returns as soon as ONE run finishes, so a fleet manager can
 * use it in a rolling-replacement loop: launch N workers, wait for the next one
 * to finish, spawn its replacement, wait again — keeping N in flight instead of
 * draining to zero between batches. Pass `all: true` to block until every
 * tracked run is terminal, or `id` to block on one specific run.
 *
 * `wait` also returns when a run needs attention — not just on completion. A
 * child that goes idle or blocks for a decision surfaces `needs_attention`
 * (the same signal Pi shows as a control notice and, interactively, wakes the
 * parent with). Since `wait` is used exactly where there is no next turn to
 * receive that notice, it must break on it too, or a stuck child would stall
 * the loop until the timeout. Attention runs are reported so the caller can
 * inspect / nudge / resume / interrupt them.
 *
 * Wake mechanism: when given Pi's event bus (`deps.events`), `wait` subscribes
 * to the subagent completion/control channels and wakes the instant any fires,
 * rather than waiting out a fixed poll interval. A poll still runs on the
 * interval as a reconciliation fallback (crashed runners, missed events), and
 * the poll is the source of truth for what actually changed — the event only
 * ends the sleep early. With no bus, `wait` degrades to pure polling.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type Details,
	type SubagentState,
	type WaitToolConfig,
} from "../../shared/types.ts";
import { formatDuration } from "../../shared/formatters.ts";

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

export interface WaitParams {
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

export interface WaitDeps {
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
function waitForWake(ms: number, signal: AbortSignal | undefined, deps: WaitDeps): Promise<void> {
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
		for (const channel of WAKE_CHANNELS) {
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

/** A running run that has flagged it needs the parent's attention. */
function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention";
}

/** Queued/running runs from this session, including runs that need attention. */
function activeRunsForSession(params: WaitParams, deps: WaitDeps): AsyncRunSummary[] {
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
function attentionRunsForSession(params: WaitParams, deps: WaitDeps, initialIds: Set<string>): AsyncRunSummary[] {
	return activeRunsForSession(params, deps).filter((run) => needsAttention(run) && initialIds.has(run.id));
}

/** All runs (any state) for this session, for the final summary. */
function allRunsForSession(params: WaitParams, deps: WaitDeps): AsyncRunSummary[] {
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

/**
 * Block until the targeted async runs finish, the timeout elapses, or the turn
 * is aborted. Resolves with a short human-readable summary either way.
 */
export async function waitForSubagents(
	params: WaitParams,
	signal: AbortSignal | undefined,
	deps: WaitDeps,
): Promise<AgentToolResult<Details>> {
	if (deps.enabled === false) {
		return result("Wait tool is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED; returning immediately without blocking background subagent runs. Active runs keep going, and you can inspect them with subagent({ action: \"status\" }) or wait for completion notifications.");
	}
	const now = deps.now ?? Date.now;
	const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
	const startedAt = now();

	// A single named run always means "wait until that one is done", regardless
	// of `all`. Otherwise `all` decides: true → every run terminal; false → the
	// first run to finish.
	const waitForAll = params.id ? true : params.all === true;

	let active: AsyncRunSummary[];
	try {
		active = activeRunsForSession(params, deps);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	if (active.length === 0) {
		const finished = params.id
			? `No active run matched "${params.id}". Nothing to wait for.`
			: "No active async runs in this session. Nothing to wait for.";
		return result(finished);
	}
	if (params.id) {
		const exact = active.filter((run) => run.id === params.id);
		if (exact.length === 1) active = exact;
		else if (active.length > 1) {
			return result(`Ambiguous async run id prefix "${params.id}" matched ${active.length} active runs: ${active.map((run) => run.id).join(", ")}. Pass a longer id.`, true);
		}
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
		if (waitForAll) return active.every((run) => !initialIds.has(run.id));
		// First-completion: satisfied once any initially-pending run is gone.
		const stillActiveInitial = active.filter((run) => initialIds.has(run.id));
		return stillActiveInitial.length < initialCount;
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
					+ `The runs are detached and keep going; call wait again or inspect with subagent({ action: "status" }).`,
				true,
			);
		}
		await waitForWake(pollIntervalMs, signal, deps);
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

	if (waitForAll) {
		const scope = params.id ? `run "${params.id}"` : `${initialCount} async run(s)`;
		const status = attention.length > 0 ? "attention required" : "done";
		const notificationText = attention.length > 0
			? "Relevant completion/control events have been observed; inspect status if the notification is not visible yet."
			: "Completion events have been observed; inspect status if the notification is not visible yet.";
		return result(
			`Waited ${elapsed} for ${scope}; ${status}.${outcome}${attentionNote} ${notificationText}`,
		);
	}

	// First-completion mode.
	const remainder = stillRunning > 0
		? ` ${stillRunning} run(s) still in flight — call wait again to catch the next one.`
		: attention.length > 0
			? " No other runs are waitable until attention is handled."
			: " No runs remain in flight.";
	const progress = attention.length > 0 && finishedCount === 0
		? `${attention.length} of ${initialCount} run(s) need attention`
		: `${finishedCount} of ${initialCount} run(s) finished`;
	const notificationText = finishedCount > 0
		? " Completion events for the finished run(s) have been observed; inspect status if the notification is not visible yet."
		: " Relevant control events have been observed; inspect status if the notification is not visible yet.";
	return result(
		`Waited ${elapsed}; ${progress}.${outcome}${attentionNote}${remainder}${notificationText}`,
	);
}
