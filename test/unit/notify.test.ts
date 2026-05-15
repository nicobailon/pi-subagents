import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STEP_COMPLETE_EVENT, type BackgroundForkHandlersConfig } from "../../src/shared/types.ts";
import { createMockPi } from "../support/mock-pi.ts";

function createPi(backgroundForkHandlers: BackgroundForkHandlersConfig = { enabled: false }, getParentSessionFile?: () => string | null | undefined) {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};

	registerSubagentNotify(pi as never, backgroundForkHandlers, getParentSessionFile);

	return { events, sent };
}

async function waitForSent(sent: unknown[], count: number, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (sent.length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${count} sent messages; saw ${sent.length}`);
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
		assert.equal((sent[0] as any).message.customType, "subagent-notify");
		assert.equal((sent[0] as any).message.content, "Background task completed: **worker**\n\n(no output)");
		assert.deepEqual((sent[0] as any).options, { triggerTurn: false });
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
		assert.equal((sent[0] as any).message.customType, "subagent-notify");
		assert.equal((sent[0] as any).message.content, `Background task completed: **worker** (2/3)\n\n${summary}`);
		assert.deepEqual((sent[0] as any).options, { triggerTurn: false });
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

		assert.equal(sent.length, 1);
		assert.equal((sent[0] as any).message.customType, "subagent-notify");
		assert.equal((sent[0] as any).message.content, "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl");
		assert.deepEqual((sent[0] as any).options, { triggerTurn: false });
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
		assert.equal((sent[0] as any).message.customType, "subagent-notify");
		assert.equal((sent[0] as any).message.content, "Background task paused: **worker**\n\nPaused after interrupt. Waiting for explicit next action.");
		assert.deepEqual((sent[0] as any).options, { triggerTurn: false });
	});

	it("sends per-step notifications through explicit inline opt-out", () => {
		const { events, sent } = createPi({ enabled: false });

		events.emit(SUBAGENT_ASYNC_STEP_COMPLETE_EVENT, {
			id: "async-run-1",
			runId: "async-run-1",
			agent: "reviewer",
			index: 1,
			totalTasks: 4,
			success: true,
			exitCode: 0,
			summary: "Reviewed and found no blockers.",
			durationMs: 1200,
			sessionFile: "/tmp/reviewer.jsonl",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background step completed: **reviewer** (2/4)\n\nReviewed and found no blockers.\n\nSession file: /tmp/reviewer.jsonl",
				display: true,
				details: {
					agent: "reviewer",
					status: "completed",
					taskInfo: " (2/4)",
					resultPreview: "Reviewed and found no blockers.",
					durationMs: 1200,
					sessionLabel: "session file",
					sessionValue: "/tmp/reviewer.jsonl",
				},
			},
			options: { triggerTurn: false },
		});
	});

	it("uses non-triggering fallback when a fork handler launch fails", async () => {
		const { events, sent } = createPi({ enabled: true, piCommand: "/definitely/missing/pi-subagents-handler" });

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-fork-fail-1",
			agent: "worker",
			success: true,
			summary: "Done after failed fork",
			exitCode: 0,
			timestamp: 456,
		});

		await waitForSent(sent, 1);
		assert.equal((sent[0] as any).message.customType, "subagent-notify");
		assert.equal((sent[0] as any).message.content, "Background task completed: **worker**\n\nDone after failed fork");
		assert.deepEqual((sent[0] as any).options, { triggerTurn: false });
	});

	it("forks background completions by default without triggering the main feed", async () => {
		const mockPi = createMockPi();
		mockPi.install();
		mockPi.onCall({ output: "completion handled in fork" });
		try {
			const parentSessionFile = "/tmp/parent-session.jsonl";
			const { events, sent } = createPi({ enabled: true }, () => parentSessionFile);
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: "notify-fork-1",
				agent: "worker",
				success: true,
				summary: "Done",
				exitCode: 0,
				timestamp: 456,
			});

			await waitForSent(sent, 2);
			assert.equal(sent.some((entry) => (entry as any).options?.triggerTurn === true), false);
			assert.equal((sent[0] as any).message.customType, "subagent-fork-handler");
			assert.equal((sent[0] as any).message.details.status, "running");
			assert.equal((sent[1] as any).message.details.status, "complete");
			assert.match((sent[1] as any).message.content, /completion handled in fork/);
			const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
			assert.ok(callFile, "mock pi was not called");
			const call = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf8"));
			const forkIndex = call.args.indexOf("--fork");
			assert.notEqual(forkIndex, -1);
			assert.equal(call.args[forkIndex + 1], parentSessionFile);
		} finally {
			mockPi.uninstall();
		}
	});

	it("forks per-step background completions by default without triggering the main feed", async () => {
		const mockPi = createMockPi();
		mockPi.install();
		mockPi.onCall({ output: "step handled in fork" });
		try {
			const { events, sent } = createPi({ enabled: true });
			events.emit(SUBAGENT_ASYNC_STEP_COMPLETE_EVENT, {
				id: "async-run-2",
				runId: "async-run-2",
				agent: "reviewer",
				index: 0,
				totalTasks: 2,
				success: true,
				exitCode: 0,
				summary: "Reviewed.",
				durationMs: 1200,
			});

			await waitForSent(sent, 2);
			assert.equal(sent.some((entry) => (entry as any).options?.triggerTurn === true), false);
			assert.equal((sent[0] as any).message.customType, "subagent-fork-handler");
			assert.equal((sent[1] as any).message.details.status, "complete");
			assert.match((sent[1] as any).message.content, /step handled in fork/);
		} finally {
			mockPi.uninstall();
		}
	});
});
