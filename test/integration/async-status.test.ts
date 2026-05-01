import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatAsyncRunList, listAsyncRuns, listAsyncRunsForOverlay } from "../../src/runs/background/async-status.ts";

function createAsyncDir(root: string, id: string, status: Record<string, unknown>): string {
	const dir = path.join(root, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
	return dir;
}

describe("async status helpers", () => {
	it("lists only requested states and includes flattened step summaries", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-"));
		try {
			createAsyncDir(root, "run-a", {
				runId: "run-a",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				cwd: "/repo-a",
				currentStep: 1,
				steps: [
					{ agent: "scout", status: "complete", durationMs: 10 },
					{ agent: "worker", status: "running", durationMs: 20 },
				],
			});
			createAsyncDir(root, "run-b", {
				runId: "run-b",
				mode: "single",
				state: "complete",
				startedAt: 50,
				lastUpdate: 75,
				steps: [{ agent: "reviewer", status: "complete" }],
			});

			const runs = listAsyncRuns(root, { states: ["queued", "running"] });
			assert.equal(runs.length, 1);
			assert.equal(runs[0]?.id, "run-a");
			assert.equal(runs[0]?.cwd, "/repo-a");
			assert.equal(runs[0]?.steps.length, 2);
			assert.equal(runs[0]?.steps[1]?.agent, "worker");
			assert.equal(runs[0]?.steps[1]?.status, "running");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("orders recent overlay runs by recency instead of failure-first state ranking", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recent-order-"));
		try {
			createAsyncDir(root, "older-failed", {
				runId: "older-failed",
				mode: "single",
				state: "failed",
				startedAt: 10,
				lastUpdate: 100,
				endedAt: 100,
				steps: [{ agent: "worker", status: "failed" }],
			});
			createAsyncDir(root, "newer-complete", {
				runId: "newer-complete",
				mode: "single",
				state: "complete",
				startedAt: 20,
				lastUpdate: 200,
				endedAt: 200,
				steps: [{ agent: "reviewer", status: "complete" }],
			});

			const overlay = listAsyncRunsForOverlay(root, { recentLimit: 5 });
			assert.deepEqual(overlay.recent.map((run) => run.id), ["newer-complete", "older-failed"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("filters overlay runs by session before applying the recent limit", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-session-overlay-"));
		try {
			for (let index = 0; index < 5; index++) {
				createAsyncDir(root, `other-${index}`, {
					runId: `other-${index}`,
					sessionId: "session-other",
					mode: "single",
					state: "complete",
					startedAt: 100 + index,
					lastUpdate: 1_000 + index,
					endedAt: 1_000 + index,
					steps: [{ agent: "other", status: "complete" }],
				});
			}
			createAsyncDir(root, "current-running", {
				runId: "current-running",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				startedAt: 50,
				lastUpdate: 60,
				steps: [{ agent: "worker", status: "running" }],
			});
			createAsyncDir(root, "current-complete", {
				runId: "current-complete",
				sessionId: "session-current",
				mode: "single",
				state: "complete",
				startedAt: 40,
				lastUpdate: 70,
				endedAt: 70,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const overlay = listAsyncRunsForOverlay(root, { recentLimit: 1, sessionId: "session-current" });
			assert.deepEqual(overlay.active.map((run) => run.id), ["current-running"]);
			assert.deepEqual(overlay.recent.map((run) => run.id), ["current-complete"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses persisted running attention state from detached runners", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-running-state-"));
		try {
			const lastActivityAt = Date.now() - 65_000;
			createAsyncDir(root, "run-running", {
				runId: "run-running",
				mode: "single",
				state: "running",
				activityState: "needs_attention",
				lastActivityAt,
				startedAt: Date.now() - 70_000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", activityState: "needs_attention", lastActivityAt }],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.activityState, "needs_attention");
			assert.equal(runs[0]?.steps[0]?.activityState, "needs_attention");
			const text = formatAsyncRunList(runs, "Active async runs");
			assert.match(text, /no activity for/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not infer attention state when the runner has not persisted one", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-no-derived-attention-"));
		try {
			const now = Date.now();
			createAsyncDir(root, "run-running", {
				runId: "run-running",
				mode: "single",
				state: "running",
				lastActivityAt: now - 90_000,
				startedAt: now - 120_000,
				lastUpdate: now,
				steps: [{ agent: "worker", status: "running", lastActivityAt: now - 90_000 }],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.activityState, undefined);
			assert.equal(runs[0]?.steps[0]?.activityState, undefined);
			assert.match(formatAsyncRunList(runs, "Active async runs"), /worker \| running \| active/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not smear run-level attention state across running siblings when step metadata exists", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-step-attention-"));
		try {
			const now = Date.now();
			createAsyncDir(root, "run-mixed", {
				runId: "run-mixed",
				mode: "chain",
				state: "running",
				activityState: "needs_attention",
				lastActivityAt: now - 90_000,
				startedAt: now - 120_000,
				lastUpdate: now,
				steps: [
					{ agent: "idle", status: "running", activityState: "needs_attention", lastActivityAt: now - 90_000 },
					{ agent: "active", status: "running", lastActivityAt: now - 1_000 },
				],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.steps[0]?.activityState, "needs_attention");
			assert.equal(runs[0]?.steps[1]?.activityState, undefined);
			const text = formatAsyncRunList(runs, "Active async runs");
			assert.match(text, /idle \| running \| no activity for/);
			assert.match(text, /active \| running \| active/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats paused runs as lifecycle state without activity state", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-paused-status-"));
		try {
			createAsyncDir(root, "run-paused", {
				runId: "run-paused",
				mode: "single",
				state: "paused",
				startedAt: 100,
				lastUpdate: 200,
				endedAt: 200,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const overlay = listAsyncRunsForOverlay(root, { recentLimit: 5 });
			assert.equal(overlay.active.length, 0);
			assert.equal(overlay.recent[0]?.id, "run-paused");
			assert.equal(overlay.recent[0]?.activityState, undefined);
			assert.equal(overlay.recent[0]?.steps[0]?.activityState, undefined);

			const text = formatAsyncRunList(overlay.recent, "Recent async runs");
			assert.match(text, /run-paused \| paused/);
			assert.match(text, /worker \| complete/);
			assert.doesNotMatch(text, /paused\/paused/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces malformed status files instead of silently skipping them", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-bad-status-"));
		const dir = path.join(root, "broken-run");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "status.json"), "{not-json", "utf-8");
		try {
			assert.throws(
				() => listAsyncRuns(root),
				/Failed to parse async status file/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed persisted session ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-bad-session-id-"));
		try {
			createAsyncDir(root, "bad-session", {
				runId: "bad-session",
				sessionId: { value: "session" },
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() => listAsyncRuns(root),
				/sessionId must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale running runs before listing active async runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-stale-list-"));
		const resultsDir = path.join(root, "results");
		try {
			const asyncDir = createAsyncDir(root, "run-stale", {
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running", startedAt: 100 }],
			});

			const active = listAsyncRuns(root, {
				states: ["running"],
				resultsDir,
				kill: () => { const error = new Error("missing") as NodeJS.ErrnoException; error.code = "ESRCH"; throw error; },
				now: () => 200,
			});
			assert.equal(active.length, 0);
			const failed = listAsyncRuns(root, { states: ["failed"], resultsDir, reconcile: false });
			assert.equal(failed[0]?.id, "run-stale");
			assert.equal(failed[0]?.steps[0]?.status, "failed");
			assert.equal(fs.existsSync(path.join(resultsDir, "run-stale.json")), true);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /repaired_stale/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses explicit parallel group wording for async chains", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-parallel-wording-"));
		try {
			createAsyncDir(root, "run-parallel", {
				runId: "run-parallel",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				currentStep: 0,
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				steps: [
					{ agent: "scout", status: "running", durationMs: 12_000 },
					{ agent: "reviewer", status: "running", durationMs: 11_000 },
					{ agent: "worker", status: "pending" },
					{ agent: "writer", status: "pending" },
				],
			});
			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /step 1\/2 · parallel group: 2 agents running · 0\/3 done/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses parallel group wording even when concurrency leaves one agent running", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-parallel-one-running-"));
		try {
			createAsyncDir(root, "run-parallel-one", {
				runId: "run-parallel-one",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				currentStep: 1,
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				steps: [
					{ agent: "scout", status: "complete", durationMs: 12_000 },
					{ agent: "reviewer", status: "running", durationMs: 11_000 },
					{ agent: "worker", status: "pending" },
				],
			});
			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /step 1\/1 · parallel group: 1 agent running · 1\/3 done/);
			assert.doesNotMatch(text, /step 2\/3/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores invalid persisted parallel group metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-invalid-parallel-group-"));
		try {
			createAsyncDir(root, "run-invalid-group", {
				runId: "run-invalid-group",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				currentStep: 0,
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 4 }],
				steps: [
					{ agent: "scout", status: "running", durationMs: 12_000 },
					{ agent: "writer", status: "pending" },
				],
			});
			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /step 1\/2/);
			assert.doesNotMatch(text, /parallel group/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps serial step wording for sequential running chains", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-sequential-wording-"));
		try {
			createAsyncDir(root, "run-seq", {
				runId: "run-seq",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				currentStep: 0,
				steps: [
					{ agent: "scout", status: "running", durationMs: 12_000 },
					{ agent: "reviewer", status: "pending" },
				],
			});
			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /step 1\/2/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("separates active and recent runs for the overlay and formats readable list output", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-overlay-"));
		try {
			createAsyncDir(root, "run-running", {
				runId: "run-running",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				steps: [{ agent: "scout", status: "running", durationMs: 12_000 }],
			});
			createAsyncDir(root, "run-failed", {
				runId: "run-failed",
				mode: "single",
				state: "failed",
				startedAt: 50,
				lastUpdate: 250,
				endedAt: 250,
				steps: [{ agent: "worker", status: "failed", durationMs: 5_000 }],
			});
			createAsyncDir(root, "run-complete", {
				runId: "run-complete",
				mode: "single",
				state: "complete",
				startedAt: 10,
				lastUpdate: 200,
				endedAt: 200,
				steps: [{ agent: "reviewer", status: "complete", durationMs: 3_000 }],
			});

			const overlay = listAsyncRunsForOverlay(root, { recentLimit: 1 });
			assert.equal(overlay.active.length, 1);
			assert.equal(overlay.active[0]?.id, "run-running");
			assert.equal(overlay.recent.length, 1);
			assert.equal(overlay.recent[0]?.id, "run-failed");

			const text = formatAsyncRunList(overlay.active);
			assert.match(text, /Active async runs: 1/);
			assert.match(text, /run-running/);
			assert.match(text, /scout/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
