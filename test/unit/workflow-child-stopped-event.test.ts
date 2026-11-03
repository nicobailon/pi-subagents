import assert from "node:assert/strict";
import { it } from "node:test";
import { workflowChildStoppedEvent } from "../../src/runs/foreground/subagent-executor.ts";

const step = {
	agent: "worker",
	status: "stopped" as const,
	workflowKey: "a",
	runId: "child-a",
	phase: "build",
	label: "A",
};

it("announces a child that a trace entry just stopped", () => {
	const event = workflowChildStoppedEvent({ key: "a", step, stepIndex: 2, previouslyStopped: false });
	assert.deepEqual(event, {
		type: "subagent.child-status",
		version: 1,
		childId: "a",
		status: "stopped",
		reason: "subagent-action",
		source: "async",
		stepIndex: 2,
		agent: "worker",
		childRunId: "child-a",
		workflowKey: "a",
		phase: "build",
		label: "A",
	});
	assert.equal("stepIndex" in (workflowChildStoppedEvent({ key: "a", step, stepIndex: undefined, previouslyStopped: false }) ?? {}), true);
});

it("does not re-announce a step that was already stopped when the trace is re-projected", () => {
	// The trace cap rotates the array, so every retained entry is projected again on each
	// rebuild. Without this rule each rebuild appended one stop record per retained stop.
	assert.equal(workflowChildStoppedEvent({ key: "a", step, stepIndex: 2, previouslyStopped: true }), undefined);
});

it("announces again when a child is stopped a second time after running", () => {
	// The caller passes the status the step had before this entry: `running` here.
	assert.notEqual(workflowChildStoppedEvent({ key: "a", step, stepIndex: 2, previouslyStopped: false }), undefined);
});
