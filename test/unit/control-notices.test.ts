import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	clearPendingForegroundControlNotices,
	handleSubagentControlNotice,
} from "../../src/extension/control-notices.ts";
import { formatControlNoticeMessage } from "../../src/runs/shared/subagent-control.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

interface SentControlNotice {
	customType: string;
	content: string;
	display: boolean;
	details: {
		event: ControlEvent;
		label?: string;
		role?: string;
		logicalStep?: number;
		totalSteps?: number;
		noticeText?: string;
	};
}

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
		activityEpoch: 1,
		evidenceLastActivityAt: 1,
		...overrides,
	};
}

function makeRecorder() {
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const events: Array<{ channel: string; data: unknown }> = [];
	return {
		sent,
		events,
		pi: {
			events: {
				emit(channel: string, data: unknown) {
					events.push({ channel, data });
				},
			},
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
	it("debounces and revalidates async needs-attention notices without changing model-facing content", async () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-notice-"));
		try {
			const state = makeState();
			state.asyncJobs.set("run-1", {
				asyncId: "run-1",
				asyncDir,
				status: "running",
				mode: "chain",
				chainStepCount: 2,
				steps: [
					{ index: 0, agent: "worker", label: "Implement API", status: "running" },
					{ index: 1, agent: "tester", label: "Validate", status: "pending" },
				],
			});
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-1",
				mode: "chain",
				state: "running",
				startedAt: 0,
				currentStep: 0,
				steps: [
					{ agent: "worker", label: "Implement API", status: "running", activityState: "needs_attention", lastActivityAt: 1 },
					{ agent: "tester", label: "Validate", status: "pending" },
				],
			}));
			const recorder = makeRecorder();
			const event = needsAttentionEvent({
				message: "worker needs attention with complete diagnostics",
				currentPath: "/tmp/project/src/index.ts",
				toolCount: 7,
			});
			const expectedModelContent = formatControlNoticeMessage(event);

			handleSubagentControlNotice({
				pi: recorder.pi,
				state,
				visibleControlNotices: new Set(),
				details: { source: "async", asyncDir, event },
				asyncDelayMs: 5,
			});

			assert.equal(recorder.sent.length, 0);
			await wait(20);
			assert.equal(recorder.sent.length, 1);
			assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
			const message = recorder.sent[0]?.message as SentControlNotice;
			assert.equal(message.content, expectedModelContent);
			assert.equal(message.details.noticeText, expectedModelContent);
			assert.match(message.content, /worker needs attention with complete diagnostics/);
			assert.match(message.content, /Status: subagent\(\{ action: "status"/);
			assert.deepEqual({
				label: message.details.label,
				role: message.details.role,
				logicalStep: message.details.logicalStep,
				totalSteps: message.details.totalSteps,
			}, {
				label: "Implement API",
				role: "worker",
				logicalStep: 1,
				totalSteps: 2,
			});
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
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
			currentStatus: "running",
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
			currentStatus: "running",
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
			currentStatus: "running",
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
			currentStatus: "running",
			currentActivityState: undefined,
		});

		await wait(25);
		assert.equal(recorder.sent.length, 0);
	});

	it("suppresses async notices when activity resumes before delivery", async () => {
		const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-notice-recovery-"));
		try {
			const state = makeState();
			state.asyncJobs.set("run-1", { asyncId: "run-1", asyncDir, status: "running" });
			const writeStatus = (lastActivityAt: number, activityState?: "needs_attention") => fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-1",
				mode: "single",
				state: "running",
				startedAt: 0,
				steps: [{ agent: "worker", status: "running", activityState, lastActivityAt }],
			}));
			writeStatus(1, "needs_attention");
			const recorder = makeRecorder();
			handleSubagentControlNotice({
				pi: recorder.pi,
				state,
				visibleControlNotices: new Set(),
				details: { source: "async", asyncDir, event: needsAttentionEvent() },
				asyncDelayMs: 15,
			});
			writeStatus(2);
			await wait(30);
			assert.equal(recorder.sent.length, 0);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("allows a new notice after activity starts a later stale interval", async () => {
		const state = makeState();
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "single",
			startedAt: 0,
			updatedAt: 0,
			currentAgent: "worker",
			currentIndex: 0,
			currentStatus: "running",
			currentActivityState: "needs_attention",
			lastActivityAt: 1,
		});
		const recorder = makeRecorder();
		const visible = new Set<string>();
		handleSubagentControlNotice({ pi: recorder.pi, state, visibleControlNotices: visible, details: { source: "foreground", event: needsAttentionEvent() }, foregroundDelayMs: 5 });
		await wait(15);
		state.foregroundControls.get("run-1")!.lastActivityAt = 2;
		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: visible,
			details: { source: "foreground", event: needsAttentionEvent({ activityEpoch: 2, evidenceLastActivityAt: 2 }) },
			foregroundDelayMs: 5,
		});
		await wait(15);
		assert.equal(recorder.sent.length, 2);
	});

	it("suppresses a terminal foreground child while another parallel child remains live", async () => {
		const state = makeState();
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "parallel",
			startedAt: 0,
			updatedAt: 2,
			currentAgent: "reviewer",
			currentIndex: 1,
			currentStatus: "running",
			currentActivityState: undefined,
			childSnapshots: new Map([
				[0, { agent: "worker", status: "complete", activityState: "needs_attention" }],
				[1, { agent: "reviewer", status: "running" }],
			]),
		});
		const recorder = makeRecorder();
		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: { source: "foreground", event: needsAttentionEvent() },
			foregroundDelayMs: 5,
		});

		await wait(15);
		assert.equal(recorder.sent.length, 0);
		assert.equal(recorder.events.length, 0);
	});

	it("delivers configured intercom content only after the actionable gate", async () => {
		const state = makeState();
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "single",
			startedAt: 0,
			updatedAt: 1,
			currentAgent: "worker",
			currentIndex: 0,
			currentStatus: "running",
			currentActivityState: "needs_attention",
			lastActivityAt: 1,
		});
		const recorder = makeRecorder();
		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: {
				source: "foreground",
				event: needsAttentionEvent(),
				channels: ["intercom"],
				intercom: { to: "main", message: "UNCHANGED INTERCOM CONTENT" },
			},
			foregroundDelayMs: 5,
		});

		assert.equal(recorder.events.length, 0);
		await wait(15);
		assert.equal(recorder.sent.length, 0);
		assert.deepEqual(recorder.events, [{
			channel: "subagent:control-intercom",
			data: {
				source: "foreground",
				event: needsAttentionEvent(),
				channels: ["intercom"],
				intercom: { to: "main", message: "UNCHANGED INTERCOM CONTENT" },
				to: "main",
				message: "UNCHANGED INTERCOM CONTENT",
			},
		}]);
	});

	it("suppresses intercom delivery when the exact child recovers during debounce", async () => {
		const state = makeState();
		const childSnapshots = new Map([
			[0, { agent: "worker", status: "running" as const, activityState: "needs_attention" as const, lastActivityAt: 1 }],
		]);
		state.foregroundControls.set("run-1", {
			runId: "run-1",
			mode: "parallel",
			startedAt: 0,
			updatedAt: 1,
			currentAgent: "worker",
			currentIndex: 0,
			currentStatus: "running",
			currentActivityState: "needs_attention",
			childSnapshots,
		});
		const recorder = makeRecorder();
		handleSubagentControlNotice({
			pi: recorder.pi,
			state,
			visibleControlNotices: new Set(),
			details: {
				source: "foreground",
				event: needsAttentionEvent(),
				channels: ["intercom"],
				intercom: { to: "main", message: "UNCHANGED INTERCOM CONTENT" },
			},
			foregroundDelayMs: 10,
		});
		childSnapshots.set(0, { agent: "worker", status: "running", lastActivityAt: 2 });

		await wait(25);
		assert.equal(recorder.sent.length, 0);
		assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), false);
	});
});
