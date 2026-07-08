import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CHILD_WATCHDOG_STATUS_EVENT,
	acceptChildWatchdogEvent,
	childWatchdogIsActive,
	decodeChildWatchdogConfig,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
} from "../../src/watchdog/child-status.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";

describe("child watchdog status helpers", () => {
	it("preserves child model and explicit override thinking when resolving config", () => {
		const config = resolveChildWatchdogConfig({
			config: {
				...DEFAULT_WATCHDOG_CONFIG,
				enabled: true,
				children: {
					...DEFAULT_WATCHDOG_CONFIG.children,
					enabled: true,
					model: "openai/gpt-test-child",
					thinking: "low",
					overrides: {
						worker: {
							model: "anthropic/claude-test-worker",
							thinking: false,
						},
					},
				},
			},
			agent: "worker",
			runId: "run-1",
			childIndex: 0,
		});

		assert.equal(config?.model, "anthropic/claude-test-worker");
		assert.equal(config?.thinking, false);
	});

	it("decodes child watchdog config and rejects malformed numeric fields", () => {
		const config = decodeChildWatchdogConfig(JSON.stringify({
			enabled: true,
			runId: "run-1",
			agent: "worker",
			childIndex: 1,
			watchdogTailTimeoutMs: 100,
			agentEndTimeoutMs: 200,
			maxWarnings: null,
			autoFollowBlockers: true,
			autoFollowMaxAttempts: 2,
			stalemateRepeats: 3,
		}));

		assert.deepEqual(config, {
			enabled: true,
			runId: "run-1",
			agent: "worker",
			childIndex: 1,
			watchdogTailTimeoutMs: 100,
			agentEndTimeoutMs: 200,
			maxWarnings: null,
			autoFollowBlockers: true,
			autoFollowMaxAttempts: 2,
			stalemateRepeats: 3,
		});
		assert.throws(
			() => decodeChildWatchdogConfig(JSON.stringify({
				enabled: true,
				watchdogTailTimeoutMs: 100,
				agentEndTimeoutMs: 200,
				maxWarnings: null,
				autoFollowMaxAttempts: 0.5,
			})),
			/autoFollowMaxAttempts/,
		);
	});

	it("accepts latest matching status events and drops stale or foreign events", () => {
		const firstEvent = {
			type: CHILD_WATCHDOG_STATUS_EVENT,
			runId: "run-1",
			agent: "worker",
			childIndex: 0,
			seq: 1,
			phase: "reviewing",
			ts: 10,
			followUpPending: false,
		} as const;

		assert.equal(isChildWatchdogStatusEvent(firstEvent), true);
		const first = acceptChildWatchdogEvent({ event: firstEvent, runId: "run-1", agent: "worker", childIndex: 0, current: undefined });
		assert.deepEqual(first, { phase: "reviewing", seq: 1, lastUpdate: 10, followUpPending: false });
		assert.equal(childWatchdogIsActive(first), true);
		assert.equal(acceptChildWatchdogEvent({ event: firstEvent, current: first, runId: "run-1", agent: "worker", childIndex: 0 }), undefined);
		assert.equal(acceptChildWatchdogEvent({ event: { ...firstEvent, seq: 2, agent: "other" }, current: first, runId: "run-1", agent: "worker", childIndex: 0 }), undefined);

		const settled = acceptChildWatchdogEvent({
			event: { ...firstEvent, seq: 2, phase: "idle", ts: 20 },
			current: first,
			runId: "run-1",
			agent: "worker",
			childIndex: 0,
		});
		assert.equal(settled?.phase, "idle");
		assert.equal(childWatchdogIsActive(settled), false);
	});
});
