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
import * as fs from "node:fs";
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

	function makeExecutor(agents = [makeAgent("echo")]) {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
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

		const outputPath = path.join(tempDir, "parallel-output.md");
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
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
		assert.equal(args.at(-1), `Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect`);
	});

	it("top-level parallel progress emits the existing progress instruction style", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Progress done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-progress",
			{ tasks: [{ agent: "echo", task: "Track work", progress: true }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		assert.ok((args.at(-1) ?? "").includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});
});
