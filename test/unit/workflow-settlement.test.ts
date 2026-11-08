import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDetachedChildSettlement, classifyWorkflowSettlement, planWorkflowSettlement, promoteSettledPausedWorkflow, workflowTerminalOutcomeForResult } from "../../src/workflows/workflow-settlement.ts";
import { buildWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";
import { resolveSubagentResultStatus } from "../../src/intercom/result-intercom.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

const terminationReason = "timed-out-waiting-on-supervisor" as const;

describe("supervisor expiry workflow settlement", () => {
	it("gives the structured reason precedence over generic timedOut and exit-code failure", () => {
		assert.deepEqual(workflowTerminalOutcomeForResult({ timedOut: true, terminationReason }), { state: "paused", reason: terminationReason });
		assert.equal(resolveSubagentResultStatus({ exitCode: 1, timedOut: true, success: false, terminationReason }), "paused");
		assert.deepEqual(workflowTerminalOutcomeForResult({ timedOut: true }), { state: "partial", reason: "timeout" });
		assert.equal(resolveSubagentResultStatus({ exitCode: 1, timedOut: true, success: false }), "failed");
		assert.equal(resolveSubagentResultStatus({ exitCode: 1, success: false }), "failed");
	});

	it("settles a detached expired child as retained attention rather than promoting paused to failed", () => {
		const status: AsyncStatus = { runId: "workflow", mode: "workflow", state: "paused", startedAt: 1, steps: [{ agent: "worker", runId: "child", workflowKey: "ask", status: "paused", activityState: "needs_attention" }] };
		const settled = applyDetachedChildSettlement(status, { childRunId: "child", result: { exitCode: 1, error: "not timeout prose", timedOut: true, terminationReason, sessionFile: "/retained.jsonl" }, now: 100 })!;
		assert.equal(settled.state, "paused");
		assert.equal(settled.timedOut, true);
		assert.equal(settled.terminationReason, terminationReason);
		assert.equal(settled.activityState, "needs_attention");
		assert.equal(settled.steps?.[0]?.status, "paused");
		assert.equal(settled.steps?.[0]?.terminationReason, terminationReason);
		assert.equal(settled.steps?.[0]?.sessionFile, "/retained.jsonl");
		assert.equal(promoteSettledPausedWorkflow(settled), undefined);
	});

	it("keeps an ordinary failed sibling authoritative when an expired detached child settles", () => {
		const status: AsyncStatus = { runId: "workflow", mode: "workflow", state: "paused", startedAt: 1, steps: [{ agent: "worker", runId: "child", status: "paused", activityState: "needs_attention" }, { agent: "other", status: "failed", error: "missing schema output" }] };
		const settled = applyDetachedChildSettlement(status, { childRunId: "child", result: { exitCode: 1, terminationReason, timedOut: true, error: "Expired" } })!;
		assert.equal(settled.state, "failed");
		assert.equal(settled.error, "missing schema output");
		assert.equal(settled.terminationReason, undefined);
		assert.equal(settled.steps?.[0]?.terminationReason, terminationReason);
	});

	it("keeps a stopped sibling authoritative over detached supervisor expiry", () => {
		const status: AsyncStatus = { runId: "workflow", mode: "workflow", state: "paused", startedAt: 1, steps: [{ agent: "worker", runId: "child", status: "paused", activityState: "needs_attention" }, { agent: "other", status: "stopped", stopped: true, error: "Stopped" }] };
		const settled = applyDetachedChildSettlement(status, { childRunId: "child", result: { exitCode: 1, terminationReason, timedOut: true, error: "Expired" } })!;
		assert.equal(settled.state, "failed");
		assert.equal(settled.terminationReason, undefined);
		assert.equal(classifyWorkflowSettlement(settled), "interrupted-child");
		assert.equal(settled.steps?.[0]?.terminationReason, terminationReason);
	});

	it("does not settle a failed workflow while another detached sibling remains open", () => {
		const status: AsyncStatus = { runId: "workflow", mode: "workflow", state: "paused", startedAt: 1, steps: [{ agent: "worker", runId: "child", status: "paused", activityState: "needs_attention" }, { agent: "failed", status: "failed", error: "missing output" }, { agent: "open", runId: "open", status: "paused", activityState: "needs_attention" }] };
		const settled = applyDetachedChildSettlement(status, { childRunId: "child", result: { exitCode: 1, terminationReason, timedOut: true, error: "Expired" } })!;
		assert.equal(settled.state, "paused");
		assert.equal(settled.terminationReason, undefined);
		assert.equal(classifyWorkflowSettlement(settled), undefined);
		assert.equal(planWorkflowSettlement({ status: settled, summary: "Open", children: [], baseResult: {} }).completionEvent, undefined);
		const closed = applyDetachedChildSettlement(settled, { childRunId: "open", result: { exitCode: 0 } })!;
		assert.equal(closed.state, "failed");
		assert.equal(closed.error, "missing output");
		assert.equal(closed.terminationReason, undefined);
		assert.equal(classifyWorkflowSettlement(closed), "failed-child");
	});

	it("publishes a terminal paused completion and receipt with explicit resume evidence", () => {
		const terminalOutcome = { state: "paused", reason: terminationReason } as const;
		const child = { key: "ask", runId: "child", agent: "worker", ok: false, output: "", error: "Expired", artifactPaths: ["/retained.jsonl"], resumability: { state: "resumable" } as const, terminalOutcome };
		const receipt = buildWorkflowReceipt({ workflowRunId: "workflow", state: "paused", children: [child], terminalOutcome });
		const status: AsyncStatus = { runId: "workflow", mode: "workflow", state: "paused", terminationReason, timedOut: true, activityState: "needs_attention", startedAt: 1, endedAt: 100, steps: [{ agent: "worker", workflowKey: "ask", runId: "child", status: "paused", terminationReason, sessionFile: "/retained.jsonl" }] };
		const plan = planWorkflowSettlement({ status, summary: "Expired", children: [], baseResult: {}, receipt, receiptPath: "/receipt.json", terminalOutcome });
		assert.equal(classifyWorkflowSettlement(status), "settled-awaiting-resume");
		assert.equal(plan.publicResult.success, false);
		assert.equal(plan.publicResult.state, "paused");
		assert.equal(plan.publicResult.terminationReason, terminationReason);
		assert.equal(plan.publicResult.timedOut, true);
		assert.equal(plan.completionEvent?.state, "paused");
		assert.equal(plan.completionEvent?.terminationReason, terminationReason);
		assert.deepEqual(plan.receipt?.entries.ask.terminalOutcome, terminalOutcome);
		assert.deepEqual(plan.recovery, [{ key: "ask", call: "runs.run", resume: { workflowRunId: "workflow", key: "ask", latest: true }, taskRequired: true }]);
		const failed = planWorkflowSettlement({ status, summary: "Expired", children: [], baseResult: { terminalOutcome }, terminalOutcome, receiptPersistenceError: "disk unavailable" });
		assert.equal(failed.publicResult.state, "failed");
		assert.equal(failed.publicResult.terminationReason, undefined);
		assert.equal(failed.publicResult.terminalOutcome, undefined);
	});
});
