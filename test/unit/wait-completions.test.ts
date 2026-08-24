import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toWaitCompletion } from "../../src/runs/background/wait-completions.ts";

describe("workflow wait completion projection", () => {
	it("retains the bounded workflow-child summary and excludes result output", () => {
		const completion = toWaitCompletion({
			agent: "workflow",
			mode: "workflow",
			state: "complete",
			success: true,
			workflowChildren: {
				version: 1,
				parentToolCallId: "tool-1",
				workflowRunId: "workflow-1",
				inventoryComplete: true,
				workflowState: "completed",
				children: [{ childId: "review", runId: "run-1", agent: "reviewer", model: "openai-codex/gpt", thinking: "high", state: "completed" }],
			},
			results: [{ agent: "reviewer", runId: "run-1", success: true, output: "must not be copied", task: "must not be copied" }],
		}, "workflow-1");

		assert.equal(completion.workflowChildren?.children[0]?.childId, "review");
		assert.doesNotMatch(JSON.stringify(completion), /must not be copied/);
	});

	it("rejects unbounded or unknown summary fields at the replay boundary", () => {
		assert.throws(() => toWaitCompletion({ workflowChildren: { version: 1, parentToolCallId: "tool", workflowRunId: "run", inventoryComplete: true, workflowState: "completed", children: [], output: "secret" } }, "run"), /unsupported fields/);
	});

	it("rejects a summary bound to another completion", () => {
		assert.throws(() => toWaitCompletion({ workflowChildren: { version: 1, parentToolCallId: "tool", workflowRunId: "other", inventoryComplete: true, workflowState: "completed", children: [] } }, "run"), /does not match its completion run id/);
	});
});
