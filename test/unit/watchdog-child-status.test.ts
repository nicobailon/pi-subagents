import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CHILD_WATCHDOG_STATUS_EVENT,
	CHILD_WATCHDOG_WARNING_LIMIT,
	acceptChildWatchdogEvent,
	applyChildWatchdogMessage,
	childWatchdogIsActive,
	decodeChildWatchdogConfig,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	unresolvedChildWatchdogBlockers,
} from "../../src/watchdog/child-status.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { events } from "../support/helpers.ts";

function warningMessage(overrides: Record<string, unknown> = {}) {
	return (events.watchdogWarning("blocker", "Claims tests passed without running them", { category: "correctness", evidence: "No test command appears in the transcript.", displayedAt: "2026-09-01T00:00:00.000Z", ...overrides }) as { message: object }).message;
}

describe("child watchdog warning envelope", () => {
	it("lifts watchdog warning messages, ignores other messages, and marks warnings addressed on assistant turns", () => {
		let snapshot = applyChildWatchdogMessage(undefined, warningMessage(), 5);
		assert.deepEqual(snapshot, {
			phase: "idle",
			seq: 0,
			lastUpdate: 5,
			warnings: [{
				severity: "blocker",
				category: "correctness",
				summary: "Claims tests passed without running them",
				evidence: "No test command appears in the transcript.",
				recommendedAction: "Run the focused test before finishing.",
				displayedAt: "2026-09-01T00:00:00.000Z",
				addressed: false,
				stalemate: false,
			}],
		});
		assert.equal(applyChildWatchdogMessage(undefined, warningMessage({ state: "stalemate" }))?.warnings?.[0]?.stalemate, true);
		assert.equal(applyChildWatchdogMessage(undefined, { role: "assistant", content: [] }), undefined);
		assert.equal(applyChildWatchdogMessage(undefined, { role: "custom", customType: "subagent-notify", details: {} }), undefined);
		assert.equal(applyChildWatchdogMessage(undefined, warningMessage({ severity: "nit" })), undefined);

		for (let index = 0; index < CHILD_WATCHDOG_WARNING_LIMIT + 5; index++) {
			snapshot = applyChildWatchdogMessage(snapshot, warningMessage({ summary: `warning ${index}` }));
		}
		assert.equal(snapshot?.warnings?.length, CHILD_WATCHDOG_WARNING_LIMIT);
		assert.equal(snapshot?.warnings?.at(-1)?.summary, `warning ${CHILD_WATCHDOG_WARNING_LIMIT + 4}`);

		const status = acceptChildWatchdogEvent({ current: snapshot, event: { type: CHILD_WATCHDOG_STATUS_EVENT, seq: 1, phase: "reviewing", ts: 10 } });
		assert.equal(status?.warnings?.length, CHILD_WATCHDOG_WARNING_LIMIT, "status events keep the warning envelope");
		assert.equal(unresolvedChildWatchdogBlockers(status).length, CHILD_WATCHDOG_WARNING_LIMIT);

		const addressed = applyChildWatchdogMessage(status, { role: "assistant" });
		assert.equal(addressed?.warnings?.every((entry) => entry.addressed), true);
		assert.equal(unresolvedChildWatchdogBlockers(addressed).length, 0);
		assert.equal(applyChildWatchdogMessage(addressed, { role: "assistant" }), undefined, "nothing left to address");
	});

	it("treats stalemate blockers as unresolved even when a turn followed, and never concerns", () => {
		const withBlocker = applyChildWatchdogMessage(undefined, warningMessage({ state: "stalemate" }));
		const withConcern = applyChildWatchdogMessage(withBlocker, warningMessage({ severity: "concern" }));
		const snapshot = applyChildWatchdogMessage(withConcern, { role: "assistant" });
		assert.deepEqual(unresolvedChildWatchdogBlockers(snapshot).map((entry) => entry.severity), ["blocker"]);
	});
});

describe("child watchdog status helpers", () => {
	it("resolves child cadence from override, then children, then the top-level cadence", () => {
		const base = { ...DEFAULT_WATCHDOG_CONFIG, enabled: true, children: { ...DEFAULT_WATCHDOG_CONFIG.children, enabled: true, overrides: {} } };
		assert.deepEqual(resolveChildWatchdogConfig({ config: base, agent: "worker" })?.cadence, { everyNTools: null });
		const root = { ...base, cadence: { everyNTools: 20 } };
		assert.deepEqual(resolveChildWatchdogConfig({ config: root, agent: "worker" })?.cadence, { everyNTools: 20 });
		const children = { ...root, children: { ...root.children, cadence: { everyNTools: 10 } } };
		assert.deepEqual(resolveChildWatchdogConfig({ config: children, agent: "worker" })?.cadence, { everyNTools: 10 });
		const override = { ...children, children: { ...children.children, overrides: { worker: { cadence: { everyNTools: 5 } } } } };
		assert.deepEqual(resolveChildWatchdogConfig({ config: override, agent: "worker" })?.cadence, { everyNTools: 5 });
		assert.deepEqual(resolveChildWatchdogConfig({ config: override, agent: "reviewer" })?.cadence, { everyNTools: 10 });
	});

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
		assert.deepEqual(config?.lsp, DEFAULT_WATCHDOG_CONFIG.lsp);
	});

	it("decodes child watchdog config and rejects malformed enabled payloads", () => {
		const payload = {
			runId: "run-1",
			agent: "worker",
			childIndex: 1,
			watchdogTailTimeoutMs: 100,
			agentEndTimeoutMs: 200,
			maxWarnings: null,
			lsp: { enabled: false, timeoutMs: 50, maxFiles: 2, maxDiagnostics: 3 },
			stalemateRepeats: 3,
			cadence: { everyNTools: 10 },
		};
		const config = decodeChildWatchdogConfig(JSON.stringify(payload));

		assert.deepEqual(config, payload);
		assert.equal(decodeChildWatchdogConfig(JSON.stringify({ enabled: false })), undefined);
		assert.throws(
			() => decodeChildWatchdogConfig(JSON.stringify({ ...payload, lsp: { ...payload.lsp, timeoutMs: 0 } })),
			/lsp\.timeoutMs/,
		);
		assert.throws(
			() => decodeChildWatchdogConfig(JSON.stringify({ ...payload, stalemateRepeats: 0 })),
			/stalemateRepeats/,
		);
		assert.throws(
			() => decodeChildWatchdogConfig(JSON.stringify({ ...payload, cadence: { everyNTools: 3 } })),
			/cadence\.everyNTools/,
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
		} as const;

		assert.equal(isChildWatchdogStatusEvent(firstEvent), true);
		const first = acceptChildWatchdogEvent({ event: firstEvent, runId: "run-1", agent: "worker", childIndex: 0, current: undefined });
		assert.deepEqual(first, { phase: "reviewing", seq: 1, lastUpdate: 10 });
		assert.equal(childWatchdogIsActive(first), true);
		assert.equal(acceptChildWatchdogEvent({ event: firstEvent, current: first, runId: "run-1", agent: "worker", childIndex: 0 }), undefined);
		assert.equal(acceptChildWatchdogEvent({ event: { ...firstEvent, seq: 2, runId: undefined }, current: first, runId: "run-1", agent: "worker", childIndex: 0 }), undefined);
		assert.equal(acceptChildWatchdogEvent({ event: { ...firstEvent, seq: 2, agent: undefined }, current: first, runId: "run-1", agent: "worker", childIndex: 0 }), undefined);
		assert.equal(acceptChildWatchdogEvent({ event: { ...firstEvent, seq: 2, childIndex: undefined }, current: first, runId: "run-1", agent: "worker", childIndex: 0 }), undefined);
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
