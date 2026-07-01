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
 * `wait` closes that gap. It keeps the turn alive by resolving only once every
 * tracked async run for this session has reached a terminal state
 * (complete / failed / paused), the caller-supplied timeout elapses, or the
 * turn is aborted. Because it awaits inside the turn, the completion the model
 * was told to wait for is actually observed before the tool returns.
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
	/** Optional run id/prefix to wait for. When omitted, waits for every active run in this session. */
	id?: string;
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

/** Snapshot of the async runs this wait call cares about, refreshed from disk. */
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

	const waitedFor = pending.length;

	while (pending.length > 0) {
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
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	// Everything terminal — report how they finished.
	let terminalSummary = "";
	try {
		const terminal = allRunsForSession(params, deps).filter((run) => !ACTIVE_STATES.includes(run.state));
		terminalSummary = summarizeTerminalRuns(terminal);
	} catch {
		// Summary is best-effort; the important part is that the wait resolved.
	}

	const elapsed = formatDuration(now() - startedAt);
	const scope = params.id ? `run "${params.id}"` : `${waitedFor} async run(s)`;
	const outcome = terminalSummary ? ` Outcome: ${terminalSummary}.` : "";
	return result(
		`Waited ${elapsed} for ${scope} to finish; all done.${outcome} `
			+ `Completion notifications for each run have been delivered above.`,
	);
}
