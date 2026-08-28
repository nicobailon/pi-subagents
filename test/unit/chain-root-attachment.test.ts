import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writePendingAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { waitForImportedAsyncRoot } from "../../src/runs/background/chain-root-attachment.ts";

let tempDir: string;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function root(runId = "root-run", index = 0) {
	return {
		runId,
		index,
		asyncDir: path.join(tempDir, runId),
		resultPath: path.join(tempDir, "results", `${runId}.json`),
	};
}

describe("async chain root attachment", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-root-attachment-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("imports an already completed async child result", async () => {
		const importedRoot = root();
		const sessionFile = path.join(tempDir, "child.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "complete",
			startedAt: 1,
			steps: [{ agent: "worker", status: "complete", sessionFile }],
		});
		writeJson(importedRoot.resultPath, {
			state: "complete",
			success: true,
		results: [{ agent: "worker", output: "root output", success: true, sessionFile, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 } }],
		});

		const result = await waitForImportedAsyncRoot(importedRoot, { pollIntervalMs: 1 });

		assert.deepEqual({
			agent: result.agent,
			output: result.output,
			exitCode: result.exitCode,
			sessionFile: result.sessionFile,
			usage: result.usage,
		}, {
			agent: "worker",
			output: "root output",
			exitCode: 0,
			sessionFile,
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
		});
	});

	it("imports a session-indexed pending result before terminal status fallback", async () => {
		const importedRoot = { ...root(), resultPath: path.join(tempDir, "root-run", "workflow-result.json") };
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "complete",
			sessionId: "session-a",
			startedAt: 1,
			steps: [{ agent: "worker", status: "complete" }],
		});
		writePendingAsyncResultFile(importedRoot.resultPath, {
			id: importedRoot.runId,
			runId: importedRoot.runId,
			sessionId: "session-a",
			state: "complete",
			success: true,
			results: [{ agent: "worker", output: "pending root output", success: true }],
		});

		const result = await waitForImportedAsyncRoot(importedRoot, { pollIntervalMs: 1, terminalResultGraceMs: 0 });

		assert.equal(result.output, "pending root output");
		assert.equal(result.exitCode, 0);
	});

	it("waits for a running async child to write its terminal result", async () => {
		const importedRoot = root();
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "running",
			startedAt: 1,
			steps: [{ agent: "worker", status: "running" }],
		});

		const waiting = waitForImportedAsyncRoot(importedRoot, { pollIntervalMs: 5 });
		setTimeout(() => {
			writeJson(importedRoot.resultPath, {
				state: "complete",
				success: true,
				results: [{ agent: "worker", output: "late root output", success: true }],
			});
		}, 20);

		const result = await waiting;

		assert.equal(result.output, "late root output");
		assert.equal(result.exitCode, 0);
	});

	it("imports a failed root as a failed first chain step", async () => {
		const importedRoot = root();
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "failed",
			startedAt: 1,
			error: "root failed",
			steps: [{ agent: "worker", status: "failed", error: "root failed" }],
		});
		writeJson(importedRoot.resultPath, {
			state: "failed",
			success: false,
			summary: "root failed",
			results: [{ agent: "worker", output: "root failed", error: "root failed", success: false }],
		});

		const result = await waitForImportedAsyncRoot(importedRoot, { pollIntervalMs: 1 });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "root failed");
		assert.equal(result.output, "root failed");
	});

	it("imports a partial root without collapsing it to failed", async () => {
		const importedRoot = root();
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "partial",
			activityState: "needs_attention",
			startedAt: 1,
			error: "Required file-only output was not produced: report.md",
			steps: [{ agent: "worker", status: "failed", activityState: "needs_attention", error: "Required file-only output was not produced: report.md" }],
		});
		writeJson(importedRoot.resultPath, {
			state: "partial",
			success: false,
			summary: "Required file-only output was not produced: report.md",
			results: [{ agent: "worker", output: "Required file-only output was not produced: report.md", error: "Required file-only output was not produced: report.md", success: false, effects: { fileMutation: { status: "observed", expected: true, attempted: true, evidence: { source: "tracked-files", trackedOnly: true, cwd: tempDir, changedFiles: ["input.md"], attemptedMutation: true } } } }],
		});

		const result = await waitForImportedAsyncRoot(importedRoot, { pollIntervalMs: 1 });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Required file-only output was not produced: report.md");
		assert.equal(result.execution?.status, "partial");
		assert.deepEqual(result.effects?.fileMutation?.evidence?.changedFiles, ["input.md"]);
	});

	it("fails a partial root that never produced a result file", async () => {
		const importedRoot = root();
		const effects = { fileMutation: { status: "observed", expected: true, attempted: true, evidence: { source: "tracked-files", trackedOnly: true, cwd: tempDir, changedFiles: ["input.md"], attemptedMutation: true } } };
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "partial",
			startedAt: 1,
			error: "Required file-only output was not produced: report.md",
			steps: [{ agent: "worker", status: "failed", activityState: "needs_attention", error: "Required file-only output was not produced: report.md", effects }],
		});

		const result = await waitForImportedAsyncRoot(importedRoot, {
			pollIntervalMs: 1,
			terminalResultGraceMs: 0,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Required file-only output was not produced: report.md");
		assert.equal(result.execution?.status, "partial");
		assert.deepEqual(result.effects?.fileMutation?.evidence?.changedFiles, ["input.md"]);
	});

	it("fails a terminal root that never produced a result file", async () => {
		const importedRoot = root();
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "complete",
			startedAt: 1,
			steps: [{ agent: "worker", status: "complete" }],
		});

		const result = await waitForImportedAsyncRoot(importedRoot, {
			pollIntervalMs: 1,
			terminalResultGraceMs: 0,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /ended without a result file/);
	});

	it("stops waiting when the parent timeout aborts an attached root", async () => {
		const importedRoot = root();
		writeJson(path.join(importedRoot.asyncDir, "status.json"), {
			runId: importedRoot.runId,
			mode: "single",
			state: "running",
			startedAt: 1,
			steps: [{ agent: "worker", status: "running" }],
		});
		let timedOut = false;
		const waiting = waitForImportedAsyncRoot(importedRoot, {
			pollIntervalMs: 1,
			shouldAbort: () => timedOut,
			timeoutMessage: "parent timed out",
		});
		setTimeout(() => {
			timedOut = true;
		}, 10);

		const result = await waiting;

		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, true);
		assert.equal(result.error, "parent timed out");
		assert.equal(result.output, "parent timed out");
	});
});
