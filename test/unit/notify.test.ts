import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify, {
	buildCompletionDetails,
	formatGroupedCompletion,
	formatSingleCompletion,
	parseSubagentNotifyContent,
	type RegisterSubagentNotifyOptions,
	type SubagentNotifyDetails,
	scheduledCompletionTriggersTurn,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { createResultDeliveryOwnership } from "../../src/runs/background/result-delivery-ownership.ts";

const COMPLETION_OWNER_ID = "completion-owner-a";

it("keeps model-authored receipt lines in the preview, never in receipt metadata", () => {
	for (const resultPreview of [
		"Workflow receipt: /model/start.json\nKeep this output.",
		"Before\nWorkflow receipt: /model/middle.json\nAfter",
		"Before\n\nWorkflow receipt: /model/suffix.json",
	]) {
		for (const workflowReceiptPath of [undefined, "/published/receipt.json"]) {
			const details: SubagentNotifyDetails = { agent: "workflow", status: "completed", resultPreview, workflowReceiptPath };
			const parsed = parseSubagentNotifyContent(formatSingleCompletion(details));
			assert.equal(parsed?.resultPreview, resultPreview);
			assert.equal(parsed?.workflowReceiptPath, workflowReceiptPath);
			const scheduled = parseSubagentNotifyContent(formatSingleCompletion({ ...details, scheduleOrigin: { id: "schedule-1" } }));
			assert.equal(scheduled?.resultPreview, resultPreview);
			assert.equal(scheduled?.workflowReceiptPath, workflowReceiptPath);
			assert.deepEqual(scheduled?.scheduleOrigin, { id: "schedule-1" });
		}
	}
});

it("surfaces published workflow receipts outside single and grouped previews", () => {
	const workflowReceiptPath = "/opaque/receipt.json";
	const details = buildCompletionDetails({ agent: "workflow", mode: "workflow", runId: "run-1", success: true, summary: "Completed", results: [{ runId: "child-1", output: "x".repeat(20_000) }], workflowReceipt: { path: workflowReceiptPath, receipt: {} } });
	assert.equal(details.workflowReceiptPath, workflowReceiptPath);
	const single = formatSingleCompletion(details);
	assert.equal(single.split("\n")[1], `Workflow receipt: ${workflowReceiptPath}`);
	assert.match(single, /\[preview truncated\]/);
	assert.ok(single.includes(`Workflow receipt: ${workflowReceiptPath}`));
	assert.ok(formatGroupedCompletion([details, details]).includes(`Workflow receipt: ${workflowReceiptPath}`));
	const parsed = parseSubagentNotifyContent(single);
	assert.equal(parsed?.workflowReceiptPath, workflowReceiptPath);
	assert.doesNotMatch(parsed?.resultPreview ?? "", /Workflow receipt:/);
});

function createEventBus() {
	const emitter = new EventEmitter();
	return {
		on(event: string, listener: (...args: unknown[]) => void) {
			emitter.on(event, listener);
			return () => emitter.off(event, listener);
		},
		emit(event: string, ...args: unknown[]) {
			return emitter.emit(event, ...args);
		},
		listenerCount(event: string) {
			return emitter.listenerCount(event);
		},
	};
}

function createPi(currentSessionId = "session-1", registerOptions: RegisterSubagentNotifyOptions = {}) {
	const events = createEventBus();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};

	// Formatting-focused tests run with batching disabled so single completions
	// emit synchronously. Batching behavior is covered by the dedicated suite below.
	const notifier = registerSubagentNotify(pi as never, { currentSessionId, completionOwnerId: COMPLETION_OWNER_ID }, { batchConfig: { enabled: false }, ...registerOptions });

	return { events, sent, notifier, dispose: () => notifier.dispose() };
}

function createBatchingPi(clock: ReturnType<typeof createFakeClock>, currentSessionId = "session-a") {
	const events = createEventBus();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	const notifier = registerSubagentNotify(pi as never, { currentSessionId, completionOwnerId: COMPLETION_OWNER_ID }, {
		batchConfig: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 },
		timers: clock.api,
		now: clock.now,
	});
	return { events, sent, notifier, dispose: () => notifier.dispose() };
}

interface FakeJob {
	id: number;
	fireAt: number;
	handler: () => void;
}

function createFakeClock() {
	let now = 0;
	let nextId = 1;
	const jobs = new Map<number, FakeJob>();
	const api = {
		setTimeout(handler: () => void, delayMs: number): unknown {
			const id = nextId++;
			jobs.set(id, { id, fireAt: now + delayMs, handler });
			return id;
		},
		clearTimeout(handle: unknown): void {
			if (typeof handle === "number") jobs.delete(handle);
		},
	};
	return {
		api,
		now: () => now,
		advance(ms: number): void {
			now += ms;
			const due = [...jobs.values()].filter((job) => job.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
			for (const job of due) {
				if (!jobs.has(job.id)) continue;
				jobs.delete(job.id);
				job.handler();
			}
		},
	};
}

function completionResult(overrides: Record<string, unknown> = {}) {
	return {
		id: `notify-${Math.random().toString(36).slice(2)}`,
		agent: "worker",
		success: true,
		summary: "Done",
		exitCode: 0,
		timestamp: 123,
		sessionId: "session-a",
		completionOwnerId: COMPLETION_OWNER_ID,
		...overrides,
	};
}

describe("registerSubagentNotify", () => {
	it("keeps a successful background completion hidden while waking the originating session", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-empty-1",
			agent: "worker",
			success: true,
			summary: "",
			exitCode: 0,
			timestamp: 123,
			sessionId: "session-1",
			completionOwnerId: COMPLETION_OWNER_ID,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\n(no output)",
				display: false,
			},
			options: { triggerTurn: true },
		});
	});

	it("does not attach async status snapshots to subagent-notify details", async () => {
		const { notifier, sent } = createPi("session-a");
		assert.equal(await notifier.deliver(completionResult({ id: "direct-no-snapshot" })), true);
		const message = sent[0]?.message as { customType?: string; details?: Record<string, unknown> } | undefined;
		assert.equal(message?.customType, "subagent-notify");
		assert.equal(message?.details?.asyncSnapshot, undefined);
	});

	it("acknowledges direct delivery only after sendMessage accepts it", async () => {
		const { notifier, sent } = createPi("session-a");
		assert.equal(await notifier.deliver(completionResult({ id: "direct-accepted" })), true);
		assert.equal(sent.length, 1);
	});

	it("rejects async completion delivery for a missing or different parent owner", async () => {
		const { notifier, sent } = createPi("session-a");
		assert.equal(await notifier.deliver(completionResult({ id: "missing-owner", completionOwnerId: undefined })), false);
		assert.equal(await notifier.deliver(completionResult({ id: "different-owner", completionOwnerId: "completion-owner-b" })), false);
		assert.equal(sent.length, 0);
	});

	it("accepts only explicitly claimed predecessor-session completions", async () => {
		const events = createEventBus();
		const sent: unknown[] = [];
		const pi = { events, sendMessage(message: unknown) { sent.push(message); } };
		const state = { currentSessionId: "session-old" as string | null, completionOwnerId: COMPLETION_OWNER_ID };
		const ownership = createResultDeliveryOwnership(state);
		assert.equal(ownership.claimPredecessor("session-old", "session-old"), true);
		state.currentSessionId = "session-new";
		const notifier = registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false }, ownership });
		try {
			assert.equal(await notifier.deliver(completionResult({ id: "predecessor", sessionId: "session-old" })), true);
			assert.equal(await notifier.deliver(completionResult({ id: "foreign", sessionId: "session-foreign" })), false);
			assert.equal(await notifier.deliver(completionResult({ id: "wrong-owner", sessionId: "session-old", completionOwnerId: "other-owner" })), false);
			assert.equal(sent.length, 1);
		} finally {
			notifier.dispose();
		}
	});

	it("rechecks session ownership before emitting a delayed batch", async () => {
		const clock = createFakeClock();
		const events = createEventBus();
		const sent: unknown[] = [];
		const pi = { events, sendMessage(message: unknown) { sent.push(message); } };
		const state = { currentSessionId: "session-a" as string | null, completionOwnerId: COMPLETION_OWNER_ID };
		const notifier = registerSubagentNotify(pi as never, state, {
			batchConfig: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 },
			timers: clock.api,
			now: clock.now,
		});
		try {
			const pending = notifier.deliver(completionResult({ id: "delayed-unclaimed" }));
			assert.equal(notifier.hasPendingDelivery(), true);
			state.currentSessionId = "session-b";
			clock.advance(150);
			assert.equal(await pending, false);
			assert.equal(notifier.hasPendingDelivery(), false);
			assert.equal(sent.length, 0);
		} finally {
			notifier.dispose();
		}
	});

	it("does not wake the session when background delivery explicitly disables triggerTurn", async () => {
		const { notifier, sent } = createPi("session-a");
		assert.equal(await notifier.deliver(completionResult({ id: "direct-silent", triggerTurn: false })), true);
		assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	});

	it("suppresses local delivery after an acknowledged grouped intercom relay", async () => {
		const { notifier, sent } = createPi("session-a");
		assert.equal(await notifier.deliver(completionResult({ id: "intercom-delivered", intercomDelivered: true })), true);
		assert.equal(sent.length, 0);
	});

	it("rejects a pending batch when the notifier is disposed", async () => {
		const clock = createFakeClock();
		const { notifier, sent } = createBatchingPi(clock);
		const pending = notifier.deliver(completionResult({ id: "dispose-pending" }));
		assert.equal(notifier.hasPendingDelivery(), true);
		notifier.dispose();
		assert.equal(await pending, false);
		assert.equal(notifier.hasPendingDelivery(), false);
		clock.advance(1000);
		assert.equal(sent.length, 0);
	});

	it("wakes the originating session with recovered detached foreground output", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, {
			id: "foreground-run:0",
			runId: "foreground-run",
			source: "foreground",
			agent: "reviewer",
			success: true,
			summary: "Recovered final review",
			exitCode: 0,
			timestamp: 123,
			sessionId: "session-1",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Detached foreground task completed: **reviewer**\n\nRecovered final review",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("does not deliver detached foreground completion to another active session", () => {
		const { events, sent } = createPi("session-2");
		events.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, {
			id: "foreground-run:0",
			source: "foreground",
			agent: "reviewer",
			success: true,
			summary: "Recovered final review",
			timestamp: 123,
			sessionId: "session-1",
		});
		assert.equal(sent.length, 0);
	});

	it("preserves non-empty completion summaries", () => {
		const { events, sent } = createPi();
		const summary = "  Done streaming\nAll clear  ";

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-summary-1",
			agent: "worker",
			success: true,
			summary,
			exitCode: 0,
			timestamp: 456,
			taskIndex: 1,
			totalTasks: 3,
			sessionId: "session-1",
			completionOwnerId: COMPLETION_OWNER_ID,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: `Background task completed: **worker** (2/3)\n\n${summary}`,
				display: false,
			},
			options: { triggerTurn: true },
		});
	});

	it("preserves session paths in notification content", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-path-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 456,
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			completionOwnerId: COMPLETION_OWNER_ID,
		});

		assert.deepEqual(sent, [{
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl",
				display: false,
			},
			options: { triggerTurn: true },
		}]);
	});

	it("labels paused completions as paused even without an exit code", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-paused-1",
			agent: "worker",
			success: false,
			state: "paused",
			summary: "Paused after interrupt. Waiting for explicit next action.",
			timestamp: 789,
			sessionId: "session-1",
			completionOwnerId: COMPLETION_OWNER_ID,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task paused: **worker**\n\nPaused after interrupt. Waiting for explicit next action.",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("labels detached-only workflow completions as paused and prints workflow child ids", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "workflow-1",
			runId: "workflow-1",
			mode: "workflow",
			agent: "workflow",
			success: false,
			state: "paused",
			summary: "Run 'detaches' detached for intercom coordination.",
			results: [{ workflowKey: "detaches", agent: "worker", runId: "child-1", status: "paused", success: false }],
			timestamp: 790,
			sessionId: "session-1",
			completionOwnerId: COMPLETION_OWNER_ID,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task paused: **workflow**\n\nRun 'detaches' detached for intercom coordination.\n\nChild outputs:\n- key=detaches run=child-1 status=paused\n  Saved output: unavailable\n  Preview: unavailable (no safe inline output)\n\nWorkflow run: workflow-1\nChild runs: detaches=child-1 (paused)",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("ignores completions for other or missing session ids", () => {
		const { events, sent } = createPi("session-owner");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-other-session",
			agent: "worker",
			success: true,
			summary: "Other done",
			timestamp: 100,
			sessionId: "session-other",
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-sessionless",
			agent: "worker",
			success: true,
			summary: "Legacy cwd-scoped done",
			timestamp: 101,
			cwd: "/repo",
		});

		assert.deepEqual(sent, []);
	});

	it("emits failed completions immediately even while successes are held", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "ok-1", agent: "ok-1", summary: "ok-1 done" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "fail-1", agent: "fail-1", success: false, summary: "boom", exitCode: 1 }));

		// The failure must arrive immediately, and the held success must be
		// flushed ahead of it rather than waiting on the debounce timer.
		assert.equal(sent.length, 2);
		assert.match((sent[0]!.message as { content: string }).content, /Background task completed: \*\*ok-1\*\*/);
		assert.match((sent[1]!.message as { content: string }).content, /Background task failed: \*\*fail-1\*\*/);

		// No deferred emission should arrive later.
		clock.advance(1000);
		assert.equal(sent.length, 2);
	});

	it("groups sibling successes into a single notification after the debounce window", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-2", agent: "beta", summary: "beta done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-3", agent: "gamma", summary: "gamma done", sessionId: "session-a" }));
		assert.equal(sent.length, 0);

		clock.advance(150);
		assert.equal(sent.length, 1);
		const content = (sent[0]!.message as { content: string }).content;
		assert.match(content, /^Background tasks completed \(3\): \*\*alpha\*\*, \*\*beta\*\*, \*\*gamma\*\*/);
		assert.match(content, /1\. alpha\nalpha done/);
		assert.match(content, /3\. gamma\ngamma done/);
		assert.deepEqual(sent[0]!.message, {
			customType: "subagent-notify",
			content,
			display: false,
		});
		assert.deepEqual(sent[0]!.options, { triggerTurn: true });
	});

	it("ignores successes from other sessions instead of grouping them", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock, "session-a");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "s-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "s-2", agent: "beta", summary: "beta done", sessionId: "session-b" }));
		clock.advance(150);

		assert.equal(sent.length, 1);
		assert.match((sent[0]!.message as { content: string }).content, /^Background task completed: \*\*alpha\*\*/);
		assert.doesNotMatch((sent[0]!.message as { content: string }).content, /beta done/);
	});

	it("does not let another session failure flush held successes", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock, "session-a");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "held-a-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "fail-b-1", agent: "beta", success: false, summary: "boom", exitCode: 1, sessionId: "session-b" }));
		assert.equal(sent.length, 0);

		clock.advance(150);
		assert.equal(sent.length, 1);
		assert.match((sent[0]!.message as { content: string }).content, /^Background task completed: \*\*alpha\*\*/);
		assert.doesNotMatch((sent[0]!.message as { content: string }).content, /boom/);
	});

	it("disposes queued completions without emitting and is idempotent", () => {
		const clock = createFakeClock();
		const { events, sent, dispose } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "dispose-held-1" }));
		assert.equal(sent.length, 0);
		assert.equal(events.listenerCount(SUBAGENT_ASYNC_COMPLETE_EVENT), 1);
		assert.equal(events.listenerCount(SUBAGENT_FOREGROUND_COMPLETE_EVENT), 1);

		dispose();
		dispose();
		assert.equal(events.listenerCount(SUBAGENT_ASYNC_COMPLETE_EVENT), 0);
		assert.equal(events.listenerCount(SUBAGENT_FOREGROUND_COMPLETE_EVENT), 0);

		clock.advance(1000);
		assert.equal(sent.length, 0);
	});

	it("does not let a disposed notifier affect another runtime", () => {
		const oldClock = createFakeClock();
		const oldRegistration = createBatchingPi(oldClock);
		oldRegistration.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "old-owner-held-1" }));

		const newClock = createFakeClock();
		const newRegistration = createBatchingPi(newClock);
		oldRegistration.dispose();
		oldClock.advance(1000);
		assert.equal(oldRegistration.sent.length, 0);

		newRegistration.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "new-owner-1" }));
		newClock.advance(150);
		assert.equal(newRegistration.sent.length, 1);
		newRegistration.dispose();
	});
});

describe("completion formatting helpers", () => {
	it("formats and parses a parallel handoff without folding it into the result preview", () => {
		const content = formatSingleCompletion({
			agent: "worker",
			status: "completed",
			resultPreview: "Done",
			handoffPath: "/tmp/run/handoff.json",
			sessionLabel: "Session file",
			sessionValue: "/tmp/session.jsonl",
		});
		assert.equal(content, "Background task completed: **worker**\n\nDone\n\nParallel handoff: /tmp/run/handoff.json\n\nSession file: /tmp/session.jsonl");
		assert.deepEqual(parseSubagentNotifyContent(content), {
			agent: "worker",
			status: "completed",
			resultPreview: "Done",
			handoffPath: "/tmp/run/handoff.json",
			sessionLabel: "session file",
			sessionValue: "/tmp/session.jsonl",
		});
		assert.equal(buildCompletionDetails({
			id: "run",
			agent: "worker",
			success: true,
			summary: "Done",
			parallelHandoff: { path: "/tmp/run/handoff.json" },
		}).handoffPath, "/tmp/run/handoff.json");
	});

	it("formatSingleCompletion mirrors the in-handler single message shape", () => {
		const content = formatSingleCompletion({
			agent: "worker",
			status: "completed",
			taskInfo: " (2/3)",
			resultPreview: "Done",
			sessionLabel: "Session file",
			sessionValue: "/tmp/session.jsonl",
		});
		assert.equal(content, "Background task completed: **worker** (2/3)\n\nDone\n\nSession file: /tmp/session.jsonl");
	});

	it("parses detached foreground notification content for the custom renderer", () => {
		const content = formatSingleCompletion({
			agent: "reviewer",
			status: "failed",
			source: "foreground",
			resultPreview: "Acceptance rejected",
			sessionLabel: "Session file",
			sessionValue: "/tmp/reviewer.jsonl",
		});
		assert.deepEqual(parseSubagentNotifyContent(content), {
			agent: "reviewer",
			status: "failed",
			source: "foreground",
			resultPreview: "Acceptance rejected",
			sessionLabel: "session file",
			sessionValue: "/tmp/reviewer.jsonl",
		});
	});

	it("formatGroupedCompletion lists each agent with its summary and session", () => {
		const content = formatGroupedCompletion([
			{ agent: "alpha", status: "completed", resultPreview: "alpha done" },
			{ agent: "beta", status: "completed", taskInfo: " (1/2)", resultPreview: "", sessionLabel: "Session", sessionValue: "https://share/abc" },
		]);
		assert.equal(
			content,
			"Background tasks completed (2): **alpha**, **beta** (1/2)\n\n"
			+ "1. alpha\nalpha done\n\n"
			+ "2. beta (1/2)\n(no output)\nSession: https://share/abc",
		);
	});

	it("round-trips workflow correlation metadata", () => {
		const details = buildCompletionDetails({
			id: "workflow-2",
			runId: "workflow-2",
			mode: "workflow",
			agent: "workflow",
			success: false,
			state: "paused",
			summary: "Run 'review' detached for supervisor handoff.",
			reconciledFromDetachedChild: "child-2",
			results: [{ workflowKey: "review", agent: "reviewer", runId: "child-2", status: "paused" }],
		});

		assert.equal(details.status, "paused");
		assert.equal(details.workflowRunId, "workflow-2");
		assert.deepEqual(details.childRuns, [{ runId: "child-2", workflowKey: "review", agent: "reviewer", status: "paused" }]);
		assert.equal(details.reconciledFromDetachedChild, "child-2");
		const parsed = parseSubagentNotifyContent(formatSingleCompletion(details));
		assert.equal(parsed?.workflowRunId, "workflow-2");
		assert.deepEqual(parsed?.childRuns, [{ runId: "child-2", workflowKey: "review", status: "paused" }]);
		assert.equal(parsed?.reconciledFromDetachedChild, "child-2");
	});

	it("shows bounded child output paths and previews before workflow correlation metadata", () => {
		const details = buildCompletionDetails({
			id: "workflow-stopped",
			runId: "workflow-stopped",
			mode: "workflow",
			agent: "workflow",
			success: false,
			state: "stopped",
			summary: "Workflow stopped after one child completed.",
			results: [
				{
					workflowKey: "review",
					runId: "child-review",
					agent: "worker",
					success: true,
					outputState: "present",
					outputReference: "/tmp/review.md",
					artifactPaths: { outputPath: "/tmp/legacy-review-path" },
					output: `\u001b[31mReview heading\u001b[0m\n${"x".repeat(5_000)}`,
				},
				{
					workflowKey: "stopped",
					agent: "worker",
					stopped: true,
					outputState: "absent",
					artifactPaths: { outputPath: "/tmp/stopped.md" },
				},
			],
		});

		assert.equal(details.status, "stopped");
		assert.deepEqual(details.childOutputs?.map(({ workflowKey, runId, status, savedOutputPath }) => ({ workflowKey, runId, status, savedOutputPath })), [
			{ workflowKey: "review", runId: "child-review", status: "completed", savedOutputPath: "/tmp/review.md" },
			{ workflowKey: "stopped", runId: undefined, status: "stopped", savedOutputPath: undefined },
		]);
		assert.ok(Buffer.byteLength(details.childOutputs?.[0]?.preview ?? "", "utf8") <= 4 * 1024);

		const content = formatSingleCompletion(details);
		assert.match(content, /Child outputs:/);
		assert.match(content, /key=review run=child-review status=completed/);
		assert.match(content, /Saved output: \/tmp\/review\.md/);
		assert.match(content, /Review heading/);
		assert.doesNotMatch(content, /legacy-review-path/);
		assert.match(content, /preview truncated/);
		assert.match(content, /key=stopped run=unavailable status=stopped/);
		assert.match(content, /Saved output: unavailable/);
		assert.match(content, /Preview: unavailable \(no safe inline output\)/);
		assert.doesNotMatch(content, /\u001b/);
		assert.match(content, /Workflow run: workflow-stopped/);
		assert.match(content, /Child runs: review=child-review \(completed\), stopped=unavailable \(stopped\)/);

		const parsed = parseSubagentNotifyContent(content);
		assert.equal(parsed?.workflowRunId, "workflow-stopped");
		assert.match(parsed?.resultPreview ?? "", /Child outputs:/);
		assert.match(parsed?.resultPreview ?? "", /Review heading/);
		assert.doesNotMatch(parsed?.resultPreview ?? "", /Workflow run:/);
	});

	it("projects only verified producer paths and diagnoses truncated unbound output", () => {
		const root = mkdtempSync(join(tmpdir(), "notify-retrieval-"));
		try {
			const artifact = join(root, "artifact-é.txt");
			const structured = join(root, "output-\u001b[31m.json");
			const directory = join(root, "not-a-file");
			writeFileSync(artifact, "retained output");
			mkdirSync(directory);
			const details = buildCompletionDetails({
				id: "workflow-paths", runId: "workflow-paths", mode: "workflow", agent: "workflow", success: true,
				results: [
					{ workflowKey: "verified", runId: "child-1", success: true, output: "é".repeat(5_000), artifactPaths: { outputPath: artifact }, structuredOutput: { ok: true }, structuredOutputPath: structured },
					{ workflowKey: "missing", runId: "child-2", success: true, output: "x".repeat(5_000), artifactPaths: { outputPath: join(root, "missing.txt") }, structuredOutputPath: join(root, "missing.json") },
					{ workflowKey: "disabled", runId: "child-3", success: true, output: "short", artifactPaths: { outputPath: join(root, "disabled.txt") } },
					{ workflowKey: "binding-failed", runId: "child-4", success: true, output: "x".repeat(5_000), artifactPaths: { outputPath: artifact }, outputSaveError: "configured output-reference save failed" },
					{ workflowKey: "directory", runId: "child-5", success: true, output: "short", artifactPaths: { outputPath: directory }, structuredOutputPath: directory },
					{ workflowKey: "stopped", runId: "child-6", success: false, stopped: true, output: "x".repeat(5_000), artifactPaths: { outputPath: artifact }, structuredOutput: { stale: true }, structuredOutputPath: structured },
					{ workflowKey: "timed-out", runId: "child-7", success: false, timedOut: true, output: "x".repeat(5_000), artifactPaths: { outputPath: artifact }, structuredOutput: { stale: true }, structuredOutputPath: structured },
					{ workflowKey: "artifact-failed", runId: "child-8", success: true, output: "x".repeat(5_000), artifactPaths: { outputPath: artifact }, outputSaveError: "Artifact output post-processing failed", artifactOutputSaveFailed: true },
				],
			});
			assert.equal(details.childOutputs?.[0]?.savedOutputPath, undefined);
			assert.equal(details.childOutputs?.[0]?.outputArtifactPath, artifact);
			assert.equal(details.childOutputs?.[0]?.structuredOutputPath, structured);
			assert.equal(details.childOutputs?.[1]?.outputArtifactPath, undefined);
			assert.equal(details.childOutputs?.[1]?.structuredOutputPath, undefined);
			assert.equal(details.childOutputs?.[2]?.outputArtifactPath, undefined);
			assert.equal(details.childOutputs?.[3]?.outputArtifactPath, artifact);
			assert.equal(details.childOutputs?.[4]?.outputArtifactPath, undefined);
			assert.ok(details.childOutputs?.slice(5, 7).every((child) => child.outputArtifactPath === artifact && child.structuredOutputPath === undefined));
			assert.equal(details.childOutputs?.[7]?.outputArtifactPath, undefined);

			const content = formatSingleCompletion(details);
			assert.match(content, /Saved output: unavailable/);
			assert.match(content, /Output artifact \(retention-managed\): .*artifact-é\.txt/);
			assert.match(content, /Structured output \(retention-managed\): .*output-\[U\+001B\]\[31m\.json/);
			assert.doesNotMatch(content, /\u001b/);
			assert.doesNotMatch(content, /configured output-reference save failed|disabled\.txt|missing\.txt|not-a-file/);
			assert.equal(content.match(/Full output unavailable/g)?.length, 2);
			assert.equal(content.match(/Output artifact \(retention-managed\):/g)?.length, 4);
			for (const key of ["binding-failed", "stopped", "timed-out"]) {
				const block = content.split("\n- key=").find((part) => part.startsWith(`${key} `)) ?? "";
				assert.match(block, /Output artifact \(retention-managed\):/);
				assert.match(block, /preview truncated/);
				assert.doesNotMatch(block, /Full output unavailable/);
			}
			const failedArtifactBlock = content.split("\n- key=").find((part) => part.startsWith("artifact-failed ")) ?? "";
			assert.doesNotMatch(failedArtifactBlock, /Output artifact \(retention-managed\):/);
			assert.match(failedArtifactBlock, /Full output unavailable/);
			assert.ok(Buffer.byteLength(details.childOutputs?.[0]?.preview ?? "", "utf8") <= 4 * 1024);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps structured retrieval separate from launch bindings for large structured-only output", () => {
		const details = buildCompletionDetails({
			id: "workflow-structured", runId: "workflow-structured", mode: "workflow", agent: "workflow", success: true,
			results: [{ workflowKey: "structured", success: true, outputState: "absent", structuredOutput: { body: "é".repeat(5_000) }, structuredOutputPath: "/retained/output.json" }],
		});
		const content = formatSingleCompletion(details);
		assert.match(content, /Saved output: unavailable/);
		assert.match(content, /Structured output \(retention-managed\): \/retained\/output\.json/);
		assert.match(content, /Full output unavailable/);
		assert.match(content, /preview truncated/);
	});

	it("distinguishes unavailable retained paths from bounded verification errors", () => {
		const originalStatSync = fs.statSync;
		fs.statSync = ((path, ...args) => {
			const value = String(path);
			if (value.includes("missing")) throw Object.assign(new Error("missing"), { code: value.includes("not-dir") ? "ENOTDIR" : "ENOENT" });
			const match = value.match(/failure-(EACCES|EPERM|EIO|unknown)/);
			if (match) {
				const error = new Error(`cannot verify\n\u001b[31m${"é".repeat(800)}`) as NodeJS.ErrnoException;
				if (match[1] !== "unknown") error.code = match[1];
				throw error;
			}
			return originalStatSync(path, ...args);
		}) as typeof fs.statSync;
		syncBuiltinESMExports();
		try {
			for (const code of ["EACCES", "EPERM", "EIO", "unknown"]) {
				const artifactPath = `/failure-${code}/${"é".repeat(500)}`;
				const structuredPath = `/failure-${code}/structured`;
				const details = buildCompletionDetails({
					id: `workflow-${code}`, mode: "workflow", agent: "workflow", success: true,
					results: [
						{ workflowKey: "artifact", output: "short", artifactPaths: { outputPath: artifactPath } },
						{ workflowKey: "structured", output: "short", structuredOutputPath: structuredPath },
						{ workflowKey: "sibling", output: "short", structuredOutput: { ok: true }, structuredOutputPath: "/producer-confirmed" },
					],
				});
				const expectedCode = code === "unknown" ? undefined : code;
				assert.deepEqual(details.childOutputs?.[0]?.outputArtifactError, { path: artifactPath, ...(expectedCode ? { code: expectedCode } : {}), message: `cannot verify\n\u001b[31m${"é".repeat(800)}` });
				assert.deepEqual(details.childOutputs?.[1]?.structuredOutputError, { path: structuredPath, ...(expectedCode ? { code: expectedCode } : {}), message: `cannot verify\n\u001b[31m${"é".repeat(800)}` });
				assert.equal(details.childOutputs?.[2]?.structuredOutputPath, "/producer-confirmed");
				const content = formatSingleCompletion(details);
				assert.match(content, new RegExp(`Output artifact verification failed: stat ${expectedCode ?? "unknown"}`));
				assert.match(content, new RegExp(`Structured output verification failed: stat ${expectedCode ?? "unknown"}`));
				assert.doesNotMatch(content, /\u001b/);
				for (const line of content.split("\n").filter((line) => line.includes("verification failed"))) assert.ok(Buffer.byteLength(line, "utf8") < 1_024);
				assert.match(formatGroupedCompletion([details, { ...details, agent: "reviewer" }]), /verification failed/);
				assert.match(parseSubagentNotifyContent(content)?.resultPreview ?? "", /verification failed/);
			}

			const unavailable = buildCompletionDetails({ id: "workflow-missing", mode: "workflow", agent: "workflow", success: true, results: [
				{ workflowKey: "missing", output: "short", artifactPaths: { outputPath: "/missing/artifact" } },
				{ workflowKey: "not-dir", output: "short", structuredOutputPath: "/missing-not-dir/structured" },
			] });
			assert.ok(unavailable.childOutputs?.every((child) => !child.outputArtifactPath && !child.structuredOutputPath && !child.outputArtifactError && !child.structuredOutputError));
		} finally {
			fs.statSync = originalStatSync;
			syncBuiltinESMExports();
		}
	});

	it("formats sanitized async retrieval metadata in single and grouped notices", () => {
		const details = buildCompletionDetails({ agent: "worker", success: true, summary: "done", asyncDir: "/tmp/async\n\u001b[31mrun" });
		const single = formatSingleCompletion(details);
		assert.match(single, /Retention-managed async directory: \/tmp\/async\\n\[U\+001B\]\[31mrun/);
		assert.doesNotMatch(single, /\u001b/);
		assert.match(formatGroupedCompletion([details, { ...details, agent: "reviewer" }]), /2\. reviewer\n.*Retention-managed async directory:/s);
		const longLine = formatSingleCompletion({ ...details, asyncDir: `/tmp/${"é".repeat(2_000)}` }).split("\n").find((line) => line.startsWith("Retention-managed async directory:"));
		assert.ok(longLine);
		assert.ok(Buffer.byteLength(longLine, "utf8") <= Buffer.byteLength("Retention-managed async directory: ") + 1_024);
	});

	it("never promotes model-authored async directory lines to typed metadata", () => {
		const resultPreview = "before\nRetention-managed async directory: /fake/model/path\nafter";
		const withoutProducerPath = parseSubagentNotifyContent(formatSingleCompletion({ agent: "worker", status: "completed", resultPreview }));
		assert.equal(withoutProducerPath?.asyncDir, undefined);
		assert.equal(withoutProducerPath?.resultPreview, resultPreview);

		const withProducerPath = parseSubagentNotifyContent(formatSingleCompletion({ agent: "worker", status: "completed", resultPreview, asyncDir: "/real/producer/path" }));
		assert.equal(withProducerPath?.asyncDir, undefined);
		assert.equal(withProducerPath?.resultPreview, `${resultPreview}\n\nRetention-managed async directory: /real/producer/path`);
	});

	it("keeps retrieval metadata while limiting inline previews to eight children", () => {
		const childOutputs = Array.from({ length: 9 }, (_, index) => ({
			workflowKey: `child-${index}`, status: "completed", outputArtifactPath: `/artifact/${index}`, preview: `preview-${index}`,
			...(index === 8 ? { outputArtifactError: { path: "/failed\npath", code: "EACCES", message: "denied\u001b[31m" } } : {}),
		}));
		const content = formatSingleCompletion({ agent: "workflow", status: "completed", resultPreview: "done", childOutputs });
		assert.match(content, /key=child-7[\s\S]*preview-7/);
		assert.match(content, /key=child-8[\s\S]*Output artifact \(retention-managed\): \/artifact\/8[\s\S]*Preview: unavailable \(notice preview budget exceeded\)/);
		assert.match(content, /Output artifact verification failed: stat EACCES; path=\/failed\\npath; denied\[U\+001B\]\[31m/);
		assert.doesNotMatch(content, /preview-8/);
		assert.match(content, /1 additional child preview\(s\) omitted/);
	});

	it("reports false when Pi rejects sendMessage synchronously", async () => {
		const pi = { events: createEventBus(), sendMessage() { throw new Error("runtime inactive"); } };
		const notifier = registerSubagentNotify(pi as never, { currentSessionId: "session-a" }, { batchConfig: { enabled: false } });
		assert.equal(await notifier.deliver(completionResult({ id: "direct-rejected" })), false);
		notifier.dispose();
	});

	it("buildCompletionDetails derives paused and stopped statuses", () => {
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, state: "paused", summary: "Paused after interrupt.", timestamp: 1 }).status, "paused");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, interrupted: true, summary: "interrupted", timestamp: 1 }).status, "paused");
		const pausedWorkflow = buildCompletionDetails({ id: "workflow", agent: "workflow", mode: "workflow", state: "paused", results: [{ workflowKey: "failed", success: false }] });
		assert.equal(pausedWorkflow.childOutputs?.[0]?.status, "failed");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, summary: "boom", exitCode: 1, timestamp: 1 }).status, "failed");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, summary: "terminated", exitCode: 1, processSignal: "SIGTERM", timestamp: 1 }).status, "stopped");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, summary: "terminated", results: [{ success: false, exitCode: 1, processSignal: "SIGTERM" }], timestamp: 1 }).status, "stopped");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: true, summary: "ok", exitCode: 0, processSignal: "SIGTERM", timestamp: 1 }).status, "completed");
	});

	it("labels workflow completion and preserves its return/emit/trace preview", () => {
		const details = buildCompletionDetails({
			id: "workflow-run",
			agent: "workflow",
			success: true,
			summary: "Workflow completed with 1 child run(s). Return: { answer: 42 } Emitted: ready Trace: 2 event(s).",
			timestamp: 1,
		});
		assert.equal(details.agent, "workflow");
		assert.match(details.resultPreview, /Return: \{ answer: 42 \}.*Emitted: ready.*Trace: 2 event/);
	});

	it("buildCompletionDetails falls back to the unknown agent label", () => {
		const details: SubagentNotifyDetails = buildCompletionDetails({ id: "x", agent: null, success: true, summary: "ok", timestamp: 1 });
		assert.equal(details.agent, "unknown");
		assert.equal(details.status, "completed");
	});

	it("surfaces structured output in workflow previews and direct notices for degenerate text", () => {
		const summary = "Workflow completed with 1 child run(s). Return: { answer: 42 } Emitted: ready Trace: 2 event(s).";
		for (const output of ["</think>", " \n\t", " \n</think> \n"]) {
			const result = {
				id: "workflow-think-tag", agent: "workflow", success: true, summary,
				results: [{
					workflowKey: "review", runId: "child-review", agent: "delegate", success: true,
					outputState: "present" as const, outputReference: "/tmp/review.json", output, structuredOutput: false,
				}],
			};
			const details = buildCompletionDetails(result);
			const content = formatSingleCompletion(details);
			assert.equal(details.resultPreview, summary);
			assert.ok(content.includes(summary));
			assert.match(content, /key=review run=child-review status=completed/);
			assert.match(content, /Saved output: \/tmp\/review\.json/);
			assert.match(content, /Workflow run: workflow-think-tag/);
			assert.match(content, /Child runs: review=child-review \(completed\)/);
			assert.match(content, /    \| false/);
			const direct = buildCompletionDetails({ ...result, agent: "delegate", summary: `delegate:\n${output}` });
			assert.match(formatSingleCompletion(direct), /Structured output:\nfalse/);
		}
	});

	it("preserves meaningful prose and direct diagnostics alongside structured output", () => {
		const output = "Review complete </think> with notes.";
		const child = { agent: "delegate", success: true, output, structuredOutput: { ok: true } };
		const workflow = buildCompletionDetails({ id: "prose-run", agent: "workflow", success: true, results: [child] });
		assert.equal(workflow.childOutputs?.[0]?.preview, output);
		const direct = buildCompletionDetails({ id: "prose-run", agent: "delegate", success: true, summary: `delegate:\n${output}`, results: [child] });
		assert.equal(direct.resultPreview, `delegate:\n${output}`);
		const diagnostic = "delegate:\n</think>\nError: validation failed.";
		const failed = buildCompletionDetails({ id: "error-run", agent: "delegate", success: false, summary: diagnostic, results: [{ ...child, success: false, output: "</think>" }] });
		assert.equal(failed.resultPreview, diagnostic);
		assert.match(formatSingleCompletion(failed), /Background task failed/);
	});

	it("retains tag text when structured output is unavailable or unserializable", () => {
		for (const structuredOutput of [undefined, 1n]) {
			const child = { agent: "delegate", success: true, output: "</think>", structuredOutput };
			const workflow = buildCompletionDetails({ id: "fallback-run", agent: "workflow", success: true, results: [child] });
			assert.equal(workflow.childOutputs?.[0]?.preview, "</think>");
			const direct = buildCompletionDetails({ id: "fallback-run", agent: "delegate", success: true, summary: "delegate:\n</think>", results: [child] });
			assert.equal(direct.resultPreview, "delegate:\n</think>");
		}
	});

	it("surfaces direct structured output when the completion has no text output", () => {
		const details = buildCompletionDetails({
			id: "structured-run",
			agent: "delegate",
			success: true,
			summary: "delegate:\n(no output)",
			results: [{ agent: "delegate", output: "", structuredOutput: { payload: { ok: true } }, success: true }],
		});

		assert.match(details.resultPreview, /Structured output:/);
		assert.match(details.resultPreview, /"ok": true/);
		assert.match(formatSingleCompletion(details), /"ok": true/);
	});
});

describe("scheduled completions", () => {
	// A schedule fires with nobody watching, so its completion has to be visible to
	// the operator and attributable by the agent that receives it.
	const scheduledResult = {
		id: "run-1",
		source: "async" as const,
		agent: "workflow",
		success: true,
		summary: "Workflow completed with 1 child run(s).",
		scheduleOrigin: { id: "45daa203", name: "authz-facts-efficacy" },
	};

	it("carries the schedule origin from the result into the notice", () => {
		const details = buildCompletionDetails(scheduledResult);
		assert.deepEqual(details.scheduleOrigin, { id: "45daa203", name: "authz-facts-efficacy" });
		assert.match(formatSingleCompletion(details), /Scheduled run from \*\*authz-facts-efficacy\*\* \(schedule 45daa203\)\./);
	});

	it("round-trips the origin without absorbing it into the result preview", () => {
		const parsed = parseSubagentNotifyContent(formatSingleCompletion(buildCompletionDetails(scheduledResult)));
		assert.deepEqual(parsed?.scheduleOrigin, { id: "45daa203", name: "authz-facts-efficacy" });
		assert.equal(parsed?.resultPreview, "Workflow completed with 1 child run(s).");
	});

	it("keeps attribution when a scheduled run is batched with other completions", () => {
		const { scheduleOrigin: _origin, ...plain } = scheduledResult;
		const grouped = formatGroupedCompletion([buildCompletionDetails({ ...plain, agent: "worker" }), buildCompletionDetails(scheduledResult)]);
		assert.match(grouped, /2\. workflow — scheduled run from authz-facts-efficacy \(schedule 45daa203\)/);
		assert.doesNotMatch(grouped, /1\. worker —/);
	});

	it("keeps a quiet scheduled success visible without triggering a turn", async () => {
		const { notifier, sent } = createPi("session-a");
		const quiet = { ...scheduledResult, scheduleOrigin: { ...scheduledResult.scheduleOrigin, quiet: true }, sessionId: "session-a", completionOwnerId: COMPLETION_OWNER_ID };
		assert.equal(await notifier.deliver(quiet), true);
		assert.deepEqual(sent[0]!.options, { triggerTurn: false });
		assert.equal((sent[0]!.message as { display?: boolean }).display, true);
	});

	it("still wakes the session when a quiet scheduled run fails, stops, or pauses", async () => {
		const quietOrigin = { ...scheduledResult.scheduleOrigin, quiet: true };
		assert.equal(scheduledCompletionTriggersTurn({ id: "45daa203" }, "completed"), true);
		for (const outcome of ["failed", "stopped", "paused"] as const) {
			assert.equal(scheduledCompletionTriggersTurn(quietOrigin, outcome), true);
		}
		const failed = createPi("session-a");
		assert.equal(await failed.notifier.deliver({ ...scheduledResult, id: "run-failed", success: false, exitCode: 1, summary: "boom", scheduleOrigin: quietOrigin, sessionId: "session-a", completionOwnerId: COMPLETION_OWNER_ID }), true);
		assert.deepEqual(failed.sent[0]!.options, { triggerTurn: true });

		const stopped = createPi("session-a");
		assert.equal(await stopped.notifier.deliver({ ...scheduledResult, id: "run-stopped", success: false, stopped: true, scheduleOrigin: quietOrigin, sessionId: "session-a", completionOwnerId: COMPLETION_OWNER_ID }), true);
		assert.deepEqual(stopped.sent[0]!.options, { triggerTurn: true });
	});

	it("does not let quiet override an explicit triggerTurn:false", async () => {
		const { notifier, sent } = createPi("session-a");
		assert.equal(await notifier.deliver({ ...scheduledResult, success: false, exitCode: 1, triggerTurn: false, scheduleOrigin: { ...scheduledResult.scheduleOrigin, quiet: true }, sessionId: "session-a", completionOwnerId: COMPLETION_OWNER_ID }), true);
		assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	});

	it("leaves an ordinary successful completion without an origin", () => {
		const { scheduleOrigin: _origin, ...withoutSchedule } = scheduledResult;
		const parsed = parseSubagentNotifyContent(formatSingleCompletion(buildCompletionDetails(withoutSchedule)));
		assert.equal(parsed?.scheduleOrigin, undefined);
		assert.equal(parsed?.resultPreview, "Workflow completed with 1 child run(s).");
	});
});

describe("watchdog blockers in completion notices", () => {
	it("collects child blockers into details and round-trips them through the notice text", () => {
		const details = buildCompletionDetails({
			id: "run-1",
			agent: "workflow",
			mode: "workflow",
			runId: "run-1",
			success: false,
			summary: "worker:\nPatched billing.",
			exitCode: 1,
			results: [
				{
					runId: "child-1",
					agent: "worker",
					success: false,
					watchdog: {
						phase: "idle",
						seq: 3,
						lastUpdate: 1,
						warnings: [
							{ severity: "blocker", category: "test-gap", summary: "Claims tests passed without running them", evidence: "e", recommendedAction: "r", addressed: false, stalemate: false },
							{ severity: "concern", category: "other", summary: "Concern is not listed", evidence: "e", recommendedAction: "r", addressed: true, stalemate: false },
							{ severity: "blocker", category: "scope-drift", summary: "Kept editing after being told to stop", evidence: "e", recommendedAction: "r", addressed: false, stalemate: true },
						],
					},
				},
				{ runId: "child-2", agent: "reviewer", success: true, output: "clean" },
			],
			sessionId: "session-1",
		});

		assert.deepEqual(details.watchdogBlockers, [
			{ agent: "worker", summary: "Claims tests passed without running them", addressed: false, stalemate: false },
			{ agent: "worker", summary: "Kept editing after being told to stop", addressed: false, stalemate: true },
		]);

		const content = formatSingleCompletion(details);
		assert.match(content, /\nWatchdog blockers:\n- worker: Claims tests passed without running them \(unaddressed\)\n- worker: Kept editing after being told to stop \(stalemate\)\n/);
		const parsed = parseSubagentNotifyContent(content);
		assert.deepEqual(parsed?.watchdogBlockers, details.watchdogBlockers);
		assert.match(parsed?.resultPreview ?? "", /^worker:\nPatched billing\./);
		assert.doesNotMatch(parsed?.resultPreview ?? "", /Watchdog blockers/);
		assert.equal(parsed?.workflowRunId, "run-1");

		const grouped = formatGroupedCompletion([details, { agent: "scout", status: "completed", resultPreview: "ok" }]);
		assert.match(grouped, /Watchdog blockers:\n- worker: Claims tests passed without running them \(unaddressed\)/);
		assert.equal(grouped.split("Watchdog blockers:").length, 2);

	});
});
