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
import { createParentWake } from "../../src/shared/parent-wake.ts";
import { createNativeSupervisorChannel } from "../../src/intercom/native-supervisor-channel.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, type SubagentState } from "../../src/shared/types.ts";

function createHarness(sessionManager: { getSessionId(): string } = SessionManager.inMemory()) {
	const calls: unknown[][] = [];
	let idle = true;
	let time = 0;
	// No sendUserMessage: a wake that sent a user message would throw here.
	const wake = createParentWake({
		sendMessage: (...args: unknown[]) => { calls.push(["sendMessage", ...args]); },
	} as never, () => time);
	wake.bindSession({ isIdle: () => idle, sessionManager } as never);
	return {
		wake,
		calls,
		wakes: () => calls.filter((call) => (call[2] as { triggerTurn?: boolean } | undefined)?.triggerTurn === true).length,
		setIdle(value: boolean) { idle = value; },
		advance(ms: number) { time += ms; },
	};
}

const notice = (content: string) => ({ customType: "subagent-test", content, display: true });
// Each run's trigger: a user prompt's text, or the type of the custom message that started it.
const runTrigger = (event: { messageType: "user"; prompt: string } | { messageType: "custom"; message: { customType: string } }) =>
	event.messageType === "user" ? event.prompt : `custom:${event.message.customType}`;

it("starts an idle parent's run with the notice itself, once, and sends no user message", () => {
	const { wake, calls } = createHarness();
	assert.equal(wake.sendMessage(notice("first"), { triggerTurn: true }), false, "Pi emits message_start for the notice that starts the run");
	assert.equal(wake.sendMessage(notice("second"), { triggerTurn: true }), true);
	assert.deepEqual(calls, [
		["sendMessage", notice("first"), { triggerTurn: true }],
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

it("after a user abort, appends waking notices without a wake until the next run starts", () => {
	const { wake, calls, wakes, setIdle } = createHarness();
	wake.userAborted();
	assert.equal(wake.sendMessage(notice("idle"), { triggerTurn: true }), true);
	setIdle(false);
	assert.equal(wake.sendMessage(notice("still finishing"), { triggerTurn: true }), true);
	assert.equal(wake.sendMessage(notice("context"), { triggerTurn: false }), false);
	assert.deepEqual(calls, [
		["sendMessage", notice("idle"), { triggerTurn: false }],
		["sendMessage", notice("still finishing"), { triggerTurn: false }],
		["sendMessage", notice("context"), { triggerTurn: false }],
	]);
	assert.equal(wake.isPending(), false, "a held notice leaves no wake outstanding");
	setIdle(true);
	wake.agentStarted();
	wake.sendMessage(notice("after the next run"), { triggerTurn: true });
	assert.equal(wakes(), 1);
});

it("drops a user-abort hold when the session changes or a resume releases it", () => {
	const manager = SessionManager.inMemory();
	const { wake, wakes } = createHarness(manager);
	wake.userAborted();
	manager.newSession();
	wake.bindSession({ isIdle: () => true, sessionManager: manager } as never);
	wake.sendMessage(notice("new session"), { triggerTurn: true });
	assert.equal(wakes(), 1);
	wake.userAborted();
	wake.releaseHold();
	wake.sendMessage(notice("during the pending wake"), { triggerTurn: true });
	assert.equal(wakes(), 1, "releasing the hold keeps the pending wake reservation");
});

it("shares one idle wake per session with other extensions, such as pi-intercom", () => {
	const manager = SessionManager.inMemory();
	const reservations = (globalThis as Record<symbol, WeakMap<object, { sessionId: string; sentAt?: number }>>)[Symbol.for("pi.idle-wake.v1")];
	const { wake, wakes, advance } = createHarness(manager);
	reservations.set(manager, { sessionId: manager.getSessionId(), sentAt: 0 });
	wake.sendMessage(notice("during the other wake's preflight"), { triggerTurn: true });
	assert.equal(wakes(), 0, "the other extension's wake is starting the run; a second wake must not start another");
	wake.agentStarted();
	advance(1);
	wake.sendMessage(notice("after start"), { triggerTurn: true });
	assert.equal(wakes(), 1);
	assert.equal(reservations.get(manager)?.sentAt, 1, "other extensions see this wake");
});

it("wakes a real SDK parent with the notice itself and holds the wake until the run starts", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-wake-notice-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const faux = fauxProvider({ provider: "parent-wake-notice", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([() => fauxAssistantMessage("Handled the notice.")]);
	let wake: ReturnType<typeof createParentWake> | undefined;
	const triggers: string[] = [];
	const started: string[] = [];
	let pendingAtStart: boolean | undefined;
	let settled = () => {};
	const settledOnce = new Promise<void>((resolve) => { settled = resolve; });
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(api) => {
			api.registerProvider(faux.provider);
			wake = createParentWake(api);
			api.on("session_start", (_event, ctx) => wake!.bindSession(ctx));
			api.on("before_agent_start", (event) => { triggers.push(runTrigger(event)); });
			api.on("agent_start", () => { pendingAtStart = wake!.isPending(); wake!.agentStarted(); });
			api.on("message_start", (event) => { if (event.message.role === "custom") started.push(event.message.customType); });
			api.on("agent_settled", () => settled());
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
		await session.bindExtensions({});
		assert.equal(wake!.sendMessage({ customType: "subagent-test", content: "Needs the parent.", display: true }, { triggerTurn: true }), false);
		assert.equal(session.isIdle, false, "Pi counts the session busy before sendMessage returns");
		assert.equal(wake!.isPending(), true);
		await settledOnce;
		assert.deepEqual(triggers, ["custom:subagent-test"], "the notice starts the run through before_agent_start");
		assert.deepEqual(started, ["subagent-test"], "Pi emits message_start for the notice");
		assert.equal(pendingAtStart, true, "the wake stays pending until agent_start");
		assert.equal(wake!.isPending(), false);
		assert.deepEqual(session.messages.filter((message) => message.role === "user"), [], "no user-role wake message");
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const emptyResponse of [false, true]) it(`starts an idle parent's completion run (${emptyResponse ? "empty response" : "tool response"}) through before_agent_start, so it keeps hook-set prompt sections`, { timeout: 30_000 }, async () => {
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
		() => emptyResponse ? fauxAssistantMessage("") : fauxAssistantMessage(fauxToolCall("probe_tool", {}), { stopReason: "toolUse" }),
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
				prompts.push(runTrigger(event));
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
		assert.deepEqual(prompts, ["Start a child.", "custom:subagent-notify"]);
		assert.equal(session.messages.filter((message) => message.role === "user").length, 1, "only the operator's prompt is a user message");
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

// Pi's compact() aborts a live run first, so a manual /compact mid-tool also ends the run with an aborted signal.
for (const stopWith of ["abort", "compact"] as const) it(`${stopWith === "abort" ? "does not restart" : "resumes"} a parent whose run was stopped mid-tool by ${stopWith}`, { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-wake-abort-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const sessionManager = SessionManager.inMemory(root);
	const sessionId = sessionManager.getSessionId();
	const faux = fauxProvider({ provider: "parent-wake-abort", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("slow_tool", {}), { stopReason: "toolUse" }),
		...Array.from({ length: 6 }, () => () => fauxAssistantMessage("Answered.")),
	]);
	const prompts: string[] = [];
	const notices: string[] = [];
	let emit = (_event: string, _data: unknown) => {};
	let stop = () => {};
	const settingsManager = SettingsManager.inMemory(stopWith === "compact" ? { compaction: { keepRecentTokens: 1 } } : {});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (api) => {
			api.registerProvider(faux.provider);
			emit = (event, data) => api.events.emit(event, data);
			api.on("before_agent_start", (event) => { prompts.push(runTrigger(event)); });
			api.on("session_before_compact", (event) => ({
				compaction: { summary: "Compacted.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore },
			}));
			api.registerTool({ name: "slow_tool", label: "Slow", description: "Wait until aborted", parameters: Type.Object({}), execute(_id, _params, signal) {
				setImmediate(stop);
				return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "stopped" }], details: {} }), { once: true }));
			} });
		}],
	});
	const theme = new Proxy({}, { get: () => (...args: unknown[]) => String(args.at(-1) ?? "") });
	const ignore = () => undefined;
	const uiContext = {
		...Object.fromEntries(["select", "confirm", "input", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "custom", "pasteToEditor", "setEditorText", "getEditorText", "editor", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded"].map((name) => [name, ignore])),
		theme,
		notify: (text: string) => { notices.push(text); },
	};
	// A failed result skips the completion batch window, so it reaches the parent at once.
	const completion = (id: string) => ({ id, sessionId, completionOwnerId: currentCompletionOwnerId(), success: false, summary: `${id} needs the parent.` });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
		await session.bindExtensions({ uiContext: uiContext as never });
		stop = () => { void (stopWith === "abort" ? session!.abort() : session!.compact()); };
		emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "still-running", sessionId, asyncDir: path.join(root, "still-running"), agent: "worker", task: "Keep going." });
		await session.prompt("Start.");
		if (stopWith === "compact") {
			for (let waited = 0; waited < 2_000 && prompts.length < 2; waited += 50) await settle();
			assert.deepEqual(prompts, ["Start.", "custom:subagent-compaction-resume"], "the compaction resume must wake the parent");
			return;
		}
		assert.equal(session.isIdle, true);
		assert.ok(notices.some((text) => text.startsWith("1 background subagent run is still active")), notices.join("\n"));

		emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("held-child"));
		await settle();
		assert.deepEqual(prompts, ["Start."], "a stopped parent must not be restarted by a background result");
		const notice = (id: string) => String(session!.messages.find((message) => message.role === "custom" && String(message.content).includes(`${id} needs the parent.`))?.content);
		assert.match(notice("held-child"), /Parent action: The user stopped the parent turn\./, "the held result is recorded for the next prompt without asking to resume");

		await session.prompt("Continue.");
		emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completion("later-child"));
		await settle();
		assert.deepEqual(prompts, ["Start.", "Continue.", "custom:subagent-notify"], "a completed run does not hold wakes");
		assert.match(notice("later-child"), /Parent action: Read the saved results above and resume the already-authorized parent task/);
	} finally {
		if (session) await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("composes prior drafts, unresolved supervisor and empty completion safeguards through real SDK", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settle-compose-"));
	const agentDir = path.join(root, "agent");
	const channelDir = path.join(root, "channel");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const manager = SessionManager.inMemory(root);
	const sessionId = manager.getSessionId();
	const requestFile = path.join(channelDir, "requests", "ask.json");
	fs.writeFileSync(requestFile, JSON.stringify({
		type: "subagent.supervisor.request", id: "ask", createdAt: Date.now(),
		reason: "need_decision", message: "May child proceed?", expectsReply: true,
		orchestratorSessionId: sessionId, runId: "child", agent: "worker", childIndex: 0,
	}));
	const faux = fauxProvider({ provider: "settle-compose", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	let responses = 0;
	faux.setResponses(Array.from({ length: 3 }, () => () => { responses++; return fauxAssistantMessage(""); }));
	let channel: ReturnType<typeof createNativeSupervisorChannel>;
	let notifier: ReturnType<typeof registerSubagentNotify>;
	const boundaries: string[][] = [];
	let observeBoundary = () => {};
	const runnable: boolean[] = [];
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(api) => {
			api.registerProvider(faux.provider);
			api.on("agent_before_settle", (event) => {
				runnable.push(event.context.canContinue);
				return { entries: [...event.entries, { type: "custom", customType: "prior-draft", data: {} }] };
			});
			const state = { currentSessionId: sessionId, supervisorOwnerSessionId: sessionId,
				completionOwnerId: "owner", asyncJobs: new Map(), foregroundControls: new Map() } as SubagentState;
			// Append notices without launching another run; explicit prompt below owns this run.
			const parentWake = { sendMessage(message: Parameters<typeof api.sendMessage>[0]) {
				api.sendMessage(message, { triggerTurn: false }); return true;
			} };
			channel = createNativeSupervisorChannel(api, state, { parentWake, getChannelDirs: () => ({ dirs: [channelDir] }) });
			notifier = registerSubagentNotify({ events: api.events, on: api.on, isHeld: () => false, ...parentWake }, state, { batchConfig: { enabled: false } });
			api.on("session_start", () => { notifier.bindSession(manager); channel.start(); });
			observeBoundary = () => { api.on("agent_before_settle", (event) => {
				boundaries.push(event.entries.map(entry => "customType" in entry ? entry.customType : entry.type));
			}); };
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: manager, noTools: "builtin" }));
		await session.bindExtensions({});
		assert.equal(await notifier!.deliver({ id: "completion", sessionId, completionOwnerId: "owner", success: true, summary: "Done" }), true);
		observeBoundary();
		await session.prompt("Inspect pending updates.");
		assert.equal(runnable[0], false, "empty assistant output leaves pre-draft continuation unavailable");
		assert.equal(responses, 3, "one bounded reminder per safeguard, then settle");
		assert.deepEqual(boundaries, [
			["prior-draft", "subagent-supervisor-unanswered"],
			["prior-draft", "subagent-supervisor-blocked", "subagent-completion-unanswered"],
			["prior-draft", "subagent-completion-unhandled"],
		]);
		assert.equal(channel!.pending.size, 1);
		assert.equal(fs.existsSync(requestFile), true, "safeguard never answers or deletes unresolved ask");
		const customTypes = manager.getBranch().filter(entry => entry.type === "custom_message").map(entry => entry.customType);
		assert.ok(customTypes.includes("subagent-supervisor-blocked"));
		assert.ok(customTypes.includes("subagent-completion-unhandled"));
		assert.equal(manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "prior-draft").length, 3);
	} finally {
		channel!?.dispose();
		notifier!?.dispose();
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("does no idle settle work without delegated work", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-demand-settle-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const manager = SessionManager.inMemory(root);
	const faux = fauxProvider({ provider: "demand-settle", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	let responses = 0;
	faux.setResponses(Array.from({ length: 2 }, () => () => {
		responses++;
		return fauxAssistantMessage("No delegated work.");
	}));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (api) => {
			api.registerProvider(faux.provider);
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: manager, noTools: "builtin" }));
		await session.bindExtensions({});
		assert.equal(session.extensionRunner.hasHandlers("agent_before_settle"), false, "no subscriptions without unanswered work");
		let previews = 0, commits = 0;
		const sdk = session as any;
		const build = sdk._buildBoundaryContext.bind(session);
		const commit = sdk._commitBoundaryDrafts.bind(session);
		sdk._buildBoundaryContext = (...args: any[]) => {
			if (args[1] === "agent_before_settle") previews++;
			return build(...args);
		};
		sdk._commitBoundaryDrafts = (...args: any[]) => {
			if (sdk._isBeforeSettle) commits++;
			return commit(...args);
		};
		await session.prompt("No new delegated work.");
		assert.equal(previews, 0, "idle settlement builds no full-history previews");
		assert.equal(commits, 0, "idle settlement does no boundary context refresh");
		assert.equal(responses, 1);
	} finally {
		if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
