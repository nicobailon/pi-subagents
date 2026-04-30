import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clearPendingForegroundControlNotices,
	handleSubagentControlNotice,
} from "../../src/extension/control-notices.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

function makeState(): SubagentState {
	return {
		baseCwd: "/tmp/project",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
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

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
			foregroundDelayMs: 20,
		});

		assert.equal(recorder.sent.length, 1);
		assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
	});

	it("queues foreground needs-attention notices until the same step is still actionable", async () => {
		const state = makeState();
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "chain",
			startedAt: 0,
			updatedAt: 0,
			currentAgent: "worker",
			currentIndex: 0,
			currentActivityState: "needs_attention",
		});
		const recorder = makeRecorder();

		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: { source: "foreground", event: needsAttentionEvent() },
			foregroundDelayMs: 10,
		});

		assert.equal(recorder.sent.length, 0);
		await wait(25);
		assert.equal(recorder.sent.length, 1);
		assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: false });
	});

	it("drops queued foreground notices when the run finishes before delivery", async () => {
		const state = makeState();
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "chain",
			startedAt: 0,
			updatedAt: 0,
			currentAgent: "worker",
			currentIndex: 0,
			currentActivityState: "needs_attention",
		});
		const recorder = makeRecorder();

		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: { source: "foreground", event: needsAttentionEvent() },
			foregroundDelayMs: 20,
		});
		clearPendingForegroundControlNotices(state, "run-1");
		state.foregroundControls.delete("run-1");

		await wait(35);
		assert.equal(recorder.sent.length, 0);
	});

	it("drops queued foreground notices after the chain advances to another step", async () => {
		const state = makeState();
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "chain",
			startedAt: 0,
			updatedAt: 0,
			currentAgent: "worker",
			currentIndex: 0,
			currentActivityState: "needs_attention",
		});
		const recorder = makeRecorder();

		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: { source: "foreground", event: needsAttentionEvent() },
			foregroundDelayMs: 10,
		});
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "chain",
			startedAt: 0,
			updatedAt: 0,
			currentAgent: "writer",
			currentIndex: 1,
			currentActivityState: undefined,
		});

		await wait(25);
		assert.equal(recorder.sent.length, 0);
	});
});
