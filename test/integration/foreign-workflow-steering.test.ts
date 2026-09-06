import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { events, makeAgent, makeMinimalCtx, createEventBus } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, waitForMockPiCall, waitForAsyncState, ASYNC_DIR, tempDir, mockPi } from "../support/async-execution-fixture.ts";
import { steerRequestsDir } from "../../src/runs/background/control-channel.ts";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
async function hostB(sessionFile: string, params: object, label: string, policy = "auto"): Promise<any> {
	const output = path.join(tempDir, `${label}.json`);
	await execFileAsync(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(path.join(repo, "test/support/register-loader.mjs")).href, path.join(repo, "test/support/foreign-workflow-steer-host.mjs"), tempDir, sessionFile, JSON.stringify(params), output, policy], { cwd: repo, env: process.env, timeout: 15000, killSignal: "SIGKILL" });
	return JSON.parse(fs.readFileSync(output, "utf8"));
}

describe("foreign workflow tool steering (separate processes)", () => {
	installAsyncExecutionHooks();
	it("delivers ID and directory requests with file-preferred identity; refuses wrong sessions and terminal runs", { timeout: 60000 }, async () => {
		assert.ok(available && createSubagentExecutor, "fixture must not skip");
		const release = path.join(tempDir, "release");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [events.assistantMessage("done")] }] });
		const sessionFile = path.join(tempDir, "parent-session.jsonl");
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => sessionFile;
		ctx.sessionManager.getSessionId = () => "different-runtime-id-in-owner";
		const state: any = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
		const executor = createSubagentExecutor({ pi: { events: createEventBus(), getSessionName: () => undefined }, state, config: {}, asyncByDefault: false, tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir, expandTilde: p => p, discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }) });
		const launch = await executor.execute("owner", { workflowScript: 'return await runs.run("A", { agent: "worker", task: "Wait" });', async: true, mission: false }, new AbortController().signal, undefined, ctx);
		assert.notEqual(launch.isError, true, JSON.stringify(launch));
		const runId = launch.details.asyncId!;
		const dir = path.join(ASYNC_DIR, runId);
		try {
			await waitForMockPiCall(mockPi, 0, 10000);
			assert.equal(state.workflowControllers.has(runId), true);
			const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
			assert.equal(status.sessionId, sessionFile);
			for (const [label, params] of [["id", { id: runId }], ["dir", { dir, index: 0 }]] as const) {
				const b = await hostB(sessionFile, params, label);
				assert.notEqual(b.pid, process.pid);
				assert.notEqual(b.completionOwnerId, status.completionOwnerId);
				assert.equal(b.sessionId, sessionFile);
				assert.equal(b.controllers, 0); assert.equal(b.controls, 0);
				assert.notEqual(b.result.isError, true, JSON.stringify(b));
				assert.equal(b.result.details.steering.state, "delivered");
				const receipt = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).steering.recent.find((r: any) => r.id === b.result.details.steering.requestId);
				assert.equal(receipt.targets[0].state, "delivered");
			}
			assert.match(fs.readFileSync(path.join(mockPi.dir, "steers.jsonl"), "utf8"), /B actual tool route/);
			const wrong = await hostB(`${sessionFile}-wrong`, { id: runId }, "wrong");
			assert.equal(wrong.result.isError, true);
			assert.match(wrong.result.content[0].text, /active session/);
			const malformed = await hostB(sessionFile, { dir, index: 0.5 }, "malformed");
			assert.equal(malformed.result.isError, true);
			assert.deepEqual(fs.readdirSync(steerRequestsDir(dir)), []);
			fs.writeFileSync(release, "go");
			await waitForAsyncState(runId, s => s.state === "complete", 10000);
			const terminal = await hostB(sessionFile, { dir }, "terminal");
			assert.equal(terminal.result.isError, true);
			assert.match(terminal.result.content[0].text, /not running or queued/);
		} finally { fs.writeFileSync(release, "go"); }
	});

	it("leaves an unavailable owner's request pending without reconciliation or recovery", { timeout: 20000 }, async () => {
		const runId = "foreign-unacknowledged";
		const dir = path.join(ASYNC_DIR, runId);
		fs.mkdirSync(dir, { recursive: true });
		const sessionFile = path.join(tempDir, "parent.jsonl");
		const status = JSON.stringify({ runId, mode: "workflow", state: "running", sessionId: sessionFile, completionOwnerId: "unavailable-owner", pid: 99999999, updatedAt: 1, steps: [{ status: "running", workflowKey: "A" }, { status: "running", workflowKey: "B" }] });
		fs.writeFileSync(path.join(dir, "status.json"), status);
		for (const policy of ["forbid", "confirm"]) {
			const refused = await hostB(sessionFile, { dir }, policy, policy);
			assert.equal(refused.result.isError, true);
			assert.match(refused.result.content[0].text, /Authority policy/);
			assert.equal(fs.existsSync(steerRequestsDir(dir)), false);
		}
		const mismatch = await hostB(sessionFile, { dir, id: "another-workflow" }, "mismatch");
		assert.equal(mismatch.result.isError, true);
		assert.match(mismatch.result.content[0].text, /does not match directory/);
		const b = await hostB(sessionFile, { id: runId }, "noack");
		assert.notEqual(b.result.isError, true, JSON.stringify(b));
		assert.equal(b.result.details.steering.state, "pending");
		assert.equal(b.result.details.steering.deliveryStatus, "queued");
		assert.deepEqual(b.result.details.steering.targets, []);
		assert.equal(fs.readFileSync(path.join(dir, "status.json"), "utf8"), status);
		const requests = fs.readdirSync(steerRequestsDir(dir));
		assert.equal(requests.length, 1);
		const request = JSON.parse(fs.readFileSync(path.join(steerRequestsDir(dir), requests[0]!), "utf8"));
		assert.equal(request.id, b.result.details.steering.requestId);
		assert.equal(request.targetIndex, undefined); assert.equal(request.targetIndexes, undefined);
		assert.deepEqual(fs.readdirSync(dir).sort(), ["control", "status.json"]);
	});
});
