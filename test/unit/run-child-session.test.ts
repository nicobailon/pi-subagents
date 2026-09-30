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
		let listener: (event: any) => void = () => {};
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
