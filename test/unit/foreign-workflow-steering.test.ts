import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { steerWorkflowRun } from "../../src/runs/foreground/workflow-foreground-steering.ts";
import { closeSteerInbox, steerRequestsDir } from "../../src/runs/background/control-channel.ts";
import { currentCompletionOwnerId } from "../../src/shared/completion-owner.ts";
import type { SubagentState } from "../../src/shared/types.ts";

it("foreign admission refuses invalid authority, identities, ownership, status and projected targets without writes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-workflow-"));
	const runId = "workflow-run";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir);
	const baseline = { runId, mode: "workflow", state: "running", sessionId: "parent-file", completionOwnerId: "foreign-owner", steps: [{ status: "running", workflowKey: "A" }] };
	const makeState = (): SubagentState => ({ baseCwd: root, currentSessionId: "parent-file", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null });
	const control = (id: string): any => ({ runId: id, parentWorkflowRunId: runId, sessionId: "parent-file", activeChildren: new Map([[0, { steer: async () => ({ state: "delivered" }) }]]) });
	try {
		const cases: Array<{ name: string; status?: object; state?: (s: SubagentState) => void; index?: number }> = [
			{ name: "missing session", state: s => { s.currentSessionId = null; } },
			{ name: "wrong session", state: s => { s.currentSessionId = "other"; } },
			{ name: "wrong run", status: { runId: "other" } },
			{ name: "non-workflow", status: { mode: "single" } },
			...(["complete", "failed", "partial", "paused", "stopped"] as const).map(state => ({ name: state, status: { state } })),
			{ name: "missing owner", status: { completionOwnerId: undefined } },
			{ name: "invalid owner", status: { completionOwnerId: 123 } },
			{ name: "blank owner", status: { completionOwnerId: " " } },
			{ name: "local orphan", status: { completionOwnerId: currentCompletionOwnerId() } },
			{ name: "configured local orphan", status: { completionOwnerId: "configured" }, state: s => { s.completionOwnerId = "configured"; } },
			{ name: "contradictory control", state: s => { s.foregroundControls.set("A", control("A")); } },
			{ name: "local empty controller", state: s => { s.workflowControllers = new Map([[runId, new AbortController()]]); } },
			{ name: "local ambiguity", state: s => { s.workflowControllers = new Map([[runId, new AbortController()]]); s.foregroundControls.set("A", control("A")); s.foregroundControls.set("B", control("B")); } },
			...[NaN, Infinity, -1, 0.5, 1].map(index => ({ name: `invalid index ${index}`, index })),
			{ name: "terminal child", index: 0, status: { steps: [{ status: "complete", workflowKey: "A" }] } },
			{ name: "missing projected key", index: 0, status: { steps: [{ status: "running" }] } },
		];
		for (const test of cases) {
			const statusText = JSON.stringify({ ...baseline, ...test.status });
			fs.writeFileSync(path.join(asyncDir, "status.json"), statusText);
			const state = makeState(); test.state?.(state);
			const result = await steerWorkflowRun({ state, runId, asyncDir, message: "steer", index: test.index, ackTimeoutMs: 0 });
			assert.equal(result.isError, true, test.name);
			assert.equal(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"), statusText, test.name);
			assert.equal(fs.existsSync(steerRequestsDir(asyncDir)), false, test.name);
		}
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(baseline));
		const local = makeState(); local.workflowControllers = new Map([[runId, new AbortController()]]); local.foregroundControls.set("A", control("A"));
		const badLocalIndex = await steerWorkflowRun({ state: local, runId, asyncDir, message: "local", index: 1, ackTimeoutMs: 0 });
		assert.equal(badLocalIndex.isError, true);
		assert.equal(fs.existsSync(steerRequestsDir(asyncDir)), false);
		closeSteerInbox(asyncDir, "complete");
		const closed = await steerWorkflowRun({ state: makeState(), runId, asyncDir, message: "closed", ackTimeoutMs: 0 });
		assert.equal(closed.isError, true);
		assert.match((closed.content[0] as any).text, /no longer accepts steering/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("explicit projected pending index stays addressed and queued without fabricating delivery or changing the owner ledger", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-pending-"));
	const runId = "workflow-run";
	const asyncDir = path.join(root, runId); fs.mkdirSync(asyncDir);
	try {
		const status = JSON.stringify({ runId, mode: "workflow", state: "queued", sessionId: "parent", completionOwnerId: "foreign", steps: [{ status: "complete", workflowKey: "A" }, { status: "pending", workflowKey: "B" }] });
		fs.writeFileSync(path.join(asyncDir, "status.json"), status);
		const state: SubagentState = { baseCwd: root, currentSessionId: "parent", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
		const result = await steerWorkflowRun({ state, runId, asyncDir, message: "next", index: 1, mode: "follow_up", ackTimeoutMs: 0 });
		assert.equal(result.details.steering?.state, "pending");
		assert.deepEqual(result.details.steering?.targets, [{ index: 1, state: "pending" }]);
		const request = JSON.parse(fs.readFileSync(path.join(steerRequestsDir(asyncDir), fs.readdirSync(steerRequestsDir(asyncDir))[0]!), "utf8"));
		assert.equal(request.targetIndex, 1); assert.equal(request.targetIndexes, undefined); assert.equal(request.mode, "follow_up");
		assert.equal(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"), status);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
