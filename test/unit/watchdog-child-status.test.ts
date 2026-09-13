import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CHILD_WATCHDOG_STATUS_EVENT,
	CHILD_WATCHDOG_WARNING_LIMIT,
	acceptChildWatchdogEvent,
	applyChildWatchdogMessage,
	childWatchdogIsActive,
	childWatchdogProgressForModel,
	decodeChildWatchdogConfig,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	unresolvedChildWatchdogBlockers,
} from "../../src/watchdog/child-status.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { childResolvedConfig } from "../../src/watchdog/register-child.ts";

describe("child watchdog warning envelope", () => {
	it("marks status-event findings addressed on assistant turns", () => {
		const snapshot = acceptChildWatchdogEvent({ current: undefined, event: {
			type: CHILD_WATCHDOG_STATUS_EVENT, seq: 1, phase: "idle", ts: 5,
			warning: { severity: "blocker", importance: "high", category: "correctness", summary: "Unverified tests", evidence: "No test command.", recommendedAction: "Run tests.", addressed: false, stalemate: true },
		} });
		assert.equal(applyChildWatchdogMessage(undefined, { role: "assistant", content: [] }), undefined);
		assert.equal(applyChildWatchdogMessage(undefined, { role: "custom", customType: "subagent-notify", details: {} }), undefined);
		const addressed = applyChildWatchdogMessage(snapshot, { role: "assistant" });
		assert.equal(addressed?.warnings?.every((entry) => entry.addressed), true);
		assert.equal(unresolvedChildWatchdogBlockers(addressed).length, 1, "stalemate remains unresolved");
		assert.equal(applyChildWatchdogMessage(addressed, { role: "assistant" }), undefined, "nothing left to address");
	});
});

describe("child watchdog status helpers", () => {
	it("retains bounded findings in audit status but projects only high importance to the parent model", () => {
		let snapshot;
		for (let index = 0; index < CHILD_WATCHDOG_WARNING_LIMIT + 2; index++) {
			const importance = index % 3 === 0 ? "high" : index % 3 === 1 ? "medium" : "low";
			snapshot = acceptChildWatchdogEvent({
				current: snapshot,
				event: {
					type: CHILD_WATCHDOG_STATUS_EVENT, seq: index + 1, phase: "idle", ts: index,
					warning: { severity: index === 4 ? "blocker" : "concern", importance, category: "correctness", summary: `${importance}-summary-${index}`, evidence: `${importance}-evidence-${index}`, recommendedAction: `${importance}-action-${index}`, addressed: false, stalemate: false },
				},
			});
		}
		assert.equal(snapshot?.warnings?.length, CHILD_WATCHDOG_WARNING_LIMIT);
		assert.equal(unresolvedChildWatchdogBlockers(snapshot).length, 1, "low/medium blockers still gate acceptance");
		const serialized = JSON.stringify(childWatchdogProgressForModel(snapshot));
		assert.doesNotMatch(serialized, /low-(summary|evidence|action)|medium-(summary|evidence|action)/);
		assert.match(serialized, /high-summary/);
	});

	it("passes child fallback precedence through the launch decoder and reviewer config", () => {
		const base = { ...DEFAULT_WATCHDOG_CONFIG, enabled: true, main: { enabled: true, fallbackModels: ["main/a"] }, children: { ...DEFAULT_WATCHDOG_CONFIG.children, enabled: true, overrides: {} } };
		assert.equal(resolveChildWatchdogConfig({ config: base })?.fallbackModels, undefined);
		const config = { ...base, children: { ...base.children, fallbackModels: ["child/a"], overrides: { worker: { fallbackModels: [] }, reviewer: { fallbackModels: ["override/a"] } } } };
		for (const [agent, expected] of [["other", ["child/a"]], ["worker", []], ["reviewer", ["override/a"]]] as const) {
			const payload = resolveChildWatchdogConfig({ config, agent })!;
			const decoded = decodeChildWatchdogConfig(JSON.stringify(payload))!;
			assert.deepEqual(childResolvedConfig(decoded).main.fallbackModels, expected);
			assert.throws(() => decodeChildWatchdogConfig(JSON.stringify({ ...payload, fallbackModels: [null] })), /fallbackModels/);
		}
	});
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

	it("rejects malformed status warning values without throwing", () => {
		const event = { type: CHILD_WATCHDOG_STATUS_EVENT, seq: 1, phase: "idle", ts: 1 };
		for (const warning of [null, [], "warning", 1, true]) {
			assert.equal(isChildWatchdogStatusEvent({ ...event, warning }), false);
		}
		assert.equal(isChildWatchdogStatusEvent(null), false);
		assert.equal(isChildWatchdogStatusEvent([]), false);
		const warning = { severity: "concern", importance: "low", category: "other", summary: "summary", evidence: "evidence", recommendedAction: "act", addressed: false, stalemate: false };
		assert.equal(isChildWatchdogStatusEvent({ ...event, warning: { ...warning, displayedAt: 1 } }), false);
		assert.equal(isChildWatchdogStatusEvent({ ...event, warning: { ...warning, displayedAt: "2026-09-13T00:00:00.000Z" } }), true);
	});
});
