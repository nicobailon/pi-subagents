import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { PI_WEB_SESSION_LIVENESS_REGISTRY_KEY } from "../../src/integrations/pi-web-session-liveness.ts";
import { currentCompletionOwnerId } from "../../src/shared/completion-owner.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

// One child that ends before its result is published, whose first completion
// send is rejected, and whose accepted wake is started by the parent later.
const terminalBeforePublicationScript = String.raw`
	import assert from "node:assert/strict";
	import * as fs from "node:fs";
	import * as path from "node:path";
	import { createEventBus } from "@earendil-works/pi-coding-agent";
	import registerSubagentExtension from "./src/extension/index.ts";
	import { currentCompletionOwnerId } from "./src/shared/completion-owner.ts";
	import { DIRS, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_PROCESS_TERMINAL_EVENT } from "./src/shared/types.ts";
	import { writeAtomicJson } from "./src/shared/atomic-json.ts";
	import { resultFilePath, writeAsyncResultFile } from "./src/runs/background/result-files.ts";
	import { updateActiveRunIndex } from "./src/runs/background/active-run-index.ts";

	// Use the event-driven tracker and run its short debounce timers as microtasks,
	// so a terminal status is observed before the result file exists.
	Object.defineProperty(process, "platform", { value: "linux" });
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const fakeTimers = new WeakSet();
	globalThis.setTimeout = ((handler, delay, ...args) => {
		if ((delay === 0 || delay === 25) && (new Error().stack ?? "").includes("/src/runs/background/async-job-tracker.ts")) {
			const timer = { active: true, unref() {} };
			fakeTimers.add(timer);
			queueMicrotask(() => { if (timer.active) { timer.active = false; handler(...args); } });
			return timer;
		}
		return originalSetTimeout(handler, delay, ...args);
	});
	globalThis.clearTimeout = ((timer) => {
		if (timer && typeof timer === "object" && fakeTimers.has(timer)) timer.active = false;
		else originalClearTimeout(timer);
	});

	const configDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ completionBatch: { enabled: false } }));
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const completionOwnerId = currentCompletionOwnerId();
	const runId = "liveness-child";
	const handlers = new Map();
	const events = createEventBus();
	let rejectNextSend = true;
	let onSend;
	const pi = new Proxy({
		events,
		on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getSessionName() {},
		sendMessage(message, options) {
			if (message.customType !== "subagent-notify") return;
			const rejected = rejectNextSend;
			rejectNextSend = false;
			onSend?.({ message, options, rejected });
			if (rejected) throw new Error("synthetic completion send rejection");
		},
	}, { get(target, property) { return property in target ? target[property] : () => undefined; } });
	let provider;
	globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")] = {
		version: 1,
		register(value) { provider = value; return () => {}; },
	};
	const ctx = {
		cwd: process.cwd(), hasUI: false, model: undefined, isIdle() { return false; },
		ui: { setWidget() {}, requestRender() {}, theme: { fg(_name, text) { return text; }, bg(_name, text) { return text; }, bold(text) { return text; } } },
		sessionManager: { getSessionId() { return sessionId; }, getSessionFile() { return null; }, getEntries() { return []; } },
		modelRegistry: { getAvailable() { return []; } },
	};
	const nextSend = () => new Promise((resolve, reject) => {
		const timer = originalSetTimeout(() => reject(new Error("Timed out waiting for a completion send")), 10_000);
		onSend = (send) => { originalClearTimeout(timer); onSend = undefined; resolve(send); };
	});
	const writeStatus = (state) => {
		const asyncDir = path.join(DIRS.async, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		writeAtomicJson(path.join(asyncDir, "status.json"), {
			runId, sessionId, completionOwnerId, mode: "single", state,
			startedAt: Date.now(), lastUpdate: Date.now(), cwd: process.cwd(), pid: process.pid,
			steps: [{ agent: "worker", status: state, index: 0 }],
			...(state === "running" ? {} : { processTerminal: { version: 1, runId, runnerProcessInstanceId: runId + "-runner", state: "pending" } }),
		});
		updateActiveRunIndex(asyncDir, state);
		return asyncDir;
	};
	const publishResult = () => writeAsyncResultFile(resultFilePath(DIRS.results, runId), {
		id: runId, runId, agent: "worker", mode: "single", state: "complete", success: true, exitCode: 0,
		summary: "child complete", timestamp: Date.now(), sessionId, completionOwnerId,
	});

	registerSubagentExtension(pi);
	for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
	assert.equal(provider.isActive(), false);
	const asyncDir = writeStatus("running");
	events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: runId, sessionId, completionOwnerId, mode: "single", agent: "worker", asyncDir });
	assert.equal(provider.isActive(), true);

	let send;
	if (process.argv[1] === "event") {
		// Detached-workflow reconciliation publishes the result and emits the
		// completion event before the status watcher sees the terminal state.
		writeStatus("complete");
		publishResult();
		send = nextSend();
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: runId, runId, sessionId, completionOwnerId, state: "complete", success: true, summary: "child complete" });
		assert.equal((await send).rejected, true);
		assert.equal(provider.isActive(), true, "a completion event with a rejected send keeps the result owed");
	} else {
		// Wait for the directory event the tracker reacts to (an atomic write can be
		// reported under its temp name). If a loaded runner drops it, the tracker's
		// 5 s liveness poll still sees the terminal status within this bound.
		const observed = new Promise((resolve) => {
			const timer = originalSetTimeout(() => { watcher.close(); resolve(); }, 6_000);
			const watcher = fs.watch(asyncDir, () => { originalClearTimeout(timer); watcher.close(); resolve(); });
		});
		writeStatus("complete");
		events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, { version: 1, runId, runnerProcessInstanceId: runId + "-runner", state: "pending" });
		await observed;
		await new Promise((resolve) => originalSetTimeout(resolve, 50));
		assert.equal(fs.existsSync(resultFilePath(DIRS.results, runId)), false);
		assert.equal(provider.isActive(), true, "an ended child stays live until its result is published");

		send = nextSend();
		publishResult();
		assert.equal((await send).rejected, true);
		assert.equal(provider.isActive(), true, "a rejected completion send keeps the result owed");
	}

	send = nextSend();
	publishResult();
	const accepted = await send;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(provider.isActive(), true, "an accepted wake stays live until Pi starts it");
	for (const handler of handlers.get("message_start")) handler({ message: { role: "custom", ...accepted.message } });
	assert.equal(provider.isActive(), false, "the started wake hands the result to the parent");

	for (const handler of handlers.get("session_shutdown")) await handler({ reason: "quit" }, ctx);
	process.stdout.write("ok");
`;

describe("session liveness through result delivery", () => {
	for (const [mode, title] of [
		["status", "stays live from a child's terminal status through a rejected send until its wake starts"],
		["event", "stays live when a completion event ends the job before its status refresh and the send is rejected"],
	]) it(title, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-liveness-delivery-"));
		try {
			fs.mkdirSync(path.join(root, "home"));
			fs.mkdirSync(path.join(root, "agent"));
			const env = { ...process.env };
			delete env.PI_SUBAGENT_CHILD;
			delete env.PI_SUBAGENT_PARENT_SESSION;
			Object.assign(env, {
				HOME: path.join(root, "home"),
				USERPROFILE: path.join(root, "home"),
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				PI_SUBAGENTS_TEMP_ROOT: path.join(root, "temp"),
				TMPDIR: root,
				TMP: root,
				TEMP: root,
			});
			const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", terminalBeforePublicationScript, mode], {
				cwd: process.cwd(), encoding: "utf-8", env, timeout: 20_000,
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stdout, "ok");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("stays live while Pi queues a completion wake during a turn and past agent_settled", { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-liveness-sdk-"));
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const registryKey = Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY);
		let provider: { isActive(): boolean } | undefined;
		(globalThis as Record<PropertyKey, unknown>)[registryKey] = {
			version: 1,
			register(value: { isActive(): boolean }) { provider = value; return () => {}; },
		};
		const sessionManager = SessionManager.inMemory(root);
		const sessionId = sessionManager.getSessionId();
		const complete = (api: Parameters<typeof registerSubagentExtension>[0], id: string) => api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id, runId: id, sessionId, completionOwnerId: currentCompletionOwnerId(), success: false, summary: `${id} needs the parent`,
		});
		const activeAt: Record<string, boolean | undefined> = {};
		const faux = fauxProvider({ provider: "session-liveness", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		faux.setResponses([
			() => fauxAssistantMessage("First reply."),
			() => fauxAssistantMessage("Second reply."),
			() => fauxAssistantMessage("Third reply."),
		]);
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [
				(api) => { api.registerProvider(faux.provider); },
				registerSubagentExtension,
				(api) => {
					api.on("agent_start", () => {
						if ("duringTurn" in activeAt) return;
						complete(api, "during-turn");
						activeAt.duringTurn = provider?.isActive();
					});
					api.on("agent_settled", () => {
						if ("atSettle" in activeAt) {
							activeAt.finalSettle = provider?.isActive();
							return;
						}
						complete(api, "at-settle");
						activeAt.atSettle = provider?.isActive();
					});
				},
			],
		});
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
			({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
			await session.bindExtensions({});
			await session.prompt("Start the original turn.");
			assert.deepEqual(activeAt, { duringTurn: true, atSettle: true, finalSettle: false });
			assert.equal(session.messages.filter((message) => message.role === "custom" && message.customType === "subagent-notify").length, 2, "Pi started both queued wakes");
			await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session?.dispose();
			delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an idle parent's completion wake across actual SDK reload until the woken run starts", { timeout: 30_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-liveness-reload-"));
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const registryKey = Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY);
		const globals = globalThis as Record<PropertyKey, unknown>;
		const previousRegistry = globals[registryKey];
		let provider: { isActive(): boolean } | undefined;
		let registrations = 0;
		globals[registryKey] = {
			version: 1,
			register(value: { isActive(): boolean }) {
				registrations++;
				provider = value;
				return () => { if (provider === value) provider = undefined; };
			},
		};
		const sessionManager = SessionManager.inMemory(root);
		const sessionId = sessionManager.getSessionId();
		const faux = fauxProvider({ provider: "liveness-reload", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		faux.setResponses([
			() => fauxAssistantMessage("Yielded original turn."),
			() => fauxAssistantMessage("Processed completion after reload."),
		]);
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let reloaded = false;
		// Hook errors after reload never reach onError, so record observations and assert after the prompt.
		let observed: Record<string, unknown> | undefined;
		const settingsManager = SettingsManager.inMemory({});
		const errors: unknown[] = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerSubagentExtension, (api) => {
				api.registerProvider(faux.provider);
				api.on("agent_settled", async () => {
					if (reloaded) return;
					reloaded = true;
					api.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
						id: "reload-wake", sessionId, completionOwnerId: currentCompletionOwnerId(),
						success: false, summary: "Review requires the parent.",
					});
					const activeBeforeReload = provider?.isActive();
					await session!.reload();
					observed = {
						activeBeforeReload,
						registrations,
						isIdle: session!.isIdle,
						pendingMessageCount: session!.pendingMessageCount,
						noticeAppended: session!.messages.some((message) => message.role === "custom" && message.customType === "subagent-notify"),
						activeAfterReload: provider?.isActive(),
					};
				});
			}],
		});
		try {
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
			({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" }));
			// With no bindings, SDK reload skips session_start. Bind an error listener
			// to exercise the real reload lifecycle.
			await session.bindExtensions({ onError: (error) => { errors.push(error); } });
			await session.prompt("Yield with a completion pending.");
			assert.equal(reloaded, true);
			assert.deepEqual(errors, []);
			assert.deepEqual(observed, {
				activeBeforeReload: true,
				registrations: 2, // reload actually bound the replacement producer
				isIdle: true,
				pendingMessageCount: 0, // Pi's deferred settled action is not counted as a pending message
				noticeAppended: true, // the idle parent gets the notice now and a prompt that wakes it
				activeAfterReload: true, // the retained wake prompt owns liveness until its deferred run starts
			});
			assert.equal(provider?.isActive(), false, "the woken run releases the retained wake");
			assert.equal(session.getLastAssistantText(), "Processed completion after reload.");
		} finally {
			if (session) await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
			if (previousRegistry === undefined) delete globals[registryKey];
			else globals[registryKey] = previousRegistry;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
