import assert from "node:assert/strict";
import { it } from "node:test";
import { workflowChildActivity, workflowChildProgress, workflowChildSummary, parseWorkflowChildSummary } from "../../src/workflows/workflow-child-summary.ts";
import type { AgentProgress } from "../../src/shared/types.ts";

const progress = { agent: "worker", status: "running", model: "provider/model", thinking: "high", currentTool: "read", currentToolStartedAt: 100, lastActivityAt: 120, durationMs: 20, toolCount: 1, turnCount: 2, tokens: 10, inputTokens: 8, outputTokens: 2, task: "private", currentToolArgs: "private", recentOutput: ["private"] } as AgentProgress;
const input = { parentToolCallId: "tool", workflowRunId: "wf", workflowState: "running" as const, inventoryComplete: false, trace: ["a", "b"].map((key) => ({ operation: "run" as const, key, state: "started" as const })) };

it("projects independent bounded snapshots by stable key and clears terminal activity", () => {
	const snapshots = new Map([["b", workflowChildProgress(progress)], ["a", workflowChildProgress({ ...progress, currentTool: "bash", toolCount: 9 })]]);
	const summary = workflowChildSummary({ ...input, progress: snapshots });
	assert.deepEqual(summary.children.map((row) => [row.childId, row.activity?.currentTool, row.activity?.toolCount]), [["a", "bash", 9], ["b", "read", 1]]);
	assert.equal(summary.children[0].model, progress.model);
	assert.equal(summary.children[0].thinking, "high");
	assert.equal(JSON.stringify(summary).includes("private"), false);
	assert.deepEqual(parseWorkflowChildSummary(summary), summary);
	snapshots.set("a", workflowChildProgress({ ...progress, currentTool: undefined, currentToolStartedAt: undefined }));
	assert.equal(workflowChildSummary({ ...input, progress: snapshots }).children[0].activity?.currentTool, undefined);
	assert.equal(summary.children[0].activity?.currentTool, "bash", "published snapshots stay immutable");
	assert.ok(workflowChildSummary({ ...input, inventoryComplete: true, workflowState: "failed", progress: snapshots }).children.every((row) => row.activity === undefined));
});

it("bounds UTF-8 and JSON bytes and rejects malformed activity strictly", () => {
	assert.equal(workflowChildActivity({ currentTool: "界".repeat(86) }).currentTool, undefined);
	assert.equal(workflowChildActivity({ currentTool: "界".repeat(85) }).currentTool?.length, 85);
	const activity = workflowChildActivity({ ...progress, currentTool: "\u0000".repeat(256), tokens: Number.MAX_VALUE });
	assert.ok(Buffer.byteLength(JSON.stringify(activity)) < 2048);
	assert.deepEqual(workflowChildActivity({ tokens: NaN, toolCount: -1, durationMs: Infinity }), {});
	const summary = workflowChildSummary({ ...input, progress: new Map([["a", workflowChildProgress(progress)]]) });
	for (const invalid of [null, [], { tokens: -1 }, { tokens: Infinity }, { tokens: "1" }, { currentTool: "界".repeat(86) }, { recentOutput: [] }, { currentToolArgs: "secret" }]) {
		assert.throws(() => parseWorkflowChildSummary({ ...summary, children: [{ ...summary.children[0], activity: invalid }] }), /activity/);
	}
	assert.throws(() => parseWorkflowChildSummary({ ...summary, children: [{ ...summary.children[0], state: "completed" }] }), /running state/);
});
