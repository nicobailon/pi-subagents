import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify, {
	buildCompletionDetails,
	formatGroupedCompletion,
	formatSingleCompletion,
	type RegisterSubagentNotifyOptions,
	type SubagentNotifyDetails,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

function createPi(registerOptions: RegisterSubagentNotifyOptions = {}) {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};

	// Formatting-focused tests run with batching disabled so single completions
	// emit synchronously. Batching behavior is covered by the dedicated suite below.
	registerSubagentNotify(pi as never, { batchConfig: { enabled: false }, ...registerOptions });

	return { events, sent };
}

function createBatchingPi(clock: ReturnType<typeof createFakeClock>) {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	registerSubagentNotify(pi as never, {
		batchConfig: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 },
		timers: clock.api,
		now: clock.now,
	});
	return { events, sent };
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
		...overrides,
	};
}

describe("registerSubagentNotify", () => {
	it("uses a fallback summary when a background completion is empty", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-empty-1",
			agent: "worker",
			success: true,
			summary: "",
			exitCode: 0,
			timestamp: 123,
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\n(no output)",
				display: true,
			},
			options: { triggerTurn: true },
		});
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
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: `Background task completed: **worker** (2/3)\n\n${summary}`,
				display: true,
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
		});

		assert.deepEqual(sent, [{
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl",
				display: true,
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

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-1", agent: "alpha", summary: "alpha done" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-2", agent: "beta", summary: "beta done" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-3", agent: "gamma", summary: "gamma done" }));
		assert.equal(sent.length, 0);

		clock.advance(150);
		assert.equal(sent.length, 1);
		const content = (sent[0]!.message as { content: string }).content;
		assert.match(content, /^Background tasks completed \(3\): \*\*alpha\*\*, \*\*beta\*\*, \*\*gamma\*\*/);
		assert.match(content, /1\. alpha\nalpha done/);
		assert.match(content, /3\. gamma\ngamma done/);
		assert.deepEqual(sent[0]!.options, { triggerTurn: true });
	});
});

describe("completion formatting helpers", () => {
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

	it("buildCompletionDetails derives paused status from state and summary", () => {
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, state: "paused", summary: "Paused after interrupt.", timestamp: 1 }).status, "paused");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, summary: "boom", exitCode: 1, timestamp: 1 }).status, "failed");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: true, summary: "ok", exitCode: 0, timestamp: 1 }).status, "completed");
	});

	it("buildCompletionDetails falls back to the unknown agent label", () => {
		const details: SubagentNotifyDetails = buildCompletionDetails({ id: "x", agent: null, success: true, summary: "ok", timestamp: 1 });
		assert.equal(details.agent, "unknown");
		assert.equal(details.status, "completed");
	});
});
