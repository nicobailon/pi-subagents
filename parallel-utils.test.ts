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
} from "./parallel-utils.ts";

// ---------------------------------------------------------------------------
// isParallelGroup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// flattenSteps
// ---------------------------------------------------------------------------

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
					{ agent: "reviewer-c", task: "review part 3" },
				],
			},
			{ agent: "summarizer", task: "combine" },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 5);
		assert.deepEqual(
			flat.map((s) => s.agent),
			["scout", "reviewer-a", "reviewer-b", "reviewer-c", "summarizer"],
		);
	});

	it("handles empty steps array", () => {
		assert.deepEqual(flattenSteps([]), []);
	});

	it("handles multiple parallel groups", () => {
		const steps: RunnerStep[] = [
			{ parallel: [{ agent: "a", task: "1" }, { agent: "b", task: "2" }] },
			{ parallel: [{ agent: "c", task: "3" }, { agent: "d", task: "4" }] },
		];
		const flat = flattenSteps(steps);
		assert.equal(flat.length, 4);
		assert.deepEqual(flat.map((s) => s.agent), ["a", "b", "c", "d"]);
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

	it("preserves all step fields through flattening", () => {
		const steps: RunnerStep[] = [
			{
				parallel: [
					{ agent: "x", task: "do", model: "gpt-4", skills: ["web-search"], cwd: "/tmp" },
				],
			},
		];
		const flat = flattenSteps(steps);
		assert.equal(flat[0].agent, "x");
		assert.equal(flat[0].model, "gpt-4");
		assert.deepEqual(flat[0].skills, ["web-search"]);
		assert.equal(flat[0].cwd, "/tmp");
	});
});

// ---------------------------------------------------------------------------
// mapConcurrent
// ---------------------------------------------------------------------------

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

		await mapConcurrent(items, 2, async (_item, _i) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			// Simulate async work
			await new Promise((r) => setTimeout(r, 10));
			running--;
		});

		assert.ok(maxRunning <= 2, `max concurrent was ${maxRunning}, expected <= 2`);
		assert.equal(running, 0, "all workers finished");
	});

	it("handles empty input", async () => {
		const results = await mapConcurrent([], 4, async (item: number) => item);
		assert.deepEqual(results, []);
	});

	it("handles limit greater than items", async () => {
		const results = await mapConcurrent([1, 2], 10, async (item) => item + 1);
		assert.deepEqual(results, [2, 3]);
	});

	it("passes correct index to callback", async () => {
		const indices: number[] = [];
		await mapConcurrent(["a", "b", "c"], 3, async (_item, i) => {
			indices.push(i);
		});
		indices.sort((a, b) => a - b);
		assert.deepEqual(indices, [0, 1, 2]);
	});
});

// ---------------------------------------------------------------------------
// aggregateParallelOutputs
// ---------------------------------------------------------------------------

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

	it("marks failed tasks with exit code", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "partial output", exitCode: 1 },
		]);
		assert.ok(result.includes("⚠️ FAILED (exit code 1)"));
		assert.ok(result.includes("partial output"));
	});

	it("includes error message when present on failure", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "", exitCode: 1, error: "timeout" },
		]);
		assert.ok(result.includes("⚠️ FAILED (exit code 1): timeout"));
	});

	it("marks empty output", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "", exitCode: 0 },
		]);
		assert.ok(result.includes("⚠️ EMPTY OUTPUT"));
	});

	it("treats whitespace-only output as empty", () => {
		const result = aggregateParallelOutputs([
			{ agent: "agent-a", output: "   \n  ", exitCode: 0 },
		]);
		assert.ok(result.includes("⚠️ EMPTY OUTPUT"));
	});

	it("handles single task", () => {
		const result = aggregateParallelOutputs([
			{ agent: "solo", output: "done", exitCode: 0 },
		]);
		assert.ok(result.includes("=== Parallel Task 1 (solo) ==="));
		assert.ok(result.includes("done"));
		// Should not have extra separators
		assert.ok(!result.includes("=== Parallel Task 2"));
	});

	it("handles mixed success and failure", () => {
		const result = aggregateParallelOutputs([
			{ agent: "a", output: "ok", exitCode: 0 },
			{ agent: "b", output: "crash", exitCode: 1 },
			{ agent: "c", output: "also ok", exitCode: 0 },
		]);
		assert.ok(result.includes("=== Parallel Task 1 (a) ==="));
		assert.ok(result.includes("=== Parallel Task 2 (b) ==="));
		assert.ok(result.includes("=== Parallel Task 3 (c) ==="));
		assert.ok(result.includes("⚠️ FAILED"));
		// The successful ones should NOT have the failure marker
		const sections = result.split("=== Parallel Task");
		// sections[0] is empty, [1] is task 1, [2] is task 2, [3] is task 3
		assert.ok(!sections[1].includes("FAILED"), "task 1 should not be failed");
		assert.ok(sections[2].includes("FAILED"), "task 2 should be failed");
		assert.ok(!sections[3].includes("FAILED"), "task 3 should not be failed");
	});
});

// ---------------------------------------------------------------------------
// MAX_PARALLEL_CONCURRENCY
// ---------------------------------------------------------------------------

describe("MAX_PARALLEL_CONCURRENCY", () => {
	it("is 4", () => {
		assert.equal(MAX_PARALLEL_CONCURRENCY, 4);
	});
});
