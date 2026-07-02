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
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { ASYNC_DIR, RESULTS_DIR, type Details, type SubagentState } from "../../shared/types.ts";
import { formatDuration } from "../../shared/formatters.ts";

/** States that mean a run is still in flight (not yet resolved). */
const ACTIVE_STATES: ReadonlyArray<AsyncRunSummary["state"]> = ["queued", "running"];

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;

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

export interface WaitDeps {
	state: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	pollIntervalMs?: number;
	/** Injectable sleep for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

function matchesId(run: AsyncRunSummary, id: string): boolean {
	return run.id === id || run.id.startsWith(id);
}

/** A running run that has flagged it needs the parent's attention. */
function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention";
}

/**
 * Runs from this session that are still queued/running AND not asking for
 * attention. A run that needs attention is treated as no longer "pending" so
 * the wait breaks on it (the caller must nudge / resume / interrupt it), the
 * same way a completion breaks the wait.
 */
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
	const scoped = params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
	return scoped.filter((run) => !needsAttention(run));
}

/** Runs (from the initial set) currently flagged needs_attention, for reporting. */
function attentionRunsForSession(params: WaitParams, deps: WaitDeps, initialIds: Set<string>): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const runs = listAsyncRuns(asyncDirRoot, {
		states: [...ACTIVE_STATES],
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
	});
	const scoped = params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
	return scoped.filter((run) => needsAttention(run) && initialIds.has(run.id));
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
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
	const startedAt = now();

	// A single named run always means "wait until that one is done", regardless
	// of `all`. Otherwise `all` decides: true → every run terminal; false → the
	// first run to finish.
	const waitForAll = params.id ? true : params.all === true;

	let pending: AsyncRunSummary[];
	try {
		pending = activeRunsForSession(params, deps);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	if (pending.length === 0) {
		const finished = params.id
			? `No active run matched "${params.id}". Nothing to wait for.`
			: "No active async runs in this session. Nothing to wait for.";
		return result(finished);
	}

	// The set of runs in flight when the wait began. In first-completion mode we
	// return as soon as any of THESE leaves the active set — a run spawned by a
	// concurrent turn shouldn't satisfy this wait.
	const initialIds = new Set(pending.map((run) => run.id));
	const initialCount = initialIds.size;

	const done = (active: AsyncRunSummary[], attention: AsyncRunSummary[]): boolean => {
		// A run needing attention always breaks the wait, in either mode: the
		// caller has to act on it (nudge/resume/interrupt) and blocking longer
		// helps nothing.
		if (attention.length > 0) return true;
		if (waitForAll) return active.length === 0;
		// First-completion: satisfied once any initially-pending run is gone.
		const stillActiveInitial = active.filter((run) => initialIds.has(run.id));
		return stillActiveInitial.length < initialCount;
	};

	let attention: AsyncRunSummary[] = [];
	try {
		attention = attentionRunsForSession(params, deps, initialIds);
	} catch {
		// best-effort; attention reporting is non-critical
	}

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
		await sleep(pollIntervalMs, signal);
		try {
			pending = activeRunsForSession(params, deps);
			attention = attentionRunsForSession(params, deps, initialIds);
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	// Report how the finished run(s) came out. In first-completion mode, name the
	// runs from the initial set that are now terminal.
	let terminalSummary = "";
	let finishedCount = 0;
	try {
		const allNow = allRunsForSession(params, deps);
		const terminal = allNow.filter(
			(run) => !ACTIVE_STATES.includes(run.state) && (waitForAll || initialIds.has(run.id)),
		);
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
		return result(
			`Waited ${elapsed} for ${scope}; done.${outcome}${attentionNote} `
				+ `Completion notifications have been delivered above.`,
		);
	}

	// First-completion mode.
	const remainder = stillRunning > 0
		? ` ${stillRunning} run(s) still in flight — call wait again to catch the next one.`
		: " No runs remain in flight.";
	return result(
		`Waited ${elapsed}; ${finishedCount} of ${initialCount} run(s) finished.${outcome}${attentionNote}`
			+ `${remainder} Completion notifications for the finished run(s) have been delivered above.`,
	);
}
