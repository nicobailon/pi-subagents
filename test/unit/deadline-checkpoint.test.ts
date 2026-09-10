import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEADLINE_CHECKPOINT_SOURCE,
	MIN_DEADLINE_CHECKPOINT_LEAD_MS,
	buildDeadlineCheckpointMessage,
	buildDeadlineCheckpointRequest,
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

	it("is undefined for non-positive, fractional, or non-finite values", () => {
		assert.equal(deadlineCheckpointDelayMs(600_000, 0), undefined);
		assert.equal(deadlineCheckpointDelayMs(600_000, -1), undefined);
		assert.equal(deadlineCheckpointDelayMs(600_000, 1.5), undefined);
		assert.equal(deadlineCheckpointDelayMs(600_000, Number.NaN), undefined);
		assert.equal(
			deadlineCheckpointDelayMs(600_000, Number.POSITIVE_INFINITY),
			undefined,
		);
	});
});

describe("buildDeadlineCheckpointRequest", () => {
	it("is an untargeted runner-sourced steer", () => {
		const request = buildDeadlineCheckpointRequest({
			deadlineAt: 1_000_000 + 300_000,
			now: 1_000_000,
		});
		assert.equal(request.type, "steer");
		assert.equal(request.mode, "steer");
		assert.equal(request.source, DEADLINE_CHECKPOINT_SOURCE);
		assert.equal(request.targetIndex, undefined);
		assert.equal(request.targetIndexes, undefined);
		assert.equal(request.ts, 1_000_000);
		assert.ok(request.id === "deadline-checkpoint-1000000", request.id);
		assert.equal(request.message, buildDeadlineCheckpointMessage(300_000));
	});

	it("tells the child the rounded remaining seconds and to stop after the current tool call", () => {
		const message = buildDeadlineCheckpointMessage(299_600);
		assert.match(message, /about 300 seconds/);
		assert.match(message, /Finish the current tool call only/);
		assert.match(message, /Do not start new work/);
		assert.match(buildDeadlineCheckpointMessage(-5_000), /about 0 seconds/);
	});
});
