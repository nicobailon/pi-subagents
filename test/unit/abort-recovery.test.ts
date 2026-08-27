import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { ABORT_RECOVERY_PROMPT, planAbortRecovery } from "../../src/runs/shared/abort-recovery.ts";

function messages(...entries: unknown[]): Message[] {
	return entries as Message[];
}

const progress = {
	role: "assistant",
	content: [{ type: "text", text: "Implemented the helper and running validation." }],
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
};
const aborted = {
	role: "assistant",
	content: [],
	stopReason: "aborted",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
};

function base(overrides: Partial<Parameters<typeof planAbortRecovery>[0]> = {}) {
	return {
		messages: messages(progress, aborted),
		processSignal: undefined,
		sessionAvailable: true,
		alreadyResumed: false,
		...overrides,
	};
}

describe("planAbortRecovery", () => {
	it("does not recover an abort without verified compaction settlement", () => {
		assert.deepEqual(planAbortRecovery(base()), { action: "settle", reason: "compaction settlement not verified" });
	});

	it("plans the same retained-session continuation for a compaction-induced abort", () => {
		assert.deepEqual(planAbortRecovery(base({ afterCompactionSettlement: true, processSignal: "SIGTERM" })), { action: "resume", prompt: ABORT_RECOVERY_PROMPT });
	});

	it("accepts a completed tool result as useful progress", () => {
		const toolProgress = messages(
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }], usage: { output: 1 } },
			{ role: "toolResult", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "tests passed" }] },
			aborted,
		);
		assert.equal(planAbortRecovery(base({ messages: toolProgress, afterCompactionSettlement: true })).action, "resume");
	});

	it("fails closed without progress, a retained session, or a first-attempt permit", () => {
		assert.equal(planAbortRecovery(base({ messages: messages(aborted) })).action, "settle");
		assert.equal(planAbortRecovery(base({ sessionAvailable: false })).action, "settle");
		assert.equal(planAbortRecovery(base({ alreadyResumed: true })).action, "settle");
	});

	it("does not reinterpret an ordinary empty completion as an abort", () => {
		const emptyStop = { ...aborted, stopReason: "stop" };
		assert.equal(planAbortRecovery(base({ messages: messages(progress, emptyStop), processSignal: undefined })).action, "settle");
	});

	it("does not treat a process signal alone as provider abort evidence", () => {
		const emptyStop = { ...aborted, stopReason: "stop" };
		assert.equal(planAbortRecovery(base({ messages: messages(progress, emptyStop), processSignal: "SIGKILL" })).action, "settle");
	});

	it("does not resume when a process signal accompanies abort evidence", () => {
		assert.deepEqual(planAbortRecovery(base({ processSignal: "SIGTERM" })), { action: "settle", reason: "process terminated by signal" });
		assert.deepEqual(planAbortRecovery(base({
			messages: messages(progress),
			error: "Connection reset by provider transport",
			processSignal: "SIGKILL",
		})), { action: "settle", reason: "process terminated by signal" });
	});

	it("excludes operator control, timeouts, budgets, schema and acceptance failures", () => {
		for (const excluded of [
			{ stopped: true },
			{ interrupted: true },
			{ timedOut: true },
			{ toolBudgetExhausted: true },
			{ usageBudgetExhausted: true },
			{ structuredOutputFailed: true },
			{ acceptanceFailed: true },
		]) {
			assert.equal(planAbortRecovery(base(excluded)).action, "settle");
		}
	});

	it("fails closed while a tool call is unresolved", () => {
		const inFlight = messages(
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }], usage: { output: 1 } },
			aborted,
		);
		assert.deepEqual(planAbortRecovery(base({ messages: inFlight, currentTool: "bash" })), { action: "settle", reason: "active tool 'bash' remains in flight" });
		assert.deepEqual(planAbortRecovery(base({ messages: inFlight, currentTool: undefined })), { action: "settle", reason: "unresolved tool call remains in transcript" });
	});

	it("names the exact blocker when compaction abort recovery is unsafe", () => {
		assert.deepEqual(planAbortRecovery(base({ sessionAvailable: false, afterCompactionSettlement: true })), {
			action: "settle",
			reason: "retained session unavailable",
			diagnostic: "Compaction-induced child abort could not be resumed safely: retained session unavailable.",
		});
		assert.deepEqual(planAbortRecovery(base({ currentTool: "bash", afterCompactionSettlement: true })), {
			action: "settle",
			reason: "active tool 'bash' remains in flight",
			diagnostic: "Compaction-induced child abort could not be resumed safely: active tool 'bash' remains in flight.",
		});
	});

	it("requires terminal assistant abort evidence for compaction recovery", () => {
		assert.deepEqual(planAbortRecovery(base({
			messages: messages(progress),
			processSignal: undefined,
			error: "Connection reset by provider transport",
		})), { action: "settle", reason: "compaction settlement not verified" });
		assert.deepEqual(planAbortRecovery(base({
			messages: messages(progress),
			processSignal: undefined,
			error: "Connection reset by provider transport",
			afterCompactionSettlement: true,
		})), { action: "settle", reason: "terminal assistant abort evidence not verified" });
		assert.equal(planAbortRecovery(base({
			messages: messages(progress, { ...aborted, stopReason: "error", errorMessage: "This operation was aborted" }),
			processSignal: undefined,
			error: "This operation was aborted",
			afterCompactionSettlement: true,
		})).action, "resume");
	});

	it("does not recover a generic transport abort after a normally settled compaction", () => {
		const settled = {
			role: "assistant",
			content: [{ type: "text", text: "Compaction completed and the child settled normally." }],
			stopReason: "stop",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		};
		assert.deepEqual(planAbortRecovery(base({
			messages: messages(progress, settled),
			error: "Connection reset by provider transport",
			afterCompactionSettlement: true,
		})), { action: "settle", reason: "terminal assistant abort evidence not verified" });
	});

	it("does not reinterpret a network-flavored task tool failure as a provider abort", () => {
		assert.equal(planAbortRecovery(base({
			messages: messages(progress),
			processSignal: undefined,
			error: "bash failed (exit 1): request connection error",
		})).action, "settle");
	});
});
