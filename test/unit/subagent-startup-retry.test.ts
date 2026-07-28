import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "../../src/shared/types.ts";
import {
	MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS,
	SUBAGENT_STARTUP_RETRY_DELAYS_MS,
	formatSubagentStartupRetryExhaustedError,
	formatSubagentStartupRetryNote,
	isRetryableSubagentStartupFailure,
	waitForSubagentStartupRetry,
	type SubagentStartupFailureEvidence,
} from "../../src/runs/shared/subagent-startup-retry.ts";

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function startupFailure(overrides: Partial<SubagentStartupFailureEvidence> = {}): SubagentStartupFailureEvidence {
	return {
		exitCode: 1,
		messageCount: 0,
		toolCount: 0,
		usage: emptyUsage(),
		durationMs: 20,
		...overrides,
	};
}

describe("subagent startup retry", () => {
	it("uses a bounded retry schedule", () => {
		assert.deepEqual(SUBAGENT_STARTUP_RETRY_DELAYS_MS, [250, 750, 1500]);
	});

	it("classifies a short non-zero exit with no child activity", () => {
		assert.equal(isRetryableSubagentStartupFailure(startupFailure()), true);
	});

	it("rejects successful, long-running, and diagnosed exits", () => {
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ exitCode: 0 })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ durationMs: MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS + 1 })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ error: "authentication failed" })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ finalOutput: "partial response" })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ protocolError: { code: "protocol_output_limit" } })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ processSignal: "SIGKILL" })), false);
	});

	it("rejects any model, tool, usage, mutation, or lifecycle activity", () => {
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ messageCount: 1 })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ toolCount: 1 })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ usage: { ...emptyUsage(), input: 1 } })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ usage: { ...emptyUsage(), turns: 1 } })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ observedMutationAttempt: true })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ detached: true })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ interrupted: true })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ timedOut: true })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ stopped: true })), false);
		assert.equal(isRetryableSubagentStartupFailure(startupFailure({ turnBudgetExceeded: true })), false);
	});

	it("formats retry and exhaustion diagnostics without task content", () => {
		assert.equal(
			formatSubagentStartupRetryNote({ model: "openai/test", attempt: 1, maxAttempts: 4, delayMs: 250 }),
			"[startup-retry] openai/test exited before model or tool activity (attempt 1/4). Retrying the same model in 250ms.",
		);
		assert.match(
			formatSubagentStartupRetryExhaustedError({ model: "openai/test", attempts: 4 }),
			/failed to start after 4 attempts.*concurrent Pi startup race.*lower subagent concurrency/i,
		);
	});

	it("cancels a pending retry delay", async () => {
		const controller = new AbortController();
		const wait = waitForSubagentStartupRetry(5000, [controller.signal]);
		controller.abort();
		assert.equal(await wait, false);
	});
});
