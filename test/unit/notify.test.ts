import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

function createPi(currentSessionId = "session-1") {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};

	registerSubagentNotify(pi as never, { currentSessionId });

	return { events, sent };
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
			sessionId: "session-1",
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
			sessionId: "session-1",
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
			sessionId: "session-1",
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
			sessionId: "session-1",
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
});
