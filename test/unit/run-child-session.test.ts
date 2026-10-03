import assert from "node:assert/strict";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { makeAgentConfigs } from "../support/helpers.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const launch = { session: {
	cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
	hooks: [], noSkills: true, noContextFiles: true,
	runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } },
} } as InProcessChildLaunch;

// Without the abort backstop this run never settles, so bound the test instead of hanging the suite.
it("settles a timed-out run whose session creation never returns, and contains late disposal rejection", { timeout: 10_000 }, async () => {
	let releaseCreate!: (session: ChildSession) => void;
	const createBlocked = new Promise<ChildSession>((resolve) => { releaseCreate = resolve; });
	let timeout: (() => void) | undefined;
	let prompted = false;
	let disposeAttempted = false;
	const session: ChildSession = {
		subscribe() { return () => {}; },
		async prompt() { prompted = true; },
		async steer() {}, async followUp() {}, async abort() {},
		async dispose() {
			disposeAttempted = true;
			throw new Error("late disposal failed");
		},
		messages: [], sessionId: "late-session", modelId: "mock/model",
	};
	const factory: ChildSessionFactory = { create: () => createBlocked, async dispose() {} };
	const run = runChildSession({
		factory,
		launch,
		prompt: "never starts",
		timeoutMessage: "Subagent timed out after 1ms.",
		appendChildEvent() {}, writeOutputLine() {},
		registerTimeout(handler) { timeout = handler; },
	});
	assert.ok(timeout, "runChildSession must register its timeout handler before the session exists");
	timeout();
	const result = await run;
	assert.equal(result.timedOut, true);
	assert.equal(result.exitCode, 1);
	assert.equal(result.error, "Subagent timed out after 1ms.");

	releaseCreate(session);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(disposeAttempted, true);
	assert.equal(prompted, false);
});

it("reports the created child's context window before prompting", { timeout: 10_000 }, async () => {
	const reported: number[] = [];
	let timeout: (() => void) | undefined;
	let promptedAfterReport = false;
	const session: ChildSession = {
		subscribe() { return () => {}; },
		async prompt() { promptedAfterReport = reported.length === 1; timeout?.(); },
		async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
		messages: [], sessionId: "window-session", modelId: "openai-codex/gpt-6-sol", contextWindow: 1_050_000,
	};
	const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
	await runChildSession({
		factory,
		launch,
		prompt: "report window",
		timeoutMessage: "done",
		appendChildEvent() {}, writeOutputLine() {},
		registerTimeout(handler) { timeout = handler; },
		onContextWindow: (contextWindow) => { reported.push(contextWindow); },
	});
	assert.deepEqual(reported, [1_050_000]);
	assert.equal(promptedAfterReport, true);
});


for (const mode of ["foreground", "background"] as const) {
	it(`rejects unfinished commands at authoritative ${mode} settlement and still disposes the child`, async () => {
		let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
		let prompted = false;
		let finalized = 0;
		let disposed = false;
		const messages = [];
		const session: ChildSession = {
			subscribe(handler) { listener = handler; return () => {}; },
			async prompt() {
				const message = fauxAssistantMessage("Done");
				messages.push(message);
				listener({ type: "message_end", message });
				listener({ type: "agent_end", messages });
				listener({ type: "agent_settled" });
				prompted = true;
			},
			async finishCommands() {
				assert.equal(prompted, true);
				finalized++;
				throw new Error("Child finished with unfinished commands: service. Commands were cancelled.");
			},
			async steer() {}, async followUp() {}, async abort() {}, async dispose() { disposed = true; },
			messages, sessionId: "command-settlement-session", modelId: "mock/model",
		};
		const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
		const result = mode === "foreground"
			? await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Finish", { childSessionFactory: factory })
			: await runChildSession({ factory, launch, prompt: "Finish", timeoutMessage: "timed out", appendChildEvent() {}, writeOutputLine() {} });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /unfinished commands: service/);
		assert.equal(finalized, 1);
		assert.equal(disposed, true);
	});
}

it("verifies a virtual-model child against its selection and keeps the dispatched model", { timeout: 10_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] | undefined;
	const session: ChildSession = {
		subscribe(next) { listener = next; return () => {}; },
		async prompt() {
			listener?.({ type: "message_end", message: { ...fauxAssistantMessage("done"), model: "gpt-6.1-sol" } });
		},
		async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
		messages: [], sessionId: "virtual-session", modelId: "router/auto", virtualModelId: "router/auto",
	};
	const result = await runChildSession({
		factory: { create: async () => session, async dispose() {} },
		launch,
		prompt: "route",
		appendChildEvent() {}, writeOutputLine() {},
		expectedModelForVerification: "router/auto:medium",
		modelVerificationRegistry: [{ provider: "router", id: "auto", fullId: "router/auto" }],
	});
	assert.equal(result.error, undefined);
	assert.equal(result.exitCode, 0);
	assert.equal(result.model, "gpt-6.1-sol");
});

// Unfinished streamed text recovered on timeout or a thrown session error.
type PartialScenario = "timeout" | "child error" | "completed reply" | "provider error" | "recovered tool call";

async function runPartialScenario(mode: "foreground" | "background", scenario: PartialScenario) {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	let timeout: (() => void) | undefined;
	let releasePrompt!: () => void;
	const hung = new Promise<void>((resolve) => { releasePrompt = resolve; });
	const messages: ChildSession["messages"] = [];
	const streaming = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			listener({ type: "message_update", message: streaming("half a th"), assistantMessageEvent: { type: "text_delta", delta: "half a th" } });
			listener({ type: "message_update", message: streaming("half a thought"), assistantMessageEvent: { type: "text_delta", delta: "ought" } });
			if (scenario === "completed reply") {
				const message = fauxAssistantMessage("half a thought, finished");
				messages.push(message);
				listener({ type: "message_end", message });
			}
			if (scenario === "provider error") {
				const message = { ...fauxAssistantMessage("text before the provider error"), stopReason: "error", errorMessage: "overloaded" };
				messages.push(message);
				listener({ type: "message_end", message });
				throw new Error("overloaded");
			}
			if (scenario === "recovered tool call") {
				// A retried provider error whose recovered reply only calls a tool, which then outlives the timeout.
				const failed = { ...fauxAssistantMessage("stale failed attempt"), stopReason: "error", errorMessage: "overloaded" };
				const toolOnly = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 100" } }], stopReason: "toolUse" };
				messages.push(failed, toolOnly);
				listener({ type: "message_end", message: failed });
				listener({ type: "message_end", message: toolOnly });
				listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep 100" } });
			}
			if (scenario === "child error") throw new Error("session blew up");
			if (mode === "background") timeout?.();
			await hung;
		},
		async steer() {}, async followUp() {}, async abort() { releasePrompt(); }, async dispose() {},
		messages, sessionId: "partial-session", modelId: "mock/model",
	};
	const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
	return mode === "foreground"
		? runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Finish", { childSessionFactory: factory, timeoutMs: 100 })
		: runChildSession({
			factory, launch, prompt: "Finish", timeoutMessage: "Subagent timed out.",
			appendChildEvent() {}, writeOutputLine() {},
			registerTimeout(handler) { timeout = handler; },
		});
}

for (const mode of ["foreground", "background"] as const) {
	it(`${mode}: returns unfinished streamed text as flagged partial output on timeout`, { timeout: 10_000 }, async () => {
		const result = await runPartialScenario(mode, "timeout");
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, 1);
		assert.equal(result.outputState, "present");
		assert.equal(result.outputPartial, true);
		assert.match(result.finalOutput ?? "", /Partial output before timeout:\nhalf a thought$/);
	});

	it(`${mode}: returns unfinished streamed text as flagged partial output on a thrown session error`, { timeout: 10_000 }, async () => {
		const result = await runPartialScenario(mode, "child error");
		assert.equal(result.exitCode, 1);
		assert.equal(result.outputPartial, true);
		assert.equal(result.finalOutput, "Partial output before child error:\nhalf a thought");
		assert.match(result.error ?? "", /session blew up/);
	});

	it(`${mode}: keeps the text of a failed provider message as partial output`, { timeout: 10_000 }, async () => {
		const result = await runPartialScenario(mode, "provider error");
		assert.equal(result.exitCode, 1);
		assert.equal(result.outputPartial, true);
		assert.equal(result.finalOutput, "Partial output before child error:\ntext before the provider error");
	});

	it(`${mode}: does not return a failed attempt's text after a completed tool-only reply`, { timeout: 10_000 }, async () => {
		const result = await runPartialScenario(mode, "recovered tool call");
		assert.equal(result.timedOut, true);
		assert.equal(result.outputPartial, undefined);
		assert.doesNotMatch(result.finalOutput ?? "", /stale failed attempt/);
	});

	it(`${mode}: never marks a completed reply as partial`, { timeout: 10_000 }, async () => {
		const result = await runPartialScenario(mode, "completed reply");
		assert.equal(result.timedOut, true);
		assert.equal(result.outputPartial, undefined);
		assert.doesNotMatch(result.finalOutput ?? "", /Partial output before child error/);
		assert.match(result.finalOutput ?? "", /half a thought, finished/);
	});
}
