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
	it("fails closed when a detached child succeeds without persisted workflow continuation", () => {
		const next = applyDetachedChildToPausedWorkflow(pausedWorkflow("child-1"), {
			childRunId: "child-1",
			result: { exitCode: 0, sessionFile: "/tmp/child.jsonl" },
		});
		assert.equal(next?.state, "failed");
		assert.equal(next?.activityState, undefined);
		assert.match(next?.error ?? "", /unsupported-continuation/);
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

	it("replaces stale detach errors when a detached child is interrupted", () => {
		const next = applyDetachedChildToPausedWorkflow(pausedWorkflow("child-1"), {
			childRunId: "child-1",
			result: { exitCode: 0, interrupted: true },
		});
		assert.equal(next?.state, "failed");
		assert.equal(next?.error, "Interrupted. Waiting for explicit next action.");
		assert.equal(next?.steps?.[0]?.status, "failed");
		assert.equal(next?.steps?.[0]?.error, "Interrupted. Waiting for explicit next action.");
	});

	it("preserves a sibling failure when a detached child is interrupted", () => {
		const status = pausedWorkflow("child-1");
		status.error = "sibling boom";
		status.steps!.push({
			agent: "other",
			workflowKey: "fails",
			runId: "child-2",
			status: "failed",
			error: "sibling boom",
		});
		const next = applyDetachedChildToPausedWorkflow(status, {
			childRunId: "child-1",
			result: { exitCode: 0, interrupted: true },
		});
		assert.equal(next?.state, "failed");
		assert.equal(next?.error, "sibling boom");
		assert.equal(next?.steps?.find((step) => step.workflowKey === "detaches")?.error, "Interrupted. Waiting for explicit next action.");
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

	it("fails closed when the matching step already settled", () => {
		const status = pausedWorkflow("child-1");
		status.steps![0]!.status = "completed";
		delete status.steps![0]!.activityState;
		const next = applyDetachedChildToPausedWorkflow(status, {
			childRunId: "child-1",
			result: { exitCode: 0, sessionFile: "/tmp/child.jsonl" },
		});
		assert.equal(next?.state, "failed");
		assert.match(next?.error ?? "", /unsupported-continuation/);
		assert.equal(promotePausedWorkflowIfSettled(status)?.state, "failed");
	});

	it("fails closed after a detached child settles when an aborted sibling is stopped", () => {
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
		assert.equal(next?.state, "failed");
		assert.match(next?.error ?? "", /unsupported-continuation/);
		assert.equal(next?.steps?.[1]?.status, "stopped");
	});
});

describe("reconcileDetachedWorkflowChildCompletion", () => {
	it("publishes a terminal result when the paused result file is already gone", () => {
		const workflowRunId = "workflow-missing-result";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const childDir = path.join(DIRS.async, "child-1");
		const requestedPath = path.join(asyncDir, "requested.md");
		const savedPath = path.join(asyncDir, "saved.md");
		const sessionFile = path.join(childDir, "session.jsonl");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(childDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
		fs.writeFileSync(path.join(childDir, "status.json"), JSON.stringify({ runId: "child-1", mode: "single", state: "complete", startedAt: 1, lastUpdate: 2, sessionId: "session-1", steps: [{ agent: "worker", status: "complete", sessionFile }] }), "utf-8");
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
			result: { index: 0, agent: "worker", task: `Write your findings to exactly this path: ${requestedPath}`, exitCode: 0, sessionFile, savedOutputPath: savedPath, usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, cost: 0.001, turns: 1 } },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; success?: boolean; summary?: string; error?: string; sessionId?: string; workflowResolution?: string; recovery?: unknown[]; results?: Array<{ outputReference?: string; outputPathMapping?: unknown }>; workflowReceipt?: { receipt?: { state?: string; workflowResolution?: string; recovery?: unknown[]; entries?: Record<string, { resumability?: { state?: string; reason?: string } }> } } };
		assert.equal(published.state, "failed");
		assert.equal(published.success, false);
		assert.match(published.error ?? "", /unsupported-continuation/);
		assert.equal(published.workflowResolution, "settled-awaiting-resume");
		assert.match(published.summary ?? "", /Workflow lanes settled/);
		assert.deepEqual(published.recovery, [{ key: "detaches", call: "runs.run", resume: { workflowRunId, key: "detaches", latest: true }, taskRequired: true }]);
		assert.ok(published.summary?.includes(`Output path mappings: 'detaches': requested ${requestedPath} -> saved ${savedPath}`));
		assert.equal(published.results?.[0]?.outputReference, savedPath);
		assert.deepEqual(published.results?.[0]?.outputPathMapping, { requestedPath, savedPath });
		const publishedChild = published.results?.[0] as { usage?: unknown; sessionFile?: string } | undefined;
		assert.deepEqual(publishedChild?.usage, { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, cost: 0.001, turns: 1 });
		assert.equal(publishedChild?.sessionFile, sessionFile);
		assert.equal(published.sessionId, "session-1");
		assert.equal(published.workflowReceipt?.receipt?.state, "failed");
		assert.equal(published.workflowReceipt?.receipt?.workflowResolution, "settled-awaiting-resume");
		assert.deepEqual(published.workflowReceipt?.receipt?.recovery, published.recovery);
		assert.equal(published.workflowReceipt?.receipt?.entries?.detaches?.resumability?.state, "resumable");
		const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.match(events, /"type":"subagent.workflow.completed"/);
		assert.match(events, /"state":"failed"/);
		assert.match(events, /"workflowResolution":"settled-awaiting-resume"/);
		assert.match(events, /"call":"runs.run"/);
	});

	it("classifies interrupted detached settlement without losing child details", () => {
		const workflowRunId = "workflow-interrupted-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...pausedWorkflow("child-interrupted"), runId: workflowRunId, sessionId: "session-1" }), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-interrupted",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, interrupted: true, error: "operator stopped child", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowResolution?: string; error?: string; results?: Array<{ interrupted?: boolean; error?: string }> };
		assert.equal(published.workflowResolution, "interrupted-child");
		assert.equal(published.error, "operator stopped child");
		assert.deepEqual(published.results, [{ workflowKey: "detaches", agent: "worker", runId: "child-interrupted", success: false, output: "", outputState: "absent", interrupted: true, error: "operator stopped child" }]);
	});

	it("prioritizes a failed sibling over interrupted detached evidence", () => {
		const workflowRunId = "workflow-failed-sibling-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const status = { ...pausedWorkflow("child-interrupted"), runId: workflowRunId, sessionId: "session-1" };
		status.steps!.push({ agent: "worker", workflowKey: "fails", runId: "child-failed", status: "paused", activityState: "needs_attention" });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;
		let emitted: { name: string; payload: { error?: string; summary?: string; workflowResolution?: string } } | undefined;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-failed",
			result: { index: 1, agent: "worker", task: "t", exitCode: 1, error: "sibling boom", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);
		const paused = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { state?: string; error?: string; steps?: Array<{ runId?: string; error?: string }> };
		assert.equal(paused.state, "paused");
		assert.equal(paused.error, "Run 'worker' detached for intercom coordination.");
		assert.equal(paused.steps?.find((step) => step.runId === "child-failed")?.error, "sibling boom");
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-interrupted",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, interrupted: true, error: "operator stopped child", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
			events: { emit: (name, payload) => { emitted = { name, payload: payload as { error?: string; summary?: string; workflowResolution?: string } }; } } as IntercomEventBus,
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowResolution?: string; error?: string; results?: Array<{ workflowKey?: string; interrupted?: boolean; error?: string }> };
		assert.equal(published.workflowResolution, "failed-child");
		assert.equal(published.error, "sibling boom");
		assert.deepEqual(published.results?.find((child) => child.workflowKey === "detaches"), { workflowKey: "detaches", agent: "worker", runId: "child-interrupted", success: false, output: "", outputState: "absent", interrupted: true, error: "operator stopped child" });
		assert.deepEqual(published.results?.find((child) => child.workflowKey === "fails"), { workflowKey: "fails", agent: "worker", runId: "child-failed", success: false, output: "", outputState: "absent", error: "sibling boom" });
		assert.equal(emitted?.name, "subagent:async-complete");
		assert.equal(emitted?.payload.summary, "sibling boom");
		assert.equal(emitted?.payload.workflowResolution, "failed-child");
		const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.match(events, /"workflowResolution":"failed-child"/);
		assert.match(events, /"error":"sibling boom"/);
		assert.doesNotMatch(events, /"error":"operator stopped child"/);
	});

	it("preserves a later failed child error after interruption settles first", () => {
		const workflowRunId = "workflow-interrupted-first-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const status = { ...pausedWorkflow("child-interrupted"), runId: workflowRunId, sessionId: "session-1" };
		status.steps!.push({ agent: "worker", workflowKey: "fails", runId: "child-failed", status: "paused", activityState: "needs_attention" });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-interrupted",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, interrupted: true, error: "operator stopped child" },
		}), true);
		const paused = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { state?: string; steps?: Array<{ runId?: string; error?: string; interrupted?: boolean }> };
		assert.equal(paused.state, "paused");
		assert.equal(paused.steps?.find((step) => step.runId === "child-interrupted")?.interrupted, true);
		assert.equal(paused.steps?.find((step) => step.runId === "child-interrupted")?.error, "operator stopped child");
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-failed",
			result: { index: 1, agent: "worker", task: "t", exitCode: 1, error: "sibling boom" },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowResolution?: string; error?: string; summary?: string; results?: Array<{ workflowKey?: string; error?: string; interrupted?: boolean }> };
		assert.equal(published.workflowResolution, "failed-child");
		assert.equal(published.error, "sibling boom");
		assert.equal(published.summary, "sibling boom");
		assert.equal(published.results?.find((child) => child.workflowKey === "detaches")?.error, "operator stopped child");
		assert.equal(published.results?.find((child) => child.workflowKey === "detaches")?.interrupted, true);
		assert.equal(published.results?.find((child) => child.workflowKey === "fails")?.error, "sibling boom");
	});

	it("preserves an interrupted child error after a later sibling succeeds", () => {
		const workflowRunId = "workflow-interrupted-first-success-final";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const status = { ...pausedWorkflow("child-interrupted"), runId: workflowRunId, sessionId: "session-1" };
		status.steps!.push({ agent: "worker", workflowKey: "passes", runId: "child-passes", status: "paused", activityState: "needs_attention" });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-interrupted",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, interrupted: true, error: "operator stopped child" },
		}), true);
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-passes",
			result: { index: 1, agent: "worker", task: "t", exitCode: 0 },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowResolution?: string; error?: string; summary?: string; results?: Array<{ workflowKey?: string; error?: string; interrupted?: boolean }> };
		assert.equal(published.workflowResolution, "interrupted-child");
		assert.equal(published.error, "operator stopped child");
		assert.equal(published.summary, "operator stopped child");
		assert.equal(published.results?.find((child) => child.workflowKey === "detaches")?.error, "operator stopped child");
		assert.equal(published.results?.find((child) => child.workflowKey === "detaches")?.interrupted, true);
	});

	it("classifies a stopped detached child as interrupted evidence", () => {
		const workflowRunId = "workflow-stopped-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...pausedWorkflow("child-stopped"), runId: workflowRunId, sessionId: "session-1" }), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-stopped",
			result: { index: 0, agent: "worker", task: "t", exitCode: 1, stopped: true, error: "Subagent stopped by user.", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowResolution?: string; error?: string; results?: Array<{ workflowKey?: string; error?: string; interrupted?: boolean; stopped?: boolean }> };
		assert.equal(published.workflowResolution, "interrupted-child");
		assert.equal(published.error, "Subagent stopped by user.");
		assert.deepEqual(published.results, [{ workflowKey: "detaches", agent: "worker", runId: "child-stopped", success: false, output: "", outputState: "absent", interrupted: true, stopped: true, error: "Subagent stopped by user." }]);
	});

	it("reconciles a foreground child without a persisted run id", () => {
		const workflowRunId = "workflow-unbound-foreground-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const sessionFile = "/tmp/current-child.jsonl";
		const status = { ...pausedWorkflow("placeholder", { runId: undefined, sessionFile }), runId: workflowRunId, sessionId: "session-1" };
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "current-child",
			workflowKey: "detaches",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, sessionFile },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { results?: Array<{ runId?: string; sessionFile?: string; success?: boolean }> };
		assert.deepEqual(published.results, [{ workflowKey: "detaches", agent: "worker", runId: "current-child", sessionFile, success: true, output: "", outputState: "absent" }]);
	});

	it("reconciles a live foreground child without persisted identity fields", () => {
		const workflowRunId = "workflow-missing-identity-handoff";
		const childRunId = "current-child";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const status = { ...pausedWorkflow("placeholder", { runId: undefined, sessionFile: undefined }), runId: workflowRunId, sessionId: "session-1" };
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = {
			asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]),
			foregroundControls: new Map([[childRunId, { runId: childRunId, parentWorkflowRunId: workflowRunId, workflowKey: "detaches" }]]),
		} as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId,
			workflowKey: "detaches",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, sessionFile: "/tmp/current-child.jsonl" },
		}), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { results?: Array<{ runId?: string; success?: boolean }> };
		assert.equal(published.results?.[0]?.runId, childRunId);
		assert.equal(published.results?.[0]?.success, true);
	});

	it("does not reconcile ambiguous same-key live attempts without persisted identity", () => {
		const workflowRunId = "workflow-ambiguous-missing-identity-handoff";
		const childRunId = "stale-child";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const status = { ...pausedWorkflow("placeholder", { runId: undefined, sessionFile: undefined }), runId: workflowRunId, sessionId: "session-1" };
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = {
			asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]),
			foregroundControls: new Map([
				[childRunId, { runId: childRunId, parentWorkflowRunId: workflowRunId, workflowKey: "detaches" }],
				["replacement-child", { runId: "replacement-child", parentWorkflowRunId: workflowRunId, workflowKey: "detaches" }],
			]),
		} as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId,
			workflowKey: "detaches",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, sessionFile: "/tmp/current-child.jsonl" },
		}), false);
		assert.equal(fs.existsSync(path.join(DIRS.results, `${workflowRunId}.json`)), false);
	});

	it("ignores stale completion when only the workflow key matches", () => {
		const workflowRunId = "workflow-key-interrupted-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const status = { ...pausedWorkflow("placeholder", { runId: undefined, sessionFile: "/tmp/replacement-child.jsonl" }), runId: workflowRunId, sessionId: "session-1" };
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "latest-child-run",
			workflowKey: "detaches",
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, interrupted: true, sessionFile: "/tmp/stale-child.jsonl", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), false);
		const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatus;
		assert.equal(persisted.steps?.[0]?.runId, undefined);
		assert.equal(persisted.steps?.[0]?.sessionFile, "/tmp/replacement-child.jsonl");
		assert.equal(persisted.steps?.[0]?.status, "paused");
		assert.equal(fs.existsSync(path.join(DIRS.results, `${workflowRunId}.json`)), false);
	});

	it("classifies a stopped sibling as interrupted terminal evidence", () => {
		const workflowRunId = "workflow-stopped-sibling-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const status = { ...pausedWorkflow("child-final"), runId: workflowRunId, sessionId: "session-1" };
		status.steps!.push({ agent: "worker", workflowKey: "stopped", runId: "child-stopped", status: "stopped", stopped: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;
		assert.equal(reconcileDetachedWorkflowChildCompletion({ state, workflowRunId, childRunId: "child-final", result: { index: 0, agent: "worker", task: "t", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } } }), true);
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowResolution?: string; results?: Array<{ workflowKey?: string; stopped?: boolean }> };
		assert.equal(published.workflowResolution, "interrupted-child");
		assert.equal(published.results?.find((child) => child.workflowKey === "stopped")?.stopped, true);
	});

	it("keeps a detached timeout outcome local after fail-closed workflow settlement", () => {
		const workflowRunId = "workflow-child-timeout-handoff";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const outcome = { state: "partial" as const, reason: "timeout" as const };
		const status = { ...pausedWorkflow("child-timeout"), runId: workflowRunId, sessionId: "session-1" };
		status.steps!.push({ agent: "worker", workflowKey: "still-open", runId: "child-open", status: "paused", activityState: "needs_attention" });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({
			workflowRunId,
			state: "paused",
			children: [
				{ key: "detaches", ok: false, agent: "worker", runId: "child-timeout", output: "paused", detached: true, artifactPaths: [], resumability: { state: "not-resumable", reason: "child detached" }, continuation: { runIds: ["child-timeout"] } },
				{ key: "still-open", ok: false, agent: "worker", runId: "child-open", output: "paused", detached: true, artifactPaths: [], resumability: { state: "not-resumable", reason: "child detached" }, continuation: { runIds: ["child-open"] } },
			],
		}));
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-timeout",
			result: { index: 0, agent: "worker", task: "t", exitCode: 1, timedOut: true, error: "Subagent timed out after 50ms." },
		}), true);
		const paused = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; terminalOutcome?: unknown; results?: Array<{ workflowKey?: string; terminalOutcome?: unknown }>; workflowReceipt?: { receipt?: { terminalOutcome?: unknown; entries?: Record<string, { terminalOutcome?: unknown }> } } };
		assert.equal(paused.state, "paused");
		assert.equal(paused.terminalOutcome, undefined);
		assert.equal(paused.workflowReceipt?.receipt?.terminalOutcome, undefined);
		assert.deepEqual(paused.results?.find((child) => child.workflowKey === "detaches")?.terminalOutcome, outcome);
		assert.deepEqual(paused.workflowReceipt?.receipt?.entries?.detaches?.terminalOutcome, outcome);

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-open",
			result: { index: 1, agent: "worker", task: "t", exitCode: 0 },
		}), true);
		const terminal = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; terminalOutcome?: unknown; results?: Array<{ workflowKey?: string; terminalOutcome?: unknown }>; workflowReceipt?: { receipt?: { terminalOutcome?: unknown; entries?: Record<string, { terminalOutcome?: unknown }> } } };
		assert.equal(terminal.state, "failed");
		assert.equal(terminal.terminalOutcome, undefined);
		assert.equal(terminal.workflowReceipt?.receipt?.terminalOutcome, undefined);
		assert.deepEqual(terminal.results?.find((child) => child.workflowKey === "detaches")?.terminalOutcome, outcome);
		assert.deepEqual(terminal.workflowReceipt?.receipt?.entries?.detaches?.terminalOutcome, outcome);
	});

	it("preserves sibling output path mappings when rebuilding from workflow status", () => {
		const workflowRunId = "workflow-sibling-mappings";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const firstRequestedPath = path.join(asyncDir, "first-requested.md");
		const firstSavedPath = path.join(asyncDir, "first-saved.md");
		const secondRequestedPath = path.join(asyncDir, "second-requested.md");
		const secondSavedPath = path.join(asyncDir, "second-saved.md");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const status = { ...pausedWorkflow("child-1"), runId: workflowRunId, sessionId: "session-1" };
		status.steps!.push({
			agent: "worker",
			workflowKey: "second",
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
			result: { index: 0, agent: "worker", task: `Write your findings to exactly this path: ${firstRequestedPath}`, exitCode: 0, savedOutputPath: firstSavedPath, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);
		fs.rmSync(path.join(DIRS.results, `${workflowRunId}.json`));
		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-2",
			result: { index: 1, agent: "worker", task: `Write your findings to exactly this path: ${secondRequestedPath}`, exitCode: 0, savedOutputPath: secondSavedPath, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { summary?: string; results?: Array<{ workflowKey?: string; outputPathMapping?: unknown }> };
		assert.deepEqual(published.results?.map((child) => [child.workflowKey, child.outputPathMapping]), [
			["detaches", { requestedPath: firstRequestedPath, savedPath: firstSavedPath }],
			["second", { requestedPath: secondRequestedPath, savedPath: secondSavedPath }],
		]);
		assert.ok(published.summary?.includes(`'detaches': requested ${firstRequestedPath} -> saved ${firstSavedPath}`));
		assert.ok(published.summary?.includes(`'second': requested ${secondRequestedPath} -> saved ${secondSavedPath}`));
	});

	it("skips non-object existing result entries while summarizing output mappings", () => {
		const workflowRunId = "workflow-existing-non-object-results";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const requestedPath = path.join(asyncDir, "requested.md");
		const savedPath = path.join(asyncDir, "saved.md");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ ...pausedWorkflow("child-1"), runId: workflowRunId, sessionId: "session-1" }), "utf-8");
		fs.writeFileSync(path.join(DIRS.results, `${workflowRunId}.json`), JSON.stringify({ activityState: "needs_attention", results: [null, { workflowKey: "detaches", runId: "child-1", success: false, output: "old", outputState: "present" }] }), "utf-8");
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId: "child-1",
			result: { index: 0, agent: "worker", task: `Write your findings to exactly this path: ${requestedPath}`, exitCode: 0, savedOutputPath: savedPath, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { activityState?: string; summary?: string; results?: unknown[] };
		assert.equal(published.activityState, undefined);
		assert.equal(published.results?.[0], null);
		assert.ok(published.summary?.includes(`'detaches': requested ${requestedPath} -> saved ${savedPath}`));
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

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; success?: boolean; error?: string; workflowReceipt?: unknown };
		assert.equal(published.state, "failed");
		assert.equal(published.success, false);
		assert.match(published.error ?? "", /evidence-persistence-failed/);
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

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; success?: boolean; error?: string; summary?: string; workflowReceipt?: unknown; reconciledFromDetachedChild?: string };
		assert.equal(published.state, "failed");
		assert.equal(published.success, false);
		assert.match(published.error ?? "", /evidence-persistence-failed/);
		assert.match(published.summary ?? "", /Available child evidence was preserved/);
		assert.equal(published.workflowReceipt, undefined);
		assert.equal(published.reconciledFromDetachedChild, "child-1");
		assert.equal(emitted?.name, "subagent:async-complete");
		assert.deepEqual(emitted?.payload, {
			id: workflowRunId,
			runId: workflowRunId,
			source: "async",
			mode: "workflow",
			agent: "workflow",
			success: false,
			state: "failed",
			workflowResolution: "settled-awaiting-resume",
			recovery: [],
			summary: published.summary,
			reconciledFromDetachedChild: "child-1",
			results: [{ workflowKey: "detaches", agent: "worker", runId: "child-1", success: true, output: "", outputState: "absent" }],
			sessionId: "session-1",
			completionOwnerId: undefined,
			timestamp: (emitted?.payload as { timestamp?: number }).timestamp,
			triggerTurn: true,
		});
	});

	it("normalizes old external-cli child status while reconciling workflow receipts", () => {
		const workflowRunId = "workflow-old-external-receipt";
		const childRunId = "child-old-external";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const childDir = path.join(DIRS.async, childRunId);
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(childDir, { recursive: true, force: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(childDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const status = { ...pausedWorkflow(childRunId), runId: workflowRunId, sessionId: "session-1" };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		fs.writeFileSync(path.join(childDir, "status.json"), JSON.stringify({
			runId: childRunId,
			mode: "single",
			state: "complete",
			startedAt: 1,
			lastUpdate: 2,
			steps: [{ agent: "external", status: "complete", runner: { type: "external-cli", command: "review-cli", args: [], promptDelivery: "stdin", capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false } } }],
		}), "utf-8");
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({
			workflowRunId,
			state: "paused",
			children: [{ key: "detaches", ok: false, agent: "external", runId: childRunId, output: "paused", detached: true, artifactPaths: [], resumability: { state: "not-resumable", reason: "child detached" }, continuation: { runIds: [childRunId] } }],
		}));
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId,
			result: { index: 0, agent: "external", task: "t", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowReceipt?: { receipt?: { entries?: Record<string, { externalAdapter?: { adapter?: { id?: string }; nonResumableReason?: string } }> } } };
		assert.equal(published.workflowReceipt?.receipt?.entries?.detaches?.externalAdapter?.adapter?.id, "external-cli");
		assert.match(published.workflowReceipt?.receipt?.entries?.detaches?.externalAdapter?.nonResumableReason ?? "", /no durable external session identity/);
		assert.doesNotMatch(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /receipt_write_failed/);
	});

	it("keeps mixed Pi and external workflow receipt entries on their computed resumability", () => {
		const workflowRunId = "workflow-mixed-receipt";
		const childRunId = "child-mixed";
		const asyncDir = path.join(DIRS.async, workflowRunId);
		const childDir = path.join(DIRS.async, childRunId);
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(childDir, { recursive: true, force: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(childDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const status = { ...pausedWorkflow(childRunId), runId: workflowRunId, sessionId: "session-1" };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
		const sessionFile = path.join(childDir, "pi-session.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		fs.writeFileSync(path.join(childDir, "status.json"), JSON.stringify({
			runId: childRunId,
			mode: "parallel",
			state: "complete",
			startedAt: 1,
			lastUpdate: 2,
			steps: [
				{ agent: "worker", status: "complete", sessionFile },
				{ agent: "external", status: "complete", runner: { type: "external-cli", command: "review-cli", args: [], promptDelivery: "stdin" } },
			],
		}), "utf-8");
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({
			workflowRunId,
			state: "paused",
			children: [{ key: "detaches", ok: false, agent: "worker", runId: childRunId, output: "paused", detached: true, artifactPaths: [], resumability: { state: "not-resumable", reason: "child detached" }, continuation: { runIds: [childRunId] } }],
		}));
		const state = { asyncJobs: new Map([[workflowRunId, { asyncId: workflowRunId, asyncDir, status: "paused" as const }]]) } as SubagentState;

		assert.equal(reconcileDetachedWorkflowChildCompletion({
			state,
			workflowRunId,
			childRunId,
			result: { index: 0, agent: "worker", task: "t", exitCode: 0, sessionFile, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
		}), true);

		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { workflowReceipt?: { receipt?: { entries?: Record<string, { resumability?: { state?: string; reason?: string }; externalAdapter?: unknown }> } } };
		assert.equal(published.workflowReceipt?.receipt?.entries?.detaches?.resumability?.state, "not-resumable");
		assert.doesNotMatch(published.workflowReceipt?.receipt?.entries?.detaches?.resumability?.reason ?? "", /no durable external session identity/);
		assert.equal(published.workflowReceipt?.receipt?.entries?.detaches?.externalAdapter, undefined);
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
		const published = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${workflowRunId}.json`), "utf-8")) as { state?: string; workflowResolution?: string; recovery?: unknown };
		assert.equal(published.state, "paused");
		assert.equal(published.workflowResolution, undefined);
		assert.equal(published.recovery, undefined);
	});
});
