import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	WORKFLOW_SESSION_REPLACED_MESSAGE,
	WORKFLOW_TEARDOWN_GRACE_MS,
	teardownWorkflowControllers,
	workflowChildRunsAllTerminal,
	type WorkflowTeardownState,
	type WorkflowTeardownTimers,
} from "../../src/extension/workflow-teardown.ts";
import type { AsyncJobState, AsyncJobStep } from "../../src/shared/types.ts";

type ScheduledTimer = { callback: () => void; delayMs: number; unrefCount: number };

interface FakeTimerHarness {
	timers: WorkflowTeardownTimers;
	scheduled: ScheduledTimer[];
	fire: (index: number) => void;
}

function makeFakeTimers(): FakeTimerHarness {
	const scheduled: ScheduledTimer[] = [];
	return {
		scheduled,
		timers: {
			setTimeout: (callback: () => void, delayMs: number) => {
				const entry: ScheduledTimer = { callback, delayMs, unrefCount: 0 };
				scheduled.push(entry);
				return {
					unref: () => {
						entry.unrefCount += 1;
					},
				};
			},
		},
		fire: (index: number) => {
			const entry = scheduled[index];
			assert.ok(entry, `expected a grace timer at index ${index}`);
			entry.callback();
		},
	};
}

function makeJob(runId: string, statuses: Array<AsyncJobStep["status"]>): AsyncJobState {
	return {
		asyncId: runId,
		asyncDir: `/async/${runId}`,
		status: "running",
		steps: statuses.map((status, index) => ({ agent: `agent-${index}`, status })),
	};
}

function makeState(jobs: Map<string, AsyncJobState>, runIds: string[]): WorkflowTeardownState {
	return {
		asyncJobs: jobs,
		workflowControllers: new Map(runIds.map((runId) => [runId, new AbortController()])),
	};
}

describe("workflowChildRunsAllTerminal", () => {
	it("is false when the job is missing or has no inspectable lanes", () => {
		assert.equal(workflowChildRunsAllTerminal(undefined), false);
		assert.equal(workflowChildRunsAllTerminal(makeJob("wf-empty", [])), false);
	});

	it("is false while any lane is still pending, running, partial, or paused", () => {
		for (const liveStatus of ["pending", "running", "partial", "paused"] as const) {
			assert.equal(workflowChildRunsAllTerminal(makeJob("wf-live", ["completed", liveStatus])), false, liveStatus);
		}
	});

	it("is true when every lane settled", () => {
		for (const terminalStatus of ["complete", "completed", "failed", "stopped", "rejected"] as const) {
			assert.equal(workflowChildRunsAllTerminal(makeJob("wf-done", ["completed", terminalStatus])), true, terminalStatus);
		}
	});
});

describe("teardownWorkflowControllers", () => {
	it("aborts a workflow with live children immediately and schedules no grace timer", () => {
		const fake = makeFakeTimers();
		const job = makeJob("wf-live", ["completed", "running"]);
		const state = makeState(new Map([["wf-live", job]]), ["wf-live"]);
		const controller = state.workflowControllers!.get("wf-live")!;

		const result = teardownWorkflowControllers(state, { timers: fake.timers });

		assert.deepEqual(result, { aborted: ["wf-live"], graceAbortsScheduled: [] });
		assert.equal(controller.signal.aborted, true);
		assert.equal(controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason), WORKFLOW_SESSION_REPLACED_MESSAGE);
		assert.equal(fake.scheduled.length, 0);
	});

	it("treats an uninspectable job as live and aborts immediately", () => {
		const fake = makeFakeTimers();
		const state = makeState(new Map(), ["wf-unknown"]);

		const result = teardownWorkflowControllers(state, { timers: fake.timers });

		assert.deepEqual(result, { aborted: ["wf-unknown"], graceAbortsScheduled: [] });
		assert.equal(state.workflowControllers!.get("wf-unknown")!.signal.aborted, true);
		assert.equal(fake.scheduled.length, 0);
	});

	it("grants the grace window to a workflow whose child runs are all terminal", () => {
		const fake = makeFakeTimers();
		const job = makeJob("wf-assembly", ["completed", "failed"]);
		const state = makeState(new Map([["wf-assembly", job]]), ["wf-assembly"]);
		const controller = state.workflowControllers!.get("wf-assembly")!;

		const result = teardownWorkflowControllers(state, { timers: fake.timers });

		assert.deepEqual(result, { aborted: [], graceAbortsScheduled: ["wf-assembly"] });
		assert.equal(controller.signal.aborted, false, "assembly-phase workflow must not be aborted during teardown");
		assert.equal(fake.scheduled.length, 1);
		assert.equal(fake.scheduled[0]!.delayMs, WORKFLOW_TEARDOWN_GRACE_MS);
		assert.ok(fake.scheduled[0]!.unrefCount > 0, "grace timer must be unref'd so process exit is never blocked");
	});

	it("honors a custom grace window", () => {
		const fake = makeFakeTimers();
		const state = makeState(new Map([["wf-assembly", makeJob("wf-assembly", ["completed"])]]), ["wf-assembly"]);

		teardownWorkflowControllers(state, { graceMs: 250, timers: fake.timers });

		assert.equal(fake.scheduled[0]!.delayMs, 250);
	});

	it("lets a workflow that completes during the grace window settle without a force abort", () => {
		const fake = makeFakeTimers();
		const job = makeJob("wf-assembly", ["completed", "completed"]);
		const state = makeState(new Map([["wf-assembly", job]]), ["wf-assembly"]);
		const controller = state.workflowControllers!.get("wf-assembly")!;

		teardownWorkflowControllers(state, { graceMs: 5, timers: fake.timers });

		// The workflow finished assembly and its settle path removed its own
		// controller, exactly like the executor's finally block does after a flush.
		state.workflowControllers!.delete("wf-assembly");
		fake.fire(0);

		assert.equal(controller.signal.aborted, false, "flushed workflow must not be force-aborted after expiry");
	});

	it("skips the force abort when the map entry was replaced by a different controller", () => {
		const fake = makeFakeTimers();
		const job = makeJob("wf-replaced", ["completed"]);
		const state = makeState(new Map([["wf-replaced", job]]), ["wf-replaced"]);
		const staleController = state.workflowControllers!.get("wf-replaced")!;

		teardownWorkflowControllers(state, { graceMs: 5, timers: fake.timers });

		// A replacing runtime registered a fresh controller for the same run id
		// before expiry; the replacement owns the run now and must survive the
		// stale entry's grace expiry untouched.
		const replacement = new AbortController();
		state.workflowControllers!.set("wf-replaced", replacement);
		fake.fire(0);

		assert.equal(staleController.signal.aborted, false, "stale controller must be left alone at expiry");
		assert.equal(replacement.signal.aborted, false, "replacement controller must not be aborted by the stale entry's expiry");
	});

	it("force-aborts on grace expiry with the standard teardown error", () => {
		const fake = makeFakeTimers();
		const job = makeJob("wf-stuck", ["completed"]);
		const state = makeState(new Map([["wf-stuck", job]]), ["wf-stuck"]);
		const controller = state.workflowControllers!.get("wf-stuck")!;

		teardownWorkflowControllers(state, { graceMs: 5, timers: fake.timers });
		assert.equal(controller.signal.aborted, false);

		fake.fire(0);

		assert.equal(controller.signal.aborted, true);
		assert.equal(controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason), WORKFLOW_SESSION_REPLACED_MESSAGE);
	});

	it("aborts only the live workflow when both kinds are registered", () => {
		const fake = makeFakeTimers();
		const jobs = new Map([
			["wf-assembly", makeJob("wf-assembly", ["completed", "failed"])],
			["wf-running", makeJob("wf-running", ["completed", "running"])],
		]);
		const state = makeState(jobs, ["wf-assembly", "wf-running"]);

		const result = teardownWorkflowControllers(state, { timers: fake.timers });

		assert.deepEqual(result, { aborted: ["wf-running"], graceAbortsScheduled: ["wf-assembly"] });
		assert.equal(state.workflowControllers!.get("wf-running")!.signal.aborted, true);
		assert.equal(state.workflowControllers!.get("wf-assembly")!.signal.aborted, false);
		assert.equal(fake.scheduled.length, 1);
	});

	it("skips controllers that were already aborted before teardown", () => {
		const fake = makeFakeTimers();
		const jobs = new Map([["wf-aborted", makeJob("wf-aborted", ["running"])]]);
		const state = makeState(jobs, ["wf-aborted"]);
		const controller = state.workflowControllers!.get("wf-aborted")!;
		const stopReason = new Error("Workflow stopped.");
		controller.abort(stopReason);

		const result = teardownWorkflowControllers(state, { timers: fake.timers });

		assert.deepEqual(result, { aborted: [], graceAbortsScheduled: [] });
		assert.equal(controller.signal.reason, stopReason, "pre-existing abort reason must be preserved");
		assert.equal(fake.scheduled.length, 0);
	});

	it("tolerates a timer without unref", () => {
		const timers: WorkflowTeardownTimers = {
			setTimeout: (_callback: () => void, _delayMs: number) => ({}),
		};
		const state = makeState(new Map([["wf-assembly", makeJob("wf-assembly", ["completed"])]]), ["wf-assembly"]);

		const result = teardownWorkflowControllers(state, { timers });

		assert.deepEqual(result, { aborted: [], graceAbortsScheduled: ["wf-assembly"] });
	});
});
