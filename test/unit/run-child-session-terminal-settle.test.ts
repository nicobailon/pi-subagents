import assert from "node:assert/strict";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const launch = { capture: { finalDrainHeld: () => false }, session: {
	cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
	hooks: [], noSkills: true, noContextFiles: true,
	runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } },
} } as InProcessChildLaunch;

// A child that stops after its terminal assistant message emits `agent_end` but Pi may
// never follow it with `agent_settled`; the run still has to settle and publish its reply.
it("settles and keeps the reply when the child ends on agent_end without agent_settled", { timeout: 10_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	const messages: ChildSession["messages"] = [];
	let releasePrompt!: () => void;
	let aborted = false;
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			const message = fauxAssistantMessage("Done");
			messages.push(message);
			listener({ type: "agent_start" });
			listener({ type: "message_end", message });
			listener({ type: "turn_end" });
			listener({ type: "agent_end", messages });
			// The real child resolves this only once its agent loop is settled or aborted.
			return new Promise<void>((resolve) => { releasePrompt = resolve; });
		},
		async steer() {}, async followUp() {}, async dispose() {},
		async abort() {
			aborted = true;
			listener({ type: "agent_settled" });
			releasePrompt();
		},
		messages, sessionId: "terminal-agent-end-session", modelId: "mock/model",
	};
	const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
	const result = await runChildSession({
		factory, launch, prompt: "Finish",
		timeoutMessage: "timed out", appendChildEvent() {}, writeOutputLine() {},
	});
	assert.equal(result.error, undefined, "a clean terminal stop must not be reported as a settle timeout");
	assert.equal(result.exitCode, 0);
	assert.equal(result.finalOutput, "Done");
	assert.equal(aborted, true, "the re-armed drain must abort the child so its loop can end");
});

// Pi's order after a final reply: agent_end, then a threshold auto-compaction (a model call that
// can take seconds), then agent_settled. Ending the run early would cancel the compaction.
it("lets a compaction that runs after the final agent_end finish", { timeout: 10_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	const messages: ChildSession["messages"] = [];
	let aborted = false;
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			const message = fauxAssistantMessage("Done");
			messages.push(message);
			listener({ type: "agent_start" });
			listener({ type: "message_end", message });
			listener({ type: "turn_end" });
			listener({ type: "agent_end", messages, willRetry: false });
			listener({ type: "compaction_start", reason: "threshold" });
			await new Promise((resolve) => setTimeout(resolve, 2500));
			listener({ type: "compaction_end", reason: "threshold", willRetry: false, aborted });
			listener({ type: "agent_settled" });
		},
		async steer() {}, async followUp() {}, async dispose() {},
		async abort() { aborted = true; },
		messages, sessionId: "compaction-after-final-session", modelId: "mock/model",
	};
	const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
	const result = await runChildSession({
		factory, launch, prompt: "Finish",
		timeoutMessage: "timed out", appendChildEvent() {}, writeOutputLine() {},
	});
	assert.equal(result.finalOutput, "Done");
	assert.equal(aborted, false, "the child must not be aborted while it compacts");
});
