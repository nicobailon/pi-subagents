import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { applyDetachedChildToPausedWorkflow, promotePausedWorkflowIfSettled, reconcileDetachedWorkflowChildCompletion } from "../../src/runs/foreground/workflow-detach-reconcile.ts";
import { DIRS, type AsyncStatus, type IntercomEventBus, type SubagentState } from "../../src/shared/types.ts";
import { buildWorkflowReceipt, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

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

	it("completes after a detached child settles when an aborted sibling is stopped", () => {
		const status = pausedWorkflow("child-1");
		status.steps!.push({
			agent: "other",
			workflowKey: "slow",
			runId: "child-2",
			status: "stopped",
			stopped: true,
		});
		const next = applyDetachedChildToPausedWorkflow(status, {
			childRunId: "child-1",
			result: { exitCode: 0 },
		});
		assert.equal(next?.state, "complete");
		assert.equal(next?.steps?.[1]?.status, "stopped");
	});
});

describe("reconcileDetachedWorkflowChildCompletion", () => {
	it("publishes a terminal result when the paused result file is already gone", () => {
		const workflowRunId = "workflow-missing-result";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const status = { ...pausedWorkflow("child-1"), runId: workflowRunId, sessionId: "session-1" };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({
			workflowRunId,
			state: "paused",
			children: [{
				key: "detaches",
				ok: false,
				agent: "worker",
				runId: "child-1",
				output: "paused",
				detached: true,
				artifactPaths: [],
				resumability: { state: "not-resumable", reason: "child detached" },
				continuation: { runIds: ["child-1"] },
			}],
		}));
		const state = {
			asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]),
		} as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-1",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; success?: boolean; sessionId?: string; workflowReceipt?: { receipt?: { state?: string; entries?: Record<string, { resumability?: { state?: string; reason?: string } }> } } };
		assert.equal(published.state, "complete");
		assert.equal(published.success, true);
		assert.equal(published.sessionId, "session-1");
		assert.equal(published.workflowReceipt?.receipt?.state, "complete");
		assert.equal(published.workflowReceipt?.receipt?.entries?.detaches?.resumability?.state, "not-resumable");
		assert.match(published.workflowReceipt?.receipt?.entries?.detaches?.resumability?.reason ?? "", /not found|Status file|too short/);
		const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.match(events, /"type":"subagent.workflow.completed"/);
		assert.match(events, /"state":"complete"/);
	});

	it("publishes detached completion when the workflow receipt is malformed", () => {
		const workflowRunId = "workflow-malformed-receipt";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const status = { ...pausedWorkflow("child-1"), runId: workflowRunId, sessionId: "session-1" };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), JSON.stringify({ version: 1, workflowRunId, state: "paused", createdAt: 1, entries: { detaches: { key: "wrong" } } }), "utf-8");
		const state = {
			asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]),
		} as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-1",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; success?: boolean; workflowReceipt?: unknown };
		assert.equal(published.state, "complete");
		assert.equal(published.success, true);
		assert.equal(published.workflowReceipt, undefined);
		const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.match(events, /"type":"subagent.workflow.receipt_write_failed"/);
		assert.match(events, /"type":"subagent.workflow.completed"/);
	});

	it("publishes detached completion when receipt error journaling fails", () => {
		const workflowRunId = "workflow-receipt-journal-fails";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const status = { ...pausedWorkflow("child-1"), runId: workflowRunId, sessionId: "session-1" };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), JSON.stringify({ version: 1, workflowRunId, state: "paused", createdAt: 1, entries: { detaches: { key: "wrong" } } }), "utf-8");
		fs.mkdirSync(path.join(asyncDir, "events.jsonl"));
		const state = {
			asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]),
		} as SubagentState;
		let emitted: { name: string; payload: unknown } | undefined;
		const originalConsoleError = console.error;
		console.error = () => undefined;
		try {
			assert.equal(reconcileDetachedWorkflowChildCompletion({
				state,
				workflowRunId,
				childRunId: "child-1",
				result: { index: 0, agent: "worker", task: "t", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
				events: { emit: (name, payload) => { emitted = { name, payload }; } } as IntercomEventBus,
			}), true);
		} finally {
			console.error = originalConsoleError;
		}

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; success?: boolean; workflowReceipt?: unknown; reconciledFromDetachedChild?: string };
		assert.equal(published.state, "complete");
		assert.equal(published.success, true);
		assert.equal(published.workflowReceipt, undefined);
		assert.equal(published.reconciledFromDetachedChild, "child-1");
		assert.equal(emitted?.name, "subagent:async-complete");
		assert.deepEqual(emitted?.payload, {
			id: workflowRunId,
			runId: workflowRunId,
			source: "async",
			mode: "workflow",
			agent: "workflow",
			success: true,
			state: "complete",
			summary: "Workflow completed after detached child child-1 finished.",
			reconciledFromDetachedChild: "child-1",
			results: [{ workflowKey: "detaches", agent: "worker", runId: "child-1", success: true, output: "", outputState: "absent" }],
			sessionId: "session-1",
			completionOwnerId: undefined,
			timestamp: (emitted?.payload as { timestamp?: number }).timestamp,
			triggerTurn: true,
		});
	});

	it("does not log workflow completion while another detached child is still open", () => {
		const workflowRunId = "workflow-still-paused";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const status = pausedWorkflow("child-1");
		status.runId = workflowRunId;
		status.sessionId = "session-1";
		status.steps!.push({
			agent: "other",
			workflowKey: "also",
			runId: "child-2",
			status: "paused",
			activityState: "needs_attention",
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = {
			asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]),
		} as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-1",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);
		assert.equal(fs.existsSync(path.join(asyncDir, "events.jsonl")), false);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string };
		assert.equal(published.state, "paused");
	});
});
