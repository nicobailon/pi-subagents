import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import registerSubagentExtension from "../../src/extension/index.ts";
import { compactionInterruptedRun, installCompactionInterruptionCapture, takeCompactionAbort } from "../../src/extension/compaction-interruption.ts";
import { currentCompletionOwnerId } from "../../src/shared/completion-owner.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";

it("wraps compact() once and keeps an interruption across overlapping calls", async () => {
	const releases: (() => void)[] = [];
	class Session {
		isStreaming = true;
		sessionManager = {};
		async compact() { this.isStreaming = false; await new Promise<void>((resolve) => { releases.push(resolve); }); }
	}
	installCompactionInterruptionCapture(Session);
	const wrapped = Session.prototype.compact;
	installCompactionInterruptionCapture(Session);
	assert.equal(Session.prototype.compact, wrapped);

	const session = new Session();
	const interrupting = session.compact();
	const idle = session.compact();
	assert.equal(takeCompactionAbort(session.sessionManager), true);
	assert.equal(takeCompactionAbort(session.sessionManager), false);
	releases.pop()!();
	await idle;
	assert.equal(compactionInterruptedRun(session.sessionManager), true, "the idle call does not erase the interruption");
	releases.pop()!();
	await interrupting;
	assert.equal(compactionInterruptedRun(session.sessionManager), false);
});

type Scenario = {
	/** How the first run ends: an extension's ctx.compact() mid-run, Esc mid-run, or on its own. */
	stop: "compact" | "abort" | "none";
	/** A checkpoint extension's ctx.compact() from agent_settled. */
	checkpoint?: "settled" | "aborted-settled";
	compactAfter?: boolean;
	cancelFirstCompaction?: boolean;
	onCompactFailed?: (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => Promise<void>;
};

async function runParent(scenario: Scenario) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compaction-interruption-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const sessionManager = SessionManager.inMemory(root);
	const sessionId = sessionManager.getSessionId();
	const faux = fauxProvider({ provider: "compaction-interruption", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	// The test's prompts call the slow tool; notices are answered at once.
	faux.setResponses(Array.from({ length: 8 }, () => (context: { messages: { content?: unknown }[] }) =>
		scenario.stop !== "none" && /"(Start|Again)\."/.test(JSON.stringify(context.messages.at(-1)?.content))
			? fauxAssistantMessage(fauxToolCall("slow_tool", {}), { stopReason: "toolUse" })
			: fauxAssistantMessage("Answered.")));
	const prompts: string[] = [];
	let compactions = 0;
	let failures = 0;
	let toolRuns = 0;
	let checkpointed = false;
	let emit = (_event: string, _data: unknown) => {};
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (api) => {
			api.registerProvider(faux.provider);
			emit = (event, data) => api.events.emit(event, data);
			api.on("before_agent_start", (event) => { prompts.push(event.messageType === "user" ? event.prompt : `custom:${event.message.customType}`); });
			api.on("session_before_compact", (event) => {
				if (scenario.cancelFirstCompaction && compactions + failures === 0) return { cancel: true };
				return { compaction: { summary: "Compacted.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
			});
			api.on("session_compact", () => { compactions++; });
			api.on("session_compact_failed", async () => { if (failures++ === 0) await scenario.onCompactFailed?.(session!); });
			api.on("agent_settled", (event, ctx) => {
				if (checkpointed || !scenario.checkpoint || (scenario.checkpoint === "aborted-settled") !== event.aborted) return;
				checkpointed = true;
				ctx.compact();
			});
			api.registerTool({ name: "slow_tool", label: "Slow", description: "Wait until aborted", parameters: Type.Object({}), execute(_id, _params, signal, _onUpdate, ctx) {
				if (toolRuns++ === 0) setImmediate(() => scenario.stop === "compact" ? ctx.compact() : void session!.abort());
				return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "stopped" }], details: {} }), { once: true }));
			} });
		}],
	});
	const uiContext = {
		...Object.fromEntries(["select", "confirm", "input", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "custom", "pasteToEditor", "setEditorText", "getEditorText", "editor", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded", "notify"].map((name) => [name, () => undefined])),
		theme: new Proxy({}, { get: () => (...args: unknown[]) => String(args.at(-1) ?? "") }),
	};
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
		await session.bindExtensions({ uiContext: uiContext as never });
		emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "still-running", sessionId, asyncDir: path.join(root, "still-running"), agent: "worker", task: "Keep going." });
		await session.prompt("Start.");
		if (scenario.compactAfter) await session.compact();
		await wait(600); // The resume polls every 50 ms until the parent is idle.
		await session.waitForIdle();
		const runsBeforeCompletion = [...prompts];
		// A failed result skips the completion batch window.
		emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "child", sessionId, completionOwnerId: currentCompletionOwnerId(), success: false, summary: "child needs the parent." });
		await wait(150);
		await session.waitForIdle();
		const notice = session.messages.find((message) => message.role === "custom" && String(message.content).includes("child needs the parent."));
		return { runsBeforeCompletion, prompts, compactions, failures, completionHeld: /The user stopped the parent turn\./.test(String(notice?.content)) };
	} finally {
		if (session) await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

it("resumes a parent that ctx.compact() cut off mid-run, without holding later wakes", { timeout: 30_000 }, async () => {
	const result = await runParent({ stop: "compact" });
	assert.deepEqual(result.runsBeforeCompletion, ["Start.", "custom:subagent-compaction-resume"]);
	assert.equal(result.completionHeld, false);
	assert.equal(result.prompts.at(-1), "custom:subagent-notify");
});

it("does not wake an idle parent that a checkpoint extension compacts", { timeout: 30_000 }, async () => {
	const result = await runParent({ stop: "none", checkpoint: "settled" });
	assert.equal(result.compactions, 1);
	assert.deepEqual(result.runsBeforeCompletion, ["Start."]);
	assert.equal(result.prompts.at(-1), "custom:subagent-notify");
});

it("keeps a parent stopped with Esc stopped when it is compacted afterwards", { timeout: 30_000 }, async () => {
	const result = await runParent({ stop: "abort", compactAfter: true });
	assert.equal(result.compactions, 1);
	assert.deepEqual(result.prompts, ["Start."]);
	assert.equal(result.completionHeld, true);
});

it("still resumes when a checkpoint compaction starts inside the interrupting one", { timeout: 30_000 }, async () => {
	// The checkpoint starts from the interrupted run's aborted agent_settled, finds no run active, and fails after the first compaction.
	const result = await runParent({ stop: "compact", checkpoint: "aborted-settled" });
	assert.deepEqual([result.compactions, result.failures], [1, 1]);
	assert.deepEqual(result.runsBeforeCompletion, ["Start.", "custom:subagent-compaction-resume"]);
});

it("treats Esc on a run started during a failed compaction's hooks as the user's stop", { timeout: 30_000 }, async () => {
	const result = await runParent({
		stop: "compact",
		cancelFirstCompaction: true,
		// Pi is already idle while it awaits session_compact_failed handlers.
		async onCompactFailed(session) {
			const run = session.prompt("Again.");
			await new Promise((resolve) => setTimeout(resolve, 50));
			await session.abort();
			await run;
		},
	});
	assert.equal(result.failures, 1);
	assert.equal(result.completionHeld, true);
	assert.deepEqual(result.prompts, ["Start.", "Again."]);
});
