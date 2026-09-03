import type { AsyncJobState, AsyncJobStep, SubagentState } from "../shared/types.ts";

/**
 * Bounded grace window granted at teardown to workflows whose child runs are
 * all terminal. Such workflows are usually only assembling their result, so
 * aborting them outright discards completed child work (#1833). The window
 * lets the workflow script finish assembly and flush its result and wake-up
 * through the normal delivery path; expiry force-aborts with the standard
 * teardown error.
 */
export const WORKFLOW_TEARDOWN_GRACE_MS = 10_000;

/** Same error style as the immediate teardown abort, used for both paths. */
export const WORKFLOW_SESSION_REPLACED_MESSAGE = "Workflow stopped because the extension session was replaced or reloaded.";

/** Step statuses that mean the child run settled and no more work is expected from its lane. */
const TERMINAL_STEP_STATUSES: ReadonlySet<AsyncJobStep["status"]> = new Set<AsyncJobStep["status"]>([
	"complete",
	"completed",
	"failed",
	"stopped",
	"rejected",
]);

export type WorkflowTeardownState = Pick<SubagentState, "asyncJobs" | "workflowControllers">;

export interface WorkflowTeardownTimers {
	setTimeout: (callback: () => void, delayMs: number) => { unref?: () => void };
}

export interface WorkflowTeardownOptions {
	/** Grace window before force-aborting all-terminal workflows. Defaults to {@link WORKFLOW_TEARDOWN_GRACE_MS}. */
	graceMs?: number;
	/** Timer source; injectable so tests never wait on real timers. */
	timers?: WorkflowTeardownTimers;
}

export interface WorkflowTeardownResult {
	/** Run ids aborted immediately because at least one child run is still live. */
	aborted: string[];
	/** Run ids granted the grace window because every child run is terminal. */
	graceAbortsScheduled: string[];
}

/**
 * True only when the workflow's per-lane projection is inspectable and every
 * lane has settled. A missing or empty projection means the state is not
 * synchronously inspectable, so callers must treat the workflow as live and
 * abort immediately rather than assume it is safe to delay.
 */
export function workflowChildRunsAllTerminal(job: AsyncJobState | undefined): boolean {
	const steps = job?.steps;
	if (!steps || steps.length === 0) return false;
	return steps.every((step) => TERMINAL_STEP_STATUSES.has(step.status));
}

/**
 * Tear down live workflow controllers for extension cleanup.
 *
 * Controllers with any non-terminal child run abort immediately (unchanged
 * behavior). Controllers whose child runs are all terminal get one bounded,
 * unref'd grace timer: a workflow that finishes assembly during the window
 * removes its own controller from `state.workflowControllers` (its normal
 * settle path) and is skipped at expiry, while the rest are force-aborted
 * with the standard teardown error. Scheduling the timer keeps cleanup
 * synchronous; unref'ing the timer unblocks only the timer itself — the
 * workflow worker thread still pins the event loop for the grace window, so
 * callers that want a prompt exit pass `graceMs: 0`.
 */
export function teardownWorkflowControllers(state: WorkflowTeardownState, options: WorkflowTeardownOptions = {}): WorkflowTeardownResult {
	const graceMs = options.graceMs ?? WORKFLOW_TEARDOWN_GRACE_MS;
	const timers: WorkflowTeardownTimers = options.timers ?? { setTimeout };
	const aborted: string[] = [];
	const graceAbortsScheduled: string[] = [];
	const graceEntries: Array<{ runId: string; controller: AbortController }> = [];
	for (const [runId, controller] of state.workflowControllers ?? []) {
		if (controller.signal.aborted) continue;
		// Accepted risk (#1833 QA): the all-terminal reading below is a snapshot.
		// A sequential workflow resting between phases (await run(a); await sleep();
		// await run(b)) can still launch one more lane through its stale launch
		// context during the grace window; damage is bounded by the expiry force
		// abort. A launch-admission latch is a possible follow-up if this bites.
		if (workflowChildRunsAllTerminal(state.asyncJobs?.get(runId))) {
			graceEntries.push({ runId, controller });
			graceAbortsScheduled.push(runId);
			continue;
		}
		controller.abort(new Error(WORKFLOW_SESSION_REPLACED_MESSAGE));
		aborted.push(runId);
	}
	if (graceEntries.length > 0) {
		const timer = timers.setTimeout(() => {
			for (const { runId, controller } of graceEntries) {
				try {
					// A workflow that finished during the grace window deleted its own
					// controller; only still-registered controllers need the force abort.
					if (state.workflowControllers?.get(runId) !== controller) continue;
					if (!controller.signal.aborted) controller.abort(new Error(WORKFLOW_SESSION_REPLACED_MESSAGE));
				} catch (error) {
					console.error(`Failed to force-abort workflow '${runId}' after the teardown grace window:`, error);
				}
			}
		}, graceMs);
		// The grace window must never keep the process alive past shutdown.
		timer.unref?.();
	}
	return { aborted, graceAbortsScheduled };
}
