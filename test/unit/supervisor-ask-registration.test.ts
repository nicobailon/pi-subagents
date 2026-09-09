import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it, type TestContext } from "node:test";
import {
	NATIVE_SUPERVISOR_TOOL_NAME,
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	registerNativeSupervisorClient,
	resolveSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";
import { steerWorkflowForegroundTarget } from "../../src/runs/foreground/workflow-foreground-steering.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import type { ForegroundRunControl, ForegroundSteerInput, SubagentState } from "../../src/shared/types.ts";
import { DIRS, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { setChildSessionFactory, type ChildSessionFactory, type ChildSessionLaunch, type ChildSessionEvent } from "../../src/runs/shared/child-session.ts";
import { createEventBus, makeAgent } from "../support/helpers.ts";
import { clearExclusions } from "../../src/runs/shared/model-exclusions.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const createdChannels: string[] = [];

interface SupervisorTool {
	execute: (id: string, params: { action: string; replyTo?: string; to?: string; message?: string }) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

function makeState(sessionId: string | null, ctx: unknown): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: sessionId,
		supervisorOwnerSessionId: (ctx as SubagentState["lastUiContext"])?.sessionManager.getSessionId() ?? null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: ctx as SubagentState["lastUiContext"],
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeCtx(sessionId: string, sessionFile: string | null = null): { cwd: string; hasUI: boolean; sessionManager: { getSessionId: () => string; getSessionFile: () => string | null; getEntries: () => [] } } {
	return {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
			getEntries: () => [],
		},
	};
}

/**
 * Write an ask directly to the channel the way a child's `contact_supervisor` call does, without
 * going through a live poller. This is the state the wave-11 incident was in: the request file was
 * on disk and no scan had happened yet.
 */
function writeRequest(input: { sessionId: string; runId: string; agent?: string; index?: number; message?: string; reason?: "need_decision" | "progress_update"; expiresAt?: number }): string {
	const agent = input.agent ?? "worker";
	const index = input.index ?? 0;
	const channelDir = resolveSupervisorChannelDir(input.runId, agent, index);
	createdChannels.push(channelDir);
	ensureSupervisorChannelDir(channelDir);
	const requestId = randomUUID();
	const reason = input.reason ?? "need_decision";
	fs.writeFileSync(path.join(channelDir, "requests", `${requestId}.json`), JSON.stringify({
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt: Date.now(),
		...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
		reason,
		message: input.message ?? "Need a decision",
		expectsReply: reason !== "progress_update",
		orchestratorSessionId: input.sessionId,
		orchestratorTarget: "shared-name",
		runId: input.runId,
		agent,
		childIndex: index,
	}, null, "\t"));
	return requestId;
}

function makePi(options: { tools: Map<string, SupervisorTool>; onSend?: (message: { content: string }) => void }): Record<string, unknown> {
	return {
		getAllTools: () => [...options.tools.keys()].map((name) => ({ name })),
		registerTool: (tool: { name: string } & SupervisorTool) => { options.tools.set(tool.name, tool); },
		sendMessage: (message: { content: string }) => { options.onSend?.(message); },
		getSessionName: () => "shared-name",
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
}

afterEach(() => {
	for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

/** Deterministic session/model seam: real launch hooks and tools, with the host's tool allowlist. */
function hookRuntime(launch: ChildSessionLaunch, platform: NodeJS.Platform, signal: AbortSignal) {
	type Tool = { execute(id: string, params: Record<string, unknown>, signal: AbortSignal, update: undefined, ctx: unknown): Promise<{
		content: Array<{ type: string; text?: string }>; isError?: boolean;
		details: { asyncDir: string; pending: Array<{ id: string; agent: string }>; requestId?: string; replyTo?: string };
	}> };
	const owner = randomUUID();
	const sessionFile = path.join(launch.cwd, `${owner}.jsonl`);
	const ctx = { ...makeCtx(owner, sessionFile), cwd: launch.cwd, ui: {}, modelRegistry: { getAvailable: () => [] } };
	const registered = new Map<string, Tool>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const subscribers = new Set<(event: ChildSessionEvent) => void>();
	const notices: Array<{ customType?: string; details?: { requestId?: string } }> = [];
	const active = () => [...registered.keys()].filter(name => (!launch.tools || launch.tools.includes(name)) && !launch.excludeTools?.includes(name));
	let closed = false;
	const pi = {
		events: createEventBus(),
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: Tool & { name: string }) { registered.set(tool.name, tool); },
		getAllTools: () => active().map(name => ({ name, sourceInfo: { source: name === "read" ? "builtin" : "extension" } })),
		getSessionName: () => "shared-name",
		setSessionName() {},
		sendMessage(message: typeof notices[number]) { if (message.customType === "subagent_supervisor_request") notices.push(message); },
	};
	registered.set("read", { execute: async () => { throw new Error("fixture has no model-authored read calls"); } });
	// Capture each native channel's platform without changing unrelated executor filesystem behavior.
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	try {
		Object.defineProperty(process, "platform", { ...descriptor, value: platform });
		for (const hook of launch.hooks) hook.factory(pi as never);
	} finally { Object.defineProperty(process, "platform", descriptor); }
	return {
		owner, sessionFile, registered, active, notices, events: pi.events,
		get closed() { return closed; },
		subscribe(listener: (event: ChildSessionEvent) => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
		async emit(type: string, fields = {}) {
			if (type === "session_shutdown") { if (closed) return; closed = true; }
			const event = { type, ...fields };
			for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
			for (const listener of subscribers) listener(event);
		},
		async call(name: string, params: Record<string, unknown>) {
			assert.ok(active().includes(name), `Tool '${name}' is not active in ${launch.runtime.agent}`);
			return registered.get(name)!.execute(randomUUID(), params, signal, undefined, ctx);
		},
	};
}

function captureSupervisorPolling(t: TestContext, allowedDirs: Set<string>) {
	const intervals = new Map<object, () => void>();
	const scans: string[] = [];
	const watches: string[] = [];
	let starts = 0;
	const set = globalThis.setInterval;
	const clear = globalThis.clearInterval;
	t.mock.method(globalThis, "setInterval", ((handler: () => void, delay: number, ...args: unknown[]) => {
		if (delay !== 250) return set(handler, delay, ...args);
		starts++;
		const token = { unref() {} };
		intervals.set(token, handler);
		return token;
	}) as typeof setInterval);
	t.mock.method(globalThis, "clearInterval", ((token: ReturnType<typeof setInterval>) => {
		if (!intervals.delete(token)) clear(token);
	}) as typeof clearInterval);
	const channelRoot = path.dirname(resolveSupervisorChannelDir("fixture", "worker", 0));
	const readdir = fsDefault.readdirSync;
	const watch = fsDefault.watch;
	t.mock.method(fsDefault, "readdirSync", ((dir: fs.PathLike, options: unknown) => {
		if (String(dir).startsWith(channelRoot)) scans.push(String(dir));
		return (readdir as (dir: fs.PathLike, options: unknown) => unknown)(dir, options);
	}) as typeof fsDefault.readdirSync);
	t.mock.method(fsDefault, "watch", ((dir: fs.PathLike, ...args: unknown[]) => {
		if (String(dir).startsWith(channelRoot)) watches.push(String(dir));
		return (watch as (dir: fs.PathLike, ...args: unknown[]) => fs.FSWatcher)(dir, ...args);
	}) as typeof fsDefault.watch);
	syncBuiltinESMExports();
	return {
		intervals, scans, get starts() { return starts; },
		tick() { for (const handler of [...intervals.values()]) handler(); },
		assertScoped() {
			assert.deepEqual(watches, [], "coordinator must not watch supervisor channels");
			for (const dir of scans) assert.ok(allowedDirs.has(dir), `Unexpected supervisor scan: ${dir}`);
		},
		restore() { t.mock.restoreAll(); syncBuiltinESMExports(); },
	};
}

describe("supervisor ask registration", () => {
	for (const platform of ["darwin", "win32", "linux"] as const) {
		it(`drains foreground and workflow progress completed between ticks exactly once (${platform})`, async (t) => {
			clearExclusions();
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-final-progress-"));
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = root;
			fs.mkdirSync(path.join(root, "agents"), { recursive: true });
			fs.writeFileSync(path.join(root, "agents", "leaf.md"), "---\nname: leaf\ndescription: Read-only leaf\ntools: read, contact_supervisor\nmodel: mock/test-model\n---\nInspect only.\n");
			const launch = buildInProcessChildLaunch({
				host: "parent", cwd: root, childAgentName: "coordinator", childIndex: 0,
				sessionEnabled: false, tools: ["subagent", "subagent_supervisor"],
				inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			});
			const abort = new AbortController();
			const runtime = hookRuntime(launch.session, platform, abort.signal);
			const allowed = new Set<string>();
			const polling = captureSupervisorPolling(t, allowed);
			const updates: string[] = [];
			const leaves: ReturnType<typeof hookRuntime>[] = [];
			setChildSessionFactory({
				async create(childLaunch) {
					const leaf = hookRuntime(childLaunch, platform, abort.signal);
					leaves.push(leaf);
					const dir = childLaunch.runtime.supervisorChannelDir!;
					createdChannels.push(dir);
					allowed.add(path.join(dir, "requests"));
					assert.equal(childLaunch.runtime.orchestratorSessionId, runtime.owner);
					await leaf.emit("session_start");
					return {
						sessionId: leaf.owner, sessionFile: leaf.sessionFile, modelId: "mock/test-model", messages: [],
						subscribe: leaf.subscribe, steer: async () => {}, followUp: async () => {},
						abort: async () => { abort.abort(); }, dispose: () => leaf.emit("session_shutdown"),
						async prompt() {
							await leaf.emit("agent_start");
							const progress = await leaf.call("contact_supervisor", { reason: "progress_update", message: "Inspection complete." });
							updates.push(progress.details.requestId!);
							await leaf.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Inspection complete." }], model: "mock/test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
							await leaf.emit("agent_end");
							await leaf.emit("agent_settled");
						},
					};
				},
				async dispose() {},
			});
			try {
				for (let i = 0; i < 100; i++) writeRequest({ sessionId: runtime.owner, runId: randomUUID(), reason: "progress_update" });
				await runtime.emit("session_start");
				assert.equal(polling.intervals.size, 0);
				assert.equal(polling.scans.length, 0);
				for (const mode of ["foreground", "workflow"] as const) {
					const params = mode === "foreground"
						? { agent: "leaf", task: "Inspect read-only and report progress.", async: false, output: false }
						: { workflowScript: "return runs.run('inspect', { agent: 'leaf', task: 'Inspect read-only and report progress.', async: false, output: false });", async: false };
					const result = await runtime.call("subagent", params);
					assert.notEqual(result.isError, true, text(result));
					assert.equal(leaves.at(-1)!.closed, true, "child starts and completes without a timer tick");
					assert.equal(polling.intervals.size, 1, "final mailbox drain remains scheduled");
					const scansBeforeDrain = polling.scans.length;
					polling.tick();
					assert.equal(polling.scans.length, scansBeforeDrain + 1, "terminal child gets exactly one final mailbox scan");
					assert.deepEqual(runtime.notices.map(notice => notice.details?.requestId), updates);
					polling.assertScoped();
					assert.equal(polling.intervals.size, 0, "last drain retires the poller");
					const scans = polling.scans.length;
					polling.tick();
					await runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "pending" });
					assert.equal(polling.scans.length, scans, "retired mailboxes are not scanned by idle queries");
					assert.equal(runtime.notices.length, updates.length, "no duplicate notifications");
				}
				assert.equal(polling.starts, 2, "next launch rearms polling");
			} finally {
				abort.abort();
				setChildSessionFactory(undefined);
				for (const leaf of leaves) await leaf.emit("session_shutdown");
				await runtime.emit("session_shutdown");
				polling.restore();
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it(`drains direct-async progress completed between ticks and retires only owned mailboxes (${platform})`, async (t) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-async-final-progress-"));
			const launch = buildInProcessChildLaunch({
				host: "parent", cwd: root, childAgentName: "coordinator", childIndex: 0,
				sessionEnabled: false, tools: ["subagent", "subagent_supervisor"],
				inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			});
			const runtime = hookRuntime(launch.session, platform, new AbortController().signal);
			const allowed = new Set<string>();
			const polling = captureSupervisorPolling(t, allowed);
			try {
				await runtime.emit("session_start");
				assert.equal(polling.intervals.size, 0);
				for (let cycle = 0; cycle < 2; cycle++) {
					const runId = randomUUID();
					const dir = resolveSupervisorChannelDir(runId, "leaf", 0);
					allowed.add(path.join(dir, "requests"));
					const unrelatedRun = randomUUID();
					writeRequest({ sessionId: runtime.owner, runId: unrelatedRun, reason: "progress_update" });
					runtime.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: unrelatedRun, asyncDir: root, agent: "worker", sessionId: "foreign-session" });
					fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({ runId, state: "running" }));
					runtime.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: runId, asyncDir: root, agent: "leaf", sessionId: runtime.sessionFile });
					assert.equal(polling.intervals.size, 1);
					const progress = writeRequest({ sessionId: runtime.owner, runId, agent: "leaf", reason: "progress_update" });
					const foreign = writeRequest({ sessionId: "foreign-owner", runId, agent: "leaf", reason: "progress_update" });
					fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({ runId, state: "complete" }));
					const scans = polling.scans.length;
					polling.tick();
					assert.equal(runtime.notices.at(-1)?.details?.requestId, progress);
					polling.assertScoped();
					assert.equal(runtime.notices.length, cycle + 1);
					assert.equal(polling.scans.length, scans + 1, "terminal mailbox gets exactly one final scan");
					assert.equal(fs.existsSync(path.join(dir, "requests", `${progress}.json`)), false);
					assert.equal(fs.existsSync(path.join(dir, "requests", `${foreign}.json`)), true, "foreign requests are never accepted or deleted");
					assert.equal(polling.intervals.size, 0);
					await runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "pending" });
					polling.tick();
					assert.equal(polling.scans.length, scans + 1);
					assert.equal(runtime.notices.length, cycle + 1);
				}
				assert.equal(polling.starts, 2);
				const live = randomUUID();
				allowed.add(path.join(resolveSupervisorChannelDir(live, "leaf", 0), "requests"));
				fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({ runId: live, state: "running" }));
				runtime.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: live, asyncDir: root, agent: "leaf", sessionId: runtime.sessionFile });
				assert.equal(polling.intervals.size, 1);
				await runtime.emit("session_shutdown");
				assert.equal(polling.intervals.size, 0, "shutdown closes live polling too");
			} finally {
				await runtime.emit("session_shutdown");
				polling.restore();
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}

	for (const platform of ["darwin", "win32"] as const) {
		it(`answers nested A → B → C asks through the child hooks and executor (${platform})`, { timeout: 15_000 }, async () => {
			clearExclusions();
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-supervisor-"));
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = root;
			const agentsDir = path.join(root, "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			fs.writeFileSync(path.join(agentsDir, "leaf.md"), "---\nname: leaf\ndescription: Read-only leaf\ntools: read, contact_supervisor\nmodel: mock/test-model\n---\nInspect only.\n");
			const a = randomUUID();
			const parentTools = new Map<string, SupervisorTool>();
			const parent = createNativeSupervisorChannel(makePi({ tools: parentTools }) as never, makeState(a, makeCtx(a)), { platform });
			const runtimes: ReturnType<typeof hookRuntime>[] = [];
			const workflows: string[] = [];
			let cRequest: string | undefined;
			let cReturned = false;
			let bReturned = false;
			const abort = new AbortController();
			const factory: ChildSessionFactory = {
				async create(launch) {
					const runtime = hookRuntime(launch, platform, abort.signal);
					runtimes.push(runtime);
					if (launch.runtime.supervisorChannelDir) createdChannels.push(launch.runtime.supervisorChannelDir);
					await runtime.emit("session_start");
					return {
						sessionId: runtime.owner, sessionFile: runtime.sessionFile, modelId: "mock/test-model", messages: [],
						subscribe: runtime.subscribe,
						steer: async () => { throw new Error("steering is not a supervisor reply"); },
						followUp: async () => { throw new Error("follow-up is not a supervisor reply"); },
						abort: async () => { abort.abort(); },
						dispose: () => runtime.emit("session_shutdown"),
						async prompt() {
							await runtime.emit("agent_start");
							if (launch.runtime.agent === "coordinator") {
								assert.ok(runtime.registered.has(NATIVE_SUPERVISOR_TOOL_NAME), "B needs a native downward provider");
								assert.ok(runtime.active().includes(NATIVE_SUPERVISOR_TOOL_NAME), "B's requested supervisor tool must be callable");
								const receipt = await runtime.call("subagent", {
									workflowScript: "return runs.run('inspect', { agent: 'leaf', task: 'Inspect the repository read-only and ask which option to report.', async: false });",
									async: true,
								});
								assert.notEqual(receipt.isError, true, text(receipt));
								workflows.push(receipt.details.asyncDir);
								// No explicit pending scan: executor activation must discover C's delayed ask.
								await waitForCondition(() => runtime.notices.length > 0, "B to discover C's ask without a manual scan");
								const pending = await runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "pending" });
								const [ask] = pending.details.pending;
								cRequest = ask.id;
								assert.equal(ask.agent, "leaf");
								assert.equal(cReturned, false);
								await assert.rejects(parentTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("foreign", { action: "reply", replyTo: cRequest, message: "A cannot answer C" }), /No pending supervisor request found/);
								await assert.rejects(runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "reply", replyTo: "wrong-request-id", message: "Wrong" }), /No pending supervisor request found/);
								const escalation = await runtime.call("contact_supervisor", { reason: "need_decision", message: "C needs a choice; may I approve option A?" });
								assert.match(text(escalation), /Approve option A/);
								assert.equal(cReturned, false, "A's answer to B must not unblock C");
								const reply = await runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "reply", replyTo: cRequest, message: "Use option A" });
								assert.equal(reply.details.replyTo, cRequest);
								bReturned = true;
							} else {
								assert.equal(launch.runtime.agent, "leaf");
								assert.equal(launch.runtime.orchestratorSessionId, runtimes[0]!.owner, "C belongs to B's exact runtime id, not A or B's file");
								assert.equal(runtime.registered.has(NATIVE_SUPERVISOR_TOOL_NAME), false, "leaf must not get downward authority");
								await new Promise(resolve => setTimeout(resolve, 25));
								const reply = await runtime.call("contact_supervisor", { reason: "need_decision", message: "Which option?" });
								assert.equal(reply.details.requestId, cRequest);
								assert.match(text(reply), /Use option A/);
								cReturned = true;
							}
							await runtime.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Inspection complete." }], model: "mock/test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
							await runtime.emit("agent_end");
							await runtime.emit("agent_settled");
						},
					};
				},
				async dispose() {},
			};
			try {
				parent.start();
				setChildSessionFactory(factory);
				const run = runSync(root, [makeAgent("coordinator", { model: "mock/test-model", tools: ["read", "subagent", "contact_supervisor", "subagent_supervisor"] })], "coordinator", "Inspect read-only with the assigned leaf.", {
					runId: randomUUID(), parentSessionId: a, orchestratorIntercomTarget: "shared-name", signal: abort.signal,
				});
				await waitForCondition(() => runtimes.length > 0, "coordinator startup");
				// Surface diagnostic failures immediately rather than hiding them behind an ask timeout.
				const result = await Promise.race([
					run.then(result => { assert.equal(result.exitCode, 0, result.error); return result; }),
					(async () => {
						await waitForCondition(() => {
							// A may be idle; its explicit query is authoritative.
							void parentTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });
							return parent.pending.size > 0;
						}, "B's escalation to A");
						const [ask] = parent.pending.values();
						assert.equal(ask!.agent, "coordinator");
						assert.notEqual(ask!.id, cRequest);
						await parentTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", { action: "reply", replyTo: ask!.id, message: "Approve option A" });
						return await run;
					})(),
				]);
				assert.equal(result.exitCode, 0, result.error);
				assert.equal(bReturned, true);
				assert.equal(cReturned, true, "B's final drain must await C's real blocked contact call and workflow completion");
				for (const dir of workflows) {
					const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
					assert.equal(status.state, "complete", JSON.stringify(status));
				}
				for (const runtime of runtimes) assert.equal(runtime.closed, true);
				const stale = writeRequest({ sessionId: runtimes[0]!.owner, runId: randomUUID() });
				await assert.rejects(runtimes[0]!.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "reply", replyTo: stale, message: "No authority after shutdown" }), /No pending supervisor request found/);
			} finally {
				abort.abort();
				setChildSessionFactory(undefined);
				for (const runtime of runtimes) await runtime.emit("session_shutdown");
				parent.dispose();
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				for (const dir of workflows) fs.rmSync(dir, { recursive: true, force: true });
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("discovers a direct async child's ask without polling pending on Darwin", { timeout: 5000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-async-supervisor-"));
		const launch = buildInProcessChildLaunch({
			host: "parent", cwd: root, childAgentName: "coordinator", childIndex: 0,
			sessionEnabled: false, tools: ["subagent", "subagent_supervisor"],
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		});
		const abort = new AbortController();
		const runtime = hookRuntime(launch.session, "darwin", abort.signal);
		const runId = randomUUID();
		const channelDir = resolveSupervisorChannelDir(runId, "leaf", 0);
		createdChannels.push(channelDir);
		const childTools = new Map<string, SupervisorTool>();
		registerNativeSupervisorClient(makePi({ tools: childTools }) as never, { channelDir, runId, agent: "leaf", childIndex: 0, orchestratorSessionId: runtime.owner });
		let request: Promise<{ content: Array<{ type: string; text?: string }> }> | undefined;
		const contact = childTools.get("contact_supervisor") as unknown as {
			execute(id: string, params: { reason: string; message: string }, signal: AbortSignal): NonNullable<typeof request>;
		};
		try {
			await runtime.emit("session_start");
			fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({ runId, state: "running" }));
			runtime.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: runId, asyncDir: root, agent: "leaf", sessionId: runtime.sessionFile });
			request = contact.execute("ask", { reason: "need_decision", message: "Which option?" }, abort.signal);
			// Attach rejection handling before any assertion can abort the child.
			void request!.catch(() => {});
			await waitForCondition(() => runtime.notices.length > 0, "direct async ask notification");
			const pending = await runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "pending" });
			await runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "reply", replyTo: pending.details.pending[0]!.id, message: "Use option A" });
			assert.match(text(await request), /Use option A/);
		} finally {
			abort.abort();
			await request?.catch(() => {});
			await runtime.emit("session_shutdown");
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not activate supervision when the coordinator excludes the reply tool", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-no-supervisor-"));
		const launch = buildInProcessChildLaunch({
			host: "parent", cwd: root, childAgentName: "coordinator", childIndex: 0,
			sessionEnabled: false, tools: ["subagent"],
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		});
		const runtime = hookRuntime(launch.session, "win32", new AbortController().signal);
		const runId = randomUUID();
		try {
			writeRequest({ sessionId: runtime.owner, runId });
			await runtime.emit("session_start");
			runtime.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: runId, asyncDir: root, agent: "worker", sessionId: runtime.sessionFile });
			await new Promise(resolve => setTimeout(resolve, 600));
			assert.equal(runtime.notices.length, 0, "no instructions to call an excluded reply tool");
			await assert.rejects(runtime.call(NATIVE_SUPERVISOR_TOOL_NAME, { action: "pending" }), /not active/);
			await assert.rejects(runtime.call("subagent", { action: "schedule.run", id: "not-authorized" }), /not available/);
		} finally {
			await runtime.emit("session_shutdown");
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wires fresh pending-ask lookup into the child-safe steering executor", async () => {
		fs.mkdirSync(DIRS.async, { recursive: true });
		const root = fs.mkdtempSync(path.join(DIRS.async, "child-blocked-steer-"));
		const launch = buildInProcessChildLaunch({
			host: "parent", cwd: root, childAgentName: "coordinator", childIndex: 0,
			sessionEnabled: false, tools: ["subagent", "subagent_supervisor"],
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		});
		const runtime = hookRuntime(launch.session, "darwin", new AbortController().signal);
		try {
			await runtime.emit("session_start");
			const runId = randomUUID();
			const requestId = writeRequest({ sessionId: runtime.owner, runId });
			const status = JSON.stringify({ runId, sessionId: runtime.sessionFile, state: "running", mode: "single", pid: process.pid, startedAt: Date.now(), steps: [{ agent: "worker", status: "running" }] });
			fs.writeFileSync(path.join(root, "status.json"), status);
			await assert.rejects(runtime.call("subagent", { action: "steer", dir: root, message: "After the decision, inspect docs." }), (error: Error) => {
				assert.ok(error.message.includes(`"replyTo":"${requestId}"`), error.message);
				assert.match(error.message, /not delivered or queued/);
				return true;
			});
			assert.equal(runtime.notices.length, 0, "receipt lookup must not register or notify");
			assert.equal(fs.readFileSync(path.join(root, "status.json"), "utf8"), status);
			assert.deepEqual(fs.readdirSync(path.join(resolveSupervisorChannelDir(runId, "worker", 0), "replies")), []);
		} finally {
			await runtime.emit("session_shutdown");
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("public single async steering reports exact pending asks without reply, queue or recovery", async () => {
		const owner = randomUUID();
		fs.mkdirSync(DIRS.async, { recursive: true });
		const root = fs.mkdtempSync(path.join(DIRS.async, "blocked-steer-"));
		const ctx = { ...makeCtx(owner, path.join(root, "parent.jsonl")), cwd: root };
		const state = makeState(ctx.sessionManager.getSessionFile(), ctx);
		state.lastUiContext = null;
		const runId = randomUUID();
		const channel = createNativeSupervisorChannel(makePi({ tools: new Map(), onSend: () => { throw new Error("lookup must not notify"); } }) as never, state);
		let probes = 0;
		let race = false;
		let racedAsk: string | undefined;
		const executor = createSubagentExecutor({
			pi: {} as never, state, config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never,
			asyncByDefault: false, tempArtifactsDir: root, getSubagentSessionRoot: () => root,
			expandTilde: value => value, discoverAgents: () => ({ agents: [] }),
			findPendingAsks: target => {
				const asks = channel.findPendingAsks(target);
				if (race) racedAsk = writeRequest({ sessionId: owner, runId });
				return asks;
			},
			kill: () => { probes++; return true; },
		});
		const status = { runId, sessionId: ctx.sessionManager.getSessionFile(), state: "running", mode: "single", pid: process.pid, startedAt: Date.now(), updatedAt: Date.now(), steps: [{ agent: "worker", status: "running" }] };
		fs.writeFileSync(path.join(root, "status.json"), JSON.stringify(status));
		const invoke = (mode: "steer" | "follow_up") => executor.executePublic(randomUUID(), { action: "steer", dir: root, message: "After this is resolved, update docs.", mode }, new AbortController().signal, undefined, ctx as never);
		try {
			const first = writeRequest({ sessionId: owner, runId });
			const second = writeRequest({ sessionId: owner, runId });
			for (const mode of ["steer", "follow_up"] as const) {
				const result = await invoke(mode);
				assert.equal(result.isError, true);
				assert.match(text(result), /not delivered or queued/);
				assert.match(text(result), /ambiguous/);
				for (const id of [first, second]) assert.ok(text(result).includes(`"replyTo":"${id}"`));
				assert.equal(result.details?.steering, undefined);
			}
			assert.deepEqual(fs.readdirSync(root), ["status.json"]);
			assert.equal(fs.readFileSync(path.join(root, "status.json"), "utf8"), JSON.stringify(status));
			assert.equal(channel.pending.size, 0);
			const dir = resolveSupervisorChannelDir(runId, "worker", 0);
			assert.deepEqual(fs.readdirSync(path.join(dir, "replies")), []);
			fs.rmSync(path.join(dir, "requests", `${second}.json`));
			assert.doesNotMatch(text(await invoke("follow_up")), /ambiguous/);
			assert.equal(probes, 0, "blocked branch precedes reconciliation/control");
			fs.rmSync(path.join(dir, "requests", `${first}.json`));
			status.steps[0]!.status = "pending";
			fs.writeFileSync(path.join(root, "status.json"), JSON.stringify(status));
			race = true;
			const raced = await invoke("follow_up");
			assert.equal(raced.isError, undefined);
			assert.equal(raced.details?.steering?.state, "scheduled");
			assert.equal(raced.details?.steering?.deliveryStatus, "queued");
			assert.match(text(raced), /Steering scheduled/);
			assert.doesNotMatch(text(raced), /unblocked|consumed/);
			assert.ok(fs.existsSync(path.join(dir, "requests", `${racedAsk}.json`)));
			assert.deepEqual(fs.readdirSync(path.join(dir, "replies")), []);
		} finally { channel.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("receipt lookup is read-only, fresh and exact for runtime owner, run, agent and index", () => {
		const owner = randomUUID(), runId = randomUUID();
		const state = makeState("/sessions/parent.jsonl", makeCtx(owner));
		state.lastUiContext = null;
		const channel = createNativeSupervisorChannel({} as never, state);
		const target = { runId, agent: "worker", childIndex: 0 };
		const live = writeRequest({ sessionId: owner, runId });
		const excluded = [
			writeRequest({ sessionId: "foreign", runId }),
			writeRequest({ sessionId: owner, runId, expiresAt: Date.now() - 1 }),
			writeRequest({ sessionId: owner, runId, reason: "progress_update" }),
		];
		const resolved = writeRequest({ sessionId: owner, runId });
		const dir = resolveSupervisorChannelDir(runId, "worker", 0);
		fs.writeFileSync(path.join(dir, "replies", `${resolved}.json`), "{}");
		// Put mismatched metadata in the exact target directory, not just another directory.
		for (const mismatch of [{ runId: "other" }, { agent: "other" }, { childIndex: 1 }]) {
			const id = writeRequest({ sessionId: owner, runId });
			const file = path.join(dir, "requests", `${id}.json`);
			fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...mismatch }));
			excluded.push(id);
		}
		assert.deepEqual(channel.findPendingAsks(target), [live]);
		assert.equal(channel.pending.size, 0);
		for (const id of [...excluded, resolved]) assert.ok(fs.existsSync(path.join(dir, "requests", `${id}.json`)));
		fs.rmSync(path.join(dir, "requests", `${live}.json`));
		assert.deepEqual(channel.findPendingAsks(target), []);
		state.supervisorOwnerSessionId = null;
		writeRequest({ sessionId: owner, runId });
		assert.deepEqual(channel.findPendingAsks(target), []);
		state.supervisorOwnerSessionId = owner;
		state.asyncJobs.set(runId, { status: "complete" } as never);
		assert.deepEqual(channel.findPendingAsks(target), [], "terminal child asks are not live");
		channel.dispose();
	});

	it("discovers delayed asks through Darwin workflow registration, control release, terminal and rearm", async () => {
		const sessionId = randomUUID();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-demand-"));
		const ctx = { ...makeCtx(sessionId), cwd: root };
		const state = makeState(sessionId, ctx);
		const intervals = new Map<object, () => void>();
		let starts = 0;
		let unrefs = 0;
		const sent: string[] = [];
		const pi = {
			getAllTools: () => [], registerTool() {}, getSessionName: () => "parent",
			events: { emit() {}, on() { return () => {}; } },
			sendMessage(message: { details?: { id?: string } }) { if (message.details?.id) sent.push(message.details.id); },
		};
		const channel = createNativeSupervisorChannel(pi as never, state, {
			platform: "darwin",
			watch: (() => { throw new Error("Darwin must not call fs.watch"); }) as never,
			timers: {
				setInterval: ((handler: () => void, delay: number) => {
					assert.equal(delay, 250);
					starts += 1;
					const token = { unref() { unrefs += 1; } };
					intervals.set(token, handler);
					return token;
				}) as typeof setInterval,
				clearInterval: ((token: object) => { intervals.delete(token); }) as typeof clearInterval,
				setImmediate, clearImmediate,
			},
		});
		const tick = () => { for (const handler of [...intervals.values()]) handler(); };
		let terminal: () => void = () => {};
		const executor = createSubagentExecutor({
			pi: pi as never, state, config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never,
			asyncByDefault: false, tempArtifactsDir: root, getSubagentSessionRoot: () => root,
			expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }),
			activateSupervisorTransport: () => channel.activateTransport(),
			refreshResultDelivery: () => { if ([...state.asyncJobs.values()].every(job => job.status !== "running" && job.status !== "queued")) terminal(); },
		});
		const dirs: string[] = [];
		try {
			channel.start();
			channel.activateTransport();
			assert.equal(intervals.size, 0, "idle registration has no timer");
			for (let cycle = 0; cycle < 2; cycle += 1) {
				const done = new Promise<void>(resolve => { terminal = resolve; });
				const result = await executor.executePublic(randomUUID(), { workflowScript: "return [];", async: true }, new AbortController().signal, undefined, ctx as never);
				assert.equal(result.isError, undefined, JSON.stringify(result));
				const runId = result.details!.asyncId!;
				const job = state.asyncJobs.get(runId)!;
				dirs.push(job.asyncDir);
				assert.equal(job.status, "running");
				assert.equal(state.foregroundControls.size, 0);
				const delayedAsk = writeRequest({ sessionId, runId });
				tick();
				assert.ok(sent.includes(delayedAsk), "lone registered workflow must discover a delayed ask without a query or foreground activation");
				assert.equal(intervals.size, 1);
				assert.equal(starts, cycle + 1);
				const controlId = randomUUID();
				// Model the unchanged foreground insertion/activation and last-control removal.
				state.foregroundControls.set(controlId, { runId: controlId, activeChildren: new Map(), schedulingOwners: 1 } as never);
				channel.activateTransport();
				assert.equal(starts, cycle + 1, "foreground activation reuses the poller");
				state.foregroundControls.delete(controlId);
				fs.rmSync(channel.pending.get(delayedAsk)!.requestFile);
				tick();
				assert.equal(channel.pending.size, 0);
				assert.equal(intervals.size, 1, "workflow demand survives last control and ask removal");
				const laterAsk = writeRequest({ sessionId, runId });
				tick();
				assert.ok(sent.includes(laterAsk));
				fs.rmSync(channel.pending.get(laterAsk)!.requestFile);
				await done;
				assert.equal(job.status, "complete");
				tick();
				assert.equal(intervals.size, 0, "terminal work and empty channel directories do not keep polling");
			}
			assert.equal(unrefs, 2);
		} finally {
			channel.dispose();
			for (const controller of state.workflowControllers?.values() ?? []) controller.abort();
			for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("caches runtime ownership at extension session_start and clears it at shutdown despite stale UI", () => {
		const script = String.raw`
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import os from "node:os";
			import path from "node:path";
			import { randomUUID } from "node:crypto";
			import registerExtension from "./index.ts";
			import { resolveSupervisorChannelDir, ensureSupervisorChannelDir } from "./src/intercom/native-supervisor-channel.ts";
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-owner-"));
			const channels = [];
			async function start(owner) {
				const handlers = new Map();
				const tools = new Map();
				const pi = new Proxy({
					events: { on() { return () => {}; }, emit() {} },
					on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
					getAllTools() { return [...tools.keys()].map(name => ({ name })); },
					registerTool(tool) { tools.set(tool.name, tool); },
					registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
				}, { get(target, key) { return key in target ? target[key] : () => undefined; } });
				const sessionFile = path.join(root, owner + ".jsonl");
				fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: owner, timestamp: new Date().toISOString(), cwd: root }) + "\n");
				let stale = false;
				const ctx = {
					cwd: root,
					get hasUI() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return false; },
					ui: { setWidget() {}, requestRender() {}, onTerminalInput() { return () => {}; }, notify() {}, theme: { fg(_name, text) { return text; }, bold(text) { return text; } } },
					sessionManager: {
						getSessionId() { if (stale) throw new Error("stale session manager"); return owner; },
						getSessionFile() { return sessionFile; }, getEntries() { return []; },
					},
					modelRegistry: { getAvailable() { return []; } },
				};
				registerExtension(pi);
				for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
				stale = true;
				// Exercise the production stale-context clearing path, not direct state assignment.
				for (const handler of handlers.get("session_before_compact") ?? []) await handler({ reason: "threshold", signal: new AbortController().signal });
				return { tool: tools.get("subagent_supervisor"), shutdown: async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler(); } };
			}
			function ask(owner) {
				const id = randomUUID();
				const runId = randomUUID();
				const dir = resolveSupervisorChannelDir(runId, "worker", 0);
				channels.push(dir);
				ensureSupervisorChannelDir(dir);
				fs.writeFileSync(path.join(dir, "requests", id + ".json"), JSON.stringify({ type: "subagent.supervisor.request", id, createdAt: Date.now(), reason: "need_decision", message: "Decision?", expectsReply: true, orchestratorSessionId: owner, runId, agent: "worker", childIndex: 0 }));
				return id;
			}
			let runtime;
			try {
				const owner = randomUUID();
				runtime = await start(owner);
				const first = ask(owner);
				assert.match(JSON.stringify(await runtime.tool.execute("pending", { action: "pending" })), new RegExp(first));
				await runtime.shutdown();
				const afterShutdown = ask(owner);
				await assert.rejects(runtime.tool.execute("reply", { action: "reply", replyTo: afterShutdown, message: "No authority" }), /No pending supervisor request found/);
				runtime = undefined;
				const replacement = randomUUID();
				runtime = await start(replacement);
				await assert.rejects(runtime.tool.execute("reply", { action: "reply", replyTo: first, message: "Foreign" }), /No pending supervisor request found/);
				const next = ask(replacement);
				assert.match(JSON.stringify(await runtime.tool.execute("reply", { action: "reply", replyTo: next, message: "Approved" })), new RegExp(next));
			} finally {
				await runtime?.shutdown();
				for (const dir of channels) fs.rmSync(dir, { recursive: true, force: true });
				fs.rmSync(root, { recursive: true, force: true });
			}
		`;
		const env = { ...process.env };
		delete env.PI_SUBAGENT_CHILD;
		execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script], { cwd: process.cwd(), env, stdio: "pipe", timeout: 30_000 });
	});

	it("fails closed for explicit mistargets and ambiguity without UI, then answers only the exact ask", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(`/sessions/${sessionId}.jsonl`, makeCtx(sessionId));
		state.lastUiContext = null;
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });
		try {
			channel.start();
			const first = writeRequest({ sessionId, runId });
			const tool = tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!;
			await assert.rejects(tool.execute("wrong", { action: "reply", to: "different-agent", message: "Approved" }), /No pending supervisor request matches/);
			await assert.rejects(tool.execute("unknown", { action: "reply", replyTo: "unknown", message: "Approved" }), /No pending supervisor request found/);
			assert.equal(channel.pending.has(first), true);
			const second = writeRequest({ sessionId, runId });
			await assert.rejects(tool.execute("ambiguous", { action: "reply", message: "Approved" }), /Multiple pending supervisor requests/);
			await assert.rejects(tool.execute("agent", { action: "reply", to: "worker", message: "Approved" }), /Multiple pending supervisor requests match/);
			const replies = path.join(resolveSupervisorChannelDir(runId, "worker", 0), "replies");
			assert.deepEqual(fs.readdirSync(replies), []);
			await tool.execute("exact", { action: "reply", replyTo: second, message: "Only second" });
			assert.deepEqual(fs.readdirSync(replies), [`${second}.json`]);
			assert.equal(JSON.parse(fs.readFileSync(path.join(replies, `${second}.json`), "utf8")).message, "Only second");
			assert.equal(channel.pending.has(first), true);
			assert.equal(channel.pending.has(second), false);
		} finally { channel.dispose(); }
	});

	it("rejects stale discovered and cached asks with no UI", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(`/sessions/${sessionId}.jsonl`, makeCtx(sessionId));
		state.lastUiContext = null;
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });
		try {
			channel.start();
			const tool = tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!;
			const expired = writeRequest({ sessionId, runId, expiresAt: Date.now() - 1 });
			await assert.rejects(tool.execute("expired", { action: "reply", replyTo: expired, message: "Too late" }), /No pending supervisor request found/);
			const missing = writeRequest({ sessionId, runId });
			const resolved = writeRequest({ sessionId, runId });
			await tool.execute("pending", { action: "pending" });
			assert.equal(channel.pending.size, 2);
			const dir = resolveSupervisorChannelDir(runId, "worker", 0);
			fs.rmSync(path.join(dir, "requests", `${missing}.json`));
			const replyFile = path.join(dir, "replies", `${resolved}.json`);
			fs.writeFileSync(replyFile, JSON.stringify({ message: "Already answered" }));
			for (const replyTo of [missing, resolved]) {
				await assert.rejects(tool.execute("stale", { action: "reply", replyTo, message: "Must not overwrite" }), /No pending supervisor request found/);
			}
			assert.equal(channel.pending.size, 0);
			assert.deepEqual(fs.readdirSync(path.join(dir, "replies")), [`${resolved}.json`]);
			assert.equal(JSON.parse(fs.readFileSync(replyFile, "utf8")).message, "Already answered");
		} finally { channel.dispose(); }
	});

	it("rechecks cached ownership without UI and never uses the persisted identity as authority", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });
		try {
			channel.start();
			const requestId = writeRequest({ sessionId, runId });
			const tool = tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!;
			await tool.execute("pending", { action: "pending" });
			assert.equal(channel.pending.has(requestId), true);
			state.lastUiContext = null;
			state.supervisorOwnerSessionId = `replacement-${randomUUID()}`;
			await assert.rejects(tool.execute("foreign", { action: "reply", replyTo: requestId, message: "Wrong owner" }), /No pending supervisor request found/);
			assert.equal(channel.pending.size, 0);
			state.supervisorOwnerSessionId = null;
			const uncached = writeRequest({ sessionId, runId });
			await assert.rejects(tool.execute("no-owner", { action: "reply", replyTo: uncached, message: "No authority" }), /No pending supervisor request found/);
			const dir = resolveSupervisorChannelDir(runId, "worker", 0);
			assert.equal(fs.existsSync(path.join(dir, "requests", `${requestId}.json`)), true, "foreign requests are not ours to delete");
			assert.deepEqual(fs.readdirSync(path.join(dir, "replies")), []);
		} finally { channel.dispose(); }
	});

	// D1: `refreshPendingRequests` only re-evaluates asks already in `pending`; it never reads the
	// filesystem. With no watcher installed and the demand-gated poller stopped, an ask written by
	// a child was unfindable by ANY number of `action:"pending"` calls.
	it("discovers an ask written while nothing was polling", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, {
			platform: "darwin",
			watch: (() => { throw new Error("darwin must not install a supervisor fs watcher"); }) as never,
			timers: {
				setInterval: (() => ({ unref() {} }) as NodeJS.Timeout) as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
				setImmediate,
				clearImmediate,
			},
		});

		try {
			channel.start();
			// The ask lands AFTER start(), so the start-time poll cannot have seen it.
			const requestId = writeRequest({ sessionId, runId });
			assert.equal(channel.pending.has(requestId), false, "precondition: nothing has scanned the ask yet");

			const result = await tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });

			assert.equal(channel.pending.has(requestId), true, "an explicit supervisor query must be authoritative against disk");
			assert.match(text(result), new RegExp(requestId), "the ask must be listed with its reply id");
		} finally {
			channel.dispose();
		}
	});

	it("accepts a reply to an ask that was never seen by a poller", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, makeState(sessionId, makeCtx(sessionId)), { platform: "darwin" });

		try {
			channel.start();
			const requestId = writeRequest({ sessionId, runId });

			const result = await tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", {
				action: "reply",
				replyTo: requestId,
				message: "Approved",
			});

			assert.notEqual(result.isError, true, text(result));
			const reply = path.join(resolveSupervisorChannelDir(runId, "worker", 0), "replies", `${requestId}.json`);
			assert.equal(fs.existsSync(reply), true, "the child's reply file must be written");
			assert.equal(JSON.parse(fs.readFileSync(reply, "utf-8")).message, "Approved");
		} finally {
			channel.dispose();
		}
	});

	it("discovers a runtime-owned ask with a persisted session path and null UI context", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const sessionFile = path.join(process.cwd(), `${sessionId}.jsonl`);
		const state = makeState(sessionFile, makeCtx(sessionId, sessionFile));
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });

		try {
			channel.start();
			state.lastUiContext = null;
			const requestId = writeRequest({ sessionId, runId });
			await tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });
			assert.equal(channel.pending.has(requestId), true, "a null lastUiContext must not drop the ask");
			assert.equal(state.currentSessionId, sessionFile, "global session identity must remain unchanged");
		} finally {
			channel.dispose();
		}
	});

	it("still refuses an ask that belongs to another session when the UI context is null", () => {
		const sessionId = `session-${randomUUID()}`;
		const foreignSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const foreignId = writeRequest({ sessionId: foreignSessionId, runId });
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(`/sessions/${sessionId}.jsonl`, makeCtx(sessionId));
		state.lastUiContext = null;
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });

		try {
			channel.start();
			assert.equal(channel.pending.has(foreignId), false, "session-ownership filtering must survive the null-context path");
		} finally {
			channel.dispose();
		}
	});

	it("retains a failed progress update until a later query accepts it without duplicate notifications", async () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(`/sessions/${sessionId}.jsonl`, makeCtx(sessionId));
		state.lastUiContext = null;
		let attempts = 0;
		let accepted = 0;
		let requestFile = "";
		let visibleText = "";
		const pi = makePi({ tools, onSend: (message) => {
			visibleText = message.content;
			attempts++;
			assert.equal(fs.existsSync(requestFile), true, "retain the update until sendMessage returns");
			if (attempts === 1) throw new Error("notification not accepted");
			accepted++;
		} });
		const channel = createNativeSupervisorChannel(pi as never, state, { platform: "darwin" });
		try {
			channel.start();
			const requestId = writeRequest({ sessionId, runId, reason: "progress_update" });
			requestFile = path.join(resolveSupervisorChannelDir(runId, "worker", 0), "requests", `${requestId}.json`);
			const tool = tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!;
			await tool.execute("failed", { action: "pending" });
			assert.equal(attempts, 1);
			assert.equal(accepted, 0);
			assert.equal(fs.existsSync(requestFile), true);
			assert.equal(channel.pending.size, 0, "a progress update must not become a blocking ask");
			await tool.execute("retry", { action: "pending" });
			assert.equal(attempts, 2);
			assert.equal(accepted, 1);
			assert.equal(fs.existsSync(requestFile), false);
			assert.ok(visibleText.includes(`Live guidance: subagent({ action: "steer", id: "${runId}", index: 0, message: "..." })`));
			assert.doesNotMatch(visibleText, /Reply with:|replyTo:|Child intercom target:/);
			await tool.execute("after-acceptance", { action: "pending" });
			assert.equal(attempts, 2);
			assert.equal(accepted, 1);
			assert.equal(channel.pending.size, 0);
		} finally { channel.dispose(); }
	});

	it("registers both asks even when every user-turn notification throws", () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({ sessionId, runId });
		const tools = new Map<string, SupervisorTool>();
		const pi = makePi({ tools, onSend: () => { throw new Error("no UI attached"); } });
		const secondId = writeRequest({ sessionId, runId });
		const channel = createNativeSupervisorChannel(pi as never, makeState(sessionId, makeCtx(sessionId)), { platform: "darwin" });

		try {
			channel.start();
			assert.equal(channel.pending.has(requestId), true, "a display failure must not lose an already-queued ask");
			assert.equal(channel.pending.has(secondId), true, "a display failure must not abort discovery of remaining asks");
		} finally {
			channel.dispose();
		}
	});

	// Drive the real child-side disk protocol: steering cannot resolve asks, explicit reply can.
	it("only unblocks the real contact_supervisor tool through an explicit reply, not steer or follow_up", async () => {
		const sessionId = `session-${randomUUID()}`;
		const workflowRunId = `workflow-${randomUUID()}`;
		const channelDir = resolveSupervisorChannelDir(workflowRunId, "worker", 0);
		createdChannels.push(channelDir);
		const supervisorTools = new Map<string, SupervisorTool>();
		const childTools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		const queued: ForegroundSteerInput[] = [];
		const control: ForegroundRunControl = {
			runId: workflowRunId, mode: "single", startedAt: 100, updatedAt: 100,
			activeChildren: new Map([[0, {
				index: 0, agent: "worker", startedAt: 100, updatedAt: 100,
				steer: async (input) => { queued.push(input); return { state: "queued" }; },
			}]]),
		};
		state.foregroundControls.set(workflowRunId, control);
		const channel = createNativeSupervisorChannel(makePi({ tools: supervisorTools }) as never, state, { platform: "darwin" });

		try {
			channel.start();
			registerNativeSupervisorClient(makePi({ tools: childTools }) as never, {
				channelDir,
				runId: workflowRunId,
				agent: "worker",
				childIndex: 0,
				orchestratorSessionId: sessionId,
			});
			const target = { control, workflowRunId, sourceRunId: workflowRunId };
			const ordinary = await steerWorkflowForegroundTarget({ target, message: "No ask is open here." });
			assert.equal(ordinary.details.steering?.state, "pending");
			assert.equal(ordinary.details.steering?.targets[0]?.state, "queued");
			assert.deepEqual(queued.splice(0), [{ message: "No ask is open here." }]);

			// The child blocks here exactly as it does in production: inside an open tool call,
			// polling its reply file.
			const blocked = childTools.get("contact_supervisor")!.execute("ask", {
				action: "ask",
				reason: "need_decision",
				message: "Which option should I take?",
			} as never);

			await waitForCondition(() => fs.readdirSync(path.join(channelDir, "requests")).length > 0, "the child's ask to reach disk");
			await supervisorTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });

			const requestId = [...channel.pending.keys()][0]!;
			assert.ok(requestId);
			const otherIndexAsk = writeRequest({ sessionId, runId: workflowRunId, index: 3 });
			await supervisorTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });
			for (const mode of ["steer", "follow_up"] as const) {
				const result = await steerWorkflowForegroundTarget({ target, message: "After this is resolved, update the docs.", mode });
				assert.equal(result.details.steering?.state, "pending");
				assert.equal(result.details.steering?.targets[0]?.state, "queued");
				assert.doesNotMatch(text(result), /the child is unblocked/);
				assert.equal(channel.pending.has(requestId), true);
				assert.equal(channel.pending.has(otherIndexAsk), true);
				assert.equal(fs.existsSync(path.join(channelDir, "replies", `${requestId}.json`)), false);
				assert.equal(fs.existsSync(path.join(channelDir, "requests", `${requestId}.json`)), true);
			}
			assert.deepEqual(queued, [
				{ message: "After this is resolved, update the docs." },
				{ message: "After this is resolved, update the docs.", mode: "follow_up" },
			]);
			await supervisorTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", {
				action: "reply", replyTo: requestId, message: "Take option A.",
			});

			const childResult = await blocked;
			assert.notEqual(childResult.isError, true, text(childResult));
			assert.match(text(childResult), /Take option A\./);
			assert.doesNotMatch(text(childResult), /update the docs/);
		} finally {
			channel.dispose();
		}
	});
});

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
