import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { snapshotBackgroundWork } from "../../api/background-work.ts";
import { ASYNC_DIR, RESULTS_DIR, type Details, type SubagentState } from "../../shared/types.ts";
import { listAsyncRuns } from "./async-status.ts";
import { waitForSubagents, type SubagentWaitDeps, type SubagentWaitParams, type WaitEventBus } from "./subagent-wait.ts";

export const DEFAULT_AUTO_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

export interface AutoDrainDeps {
	state: SubagentState;
	events?: WaitEventBus;
	timeoutMs?: number;
	now?: () => number;
	wait?: (
		params: SubagentWaitParams,
		signal: AbortSignal | undefined,
		deps: SubagentWaitDeps,
	) => Promise<AgentToolResult<Details>>;
	hasWork?: (sessionId: string, nowMs: number) => boolean;
}

function resultText(value: AgentToolResult<Details>): string {
	return value.content.map((part) => part.type === "text" ? part.text : "").join(" ").trim();
}

function hasOutstandingWork(sessionId: string, nowMs: number): boolean {
	const asyncRuns = listAsyncRuns(ASYNC_DIR, {
		states: ["queued", "running"],
		sessionId,
		resultsDir: RESULTS_DIR,
		now: () => nowMs,
	});
	return asyncRuns.length > 0 || snapshotBackgroundWork(sessionId, nowMs).items.length > 0;
}

/** Drain all work owned by the current headless session, including work added while draining. */
export async function drainOutstandingWork(deps: AutoDrainDeps): Promise<void> {
	const sessionId = deps.state.currentSessionId;
	if (!sessionId) throw new Error("Cannot auto-drain background work without an active session identity.");
	const now = deps.now ?? Date.now;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_AUTO_DRAIN_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Auto-drain timeoutMs must be a positive finite number.");
	const deadlineAt = now() + timeoutMs;
	const hasWork = deps.hasWork ?? hasOutstandingWork;
	const wait = deps.wait ?? waitForSubagents;

	while (hasWork(sessionId, now())) {
		const remainingMs = deadlineAt - now();
		if (remainingMs <= 0) {
			throw new Error(`Auto-drain timed out after ${timeoutMs}ms with background work still active in session '${sessionId}'.`);
		}
		const waitResult = await wait(
			{ all: true, timeoutMs: remainingMs },
			undefined,
			{
				state: deps.state,
				events: deps.events,
				now,
				stopOnAttention: false,
				failOnFailedRuns: true,
			},
		);
		if (waitResult.isError) {
			throw new Error(`Auto-drain failed for session '${sessionId}': ${resultText(waitResult) || "subagent_wait returned an error without details"}.`);
		}
	}
}
