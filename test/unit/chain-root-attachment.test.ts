import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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
			results: [{ agent: "worker", output: "root output", success: true, sessionFile }],
		});

		const result = await waitForImportedAsyncRoot(importedRoot, { pollIntervalMs: 1 });

		assert.deepEqual({
			agent: result.agent,
			output: result.output,
			exitCode: result.exitCode,
			sessionFile: result.sessionFile,
		}, {
			agent: "worker",
			output: "root output",
			exitCode: 0,
			sessionFile,
		});
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
});
