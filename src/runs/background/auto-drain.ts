import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { snapshotBackgroundWork } from "../../api/background-work.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { listAsyncRuns } from "./async-status.ts";
import { deliverInterruptRequest, deliverStopRequest, deliverTimeoutRequest } from "./control-channel.ts";
import type { ReadonlyDrainObservation } from "../shared/readonly-drain-observation.ts";
import { waitForSubagents, waitRunScopes, type SubagentWaitDeps, type SubagentWaitParams, type WaitEventBus } from "./subagent-wait.ts";

export const DEFAULT_AUTO_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

export interface AutoDrainDeps {
	state: SubagentState;
	events?: WaitEventBus;
	signal?: AbortSignal;
	/** Deliver terminal result data before the drain may settle. */
	deliver?: (result: AgentToolResult<Details>) => void;
	onWait?: () => void;
	nestedRootRunId?: string;
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

function hasOutstandingWork(sessionId: string, nowMs: number, observation?: ReadonlyDrainObservation, nestedRootRunId?: string): boolean {
	const asyncRuns = waitRunScopes({ nestedRootRunId }).flatMap(({ asyncDirRoot, resultsDir }) => listAsyncRuns(asyncDirRoot, {
		states: ["queued", "running"],
		sessionId,
		resultsDir,
		now: () => nowMs,
	}, observation?.status));
	return asyncRuns.length > 0 || snapshotBackgroundWork(sessionId, nowMs).items.length > 0;
}

/** Cascade a host action using existing controls; aborting bg_wait alone never calls this. */
export function cancelOutstandingWork(state: SubagentState, action: "interrupt" | "stop" | "timeout", nestedRootRunId?: string): string[] {
	if (!state.currentSessionId) throw new Error("Cannot cancel descendant work without an exact session identity.");
	const notes: string[] = [];
	for (const control of state.foregroundControls.values()) {
		if (control.sessionId !== state.currentSessionId) continue;
		const children = control.activeChildren?.size ? [...control.activeChildren.values()] : [control];
		for (const child of children) {
			const cancel = action === "interrupt" ? child.interrupt : child.stop;
			if (cancel && !cancel()) notes.push(`Descendant ${control.runId} did not accept ${action}; inspect its saved status.`);
		}
	}
	for (const run of waitRunScopes({ nestedRootRunId }).flatMap(({ asyncDirRoot, resultsDir }) => listAsyncRuns(asyncDirRoot, { states: ["queued", "running"], sessionId: state.currentSessionId!, resultsDir, includeNested: false, reconcile: false }))) {
		const workflow = state.workflowControllers?.get(run.id);
		const pauseUnsupported = run.mode === "workflow" || run.steps.some((step) => step.runner !== undefined);
		if (action === "interrupt" && pauseUnsupported) notes.push(`Descendant ${run.id} does not support pause; stopping it while retaining output and recovery records.`);
		if (workflow) workflow.abort(new Error(`Parent ${action}: workflow stopped (pause unsupported).`));
		else if (action === "interrupt" && !pauseUnsupported) deliverInterruptRequest({ asyncDir: run.asyncDir, source: "ancestor-interrupt" });
		else if (action === "timeout") deliverTimeoutRequest({ asyncDir: run.asyncDir, source: "ancestor-timeout" });
		else deliverStopRequest({ asyncDir: run.asyncDir, source: "ancestor-stop" });
	}
	return notes;
}

/** Drain all work owned by the current headless session, including work added while draining. */
export async function drainOutstandingWork(deps: AutoDrainDeps, observation?: ReadonlyDrainObservation): Promise<void> {
	const sessionId = deps.state.currentSessionId;
	observation?.begin(sessionId, !deps.hasWork && !deps.wait && !deps.now);
	try {
		if (!sessionId) throw new Error("Cannot auto-drain background work without an active session identity.");
		const now = deps.now ?? Date.now;
		const timeoutMs = deps.timeoutMs ?? DEFAULT_AUTO_DRAIN_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Auto-drain timeoutMs must be a positive finite number.");
		const deadlineAt = now() + timeoutMs;
		const hasWork = deps.hasWork ?? ((id: string, time: number) => hasOutstandingWork(id, time, observation, deps.nestedRootRunId));
		const wait = deps.wait ?? waitForSubagents;

		while (true) {
			deps.signal?.throwIfAborted();
			if (deps.state.currentSessionId !== sessionId) throw new Error("Auto-drain stopped because the active session changed.");
			const work = hasWork(sessionId, now());
			observation?.predicate(work);
			if (!work) break;
			const remainingMs = deadlineAt - now();
			if (remainingMs <= 0) {
				throw new Error(`Auto-drain timed out after ${timeoutMs}ms with background work still active in session '${sessionId}'.`);
			}
			deps.onWait?.();
			const waitResult = await wait(
				{ all: true, timeoutMs: remainingMs },
				deps.signal,
				{
					state: deps.state,
					nestedRootRunId: deps.nestedRootRunId,
					events: deps.events,
					now,
					stopOnAttention: false,
					failOnFailedRuns: true,
					failOnAttention: true,
				},
			);
			deps.signal?.throwIfAborted();
			if (deps.state.currentSessionId !== sessionId) throw new Error("Auto-drain stopped because the active session changed.");
			if (waitResult.isError) {
				throw new Error(`Auto-drain failed for session '${sessionId}': ${resultText(waitResult) || "bg_wait returned an error without details"}.`);
			}
			deps.deliver?.(waitResult);
		}
		observation?.complete();
	} catch (error) {
		observation?.deny();
		throw error;
	}
}
