import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { awaitExistingAsyncRun } from "../../src/runs/background/await-async-run.ts";

let tempDir: string;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function childDir(runId = "child-run"): string {
	return path.join(tempDir, runId);
}

function writeStatus(asyncDir: string, fields: Record<string, unknown>): void {
	writeJson(path.join(asyncDir, "status.json"), {
		runId: path.basename(asyncDir),
		mode: "single",
		parentWorkflowRunId: "workflow-parent",
		sessionId: "session-a",
		state: "running",
		startedAt: 1,
		steps: [{ agent: "worker", status: "running" }],
		...fields,
	});
}

function writeResult(asyncDir: string, output: string): void {
	writeJson(path.join(asyncDir, "workflow-result.json"), {
		id: path.basename(asyncDir),
		runId: path.basename(asyncDir),
		sessionId: "session-a",
		toolCallId: "tool-call-a",
		state: "complete",
		success: true,
		results: [{ agent: "worker", output, success: true }],
	});
}

function deadPid(): number {
	const exited = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(exited.pid);
	return exited.pid;
}

describe("awaitExistingAsyncRun", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-await-async-run-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns an already published result without consuming or rewriting files", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { state: "complete", steps: [{ agent: "worker", status: "complete" }] });
		writeResult(asyncDir, "finished output");
		const files = ["status.json", "workflow-result.json"].map((name) => path.join(asyncDir, name));
		const before = files.map((file) => fs.readFileSync(file));

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "settled");
		assert.equal(outcome.status === "settled" && outcome.result.output, "finished output");
		assert.equal(outcome.status === "settled" && outcome.result.success, true);
		assert.equal(outcome.status === "settled" && outcome.result.exitCode, 0);
		assert.deepEqual(outcome.status === "settled" && outcome.result.importedPublication, { sessionId: "session-a", toolCallId: "tool-call-a" });
		files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], file));
	});

	it("waits for an active run to publish its result", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { pid: process.pid });
		setTimeout(() => {
			writeResult(asyncDir, "late output");
			writeStatus(asyncDir, { pid: process.pid, state: "complete", steps: [{ agent: "worker", status: "complete" }] });
		}, 50);

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "settled");
		assert.equal(outcome.status === "settled" && outcome.result.output, "late output");
	});

	it("is unavailable when the status belongs to a different run", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { runId: "other-run", state: "complete" });
		writeResult(asyncDir, "other output");

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /belongs to run 'other-run'/);
	});

	it("is unavailable when the run directory is missing", async () => {
		const outcome = await awaitExistingAsyncRun(childDir("missing-run"), "missing-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /No async status/);
	});

	it("is unavailable when a terminal run has no result file", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { state: "complete", steps: [{ agent: "worker", status: "complete" }] });

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /ended without a result file/);
		assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "complete");
	});

	it("is unavailable when the runner died while status still says running", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { pid: deadPid() });

		const outcome = await awaitExistingAsyncRun(asyncDir, "child-run", new AbortController().signal);

		assert.equal(outcome.status, "unavailable");
		assert.match(outcome.status === "unavailable" ? outcome.reason : "", /exited without publishing a result/);
		assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).state, "running");
	});

	it("rejects with the abort reason while waiting", async () => {
		const asyncDir = childDir();
		writeStatus(asyncDir, { pid: process.pid });
		const controller = new AbortController();
		const startedAt = Date.now();
		setTimeout(() => controller.abort(new Error("workflow replaced")), 20);

		await assert.rejects(awaitExistingAsyncRun(asyncDir, "child-run", controller.signal), /workflow replaced/);
		assert.ok(Date.now() - startedAt < 2_000);
	});

	it("rejects immediately when already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already stopped"));

		await assert.rejects(awaitExistingAsyncRun(childDir(), "child-run", controller.signal), /already stopped/);
	});
});
