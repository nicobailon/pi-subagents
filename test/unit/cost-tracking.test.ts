import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, after } from "node:test";
import { formatCost } from "../../src/shared/formatters.ts";
import { compactCompletedProgress } from "../../src/shared/utils.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";
import type { AgentProgress } from "../../src/shared/types.ts";

describe("formatCost", () => {
	it("returns empty string for zero", () => {
		assert.equal(formatCost(0), "");
	});

	it("returns empty string for negative values", () => {
		assert.equal(formatCost(-0.001), "");
	});

	it("formats small positive costs with 4 decimal places", () => {
		assert.equal(formatCost(0.0123), "$0.0123");
	});

	it("formats large positive costs with 4 decimal places", () => {
		assert.equal(formatCost(1.5), "$1.5000");
	});
});

describe("compactCompletedProgress", () => {
	it("preserves cost for completed progress", () => {
		const progress: AgentProgress = {
			index: 0,
			agent: "scout",
			status: "completed",
			task: "test task",
			recentTools: [{ tool: "read", args: "file.txt", endMs: 100 }],
			recentOutput: ["some output"],
			toolCount: 3,
			tokens: 1500,
			cost: 0.025,
			durationMs: 5000,
		};
		const compacted = compactCompletedProgress(progress);
		assert.equal(compacted.cost, 0.025);
	});

	it("returns running progress unchanged", () => {
		const progress: AgentProgress = {
			index: 0,
			agent: "scout",
			status: "running",
			task: "test task",
			recentTools: [{ tool: "read", args: "file.txt", endMs: 100 }],
			recentOutput: ["some output"],
			toolCount: 3,
			tokens: 1500,
			cost: 0.025,
			durationMs: 5000,
		};
		const compacted = compactCompletedProgress(progress);
		assert.strictEqual(compacted, progress);
	});
});

describe("listAsyncRuns cost field mapping", () => {
	it("maps cost from steps and totalCost in status.json", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cost-tracking-"));
		after(() => { fs.rmSync(root, { recursive: true, force: true }); });

		const asyncRoot = path.join(root, "runs");
		const asyncDir = path.join(asyncRoot, "run-with-cost");
		fs.mkdirSync(asyncDir, { recursive: true });

		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "run-with-cost",
			mode: "single",
			state: "complete",
			startedAt: 100,
			endedAt: 200,
			steps: [
				{ agent: "scout", status: "complete", cost: 0.0123 },
				{ agent: "planner", status: "complete", cost: 0.0456 },
			],
			totalCost: 0.0579,
		}, null, 2), "utf-8");

		const runs = listAsyncRuns(asyncRoot, { reconcile: false });
		assert.equal(runs.length, 1);

		const run = runs[0];
		assert.equal(run.totalCost, 0.0579);
		assert.equal(run.steps[0].cost, 0.0123);
		assert.equal(run.steps[1].cost, 0.0456);
	});

	it("defaults cost to 0 when missing in status.json (old format)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cost-tracking-old-"));
		after(() => { fs.rmSync(root, { recursive: true, force: true }); });

		const asyncRoot = path.join(root, "runs");
		const asyncDir = path.join(asyncRoot, "run-old-format");
		fs.mkdirSync(asyncDir, { recursive: true });

		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "run-old-format",
			mode: "single",
			state: "complete",
			startedAt: 100,
			endedAt: 200,
			steps: [
				{ agent: "scout", status: "complete" },
				{ agent: "planner", status: "complete" },
			],
			totalCost: 0,
		}, null, 2), "utf-8");

		const runs = listAsyncRuns(asyncRoot, { reconcile: false });
		assert.equal(runs.length, 1);

		const run = runs[0];
		assert.equal(run.totalCost, 0);
		assert.equal(run.steps[0].cost, 0);
		assert.equal(run.steps[1].cost, 0);
	});
});
