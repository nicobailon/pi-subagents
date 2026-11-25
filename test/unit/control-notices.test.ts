import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

function makeState(): SubagentState {
	return {
		baseCwd: "/tmp/project",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function needsAttentionEvent(overrides: Partial<ControlEvent> = {}): ControlEvent {
	return {
		type: "needs_attention",
		to: "needs_attention",
		ts: 1,
		runId: "run-1",
		agent: "worker",
		index: 0,
		message: "worker needs attention",
		reason: "idle",
		...overrides,
	};
}

function makeRecorder() {
	const sent: Array<{ message: unknown; options: unknown }> = [];
	return {
		sent,
		pi: {
			sendMessage(message: unknown, options: unknown) {
				sent.push({ message, options });
			},
		},
	};
}

describe("subagent control notice delivery", () => {
	it("delivers async needs-attention notices immediately", () => {
		const state = makeState();
		const recorder = makeRecorder();

		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: { source: "async", event: needsAttentionEvent() },
		});

		assert.equal(recorder.sent.length, 1);
		assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
	});

	it("delivers goal notices without starting a new turn", () => {
		const state = makeState();
		const recorder = makeRecorder();

		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: { source: "goal", event: needsAttentionEvent(), noticeText: "Goal is ready." },
		});

		assert.equal(recorder.sent.length, 1);
		assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: false });
	});

	it("sends nothing for a deferred supervisor-request status event", () => {
		const recorder = makeRecorder();
		handleSubagentControlNotice({ pi: recorder.pi, state: makeState(), visibleControlNotices: new Set(), details: { source: "async", event: needsAttentionEvent({ reason: "supervisor_request" }), noticeDeferred: true } });
		assert.deepEqual(recorder.sent, []);
	});

	it("does not queue a foreground notice that Pi could flush after completion", () => {
		const state = makeState();
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "parallel",
			startedAt: 0,
			updatedAt: 0,
			currentAgent: "worker",
			currentIndex: 0,
			currentActivityState: "needs_attention",
		});
		const queued: Array<{ message: unknown; options: unknown }> = [];
		const visible: Array<{ message: unknown; options: unknown }> = [];
		const pi = {
			sendMessage(message: unknown, options: unknown) {
				queued.push({ message, options });
			},
		};

		handleSubagentControlNotice({
			pi,
			state,
			visibleControlNotices: new Set(),
			details: { source: "foreground", event: needsAttentionEvent() },
		});
		state.foregroundControls.delete("run-1");
		visible.push(...queued);

		assert.deepEqual(visible, []);
	});

	it("wakes the parent with each 30-minute check-in, but not with other long-running signals", () => {
		const recorder = makeRecorder();
		const visibleControlNotices = new Set<string>();
		const checkIn = (elapsedMs: number) => needsAttentionEvent({ type: "active_long_running", to: "active_long_running", runId: "1a2b3c4d-run", reason: "check_in", elapsedMs, message: "worker has been running" });
		for (const event of [checkIn(1_800_000), checkIn(3_600_000), checkIn(3_600_000), needsAttentionEvent({ type: "active_long_running", to: "active_long_running", reason: "time_threshold" })]) {
			handleSubagentControlNotice({ pi: recorder.pi, state: makeState(), visibleControlNotices, details: { source: "async", event } });
		}
		assert.deepEqual(recorder.sent.map((entry) => [(entry.message as { content: string }).content, entry.options]), [
			['worker 1a2b3c4d has been running 30 min. Check it: subagent({action:"status", id:"1a2b3c4d"}); steer or stop it if it\'s stuck.', { triggerTurn: true }],
			['worker 1a2b3c4d has been running 60 min. Check it: subagent({action:"status", id:"1a2b3c4d"}); steer or stop it if it\'s stuck.', { triggerTurn: true }],
		]);
	});
});
