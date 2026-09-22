import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerChildWatchdog } from "../../src/watchdog/register-child.ts";
import type { WatchdogReviewFunction } from "../../src/watchdog/runtime.ts";

function warning() {
	return {
		severity: "blocker" as const,
		importance: "high" as const,
		summary: "Independent blocker",
		evidence: "A real failure remains after structured capture.",
		recommendedAction: "Fix the failure.",
		source: "child" as const,
	};
}

describe("child watchdog registration", () => {
	it("records a late real blocker without triggering a turn after agent settlement", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: { cwd: string }) => unknown>>();
		const sent: unknown[] = [];
		const appended: unknown[] = [];
		const statuses: unknown[] = [];
		const pi = {
			on(event: string, handler: (event: unknown, ctx: { cwd: string }) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage(message: unknown) { sent.push(message); },
			appendEntry(type: unknown, details: unknown) { appended.push({ type, details }); },
			getThinkingLevel() { return "off"; },
		};
		const terminalState = { captured: true };
		const runtime = registerChildWatchdog(pi as never, {
			agentEndTimeoutMs: 1_000,
			maxWarnings: 3,
			stalemateRepeats: 2,
			watchdogTailTimeoutMs: 1_000,
			cadence: { everyNTools: null },
			lsp: { enabled: false, timeoutMs: 1_000, maxFiles: 10, maxDiagnostics: 10 },
		}, (event) => statuses.push(event), terminalState)!;
		let changeKey = "baseline";
		let reviewStarted!: () => void;
		let releaseReview!: () => void;
		const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
		const review: WatchdogReviewFunction = async (request) => {
			reviewStarted();
			await new Promise<void>((resolve) => { releaseReview = resolve; });
			request.emitWarning(warning());
			return { stopReason: "stop" };
		};
		Object.defineProperty(runtime, "review", { value: review });
		Object.defineProperty(runtime, "repoChangeSignature", { value: () => ({ root: "/tmp", key: changeKey, changedPaths: ["src/file.ts"] }) });
		const ctx = { cwd: "/tmp" };
		const emit = async (event: string, payload: unknown = {}) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		};

		await emit("session_start");
		await emit("before_agent_start", { prompt: "Complete the task." });
		await emit("turn_end", { type: "turn_end", message: { role: "assistant", content: [], stopReason: "stop" }, toolResults: [] });
		changeKey = "changed";
		const ending = emit("agent_end");
		await started;
		await emit("agent_settled");
		releaseReview();
		await ending;

		assert.equal(sent.length, 0, "settled child must not receive a turn-triggering warning");
		assert.equal(appended.length, 1, "the real blocker remains visible as a status-only entry");
		assert.deepEqual((appended[0] as { details?: { severity?: string; summary?: string } }).details && {
			severity: (appended[0] as { details: { severity: string } }).details.severity,
			summary: (appended[0] as { details: { summary: string } }).details.summary,
		}, { severity: "blocker", summary: "Independent blocker" });
		assert.ok(statuses.some((event) => {
			const status = event as { phase?: string; warning?: { severity?: string; summary?: string } };
			return status.phase === "reviewing" && status.warning?.severity === "blocker" && status.warning.summary === "Independent blocker";
		}), "the status sink must retain the late blocker evidence");
		runtime.dispose();
	});
});
