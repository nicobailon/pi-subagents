import assert from "node:assert/strict";
import { it } from "node:test";
import { MAX_EXECUTION_TIMEOUT_MS, resolveExecutionLifetime } from "../../src/runs/shared/execution-lifetime.ts";

it("explicit lifetimes override configured defaults without timer overflow", () => {
	assert.deepEqual(resolveExecutionLifetime({ mode: "unbounded" }, 1000), { effectiveExecutionLifetime: { mode: "unbounded" } });
	assert.deepEqual(resolveExecutionLifetime({ mode: "bounded", timeoutMs: MAX_EXECUTION_TIMEOUT_MS }, 1000), {
		timeoutMs: MAX_EXECUTION_TIMEOUT_MS, effectiveExecutionLifetime: { mode: "bounded", timeoutMs: MAX_EXECUTION_TIMEOUT_MS },
	});
	assert.deepEqual(resolveExecutionLifetime(undefined, 1000), { timeoutMs: 1000, effectiveExecutionLifetime: { mode: "bounded", timeoutMs: 1000 } });
});

it("rejects malformed lifetimes before they can reach a timer", () => {
	for (const value of [null, false, [], {}, { mode: "unknown" }, { mode: "unbounded", timeoutMs: 1 }, { mode: "bounded" },
		...[0, -1, 1.5, Infinity, NaN, MAX_EXECUTION_TIMEOUT_MS + 1, "1000"].map((timeoutMs) => ({ mode: "bounded", timeoutMs }))]) {
		assert.match(resolveExecutionLifetime(value).error ?? "", /executionLifetime/);
	}
});
