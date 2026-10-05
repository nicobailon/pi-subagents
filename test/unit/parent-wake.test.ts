import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import registerSubagentExtension from "../../src/extension/index.ts";
import { currentCompletionOwnerId } from "../../src/shared/completion-owner.ts";
import { createParentWake, PARENT_WAKE_TEXT } from "../../src/shared/parent-wake.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

function createHarness(sessionManager: { getSessionId(): string } = SessionManager.inMemory()) {
	const calls: unknown[][] = [];
	let idle = true;
	let time = 0;
	const wake = createParentWake({
		sendMessage: (...args: unknown[]) => { calls.push(["sendMessage", ...args]); },
		sendUserMessage: (...args: unknown[]) => { calls.push(["sendUserMessage", ...args]); },
	} as never, () => time);
	wake.bindSession({ isIdle: () => idle, sessionManager } as never);
	return {
		wake,
		calls,
		wakes: () => calls.filter(([method]) => method === "sendUserMessage").length,
		setIdle(value: boolean) { idle = value; },
		advance(ms: number) { time += ms; },
	};
}

const notice = (content: string) => ({ customType: "subagent-test", content, display: true });

it("appends a notice to an idle parent and wakes it once through a user prompt", () => {
	const { wake, calls } = createHarness();
	assert.equal(wake.sendMessage(notice("first"), { triggerTurn: true }), true);
	assert.equal(wake.sendMessage(notice("second"), { triggerTurn: true }), true);
	assert.deepEqual(calls, [
		["sendMessage", notice("first"), { triggerTurn: false }],
		["sendUserMessage", PARENT_WAKE_TEXT, { deliverAs: "steer" }],
		["sendMessage", notice("second"), { triggerTurn: false }],
	]);
});

it("steers a busy parent as before and passes non-waking messages through", () => {
	const { wake, calls, setIdle } = createHarness();
	assert.equal(wake.sendMessage(notice("context"), { triggerTurn: false }), false);
	assert.equal(wake.sendMessage(notice("plain")), false);
	setIdle(false);
	assert.equal(wake.sendMessage(notice("busy"), { triggerTurn: true }), false);
	assert.deepEqual(calls, [
		["sendMessage", notice("context"), { triggerTurn: false }],
		["sendMessage", notice("plain"), undefined],
		["sendMessage", notice("busy"), { triggerTurn: true }],
	]);
});

it("wakes again after the woken run starts or after a wake that never started expires", () => {
	const { wake, wakes, advance } = createHarness();
	wake.sendMessage(notice("first"), { triggerTurn: true });
	wake.agentStarted();
	wake.sendMessage(notice("after start"), { triggerTurn: true });
	advance(9_999);
	wake.sendMessage(notice("still pending"), { triggerTurn: true });
	advance(1);
	wake.sendMessage(notice("expired"), { triggerTurn: true });
	assert.equal(wakes(), 3);
});

it("keeps one pending wake per session manager and session across reload, and none for another session", () => {
	const manager = SessionManager.inMemory();
	const first = createHarness(manager);
	first.wake.sendMessage(notice("first"), { triggerTurn: true });
	first.wake.sessionShutdown("reload");
	const reloaded = createHarness(manager);
	assert.equal(reloaded.wake.isPending(), true, "reload keeps the wake that is still in preflight");
	reloaded.wake.sendMessage(notice("during preflight"), { triggerTurn: true });
	assert.equal(reloaded.wakes(), 0, "the reloaded extension must not send a second wake");
	const other = createHarness({ getSessionId: () => manager.getSessionId() });
	assert.equal(other.wake.isPending(), false, "another session manager does not inherit the wake");
	manager.newSession();
	const switched = createHarness(manager);
	assert.equal(switched.wake.isPending(), false, "a new session on the same manager does not inherit the wake");
	switched.wake.sendMessage(notice("new session"), { triggerTurn: true });
	assert.equal(switched.wakes(), 1);
	switched.wake.sessionShutdown("quit");
	assert.equal(createHarness(manager).wake.isPending(), false, "quit clears the wake");
});

it("holds a pending wake until its run starts, and abandons it only once an idle parent passes the deadline", () => {
	const { wake, setIdle, advance } = createHarness();
	wake.sendMessage(notice("first"), { triggerTurn: true });
	assert.equal(wake.isPending(), true);
	wake.agentStarted();
	assert.equal(wake.isPending(), false);
	wake.sendMessage(notice("second"), { triggerTurn: true });
	advance(10_000);
	setIdle(false);
	assert.equal(wake.isPending(), true, "a busy parent may still be in the wake's preflight");
	setIdle(true);
	assert.equal(wake.isPending(), false, "an idle parent past the deadline has abandoned the wake");
});

it("abandons a real SDK wake that an input handler consumes", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-wake-handled-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let time = 0;
	let wake: ReturnType<typeof createParentWake> | undefined;
	const inputs: string[] = [];
	let starts = 0;
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(api) => {
			wake = createParentWake(api, () => time);
			api.on("session_start", (_event, ctx) => wake!.bindSession(ctx));
			api.on("agent_start", () => { starts++; wake!.agentStarted(); });
			api.on("input", (event) => { inputs.push(event.text); return { action: "handled" }; });
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
		await session.bindExtensions({});
		wake!.sendMessage({ customType: "subagent-test", content: "Needs the parent.", display: true }, { triggerTurn: true });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(inputs, [PARENT_WAKE_TEXT]);
		assert.equal(starts, 0);
		assert.equal(wake!.isPending(), true);
		time = 10_000;
		assert.equal(wake!.isPending(), false, "no run will start, so the wake must not hold the session forever");
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("starts an idle parent's completion run through before_agent_start, so it keeps hook-set prompt sections", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-wake-sdk-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const sessionManager = SessionManager.inMemory(root);
	const sessionId = sessionManager.getSessionId();
	const faux = fauxProvider({ provider: "parent-wake", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([
		() => fauxAssistantMessage("Started the child."),
		() => fauxAssistantMessage(fauxToolCall("probe_tool", {}), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("Handled the child result."),
	]);
	const prompts: string[] = [];
	let emitCompletion = () => {};
	let settled = () => {};
	let runs = 0;
	const settledAgain = new Promise<void>((resolve) => { settled = resolve; });
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (api) => {
			api.registerProvider(faux.provider);
			emitCompletion = () => api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: "idle-child", sessionId, completionOwnerId: currentCompletionOwnerId(), success: false, summary: "The child needs the parent.",
			});
			api.on("before_agent_start", (event) => {
				prompts.push(event.prompt);
				event.systemPromptOptions.sections.probe = "Hook-set section.";
			});
			api.on("agent_settled", () => { if (++runs === 2) settled(); });
			api.registerTool({ name: "probe_tool", label: "Probe", description: "Return a fixed result", parameters: Type.Object({}), async execute() {
				return { content: [{ type: "text", text: "probed" }], details: {} };
			} });
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
		await session.bindExtensions({});
		await session.prompt("Start a child.");
		assert.equal(session.isIdle, true);
		emitCompletion();
		await settledAgain;
		assert.deepEqual(prompts, ["Start a child.", PARENT_WAKE_TEXT]);
		const removals = session.messages.filter((message) => message.role === "system"
			&& Object.values((message as { sections?: Record<string, unknown> }).sections ?? {}).some((value) => value === null));
		assert.deepEqual(removals, [], "the woken run's second request must not drop hook-set sections");
		assert.equal(session.getLastAssistantText(), "Handled the child result.");
	} finally {
		if (session) await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
