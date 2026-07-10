import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatModelThinking } from "../../src/shared/formatters.ts";
import { aggregateStepStatus, formatActivityLabel, formatParallelOutcome } from "../../src/shared/status-format.ts";
import type { AsyncJobStep } from "../../src/shared/types.ts";

describe("status format helpers", () => {
	it("formats activity labels consistently", () => {
		assert.equal(formatActivityLabel(1_000, undefined, 1_500), "active now");
		assert.equal(formatActivityLabel(1_000, "needs_attention", 4_000), "no activity for 3s");
		assert.equal(formatActivityLabel(undefined, "active_long_running", 4_000), "active but long-running");
		assert.equal(formatActivityLabel(4_000, "active_long_running", 4_000), "active but long-running · last activity now");
	});

	it("formats max thinking from model suffixes and explicit metadata", () => {
		assert.equal(formatModelThinking("openai/gpt-5:max"), "gpt-5 · thinking max");
		assert.equal(formatModelThinking("openai/gpt-5", "max"), "gpt-5 · thinking max");
	});

	it("aggregates step status and parallel outcomes", () => {
		const steps = [{ status: "complete" }, { status: "running" }, { status: "failed" }] satisfies Array<Pick<AsyncJobStep, "status">>;
		assert.equal(aggregateStepStatus(steps), "running");
		assert.equal(formatParallelOutcome(steps, 3), "1 agent running · 1/3 done · 1 failed");
		assert.equal(formatParallelOutcome(steps, 3, { showRunning: false }), "1/3 done · 1 failed");
	});
});
