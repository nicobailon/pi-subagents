import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkPidLiveness, reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("async stale-run reconciliation", () => {
	it("classifies pid liveness without treating EPERM as dead", () => {
		assert.equal(checkPidLiveness(123, () => true), "alive");
		assert.equal(checkPidLiveness(123, () => { throw errno("ESRCH"); }), "dead");
		assert.equal(checkPidLiveness(123, () => { throw errno("EPERM"); }), "unknown");
		assert.equal(checkPidLiveness(123, () => { throw new Error("boom"); }), "unknown");
	});

	it("marks a running async run failed when the runner pid is dead and no result exists", () => {
		const root = tempRoot("pi-stale-run-");
		try {
			const asyncDir = path.join(root, "run-dead");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /process 12345 exited or disappeared/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.steps[0].status, "failed");
			assert.match(status.steps[0].error, /process 12345 exited or disappeared/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"));
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.sessionId, "session-current");
			assert.equal(resultJson.state, "failed");
			assert.equal(resultJson.exitCode, 1);
			assert.match(resultJson.summary, /process 12345 exited or disappeared/);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.run\.repaired_stale/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale status with per-child result outcomes", () => {
		const root = tempRoot("pi-stale-mixed-result-");
		try {
			const asyncDir = path.join(root, "run-mixed");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-mixed",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ agent: "scout", status: "running", startedAt: 1000 },
					{ agent: "worker", status: "running", startedAt: 1100 },
				],
			});
			fs.writeFileSync(path.join(resultsDir, "run-mixed.json"), JSON.stringify({
				id: "run-mixed",
				success: false,
				state: "failed",
				results: [
					{ agent: "scout", success: true, model: "fast" },
					{ agent: "worker", success: false, error: "boom", model: "careful" },
				],
			}, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[0]?.exitCode, 0);
			assert.equal(result.status?.steps?.[0]?.model, "fast");
			assert.equal(result.status?.steps?.[1]?.status, "failed");
			assert.equal(result.status?.steps?.[1]?.exitCode, 1);
			assert.equal(result.status?.steps?.[1]?.error, "boom");
			assert.equal(result.status?.steps?.[1]?.model, "careful");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a stale run when a live pid has not updated beyond the stale threshold", () => {
		const root = tempRoot("pi-stale-live-pid-");
		try {
			const asyncDir = path.join(root, "run-reused-pid");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-reused-pid",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => true,
				now: () => 5000,
				staleAlivePidMs: 1000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /live PID, but status has not updated/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing result instead of overwriting it with stale-run failure", () => {
		const root = tempRoot("pi-stale-existing-result-");
		try {
			const asyncDir = path.join(root, "run-result");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-result",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			const resultPath = path.join(resultsDir, "run-result.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "run-result", success: true, state: "complete", summary: "already done" }, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "complete");
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).summary, "already done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
