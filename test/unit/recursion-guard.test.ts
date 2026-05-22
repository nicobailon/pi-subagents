import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	checkSubagentDepth,
	getSubagentDepthEnv,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	normalizeMaxSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../../src/shared/types.ts";

let savedDepth: string | undefined;
let savedMaxDepth: string | undefined;

beforeEach(() => {
	savedDepth = process.env.PI_SUBAGENT_DEPTH;
	savedMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
});

afterEach(() => {
	if (savedDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedDepth;
	if (savedMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
	else process.env.PI_SUBAGENT_MAX_DEPTH = savedMaxDepth;
});

describe("DEFAULT_SUBAGENT_MAX_DEPTH", () => {
	it("is 2", () => {
		assert.equal(DEFAULT_SUBAGENT_MAX_DEPTH, 2);
	});
});

describe("normalizeMaxSubagentDepth", () => {
	it("accepts integers >= 0", () => {
		assert.equal(normalizeMaxSubagentDepth(0), 0);
		assert.equal(normalizeMaxSubagentDepth(3), 3);
		assert.equal(normalizeMaxSubagentDepth("4"), 4);
	});

	it("rejects negatives and non-integers", () => {
		assert.equal(normalizeMaxSubagentDepth(-1), undefined);
		assert.equal(normalizeMaxSubagentDepth(1.5), undefined);
		assert.equal(normalizeMaxSubagentDepth("garbage"), undefined);
	});
});

describe("resolveCurrentMaxSubagentDepth", () => {
	it("uses env when present", () => {
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";
		assert.equal(resolveCurrentMaxSubagentDepth(1), 5);
	});

	it("falls back to config when env is absent", () => {
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		assert.equal(resolveCurrentMaxSubagentDepth(1), 1);
	});

	it("falls back to default when neither env nor config is valid", () => {
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		assert.equal(resolveCurrentMaxSubagentDepth(undefined), 2);
		assert.equal(resolveCurrentMaxSubagentDepth(-1), 2);
	});
});

describe("top-level parallel config helpers", () => {
	it("resolves maxTasks from config or falls back to the default", () => {
		assert.equal(resolveTopLevelParallelMaxTasks(12), 12);
		assert.equal(resolveTopLevelParallelMaxTasks(undefined), 8);
		assert.equal(resolveTopLevelParallelMaxTasks(0), 8);
		assert.equal(resolveTopLevelParallelMaxTasks("oops"), 8);
	});

	it("resolves concurrency from per-call override, config, or default", () => {
		assert.equal(resolveTopLevelParallelConcurrency(2, 6), 2);
		assert.equal(resolveTopLevelParallelConcurrency(undefined, 6), 6);
		assert.equal(resolveTopLevelParallelConcurrency(0, 6), 6);
		assert.equal(resolveTopLevelParallelConcurrency(undefined, 0), 4);
	});
});

describe("resolveChildMaxSubagentDepth", () => {
	it("keeps the inherited max when agent override is absent", () => {
		assert.equal(resolveChildMaxSubagentDepth(3, undefined), 3);
	});

	it("tightens to the lower per-agent max", () => {
		assert.equal(resolveChildMaxSubagentDepth(3, 1), 1);
		assert.equal(resolveChildMaxSubagentDepth(2, 0), 0);
	});

	it("does not relax an already stricter inherited max", () => {
		assert.equal(resolveChildMaxSubagentDepth(1, 3), 1);
	});
});

describe("checkSubagentDepth", () => {
	it("not blocked at depth=0, max=2", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		const result = checkSubagentDepth();
		assert.equal(result.blocked, false);
		assert.equal(result.depth, 0);
		assert.equal(result.maxDepth, 2);
	});

	it("uses config max depth when env is absent", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const result = checkSubagentDepth(1);
		assert.equal(result.blocked, true);
		assert.equal(result.maxDepth, 1);
	});

	it("not blocked at depth=1, max=2", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		assert.equal(checkSubagentDepth().blocked, false);
	});

	it("blocks at depth=1, max=1 after one nested level", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "1";
		assert.equal(checkSubagentDepth().blocked, true);
	});

	it("blocked at depth=2, max=2", () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		const result = checkSubagentDepth();
		assert.equal(result.blocked, true);
		assert.equal(result.depth, 2);
		assert.equal(result.maxDepth, 2);
	});

	it("blocked at depth=3, max=2", () => {
		process.env.PI_SUBAGENT_DEPTH = "3";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		assert.equal(checkSubagentDepth().blocked, true);
	});

	it("blocked at depth=0, max=0 (disables subagent entirely)", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "0";
		assert.equal(checkSubagentDepth().blocked, true);
	});

	it("defaults to depth=0, max=2 when env vars unset", () => {
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const result = checkSubagentDepth();
		assert.equal(result.blocked, false);
		assert.equal(result.depth, 0);
		assert.equal(result.maxDepth, 2);
	});

	it("not blocked when depth is invalid (NaN)", () => {
		process.env.PI_SUBAGENT_DEPTH = "garbage";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		assert.equal(checkSubagentDepth().blocked, false);
	});
});

describe("getSubagentDepthEnv", () => {
	it("increments from depth=0", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const env = getSubagentDepthEnv();
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "2");
	});

	it("increments from depth=1", () => {
		process.env.PI_SUBAGENT_DEPTH = "1";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const env = getSubagentDepthEnv();
		assert.equal(env.PI_SUBAGENT_DEPTH, "2");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "2");
	});

	it("uses provided max depth override", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const env = getSubagentDepthEnv(1);
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "1");
	});

	it("respects inherited PI_SUBAGENT_MAX_DEPTH when override is absent", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";
		const env = getSubagentDepthEnv();
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "5");
	});

	it("uses the explicit child override even when a looser inherited env max exists", () => {
		process.env.PI_SUBAGENT_DEPTH = "0";
		process.env.PI_SUBAGENT_MAX_DEPTH = "5";
		const env = getSubagentDepthEnv(1);
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
		assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "1");
	});

	it("falls back to depth=1 when env var is invalid (NaN)", () => {
		process.env.PI_SUBAGENT_DEPTH = "not-a-number";
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const env = getSubagentDepthEnv();
		assert.equal(env.PI_SUBAGENT_DEPTH, "1");
	});
});
