import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_ASYNC_TIMEOUT_MS,
	DEFAULT_FOREGROUND_TIMEOUT_MS,
	resolveConfigDefaultTimeoutMs,
	resolveSingleAgentLaunchTimeout,
} from "../../src/runs/foreground/subagent-executor.ts";

describe("single-agent launch timeout wiring", () => {
	it("async runs default to DEFAULT_ASYNC_TIMEOUT_MS when no explicit/agent timeout", () => {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({}, true), {
			timeoutMs: DEFAULT_ASYNC_TIMEOUT_MS,
		});
	});

	it("foreground runs default to DEFAULT_FOREGROUND_TIMEOUT_MS when no explicit/agent timeout", () => {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({}, false), {
			timeoutMs: DEFAULT_FOREGROUND_TIMEOUT_MS,
		});
	});

	it("explicit timeoutMs wins over the async default", () => {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({ timeoutMs: 5_000 }, true), {
			timeoutMs: 5_000,
		});
	});

	it("maxRuntimeMs alias wins over the async default", () => {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({ maxRuntimeMs: 7_000 }, true), {
			timeoutMs: 7_000,
		});
	});

	it("rejects non-positive timeouts", () => {
		const result = resolveSingleAgentLaunchTimeout({ timeoutMs: 0 }, true);
		assert.ok(result.error);
		assert.match(result.error!, /positive integer/);
	});

	it("rejects mismatched alias values", () => {
		const result = resolveSingleAgentLaunchTimeout({ timeoutMs: 1_000, maxRuntimeMs: 2_000 }, true);
		assert.ok(result.error);
		assert.match(result.error!, /aliases/);
	});

	it("does not apply the async default to async chains (children are bounded individually)", () => {
		assert.deepEqual(
			resolveSingleAgentLaunchTimeout({ agent: "worker", task: "x", chain: [{ agent: "worker", task: "y" }] }, true),
			{},
		);
	});

	it("does not apply the async default to async parallel tasks", () => {
		assert.deepEqual(
			resolveSingleAgentLaunchTimeout({ agent: "worker", task: "x", tasks: [{ agent: "worker", task: "y" }] }, true),
			{},
		);
	});

	it("does not apply the async default to async workflowScript", () => {
		assert.deepEqual(
			resolveSingleAgentLaunchTimeout({ workflowScript: "return runs.run('a', { agent: 'worker', task: 'x' })" }, true),
			{},
		);
	});

	it("explicit top-level timeout still applies to async chains", () => {
		assert.deepEqual(
			resolveSingleAgentLaunchTimeout({ agent: "worker", task: "x", chain: [{ agent: "worker", task: "y" }], timeoutMs: 5_000 }, true),
			{ timeoutMs: 5_000 },
		);
	});

	const NINETY_MIN = 90 * 60 * 1000;

	it("applies the global config default in place of the foreground backstop", () => {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({}, false, NINETY_MIN), {
			timeoutMs: NINETY_MIN,
		});
	});

	it("applies the global config default to composite foreground runs (parallel/chain)", () => {
		assert.deepEqual(
			resolveSingleAgentLaunchTimeout({ agent: "worker", task: "x", tasks: [{ agent: "worker", task: "y" }] }, false, NINETY_MIN),
			{ timeoutMs: NINETY_MIN },
		);
		assert.deepEqual(
			resolveSingleAgentLaunchTimeout({ agent: "worker", task: "x", chain: [{ agent: "worker", task: "y" }] }, false, NINETY_MIN),
			{ timeoutMs: NINETY_MIN },
		);
	});

	it("applies the global config default in place of the single-agent async backstop", () => {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({}, true, NINETY_MIN), {
			timeoutMs: NINETY_MIN,
		});
	});

	it("lets an explicit call timeout win over the global config default", () => {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({ timeoutMs: 5_000 }, false, NINETY_MIN), {
			timeoutMs: 5_000,
		});
	});

	it("keeps composite async runs unbounded even with a global config default", () => {
		assert.deepEqual(
			resolveSingleAgentLaunchTimeout({ agent: "worker", task: "x", tasks: [{ agent: "worker", task: "y" }] }, true, NINETY_MIN),
			{},
		);
	});
});

describe("resolveConfigDefaultTimeoutMs", () => {
	it("returns a positive integer unchanged", () => {
		assert.equal(resolveConfigDefaultTimeoutMs(90 * 60 * 1000), 90 * 60 * 1000);
	});

	it("treats unset config as no default", () => {
		assert.equal(resolveConfigDefaultTimeoutMs(undefined), undefined);
	});

	it("ignores non-positive, non-integer, and non-numeric values", () => {
		assert.equal(resolveConfigDefaultTimeoutMs(0), undefined);
		assert.equal(resolveConfigDefaultTimeoutMs(-1), undefined);
		assert.equal(resolveConfigDefaultTimeoutMs(1.5), undefined);
		assert.equal(resolveConfigDefaultTimeoutMs("600000" as unknown), undefined);
		assert.equal(resolveConfigDefaultTimeoutMs(Number.NaN), undefined);
	});

	it("accepts the maximum schedulable timer delay but ignores anything larger", () => {
		// 2_147_483_647 is the largest delay a Node.js timer can honor; above it
		// setTimeout overflows to ~1ms and the run would expire almost immediately.
		assert.equal(resolveConfigDefaultTimeoutMs(2_147_483_647), 2_147_483_647);
		assert.equal(resolveConfigDefaultTimeoutMs(2_147_483_648), undefined);
		assert.equal(resolveConfigDefaultTimeoutMs(Number.MAX_SAFE_INTEGER), undefined);
	});
});
