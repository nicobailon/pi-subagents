import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backfillStepUsageFromSession, hasUsageValue } from "../../src/shared/utils.ts";
import type { SessionUsageTotals } from "../../src/shared/session-tokens.ts";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function totals(overrides: Partial<SessionUsageTotals>): SessionUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...overrides };
}

describe("hasUsageValue", () => {
	it("is false for all-zero usage and true when any field is set", () => {
		assert.equal(hasUsageValue(ZERO), false);
		assert.equal(hasUsageValue({ ...ZERO, turns: 3 }), true);
		assert.equal(hasUsageValue({ ...ZERO, cost: 0.001 }), true);
	});
});

describe("backfillStepUsageFromSession", () => {
	it("adopts the full cumulative parse when the step started without a session file", () => {
		const backfill = backfillStepUsageFromSession({
			current: ZERO,
			baseline: null,
			cumulative: totals({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.001, turns: 2 }),
		});
		assert.deepEqual(backfill, {
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.001, turns: 2 },
			totalCost: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
		});
	});

	it("excludes history present before the step started", () => {
		const backfill = backfillStepUsageFromSession({
			current: ZERO,
			baseline: totals({ input: 1000, output: 500, cacheRead: 90, cost: 0.5, turns: 9 }),
			cumulative: totals({ input: 1100, output: 550, cacheRead: 100, cacheWrite: 5, cost: 0.75, turns: 10 }),
		});
		assert.deepEqual(backfill, {
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.25, turns: 1 },
			totalCost: { inputTokens: 100, outputTokens: 50, costUsd: 0.25 },
		});
	});

	it("keeps event-accumulated usage untouched", () => {
		const current = { ...ZERO, input: 10, output: 5, turns: 1 };
		assert.equal(
			backfillStepUsageFromSession({
				current,
				baseline: null,
				cumulative: totals({ input: 110, output: 55, cost: 0.002, turns: 3 }),
			}),
			null,
		);
	});

	it("returns null without a parse, without new tokens, or on negative deltas", () => {
		assert.equal(backfillStepUsageFromSession({ current: ZERO, baseline: null, cumulative: null }), null);
		assert.equal(
			backfillStepUsageFromSession({
				current: ZERO,
				baseline: totals({ input: 100, output: 50, turns: 2 }),
				cumulative: totals({ input: 100, output: 50, turns: 2 }),
			}),
			null,
		);
		const clamped = backfillStepUsageFromSession({
			current: ZERO,
			baseline: totals({ input: 200, output: 100, cacheRead: 50, cost: 0.01, turns: 5 }),
			cumulative: totals({ input: 100, output: 120, cacheRead: 10, cost: 0.002, turns: 3 }),
		});
		assert.deepEqual(clamped, {
			usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			totalCost: { inputTokens: 0, outputTokens: 20, costUsd: 0 },
		});
	});
});
