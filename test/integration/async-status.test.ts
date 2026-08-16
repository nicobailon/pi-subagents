import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatAsyncRunList, listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { ACTIVE_RUN_INDEX_DIR, DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS, updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { encodeIndexSegment } from "../../src/runs/background/index-segment.ts";
import { TERMINAL_RUN_INDEX_DIR } from "../../src/runs/background/terminal-run-index.ts";
import { claimRunFanoutBatch, createRunFanoutBudget, writeRunFanoutBudgetDescriptor } from "../../src/runs/shared/run-fanout-budget.ts";

function createAsyncDir(root: string, id: string, status: Record<string, unknown>): string {
	const dir = path.join(root, id);
	fs.mkdirSync(dir, { recursive: true });
	const persisted = status.sessionId === undefined ? { ...status, sessionId: "session-a" } : status;
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(persisted), "utf-8");
	updateActiveRunIndex(dir, persisted.state as "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected");
	return dir;
}

describe("async status helpers", () => {
	it("lists only requested states and includes flattened step summaries", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-"));
		let budgetDirectory: string | undefined;
		try {
			const outputFile = path.join(root, "run-a", "output-1.log");
			const runDir = createAsyncDir(root, "run-a", {
				runId: "run-a",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				cwd: "/repo-a",
				currentStep: 1,
				runFanoutBudget: { used: 2, limit: 64, remaining: 62 },
				outputFile,
				steps: [
					{ agent: "scout", status: "complete", durationMs: 10, description: "Inspect auth only" },
					{ agent: "worker", status: "running", durationMs: 20, description: "Patch billing only" },
				],
			});
			const descriptor = createRunFanoutBudget("run-a", 64);
			budgetDirectory = descriptor.directory;
			writeRunFanoutBudgetDescriptor(runDir, descriptor);
			claimRunFanoutBatch(descriptor, ["chain[0]", "chain[1]", "chain[1]/single"]);
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
			assert.equal(runs[0]?.steps[0]?.description, "Inspect auth only");
			assert.equal(runs[0]?.steps[1]?.description, "Patch billing only");
			const text = formatAsyncRunList(runs);
			assert.match(text, /Run fan-out: 3\/64 used, 61 remaining/);
			assert.match(text, /output: .*output-1\.log/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			if (budgetDirectory) fs.rmSync(budgetDirectory, { recursive: true, force: true });
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

	it("preserves capability ceiling and audit projections on summaries", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-capability-"));
		try {
			const ceiling = { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["plan"] };
			const audit = { ceiling, requestedTools: ["read", "write"], effectiveTools: ["read"], removedTools: ["write"], internalTools: [], extensionsDenied: true, removedExtensionCount: 1, requestedMcpToolCount: 0, effectiveMcpTools: [] };
			createAsyncDir(root, "run-capability", {
				runId: "run-capability",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				capabilityCeiling: ceiling,
				capabilityAudit: audit,
				steps: [{ agent: "worker", status: "complete", capabilityCeiling: ceiling, capabilityAudit: audit }],
			});

			const runs = listAsyncRuns(root, { states: ["complete"] });
			assert.deepEqual(runs[0]?.capabilityCeiling, ceiling);
			assert.deepEqual(runs[0]?.capabilityAudit, audit);
			assert.deepEqual(runs[0]?.steps[0]?.capabilityCeiling, ceiling);
			assert.deepEqual(runs[0]?.steps[0]?.capabilityAudit, audit);
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

	it("does not infer workflow activity from the workflow launch time", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-workflow-no-false-activity-"));
		try {
			const now = Date.now();
			createAsyncDir(root, "workflow-running", {
				runId: "workflow-running",
				mode: "workflow",
				state: "running",
				startedAt: now - 120_000,
				lastUpdate: now - 120_000,
				steps: [{ agent: "main", workflowKey: "main", status: "running", startedAt: now - 120_000 }],
			});

			const runs = listAsyncRuns(root, { states: ["running"] });
			assert.equal(runs[0]?.lastActivityAt, undefined);
			assert.equal(runs[0]?.steps[0]?.lastActivityAt, undefined);
			assert.doesNotMatch(formatAsyncRunList(runs), /active 2m ago/);
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
				() => listAsyncRuns(root, { repairScan: true }),
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
				sessionId: "session-stale",
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

	it("lists indexed active runs without reading historical status files", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-indexed-"));
		try {
			for (let i = 0; i < 200; i++) {
				createAsyncDir(root, `terminal-${i}`, {
					runId: `terminal-${i}`,
					mode: "single",
					state: "complete",
					startedAt: 100,
					steps: [{ agent: "reviewer", status: "complete" }],
				});
			}
			fs.writeFileSync(path.join(root, "terminal-0", "status.json"), "{not-json", "utf-8");
			createAsyncDir(root, "active", {
				runId: "active",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			const runs = listAsyncRuns(root, { states: ["queued", "running"], reconcile: false });

			assert.deepEqual(runs.map((run) => run.id), ["active"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("lists recent terminal runs from time-sortable session markers", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-terminal-index-"));
		try {
			for (let index = 1; index <= 3; index++) {
				createAsyncDir(root, `terminal-${index}`, {
					runId: `terminal-${index}`,
					sessionId: "session-a",
					mode: "single",
					state: "complete",
					startedAt: index,
					endedAt: index * 100,
					steps: [{ agent: "worker", status: "complete" }],
				});
			}

			const runs = listAsyncRuns(root, { sessionId: "session-a", states: ["complete"], entryLimit: 2, reconcile: false });
			assert.deepEqual(runs.map((run) => run.id), ["terminal-3", "terminal-2"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes invalid terminal markers while reading the advisory index", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-terminal-heal-"));
		try {
			const marker = path.join(root, TERMINAL_RUN_INDEX_DIR, encodeIndexSegment("session-a"), "0000000000000100-missing.json");
			fs.mkdirSync(path.dirname(marker), { recursive: true });
			fs.writeFileSync(marker, JSON.stringify({ version: 1, runId: "missing", sessionId: "session-a", endedAt: 100 }));

			assert.deepEqual(listAsyncRuns(root, { sessionId: "session-a", states: ["complete"], reconcile: false }), []);
			assert.equal(fs.existsSync(marker), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not enumerate the async root for full-id or unsafe-prefix misses", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-exact-miss-"));
		const originalReaddirSync = fsDefault.readdirSync;
		try {
			fsDefault.readdirSync = (() => { throw new Error("async root enumerated"); }) as typeof fsDefault.readdirSync;
			syncBuiltinESMExports();
			assert.deepEqual(listAsyncRuns(root, { runId: "12345678-1234-1234-1234-123456789012", reconcile: false }), []);
			assert.deepEqual(listAsyncRuns(root, { runId: "short", reconcile: false }), []);
		} finally {
			fsDefault.readdirSync = originalReaddirSync;
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps terminal active markers until observed process-terminal proof releases them", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-index-prune-"));
		try {
			const asyncDir = createAsyncDir(root, "finished", {
				runId: "finished",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				displayDismissedAt: 250,
				processTerminal: { version: 1, state: "unknown", runId: "finished", runnerProcessInstanceId: "runner", reason: "process-tree-unverified" },
				steps: [{ agent: "worker", status: "complete" }],
			});
			updateActiveRunIndex(asyncDir, "running");
			const markerPath = path.join(root, ACTIVE_RUN_INDEX_DIR, "finished");

			assert.deepEqual(listAsyncRuns(root, { states: ["running"], reconcile: false }), []);
			assert.equal(fs.existsSync(markerPath), true);

			fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify({
				version: 1,
				state: "observed",
				runId: "finished",
				runnerProcessInstanceId: "runner",
				observedAt: 300,
				instances: [{ kind: "runner", processInstanceId: "runner", closeObservedAt: 300, exitCode: 0, signal: null }],
			}), "utf-8");
			assert.deepEqual(listAsyncRuns(root, { states: ["running"], reconcile: false }), []);
			assert.equal(fs.existsSync(markerPath), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prunes old terminal active markers without process-terminal proof", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-index-aged-prune-"));
		try {
			const asyncDir = createAsyncDir(root, "finished", {
				runId: "finished",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				displayDismissedAt: 250,
				processTerminal: { version: 1, state: "unknown", runId: "finished", runnerProcessInstanceId: "runner", reason: "process-tree-unverified" },
				steps: [{ agent: "worker", status: "complete" }],
			});
			updateActiveRunIndex(asyncDir, "running");
			const markerPath = path.join(root, ACTIVE_RUN_INDEX_DIR, "finished");
			const oldTime = new Date(1_000);
			fs.utimesSync(markerPath, oldTime, oldTime);

			assert.deepEqual(listAsyncRuns(root, { states: ["running"], reconcile: false, now: () => 1_000 + DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS + 1 }), []);
			assert.equal(fs.existsSync(markerPath), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
