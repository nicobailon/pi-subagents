import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createOwnedProcessTreeController } from "../../src/runs/background/owned-process-tree.ts";
import { makeAgent } from "../support/helpers.ts";
import {
	ASYNC_DIR,
	available,
	executeAsyncSingle,
	installAsyncExecutionHooks,
	mockPi,
	tempDir,
} from "../support/async-execution-fixture.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function waitForStatus(runId: string): Promise<{ pid: number }> {
	const statusPath = path.join(ASYNC_DIR, runId, "status.json");
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { pid?: unknown };
			if (typeof status.pid === "number") return { pid: status.pid };
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`Timed out waiting for runner status: ${statusPath}`);
}

describe("async fixture runner lifecycle", { skip: !available }, () => {
	installAsyncExecutionHooks();
	let ownedPid: number;
	let unrelated: ChildProcess;

	it("starts a deliberately nonterminating fixture-owned runner", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: process.platform !== "win32",
			stdio: "ignore",
		});
		unrelated.unref();
		const runId = "fixture-owned-nonterminating";
		const receipt = executeAsyncSingle(runId, {
			agent: "worker",
			task: "Remain active until fixture teardown",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "fixture-lifecycle" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal(receipt.isError, undefined);
		ownedPid = (await waitForStatus(runId)).pid;
		assert.equal(alive(ownedPid), true);
	});

	it("left no owned runner alive and did not touch an unrelated process", async () => {
		try {
			assert.equal(alive(ownedPid), false);
			assert.ok(unrelated.pid);
			assert.equal(alive(unrelated.pid), true);
		} finally {
			if (unrelated.pid && alive(unrelated.pid)) {
				await createOwnedProcessTreeController(unrelated.pid, { termGraceMs: 500, killVerifyMs: 500 }).terminate();
			}
		}
	});
});
