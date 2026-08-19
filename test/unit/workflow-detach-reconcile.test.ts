import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDetachedChildToPausedWorkflow, promotePausedWorkflowIfSettled } from "../../src/runs/foreground/workflow-detach-reconcile.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

function pausedWorkflow(childRunId: string, extra?: Partial<NonNullable<AsyncStatus["steps"]>[number]>): AsyncStatus {
	return {
		runId: "workflow-1",
		mode: "workflow",
		state: "paused",
		startedAt: 1,
		activityState: "needs_attention",
		error: "Run 'worker' detached for intercom coordination.",
		steps: [{
			agent: "worker",
			workflowKey: "detaches",
			runId: childRunId,
			status: "paused",
			activityState: "needs_attention",
			currentTool: "contact_supervisor",
			...extra,
		}],
	};
}

describe("applyDetachedChildToPausedWorkflow", () => {
	it("completes a paused workflow when its detached child succeeds", () => {
		const next = applyDetachedChildToPausedWorkflow(pausedWorkflow("child-1"), {
			childRunId: "child-1",
			result: { exitCode: 0, sessionFile: "/tmp/child.jsonl" },
		});
		assert.equal(next?.state, "complete");
		assert.equal(next?.activityState, undefined);
		assert.equal(next?.error, undefined);
		assert.equal(next?.steps?.[0]?.status, "completed");
		assert.equal(next?.steps?.[0]?.activityState, undefined);
		assert.equal(next?.steps?.[0]?.sessionFile, "/tmp/child.jsonl");
	});

	it("fails a paused workflow when its detached child fails", () => {
		const next = applyDetachedChildToPausedWorkflow(pausedWorkflow("child-1"), {
			childRunId: "child-1",
			result: { exitCode: 1, error: "boom" },
		});
		assert.equal(next?.state, "failed");
		assert.equal(next?.error, "boom");
		assert.equal(next?.steps?.[0]?.status, "failed");
		assert.equal(next?.steps?.[0]?.error, "boom");
	});

	it("keeps the workflow paused while another detached child still needs attention", () => {
		const status = pausedWorkflow("child-1");
		status.steps!.push({
			agent: "other",
			workflowKey: "also",
			runId: "child-2",
			status: "paused",
			activityState: "needs_attention",
		});
		const next = applyDetachedChildToPausedWorkflow(status, {
			childRunId: "child-1",
			result: { exitCode: 0 },
		});
		assert.equal(next?.state, "paused");
		assert.equal(next?.activityState, "needs_attention");
		assert.equal(next?.steps?.[0]?.status, "completed");
		assert.equal(next?.steps?.[1]?.status, "paused");
	});

	it("ignores failed workflows and unknown children", () => {
		assert.equal(applyDetachedChildToPausedWorkflow({ ...pausedWorkflow("child-1"), state: "failed" }, {
			childRunId: "child-1",
			result: { exitCode: 0 },
		}), undefined);
		assert.equal(applyDetachedChildToPausedWorkflow(pausedWorkflow("child-1"), {
			childRunId: "missing",
			result: { exitCode: 0 },
		}), undefined);
	});

	it("completes a paused workflow when the matching step already settled", () => {
		const status = pausedWorkflow("child-1");
		status.steps![0]!.status = "completed";
		delete status.steps![0]!.activityState;
		const next = applyDetachedChildToPausedWorkflow(status, {
			childRunId: "child-1",
			result: { exitCode: 0, sessionFile: "/tmp/child.jsonl" },
		});
		assert.equal(next?.state, "complete");
		assert.equal(promotePausedWorkflowIfSettled(status)?.state, "complete");
	});
});
