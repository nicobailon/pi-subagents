import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildControlEvent,
	claimControlNotification,
	controlNotificationKey,
	deriveActivityState,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	resolveControlConfig,
	shouldEmitOpenToolAttention,
	shouldNotifyControlEvent,
} from "../../src/runs/shared/subagent-control.ts";
import { nextLongRunningTrigger } from "../../src/runs/shared/long-running-guard.ts";

const config = resolveControlConfig(undefined, {
	needsAttentionAfterMs: 300,
});

describe("subagent control attention state", () => {
	it("marks a run as needing attention only after the idle threshold", () => {
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }), undefined);
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, currentTool: "bash", now: 400 }), undefined);
		assert.equal(deriveActivityState({ config, startedAt: 0, now: 400 }), "needs_attention");
	});


	it("builds compact needs-attention control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 2,
			ts: 1_000,
			lastActivityAt: 100,
		});
		assert.deepEqual(event, {
			type: "needs_attention",
			to: "needs_attention",
			ts: 1_000,
			runId: "run-1",
			agent: "worker",
			index: 2,
			message: "worker needs attention (no observed activity for 0s)",
			reason: "idle",
			elapsedMs: 900,
		});
	});

	it("supports a specific attention message", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
		});

		assert.equal(event.message, "worker completed without making edits for an implementation task");
	});

	it("builds terminal completion guard control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		assert.equal(event.reason, "completion_guard");
	});

	it("defaults notifications to active-long-running and needs attention", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		const activeEvent = buildControlEvent({ type: "active_long_running", to: "active_long_running", runId: "run-1", agent: "worker" });
		assert.equal(shouldNotifyControlEvent(config, event), true);
		assert.equal(shouldNotifyControlEvent(config, activeEvent), true);
		assert.deepEqual(config.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(config.notifyChannels, ["event", "async", "intercom"]);
	});

	it("defaults active-long-running notices to elapsed time only", () => {
		const defaults = resolveControlConfig();

		assert.equal(defaults.activeNoticeAfterMs, 240_000);
		assert.equal(defaults.activeNoticeAfterTurns, undefined);
		assert.equal(defaults.activeNoticeAfterTokens, undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 77_000,
			turns: 50,
			tokens: 800_000,
		}), undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 240_000,
			turns: 1,
			tokens: 1,
		}), "time_threshold");
	});

	it("scales the default idle threshold for higher thinking levels", () => {
		const defaults = resolveControlConfig();

		assert.equal(deriveActivityState({ config: defaults, startedAt: 0, now: 60_001 }), "needs_attention");
		assert.equal(deriveActivityState({ config: defaults, startedAt: 0, thinking: "low", now: 60_001 }), "needs_attention");
		assert.equal(deriveActivityState({ config: defaults, startedAt: 0, thinking: "minimal", now: 60_001 }), "needs_attention");
		assert.equal(deriveActivityState({ config: defaults, startedAt: 0, thinking: "high", now: 60_001 }), undefined);
		assert.equal(deriveActivityState({ config: defaults, startedAt: 0, thinking: "high", now: 300_001 }), "needs_attention");
	});

	it("keeps explicit idle threshold overrides higher priority than thinking scale", () => {
		const explicit = resolveControlConfig(undefined, { needsAttentionAfterMs: 90_000 });

		assert.equal(explicit.needsAttentionAfterMsIsExplicit, true);
		assert.equal(deriveActivityState({ config: explicit, startedAt: 0, thinking: "high", now: 90_001 }), "needs_attention");
	});

	it("treats recovered resolved configs without explicitness metadata as fixed thresholds", () => {
		const recovered = { ...resolveControlConfig(undefined, { needsAttentionAfterMs: 90_000 }) };
		delete recovered.needsAttentionAfterMsIsExplicit;

		assert.equal(deriveActivityState({ config: recovered, startedAt: 0, thinking: "high", now: 90_001 }), "needs_attention");
	});

	it("marks non-exempt open tools for attention at the active threshold", () => {
		const defaults = resolveControlConfig();

		assert.equal(shouldEmitOpenToolAttention({ config: defaults, currentTool: "bash", currentToolStartedAt: 0, now: 239_999 }), false);
		assert.equal(shouldEmitOpenToolAttention({ config: defaults, currentTool: "bash", currentToolStartedAt: 0, now: 240_000 }), true);
		assert.equal(shouldEmitOpenToolAttention({ config: defaults, currentTool: "contact_supervisor", currentToolStartedAt: 0, now: 999_999 }), false);
		assert.equal(shouldEmitOpenToolAttention({ config: { ...defaults, enabled: false }, currentTool: "bash", currentToolStartedAt: 0, now: 999_999 }), false);
	});

	it("supports opt-in turn and token long-running thresholds", () => {
		const tokenBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 500_000 });
		const turnBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTurns: 5 });

		assert.equal(nextLongRunningTrigger(tokenBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 1,
			tokens: 500_000,
		}), "token_threshold");
		assert.equal(nextLongRunningTrigger(turnBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 5,
			tokens: 1,
		}), "turn_threshold");
	});

	it("resolves custom notification config", () => {
		const custom = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 1234,
			activeNoticeAfterMs: 2345,
			activeNoticeAfterTurns: 7,
			activeNoticeAfterTokens: 8000,
			failedToolAttemptsBeforeAttention: 4,
			notifyOn: ["active_long_running", "needs_attention", "nope" as never],
			notifyChannels: ["event", "intercom", "bad" as never],
		});
		assert.equal(custom.needsAttentionAfterMs, 1234);
		assert.equal(custom.activeNoticeAfterMs, 2345);
		assert.equal(custom.activeNoticeAfterTurns, 7);
		assert.equal(custom.activeNoticeAfterTokens, 8000);
		assert.equal(custom.failedToolAttemptsBeforeAttention, 4);
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "intercom"]);
	});

	it("falls back to defaults for invalid non-empty notification arrays", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: ["bogus" as never],
			notifyChannels: ["bogus" as never],
		});
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "async", "intercom"]);
	});

	it("allows empty notification arrays to disable notifications", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: [],
			notifyChannels: [],
		});
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		assert.deepEqual(custom.notifyOn, []);
		assert.deepEqual(custom.notifyChannels, []);
		assert.equal(shouldNotifyControlEvent(custom, event), false);
	});

	it("formats control notices with a proactive hint and concrete commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /Subagent needs attention: worker/);
		assert.match(message, /Hint: Inspect status first unless the run is clearly blocked/);
		assert.match(message, /steer for a top-level live async child, routed resume for a live nested child/);
		assert.match(message, /Top-level live async nudge: subagent\(\{ action: "steer", id: "78f659a3", message: "What are you blocked on\?/);
		assert.match(message, /Routed live nested nudge: subagent\(\{ action: "resume", id: "78f659a3", message: "What are you blocked on\?/);
		assert.match(message, /Direct intercom target: subagent-worker-78f659a3/);
		assert.match(message, /Status: subagent\(\{ action: "status", id: "78f659a3" \}\)/);
		assert.match(message, /Interrupt: subagent\(\{ action: "interrupt", id: "78f659a3" \}\)/);
		assert.doesNotMatch(message, /Wait:/);
	});

	it("formats open-tool attention notices with tool facts", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "78f659a3",
			agent: "worker",
			reason: "tool_open_threshold",
			message: "worker has had tool 'bash' open for 240s",
			currentTool: "bash",
			currentToolDurationMs: 240_000,
			currentPath: "scripts/run-tests.sh",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /worker has had tool 'bash' open for 240s/);
		assert.match(message, /Facts: tool bash 240s \| path scripts\/run-tests\.sh/);
		assert.match(message, /message: "Check tool bash at path scripts\/run-tests\.sh\. Report the smallest next step or ask for a decision\."/);
	});

	it("uses bounded task context in nudges and de-duplicates distinct contexts", () => {
		const first = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "reviewer", label: `release gate ${"x".repeat(200)}` });
		const second = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "reviewer", label: "security gate" });
		const firstMessage = formatControlNoticeMessage(first);
		const nudge = firstMessage.match(/message: ("(?:[^"\\]|\\.)*")/)?.[1];
		assert.ok(nudge);
		assert.ok((JSON.parse(nudge) as string).length <= 160);
		assert.notEqual(controlNotificationKey(first), controlNotificationKey(second));
	});

	it("formats supervisor-request notices with pending-channel guidance", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "78f659a3",
			agent: "worker",
			reason: "supervisor_request",
			currentTool: "contact_supervisor",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /Supervisor request: reply to the pending request/);
		assert.match(message, /subagent_supervisor pending/);
		assert.match(message, /intercom pending/);
	});

	it("formats active-long-running notices as informational", () => {
		const event = buildControlEvent({
			type: "active_long_running",
			to: "active_long_running",
			runId: "78f659a3",
			agent: "worker",
			turns: 15,
			tokens: 160000,
			toolCount: 42,
			currentTool: "edit",
			currentPath: "src/runs/background/async-status.ts",
			reason: "turn_threshold",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.match(message, /Subagent active but long-running: worker/);
		assert.match(message, /Inspect status/);
		assert.match(message, /steer for a top-level live async child, routed resume for a live nested child/);
		assert.match(message, /Top-level live async nudge: subagent\(\{ action: "steer", id: "78f659a3", message: "Check tool edit at path src\/runs\/background\/async-status\.ts/);
		assert.match(message, /Routed live nested nudge: subagent\(\{ action: "resume", id: "78f659a3", message: "Check tool edit at path src\/runs\/background\/async-status\.ts/);
		assert.match(message, /15 turns/);
		assert.match(message, /160000 tokens/);
		assert.match(message, /path src\/runs\/background\/async-status\.ts/);
		assert.doesNotMatch(message, /Subagent needs attention/);
	});

	it("formats terminal completion guard notices without live-run commands", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "78f659a3",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.match(message, /Subagent failed: worker/);
		assert.match(message, /read the output artifact or session/);
		assert.match(message, /Run intercom target \(may be inactive\): subagent-worker-78f659a3-1/);
		assert.doesNotMatch(message, /Status:/);
		assert.doesNotMatch(message, /Interrupt:/);
		assert.doesNotMatch(message, /What are you blocked on/);
	});

	it("formats intercom notifications with the same control commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlIntercomMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /worker needs attention in run 78f659a3/);
		assert.match(message, /Top-level live async nudge: subagent\(\{ action: "steer", id: "78f659a3", message: "What are you blocked on\?/);
		assert.match(message, /Routed live nested nudge: subagent\(\{ action: "resume", id: "78f659a3", message: "What are you blocked on\?/);
	});

	it("dedupes notifications once per child target and attention state", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker", index: 0 });
		const seen = new Set<string>();

		assert.match(controlNotificationKey(event, "subagent-worker-run-1-1"), /^subagent-worker-run-1-1:needs_attention:idle:[a-f0-9]{8}$/);
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), true);
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), false);

		const terminalEvent = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});
		assert.equal(claimControlNotification(resolveControlConfig(), terminalEvent, seen, "subagent-worker-run-1-1"), true);
	});
});
