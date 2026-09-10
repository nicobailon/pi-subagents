import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MIN_DEADLINE_CHECKPOINT_LEAD_MS,
	deadlineCheckpointDelayMs,
} from "../../src/runs/background/deadline-checkpoint.ts";

describe("deadlineCheckpointDelayMs", () => {
	it("is undefined when the option is absent (no timer, no behaviour change)", () => {
		assert.equal(deadlineCheckpointDelayMs(600_000, undefined), undefined);
	});

	it("fires at timeoutMs - checkpointBeforeDeadlineMs", () => {
		assert.equal(deadlineCheckpointDelayMs(900_000, 300_000), 600_000);
		assert.equal(
			deadlineCheckpointDelayMs(MIN_DEADLINE_CHECKPOINT_LEAD_MS + 5_000, 5_000),
			MIN_DEADLINE_CHECKPOINT_LEAD_MS,
		);
	});

	it("is undefined when the checkpoint would fire less than the minimum lead after launch", () => {
		assert.equal(deadlineCheckpointDelayMs(300_000, 300_000), undefined);
		assert.equal(deadlineCheckpointDelayMs(300_000, 299_500), undefined);
		assert.equal(deadlineCheckpointDelayMs(240_000, 300_000), undefined);
	});

	it("is undefined for non-positive or fractional values", () => {
		assert.equal(deadlineCheckpointDelayMs(600_000, 0), undefined);
		assert.equal(deadlineCheckpointDelayMs(600_000, -1), undefined);
		assert.equal(deadlineCheckpointDelayMs(600_000, 1.5), undefined);
	});
});
