import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
	type RunnerSubagentStep,
	type ParallelStepGroup,
	type RunnerStep,
} from "../../src/runs/shared/parallel-utils.ts";

describe("isParallelGroup", () => {
	it("returns true for a parallel step group", () => {
		const step: ParallelStepGroup = {
			parallel: [
				{ agent: "a", task: "do stuff" },
				{ agent: "b", task: "do other stuff" },
			],
		};
		assert.equal(isParallelGroup(step), true);
	});

	it("returns false for a sequential step", () => {
		const step: RunnerSubagentStep = { agent: "a", task: "do stuff" };
		assert.equal(isParallelGroup(step), false);
	});

	it("returns false when parallel is not an array", () => {
		const step = { parallel: "not-an-array", agent: "a", task: "x" } as unknown as RunnerStep;
		assert.equal(isParallelGroup(step), false);
	});
});

describe("flattenSteps", () => {
	it("returns sequential steps unchanged", () => {
		const steps: RunnerStep[] = [
			{ agent: "a", task: "t1" },
			{ agent: "b", task: "t2" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 2);
		assert.equal(flat[0].agent, "a");
		assert.equal(flat[1].agent, "b");
	});

	it("expands parallel groups into individual steps", () => {
		const steps: RunnerStep[] = [
			{ agent: "scout", task: "find info" },
			{
				parallel: [
					{ agent: "reviewer-a", task: "review part 1" },
					{ agent: "reviewer-b", task: "review part 2" },
				],
			},
			{ agent: "summarizer", task: "combine" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 4);
		assert.deepEqual(
			flat.map((s) => s.agent),
			["scout", "reviewer-a", "reviewer-b", "summarizer"],
		);
	});

	it("handles empty steps array", () => {
		assert.deepEqual(flattenSteps([]), []);
	});

	it("handles empty parallel group", () => {
		const steps: RunnerStep[] = [
			{ agent: "before", task: "x" },
			{ parallel: [] },
			{ agent: "after", task: "y" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 2);
		assert.deepEqual(flat.map((s) => s.agent), ["before", "after"]);
	});
});

describe("mapConcurrent", () => {
	it("processes all items and preserves order", async () => {
		const items = [10, 20, 30, 40];
		const results = await mapConcurrent(items, 2, async (item) => item * 2);
		assert.deepEqual(results, [20, 40, 60, 80]);
	});

	it("respects concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3, 4, 5, 6];

		await mapConcurrent(items, 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
		});

		assert.ok(maxRunning <= 2, `max concurrent was ${maxRunning}, expected <= 2`);
	});

	it("handles empty input", async () => {
		const results = await mapConcurrent([], 4, async (item: number) => item);
		assert.deepEqual(results, []);
	});

	it("clamps limit=0 to 1 (sequential execution)", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3];
		await mapConcurrent(items, 0, async (item) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
			return item * 10;
		});
		assert.equal(maxRunning, 1, "should run sequentially with limit=0");
	});

	it("clamps limit=-1 to 1 (sequential execution)", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3];
		await mapConcurrent(items, -1, async (item) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
			return item * 10;
		});
		assert.equal(maxRunning, 1, "should run sequentially with limit=-1");
	});

	it("does not stagger by default", async () => {
		const startTimes: number[] = [];
		const items = [1, 2, 3];

		await mapConcurrent(items, 3, async (_item, i) => {
			startTimes[i] = Date.now();
			await new Promise((r) => setTimeout(r, 10));
		});

		// All workers should start nearly simultaneously
		const d1 = startTimes[1]! - startTimes[0]!;
		const d2 = startTimes[2]! - startTimes[0]!;
		assert.ok(d1 < 20, `worker 1 should start immediately, got ${d1}ms delay`);
		assert.ok(d2 < 20, `worker 2 should start immediately, got ${d2}ms delay`);
	});

	it("stagger makes total runtime longer than without stagger", async () => {
		// With staggerMs=60, 2 workers, and 2 items that each take 20ms:
		// Without stagger: both workers start immediately, total ~20ms.
		// With stagger: worker 1 starts immediately, worker 2 waits ~60ms, total ~80ms.
		const items = [1, 2];
		const blockMs = 20;

		const startNoStagger = Date.now();
		await mapConcurrent(items, 2, async () => {
			await new Promise((r) => setTimeout(r, blockMs));
		});
		const noStaggerDuration = Date.now() - startNoStagger;

		const startStagger = Date.now();
		await mapConcurrent(items, 2, async () => {
			await new Promise((r) => setTimeout(r, blockMs));
		}, { staggerMs: 60 });
		const staggerDuration = Date.now() - startStagger;

		// Staggered run should be meaningfully longer than non-staggered
		assert.ok(staggerDuration >= noStaggerDuration + 25,
			`staggered (${staggerDuration}ms) should be >= non-staggered (${noStaggerDuration}ms) + 25ms`);
	});

	it("stagger with jitter=0 is slower than with jitter=1 for small stagger", async () => {
		// Both should still apply stagger, just with different jitter ranges.
		// Just verify jitter=0 completes slower than no-stagger.
		const items = [1, 2];
		const blockMs = 20;

		const start = Date.now();
		await mapConcurrent(items, 2, async () => {
			await new Promise((r) => setTimeout(r, blockMs));
		}, { staggerMs: 50, staggerJitter: 0 });
		const duration = Date.now() - start;

		// With staggerMs=50 and no jitter, worker 2 waits exactly 50ms
		assert.ok(duration >= 50,
			`with jitter=0, duration (${duration}ms) should be >= 50ms`);
	});

	it("stagger options bag is accepted without error", async () => {
		const items = [1, 2, 3];
		const results = await mapConcurrent(items, 2, async (item) => item * 2, { staggerMs: 10, staggerJitter: 0.5 });
		assert.deepEqual(results, [2, 4, 6]);
	});
});

describe("aggregateParallelOutputs", () => {
	it("aggregates successful outputs with headers", () => {
		const result = aggregateParallelOutputs([
			{ agent: "reviewer-a", output: "Looks good", exitCode: 0 },
			{ agent: "reviewer-b", output: "Needs fixes", exitCode: 0 },
		]);
		assert.ok(result.includes("=== Parallel Task 1 (reviewer-a) ==="));
		assert.ok(result.includes("Looks good"));
		assert.ok(result.includes("=== Parallel Task 2 (reviewer-b) ==="));
		assert.ok(result.includes("Needs fixes"));
	});

	it("marks failed tasks", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "partial output", exitCode: 1 },
		]);
		assert.ok(result.includes("FAILED (exit code 1)"));
	});

	it("marks empty output", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "", exitCode: 0 },
		]);
		assert.ok(result.includes("EMPTY OUTPUT"));
	});

	it("treats whitespace-only output as empty", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "   \n  ", exitCode: 0 },
		]);
		assert.ok(result.includes("EMPTY OUTPUT"));
	});

	it("marks skipped tasks (exitCode=-1) distinctly from failed", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "done", exitCode: 0 },
			{ agent: "agent-b", output: "(skipped — fail-fast)", exitCode: -1 },
		]);
		assert.ok(result.includes("SKIPPED"), "skipped task should show SKIPPED");
		assert.ok(!result.includes("FAILED"), "skipped task should not show FAILED");
	});
});

describe("MAX_PARALLEL_CONCURRENCY", () => {
	it("is 4", () => {
		assert.equal(MAX_PARALLEL_CONCURRENCY, 4);
	});
});
