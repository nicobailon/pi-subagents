/**
 * Integration tests for parallel execution.
 *
 * Tests the mapConcurrent utility and parallel agent spawning via runSync.
 * The top-level parallel mode (params.tasks) lives in index.ts and uses
 * mapConcurrent + runSync — we test both pieces here.
 *
 * mapConcurrent tests always run. runSync tests require pi packages.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./src/shared/utils.ts");
const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
const piAvailable = !!(execution && utils);

const runSync = execution?.runSync;
const mapConcurrent = utils?.mapConcurrent;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

// ---------------------------------------------------------------------------
// mapConcurrent — always runs (pure logic, no pi deps beyond utils.ts)
// ---------------------------------------------------------------------------

describe("mapConcurrent", { skip: !mapConcurrent ? "utils not importable" : undefined }, () => {
	it("processes all items", async () => {
		const items = [1, 2, 3, 4, 5];
		const results = await mapConcurrent(items, 2, async (item: number) => item * 2);
		assert.deepEqual(results, [2, 4, 6, 8, 10]);
	});

	it("preserves order regardless of completion time", async () => {
		const items = [80, 10, 40]; // delays in ms
		const results = await mapConcurrent(items, 3, async (ms: number, i: number) => {
			await new Promise((r) => setTimeout(r, ms));
			return i;
		});
		assert.deepEqual(results, [0, 1, 2], "results should be in original order");
	});

	it("respects concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3, 4, 5, 6];

		await mapConcurrent(items, 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
		});

		assert.ok(maxRunning <= 2, `max concurrent should be ≤ 2, got ${maxRunning}`);
	});

	it("handles empty array", async () => {
		const results = await mapConcurrent([], 4, async (item: unknown) => item);
		assert.deepEqual(results, []);
	});

	it("propagates errors", async () => {
		await assert.rejects(
			() =>
				mapConcurrent([1, 2, 3], 2, async (item: number) => {
					if (item === 2) throw new Error("boom");
					return item;
				}),
			/boom/,
		);
	});
});

// ---------------------------------------------------------------------------
// Parallel agent execution via runSync
// ---------------------------------------------------------------------------

describe("parallel agent execution", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeExecutor(
		agents = [makeAgent("echo")],
		state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
		config: Record<string, unknown> = {},
	) {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	function git(args: string[]): string {
		const result = spawnSync("git", args, { cwd: tempDir, encoding: "utf-8" });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		return result.stdout.trim();
	}

	function readLastCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	it("runs multiple agents concurrently via mapConcurrent + runSync", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["agent-a", "agent-b", "agent-c"]);
		const tasks = ["Task A", "Task B", "Task C"];

		const results = await mapConcurrent(
			tasks.map((task, i) => ({ agent: agents[i].name, task, index: i })),
			3,
			async ({ agent, task, index }: any) => {
				return runSync(tempDir, agents, agent, task, { index });
			},
		);

		assert.equal(results.length, 3);
		assert.ok(results.every((r: any) => r.exitCode === 0));
		assert.equal(results[0].agent, "agent-a");
		assert.equal(results[1].agent, "agent-b");
		assert.equal(results[2].agent, "agent-c");
	});

	it("all agents get independent results", async () => {
		mockPi.onCall({ output: "Result" });
		const agents = makeAgentConfigs(["a", "b"]);

		const results = await mapConcurrent(
			[
				{ agent: "a", task: "Task A" },
				{ agent: "b", task: "Task B" },
			],
			2,
			async ({ agent, task }: any, i: number) => runSync(tempDir, agents, agent, task, { index: i }),
		);

		assert.equal(results.length, 2);
		assert.equal(results[0].agent, "a");
		assert.equal(results[1].agent, "b");
		const ok = results.filter((r: any) => r.exitCode === 0).length;
		assert.equal(ok, 2);
	});

	it("tracks every concurrently running foreground child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		for (let index = 0; index < 3; index++) mockPi.onCall({ output: `Review ${index} complete`, delay: 250 });
		const agents = [makeAgent("reviewer")];
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = makeExecutor(agents, state);
		const executionPromise = executor.execute(
			"parallel-foreground-fleet",
			{
				tasks: [
					{ agent: "reviewer", task: "Review correctness" },
					{ agent: "reviewer", task: "Review quality" },
					{ agent: "reviewer", task: "Review tests" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		for (let attempt = 0; attempt < 40; attempt++) {
			const active = [...state.foregroundControls.values()][0]?.activeChildren;
			if (active?.size === 3) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const control = [...state.foregroundControls.values()][0];
		assert.ok(control);
		assert.deepEqual([...control.activeChildren.values()].map((child) => child.description), [
			"Review correctness",
			"Review quality",
			"Review tests",
		]);
		assert.equal(control.activeChildren.size, 3);

		const result = await executionPromise;
		assert.equal(result.isError, undefined);
		assert.equal(state.foregroundControls.size, 0);
	});

	it("exposes stable child indexes for counted top-level parallel results", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolName: "read", args: { path: "a.md" } }], delay: 10 },
				{ jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Counted A done" }], model: "mock/test-model", stopReason: "stop", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } }] },
			],
		});
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolName: "read", args: { path: "b.md" } }], delay: 10 },
				{ jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Counted B done" }], model: "mock/test-model", stopReason: "stop", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } }] },
			],
		});
		const executor = makeExecutor();
		const updateIndexes: number[] = [];

		const result = await executor.execute(
			"counted-parallel-indexes",
			{ tasks: [{ agent: "echo", task: "Counted inspection", count: 2 }] },
			new AbortController().signal,
			(update) => {
				for (const row of update.details?.results ?? []) updateIndexes.push(row.index);
			},
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.results.map((row: { index: number }) => row.index), [0, 1]);
		assert.deepEqual([...new Set(result.details?.results.map((row: { index: number }) => row.index))], [0, 1]);
		assert.ok(updateIndexes.includes(0));
		assert.ok(updateIndexes.includes(1));
		assert.ok(updateIndexes.every((index) => Number.isInteger(index)));
	});

	it("publishes a durable handoff before cleaning foreground parallel worktrees", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		git(["init"]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\n", "utf-8");
		git(["add", "tracked.txt"]);
		git(["commit", "-m", "initial"]);
		mockPi.onCall({ output: "Worktree task complete" });
		const executor = makeExecutor();
		const result = await executor.execute(
			"foreground-worktree-handoff",
			{ tasks: [{ agent: "echo", task: "Work in isolation" }], worktree: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.parallelHandoff?.version, 1);
		assert.equal(result.details?.parallelHandoff?.cleanupState, "complete");
		assert.match(result.content[0]?.text ?? "", /Parallel handoff:/);
		const handoffPath = result.details!.parallelHandoff!.path;
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{ children: Array<{ agent: string; summary: string; patch: { path: string } }>; cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> } }>;
		};
		assert.equal(handoff.groups[0]!.children[0]!.agent, "echo");
		assert.equal(handoff.groups[0]!.children[0]!.summary, "Worktree task complete");
		assert.equal(fs.existsSync(handoff.groups[0]!.children[0]!.patch.path), true);
		assert.ok(result.details?.runId);
		assert.ok(handoff.groups[0]!.children[0]!.patch.path.includes(`${path.sep}worktree-diffs${path.sep}${result.details.runId}${path.sep}`));
		assert.equal(handoff.groups[0]!.cleanup.state, "complete");
		assert.equal(handoff.groups[0]!.cleanup.tasks[0]!.worktreeRemoved, true);
		assert.equal(handoff.groups[0]!.cleanup.tasks[0]!.branchRemoved, true);
		assert.equal(fs.existsSync(handoff.groups[0]!.cleanup.tasks[0]!.path), false);
	});

	it("aborts and cleans up before child execution when the ownership journal cannot be written", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		git(["init"]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\n", "utf-8");
		git(["add", "tracked.txt"]);
		git(["commit", "-m", "initial"]);
		const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
		try {
			const artifactsDir = path.join(sessionDir, "subagent-artifacts");
			fs.mkdirSync(artifactsDir, { recursive: true });
			fs.writeFileSync(path.join(artifactsDir, "handoffs"), "not a directory", "utf-8");
			mockPi.onCall({ output: "Worktree task complete" });
			const executor = makeExecutor([makeAgent("echo")], undefined, { artifactDir: "session" });
			const ctx = {
				...makeMinimalCtx(tempDir),
				sessionManager: {
					getSessionId: () => "session-123",
					getSessionFile: () => path.join(sessionDir, "session.jsonl"),
				},
			};
			const result = await executor.execute(
				"foreground-worktree-handoff-collision",
				{ tasks: [{ agent: "echo", task: "Work in isolation" }], worktree: true },
				new AbortController().signal,
				undefined,
				ctx,
			);

			assert.equal(result.isError, true);
			assert.equal(result.details?.parallelHandoff, undefined);
			assert.match(result.content[0]?.text ?? "", /handoff|not a directory|EEXIST/i);
			assert.equal(mockPi.callCount(), 0);
			assert.doesNotMatch(git(["worktree", "list", "--porcelain"]), /pi-parallel-/);
			assert.equal(git(["branch", "--list", "pi-parallel-*"]), "");
		} finally {
			fs.rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("treats parallel action aliases with tasks as top-level parallel execution", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		for (const action of ["parallel", "PARALLEL", "tasks"]) {
			mockPi.reset();
			mockPi.onCall({ output: `${action} alias finished` });
			const executor = makeExecutor();

			const result = await executor.execute(
				`parallel-alias-${action}`,
				{ action, tasks: [{ agent: "echo", task: `Run ${action}` }] },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.equal(result.details?.mode, "parallel");
			assert.match(result.content[0]?.text ?? "", new RegExp(`${action} alias finished`));
		}
	});

	it("does not apply agent acceptance defaults to top-level parallel tasks", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "parallel response without explicit acceptance" });
		const executor = makeExecutor([
			makeAgent("echo", { defaultAcceptance: { level: "none", reason: "single launches only" } }),
		]);

		const result = await executor.execute(
			"parallel-agent-acceptance-default",
			{ tasks: [{ agent: "echo", task: "Return a concise answer" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results?.[0]?.acceptance?.explicit, false);
		assert.equal(result.details?.results?.[0]?.acceptance?.effectiveAcceptance.level, "attested");
	});

	it("applies agent acceptance roles to inferred parallel acceptance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "exploration complete" });
		const executor = makeExecutor([
			makeAgent("worker", { acceptanceRole: "read-only" }),
		]);

		const result = await executor.execute(
			"parallel-agent-acceptance-role",
			{ tasks: [{ agent: "worker", task: "Explore the authentication flow" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.details?.results?.[0]?.acceptance?.effectiveAcceptance.level, "attested");
	});

	it("top-level parallel output saves use per-task output paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Saved report" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-output.md" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const runId = result.details?.runId;
		assert.ok(runId, "expected run id in details");
		const outputPath = path.join(tempDir, ".pi-subagents", "artifacts", "outputs", runId, "parallel-output.md");
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
	});

	it("top-level parallel tasks support outputSchema", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "First structured", output: "first", structuredOutput: { ok: true, item: "first" } });
		mockPi.onCall({ matchArgIncludes: "Second structured", output: "second", structuredOutput: { ok: true, item: "second" } });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-schema",
			{
				tasks: [
					{ agent: "echo", task: "First structured", outputSchema: { type: "object", required: ["ok", "item"], properties: { ok: { type: "boolean" }, item: { type: "string" } } } },
					{ agent: "echo", task: "Second structured", outputSchema: { type: "object", required: ["ok", "item"], properties: { ok: { type: "boolean" }, item: { type: "string" } } } },
				],
				acceptance: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.results?.map((item: { structuredOutput?: unknown }) => item.structuredOutput), [
			{ ok: true, item: "first" },
			{ ok: true, item: "second" },
		]);
	});

	it("top-level parallel preserves completed siblings and marks timed-out children", { skip: !createSubagentExecutor ? "executor not importable" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Slow review", delay: 10000 });
		mockPi.onCall({ matchArgIncludes: "Fast review", output: "fast done" });
		const executor = makeExecutor();

		const start = Date.now();
		const result = await executor.execute(
			"parallel-timeout",
			{
				tasks: [
					{ agent: "echo", task: "Slow review" },
					{ agent: "echo", task: "Fast review" },
				],
				concurrency: 2,
				maxRuntimeMs: 300,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results?.length, 2);
		assert.equal(result.details?.results?.[0]?.timedOut, true);
		assert.equal(result.details?.results?.[0]?.error, "Subagent timed out after 300ms.");
		assert.equal(result.details?.results?.[1]?.exitCode, 0);
		assert.equal(result.details?.results?.[1]?.finalOutput, "fast done");
		assert.match(result.content[0]?.text ?? "", /1\/2 succeeded/);
		assert.match(result.content[0]?.text ?? "", /TIMED OUT: Subagent timed out after 300ms\./);
	});

	it("top-level parallel file-only output aggregates concise file references", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Parallel full report\nwith details" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-file-only.md", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const runId = result.details?.runId;
		assert.ok(runId, "expected run id in details");
		const outputPath = path.join(tempDir, ".pi-subagents", "artifacts", "outputs", runId, "parallel-file-only.md");
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Output saved to:/);
		assert.match(text, /2 lines/);
		assert.doesNotMatch(text, /Parallel full report/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details?.results?.[0]?.finalOutput ?? "", /Parallel full report/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Parallel full report\nwith details");
	});

	it("rejects top-level parallel file-only output without an output path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-missing-output",
			{ tasks: [{ agent: "echo", task: "Write report", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects duplicate top-level parallel output paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-duplicate-output",
			{
				tasks: [
					{ agent: "echo", task: "Write A", output: "same.md" },
					{ agent: "echo", task: "Write B", output: "same.md" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	for (const outputOverride of [undefined, true] as const) {
		it(`isolates foreground inherited output (${outputOverride === true ? "output:true" : "omitted output"})`, { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
			mockPi.onCall({ matchArgIncludes: "Write A", output: "first foreground report" });
			mockPi.onCall({ matchArgIncludes: "Write B", output: "second foreground report" });
			const executor = makeExecutor([makeAgent("echo", { output: "context.md" })]);
			const tasks = [
				{ agent: "echo", task: "Write A", ...(outputOverride !== undefined ? { output: outputOverride } : {}) },
				{ agent: "echo", task: "Write B", ...(outputOverride !== undefined ? { output: outputOverride } : {}) },
			];

			const result = await executor.execute(
				`parallel-inherited-output-${outputOverride === true ? "true" : "omitted"}`,
				{ tasks },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			const runId = result.details?.runId;
			assert.ok(runId, "expected run id in details");
			const outputDir = path.join(tempDir, ".pi-subagents", "artifacts", "outputs", runId);
			const firstOutputPath = path.join(outputDir, "parallel-0", "0-echo", "context.md");
			const secondOutputPath = path.join(outputDir, "parallel-0", "1-echo", "context.md");
			assert.equal(result.isError, undefined);
			assert.equal(mockPi.callCount(), 2);
			assert.equal(fs.readFileSync(firstOutputPath, "utf-8"), "first foreground report");
			assert.equal(fs.readFileSync(secondOutputPath, "utf-8"), "second foreground report");
			assert.equal(result.details?.results?.[0]?.savedOutputPath, firstOutputPath);
			assert.equal(result.details?.results?.[1]?.savedOutputPath, secondOutputPath);
		});
	}

	it("treats string false as disabled output in top-level parallel runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-string-false-output",
			{
				tasks: [
					{ agent: "echo", task: "Review A", output: "false" },
					{ agent: "echo", task: "Review B", output: "false" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
	});

	it("top-level parallel reads are injected once with chain-style prefix", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Read done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-reads",
			{ tasks: [{ agent: "echo", task: "Inspect", reads: ["a.md", "b.md"] }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.startsWith(`Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect

## Acceptance Contract`));
	});

	it("top-level parallel defaultProgress uses isolated run storage", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Progress done" });
		const executor = makeExecutor([makeAgent("echo", { defaultProgress: true })]);
		const parentSessionFile = path.join(tempDir, "parent-session.jsonl");

		const result = await executor.execute(
			"parallel-progress",
			{ tasks: [{ agent: "echo", task: "Track work" }] },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				sessionManager: {
					getSessionId: () => "session-123",
					getSessionFile: () => parentSessionFile,
				},
			},
		);
		const runId = result.details?.runId;
		assert.ok(runId, "expected run id in details");
		const expectedProgressPath = path.join(tempDir, ".pi-subagents", "artifacts", "progress", runId, "progress.md");

		const args = readLastCallArgs();
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.includes(`Update progress at: ${expectedProgressPath}`), taskArg);
		assert.equal(fs.existsSync(expectedProgressPath), true);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("top-level parallel suppresses progress when the task is review-only", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor([makeAgent("reviewer", { defaultProgress: true })]);

		await executor.execute(
			"parallel-read-only-progress",
			{ tasks: [{ agent: "reviewer", task: "Review-only. Do not edit files. Return findings." }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readLastCallArgs().at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});
});
