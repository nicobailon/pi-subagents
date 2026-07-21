import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatAsyncRunList, listAsyncRuns } from "../../src/runs/background/async-status.ts";

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
			const outputFile = path.join(root, "run-a", "output-1.log");
			createAsyncDir(root, "run-a", {
				runId: "run-a",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				cwd: "/repo-a",
				currentStep: 1,
				outputFile,
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
			assert.match(formatAsyncRunList(runs), /output: .*output-1\.log/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves agent contract projections on step summaries", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-contract-"));
		try {
			createAsyncDir(root, "run-contract", {
				runId: "run-contract",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [{
					agent: "worker",
					status: "complete",
					agentContract: { version: 1 },
					execution: { status: "completed", success: true, exitCode: 0 },
					acceptance: { status: "rejected", effectiveAcceptance: { level: "checked", explicit: true } },
					review: { status: "not-requested" },
					effects: { fileMutation: { status: "missing", expected: true, attempted: false } },
				}],
			});

			const runs = listAsyncRuns(root, { states: ["complete"] });
			const step = runs[0]?.steps[0];
			assert.equal(step?.agentContract?.version, 1);
			assert.deepEqual(step?.execution, { status: "completed", success: true, exitCode: 0 });
			assert.equal(step?.acceptance?.status, "rejected");
			assert.equal(step?.review?.status, "not-requested");
			assert.equal(step?.effects?.fileMutation?.status, "missing");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats async run and step context labels", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-context-"));
		try {
			createAsyncDir(root, "run-context", {
				runId: "run-context",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "scout", context: "fresh", status: "running" },
					{ agent: "worker", context: "fork", status: "running" },
				],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.context, "mixed");
			assert.deepEqual(runs[0]?.steps.map((step) => step.context), ["fresh", "fork"]);
			const text = formatAsyncRunList(runs);
			assert.match(text, /run-context \| running .* \| parallel \[mixed\]/);
			assert.match(text, /1\. scout \[fresh\] \| running/);
			assert.match(text, /2\. worker \[fork\] \| running/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats model thinking in step summaries", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-model-thinking-"));
		try {
			createAsyncDir(root, "run-model", {
				runId: "run-model",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "reviewer", status: "running", model: "openai-codex/gpt-5.5:high" },
					{ agent: "scout", status: "running", model: "anthropic/claude-haiku-4-5", thinking: "low" },
					{ agent: "local", status: "running", model: "ollama/qwen2.5-coder:7b" },
					{ agent: "fallback", status: "running", model: "anthropic/claude-sonnet-4-5:low", thinking: "high" },
				],
			});

			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /1\. reviewer \| running \| gpt-5\.5 · thinking high/);
			assert.match(text, /2\. scout \| running \| claude-haiku-4-5 · thinking low/);
			assert.match(text, /3\. local \| running \| qwen2\.5-coder:7b(?! · thinking)/);
			assert.match(text, /4\. fallback \| running \| claude-sonnet-4-5 · thinking low/);
			assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
			assert.doesNotMatch(text, /gpt-5\.5:high/);
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

	it("renders deferred turn-budget termination distinctly from a soft wrap-up request", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-turn-budget-deferred-"));
		try {
			createAsyncDir(root, "run-deferred", {
				runId: "run-deferred",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1_000,
				lastUpdate: Date.now(),
				wrapUpRequested: true,
				turnBudget: { maxTurns: 2, graceTurns: 1, turnCount: 3, outcome: "termination-deferred", wrapUpRequestedAtTurn: 2, terminationDeferredAtTurn: 3 },
				steps: [{
					agent: "worker",
					status: "running",
					wrapUpRequested: true,
					turnBudget: { maxTurns: 2, graceTurns: 1, turnCount: 3, outcome: "termination-deferred", wrapUpRequestedAtTurn: 2, terminationDeferredAtTurn: 3 },
				}],
			});

			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /turn-budget termination deferred 3\/2\+1/);
			assert.doesNotMatch(text, /wrap-up requested/);
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

			const runs = listAsyncRuns(root, { states: ["paused"] });
			assert.equal(runs[0]?.id, "run-paused");
			assert.equal(runs[0]?.activityState, undefined);
			assert.equal(runs[0]?.steps[0]?.activityState, undefined);

			const text = formatAsyncRunList(runs, "Paused async runs");
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

	it("uses foreground-style wording for top-level async parallel runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-top-parallel-wording-"));
		try {
			createAsyncDir(root, "run-parallel", {
				runId: "run-parallel",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				currentStep: 0,
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				steps: [
					{ agent: "scout", status: "running", durationMs: 12_000 },
					{ agent: "reviewer", status: "running", durationMs: 11_000 },
					{ agent: "worker", status: "pending" },
				],
			});
			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /run-parallel \| running .*\| parallel \| 2 agents running · 0\/3 done/);
			assert.doesNotMatch(text, /step 1\/1/);
			assert.doesNotMatch(text, /parallel group/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("includes terminal outcome counts for failed top-level async parallel runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-terminal-parallel-counts-"));
		try {
			createAsyncDir(root, "run-parallel-failed", {
				runId: "run-parallel-failed",
				mode: "parallel",
				state: "failed",
				startedAt: 100,
				lastUpdate: 300,
				currentStep: 0,
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				steps: [
					{ agent: "scout", status: "failed" },
					{ agent: "reviewer", status: "failed" },
					{ agent: "worker", status: "paused" },
				],
			});
			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["failed"] }));
			assert.match(text, /run-parallel-failed \| failed \| parallel \| 0\/3 done · 2 failed · 1 paused/);
			assert.doesNotMatch(text, /0 agents running/);
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
				parallelGroups: [{ start: 0, count: 3, stepIndex: 4 }, null, "bad"],
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

	it("keeps top-level parallel wording without valid group metadata", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-parallel-invalid-group-"));
		try {
			createAsyncDir(root, "run-parallel-invalid-group", {
				runId: "run-parallel-invalid-group",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 300,
				currentStep: 0,
				chainStepCount: 1,
				parallelGroups: "bad",
				steps: [
					{ agent: "scout", status: "running" },
					{ agent: "reviewer", status: "pending" },
				],
			});
			const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
			assert.match(text, /parallel \| 1 agent running · 0\/2 done/);
			assert.doesNotMatch(text, /step 1\/2/);
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

	it("filters terminal runs to active states without scanning nested routes per run", () => {
		// Regression guard: load-time restoration calls listAsyncRuns with a
		// queued/running filter over every run dir on disk. The nested-route
		// lookup must be skipped for runs that fail the state filter, otherwise
		// session start freezes when many stale run dirs have accumulated.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-filter-"));
		try {
			for (let i = 0; i < 200; i++) {
				createAsyncDir(root, `run-${i}`, {
					runId: `run-${i}`,
					mode: "single",
					state: "complete",
					startedAt: 100,
					lastUpdate: 200,
					steps: [{ agent: "reviewer", status: "complete" }],
				});
			}

			const start = Date.now();
			const runs = listAsyncRuns(root, { states: ["queued", "running"] });
			const elapsed = Date.now() - start;

			assert.equal(runs.length, 0);
			// 200 terminal dirs filtered to active states should resolve in well
			// under a second. The old per-run nested-route scan blew past this.
			assert.ok(elapsed < 1000, `listAsyncRuns took ${elapsed}ms for 200 terminal runs`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
