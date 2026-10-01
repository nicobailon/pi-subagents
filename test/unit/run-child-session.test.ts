import assert from "node:assert/strict";
import { it } from "node:test";
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

it("verifies a virtual-model child against its selection and keeps the dispatched model", { timeout: 10_000 }, async () => {
	let listener: ((event: never) => void) | undefined;
	const session: ChildSession = {
		subscribe(next) { listener = next as typeof listener; return () => {}; },
		async prompt() {
			listener?.({ type: "message_end", message: { role: "assistant", model: "gpt-6.1-sol", stopReason: "stop", content: [{ type: "text", text: "done" }] } } as never);
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
