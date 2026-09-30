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

	it("wakes the parent with inspection and recovery guidance for an open bash call", () => {
		const recorder = makeRecorder();
		handleSubagentControlNotice({
			pi: recorder.pi,
			state: makeState(),
			visibleControlNotices: new Set(),
			details: { source: "async", event: needsAttentionEvent({ reason: "tool_open_threshold", currentTool: "bash" }) },
		});
		assert.equal(recorder.sent.length, 1);
		assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
		const message = recorder.sent[0]?.message as { content: string };
		assert.match(message.content, /Inspect the running command and recent output/);
		assert.match(message.content, /view: "transcript", index: 0/);
		assert.doesNotMatch(message.content, /live async nudge|live nested nudge/);
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
});
