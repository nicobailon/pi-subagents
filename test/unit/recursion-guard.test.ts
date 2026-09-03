import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	checkSubagentDepth,
	resolveChildDepth,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	normalizeMaxSubagentDepth,
	normalizeMaxSubagentSpawnsPerSession,
	resolveMaxSubagentSpawnsPerSession,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
} from "../../src/shared/types.ts";

let savedMaxSpawns: string | undefined;

beforeEach(() => {
	savedMaxSpawns = process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
});

afterEach(() => {
	if (savedMaxSpawns === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
	else process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = savedMaxSpawns;
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

describe("normalizeMaxSubagentSpawnsPerSession", () => {
	it("accepts integers >= 0", () => {
		assert.equal(normalizeMaxSubagentSpawnsPerSession(0), 0);
		assert.equal(normalizeMaxSubagentSpawnsPerSession(12), 12);
		assert.equal(normalizeMaxSubagentSpawnsPerSession("9"), 9);
	});

	it("rejects negatives and non-integers", () => {
		assert.equal(normalizeMaxSubagentSpawnsPerSession(-1), undefined);
		assert.equal(normalizeMaxSubagentSpawnsPerSession(1.5), undefined);
		assert.equal(normalizeMaxSubagentSpawnsPerSession("garbage"), undefined);
	});
});

describe("resolveMaxSubagentSpawnsPerSession", () => {
	it("uses positive env values as opt-in caps", () => {
		process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = "5";
		assert.equal(resolveMaxSubagentSpawnsPerSession(1), 5);
	});

	it("falls back to a positive config cap when env is absent", () => {
		delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
		assert.equal(resolveMaxSubagentSpawnsPerSession(7), 7);
	});

	it("ignores invalid env values and falls back to config", () => {
		for (const value of ["garbage", "-1", "1.5"]) {
			process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = value;
			assert.equal(resolveMaxSubagentSpawnsPerSession(7), 7);
			assert.equal(resolveMaxSubagentSpawnsPerSession(undefined), undefined);
		}
	});

	it("is unlimited by default", () => {
		delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
		assert.equal(resolveMaxSubagentSpawnsPerSession(undefined), undefined);
		assert.equal(resolveMaxSubagentSpawnsPerSession(-1), undefined);
	});

	it("treats zero as an explicit unlimited override", () => {
		process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = "0";
		assert.equal(resolveMaxSubagentSpawnsPerSession(7), undefined);
		delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
		assert.equal(resolveMaxSubagentSpawnsPerSession(0), undefined);
	});
});

describe("resolveCurrentMaxSubagentDepth", () => {
	it("uses the executor's own child runtime max when present", () => {
		assert.equal(resolveCurrentMaxSubagentDepth(1, { depth: 1, maxDepth: 5 }), 5);
	});

	it("falls back to config for a top-level parent", () => {
		assert.equal(resolveCurrentMaxSubagentDepth(1), 1);
		assert.equal(resolveCurrentMaxSubagentDepth(1, { depth: 1 }), 1);
	});

	it("falls back to default when neither runtime nor config is valid", () => {
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
		const result = checkSubagentDepth(2);
		assert.equal(result.blocked, false);
		assert.equal(result.depth, 0);
		assert.equal(result.maxDepth, 2);
	});

	it("uses config max depth when the runtime carries none", () => {
		const result = checkSubagentDepth(1, { depth: 1 });
		assert.equal(result.blocked, true);
		assert.equal(result.maxDepth, 1);
	});

	it("not blocked at depth=1, max=2", () => {
		assert.equal(checkSubagentDepth(undefined, { depth: 1, maxDepth: 2 }).blocked, false);
	});

	it("blocks at depth=1, max=1 after one nested level", () => {
		assert.equal(checkSubagentDepth(undefined, { depth: 1, maxDepth: 1 }).blocked, true);
	});

	it("blocked at depth=2, max=2", () => {
		const result = checkSubagentDepth(undefined, { depth: 2, maxDepth: 2 });
		assert.equal(result.blocked, true);
		assert.equal(result.depth, 2);
		assert.equal(result.maxDepth, 2);
	});

	it("blocked at depth=3, max=2", () => {
		assert.equal(checkSubagentDepth(undefined, { depth: 3, maxDepth: 2 }).blocked, true);
	});

	it("blocked at depth=0, max=0 (disables subagent entirely)", () => {
		assert.equal(checkSubagentDepth(0).blocked, true);
	});

	it("defaults to depth=0, max=2 for a top-level parent", () => {
		const result = checkSubagentDepth();
		assert.equal(result.blocked, false);
		assert.equal(result.depth, 0);
		assert.equal(result.maxDepth, 2);
	});

	it("not blocked when the runtime depth is invalid (NaN)", () => {
		assert.equal(checkSubagentDepth(undefined, { depth: Number.NaN, maxDepth: 2 }).blocked, false);
	});
});

describe("resolveChildDepth", () => {
	it("increments from a top-level parent", () => {
		assert.deepEqual(resolveChildDepth(), { depth: 1, maxDepth: 2 });
	});

	it("increments from depth=1", () => {
		assert.deepEqual(resolveChildDepth(undefined, { depth: 1 }), { depth: 2, maxDepth: 2 });
	});

	it("uses provided max depth override", () => {
		assert.deepEqual(resolveChildDepth(1), { depth: 1, maxDepth: 1 });
	});

	it("respects the inherited runtime max when override is absent", () => {
		assert.deepEqual(resolveChildDepth(undefined, { depth: 0, maxDepth: 5 }), { depth: 1, maxDepth: 5 });
	});

	it("uses the explicit child override even when a looser inherited max exists", () => {
		assert.deepEqual(resolveChildDepth(1, { depth: 0, maxDepth: 5 }), { depth: 1, maxDepth: 1 });
	});

	it("falls back to depth=1 when the runtime depth is invalid (NaN)", () => {
		assert.equal(resolveChildDepth(undefined, { depth: Number.NaN }).depth, 1);
	});
});
