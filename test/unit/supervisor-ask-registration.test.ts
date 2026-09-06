import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import {
	NATIVE_SUPERVISOR_TOOL_NAME,
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	registerNativeSupervisorClient,
	resolveSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";
import { steerWorkflowForegroundTarget } from "../../src/runs/foreground/workflow-foreground-steering.ts";
import type { ForegroundRunControl, ForegroundSteerInput, SubagentState } from "../../src/shared/types.ts";

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

function makePi(options: { tools: Map<string, SupervisorTool>; onSend?: () => void }): Record<string, unknown> {
	return {
		getAllTools: () => [...options.tools.keys()].map((name) => ({ name })),
		registerTool: (tool: { name: string } & SupervisorTool) => { options.tools.set(tool.name, tool); },
		sendMessage: () => { options.onSend?.(); },
		getSessionName: () => "shared-name",
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
}

afterEach(() => {
	for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

describe("supervisor ask registration", () => {
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
			function start(owner) {
				const handlers = new Map();
				const tools = new Map();
				const pi = new Proxy({
					events: { on() { return () => {}; }, emit() {} },
					on(name, handler) { handlers.set(name, handler); },
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
				handlers.get("session_start")({ reason: "startup" }, ctx);
				stale = true;
				// Exercise the production stale-context clearing path, not direct state assignment.
				handlers.get("session_before_compact")({ reason: "threshold", signal: new AbortController().signal });
				return { tool: tools.get("subagent_supervisor"), shutdown: () => handlers.get("session_shutdown")() };
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
				runtime = start(owner);
				const first = ask(owner);
				assert.match(JSON.stringify(await runtime.tool.execute("pending", { action: "pending" })), new RegExp(first));
				await runtime.shutdown();
				const afterShutdown = ask(owner);
				await assert.rejects(runtime.tool.execute("reply", { action: "reply", replyTo: afterShutdown, message: "No authority" }), /No pending supervisor request found/);
				runtime = undefined;
				const replacement = randomUUID();
				runtime = start(replacement);
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
		const pi = makePi({ tools, onSend: () => {
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
