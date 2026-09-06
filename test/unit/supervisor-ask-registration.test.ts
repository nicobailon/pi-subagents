import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
	NATIVE_SUPERVISOR_TOOL_NAME,
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	registerNativeSupervisorClient,
	resolveSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";
import { steerWorkflowForegroundTarget } from "../../src/runs/foreground/workflow-foreground-steering.ts";
import type { ForegroundSteerInput, SubagentState } from "../../src/shared/types.ts";

const createdChannels: string[] = [];

interface SupervisorTool {
	execute: (id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

function makeState(sessionId: string | null, ctx: unknown): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: sessionId,
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

function makeCtx(sessionId: string): { cwd: string; hasUI: boolean; sessionManager: { getSessionId: () => string; getSessionFile: () => null; getEntries: () => [] } } {
	return {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => null,
			getEntries: () => [],
		},
	};
}

/**
 * Write an ask directly to the channel the way a child's `contact_supervisor` call does, without
 * going through a live poller. This is the state the wave-11 incident was in: the request file was
 * on disk and no scan had happened yet.
 */
function writeRequest(input: { sessionId: string; runId: string; agent?: string; index?: number; message?: string; reason?: "need_decision" | "progress_update" }): string {
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

function makePi(options: { tools: Map<string, SupervisorTool>; onSend?: () => void; onAppendEntry?: () => void }): Record<string, unknown> {
	return {
		getAllTools: () => [...options.tools.keys()].map((name) => ({ name })),
		registerTool: (tool: { name: string } & SupervisorTool) => { options.tools.set(tool.name, tool); },
		sendMessage: () => { options.onSend?.(); },
		getSessionName: () => "shared-name",
		...(options.onAppendEntry ? { appendEntry: () => { options.onAppendEntry!(); } } : {}),
	};
}

function registerWorkflowChild(state: SubagentState, workflowRunId: string, childRunId: string, steer: (input: ForegroundSteerInput) => Promise<{ state: "delivered" | "queued" | "failed"; reason?: string }>): void {
	state.workflowControllers ??= new Map();
	state.workflowControllers.set(workflowRunId, new AbortController());
	state.foregroundControls.set(childRunId, {
		runId: childRunId,
		parentWorkflowRunId: workflowRunId,
		workflowKey: childRunId,
		sessionId: "session",
		mode: "single",
		startedAt: 100,
		updatedAt: 100,
		activeChildren: new Map([[0, { index: 0, agent: "worker", startedAt: 100, updatedAt: 100, steer }]]),
		schedulingOwners: 1,
	} as never);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
}

afterEach(() => {
	delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
	for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

describe("supervisor ask registration", () => {
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

	// D3: `poll()` returned early whenever `state.lastUiContext` was null, which blinded the QUEUE
	// and not just the display. Session ownership is carried by `state.currentSessionId`.
	it("registers an ask with a null UI context", () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({ sessionId, runId });
		const tools = new Map<string, SupervisorTool>();
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, makeState(sessionId, null), { platform: "darwin" });

		try {
			channel.start();
			assert.equal(channel.pending.has(requestId), true, "a null lastUiContext must not drop the ask");
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
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, makeState(sessionId, null), { platform: "darwin" });

		try {
			channel.start();
			assert.equal(channel.pending.has(foreignId), false, "session-ownership filtering must survive the null-context path");
		} finally {
			channel.dispose();
		}
	});

	it("keeps a queued ask when the user-turn notification throws", () => {
		const sessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({ sessionId, runId });
		const tools = new Map<string, SupervisorTool>();
		const pi = makePi({ tools, onSend: () => { throw new Error("no UI attached"); } });
		const channel = createNativeSupervisorChannel(pi as never, makeState(sessionId, makeCtx(sessionId)), { platform: "darwin" });

		try {
			channel.start();
			assert.equal(channel.pending.has(requestId), true, "a display failure must not lose an already-queued ask");
		} finally {
			channel.dispose();
		}
	});

	// D4: a child inside `contact_supervisor` has no turn boundary, so `child.steer` can only
	// return "queued" into a queue that never drains. The steer must instead answer the open ask.
	it("answers a blocked child's open ask when a steer targets it", async () => {
		const sessionId = `session-${randomUUID()}`;
		const workflowRunId = `workflow-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		const queued: string[] = [];
		registerWorkflowChild(state, workflowRunId, workflowRunId, async (input) => {
			queued.push(input.message);
			return { state: "queued" as const };
		});
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });

		try {
			channel.start();
			const requestId = writeRequest({ sessionId, runId: workflowRunId });
			await tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });
			assert.equal(channel.pending.has(requestId), true, "precondition: the child is blocked on a registered ask");

			const control = state.foregroundControls.get(workflowRunId)!;
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: workflowRunId },
				message: "RULING VIA STEER: proceed with option A.",
			});

			assert.equal(result.details.steering?.state, "delivered", "the steer must report a real delivery, not a queue");
			assert.match(text(result), new RegExp(`open supervisor request ${requestId}`));
			assert.match(text(result), /the child is unblocked/);
			assert.deepEqual(queued, [], "the message must be delivered exactly once, not also queued in the dead queue");

			const reply = path.join(resolveSupervisorChannelDir(workflowRunId, "worker", 0), "replies", `${requestId}.json`);
			assert.equal(JSON.parse(fs.readFileSync(reply, "utf-8")).message, "RULING VIA STEER: proceed with option A.");
			assert.equal(channel.pending.has(requestId), false, "the answered ask must leave the pending queue");
		} finally {
			channel.dispose();
		}
	});

	// Once the reply file exists the child can read it, so the steer HAS been delivered. A failure in
	// the bookkeeping that follows must not report "no resolution", because the caller would then also
	// send the same instruction through child.steer and the child would receive it twice.
	it("reports the delivery even when post-reply bookkeeping fails, and does not steer twice", async () => {
		const sessionId = `session-${randomUUID()}`;
		const workflowRunId = `workflow-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		const queued: string[] = [];
		registerWorkflowChild(state, workflowRunId, workflowRunId, async (input) => {
			queued.push(input.message);
			return { state: "queued" as const };
		});
		// `clearForegroundSupervisorAttention` reads this map after the reply is already on disk.
		// (`appendSupervisorReplyEntry` swallows its own errors, so it cannot stand in for this.)
		// Armed only after registration, because the same map is read while the ask is being queued.
		let failForegroundLookup = false;
		state.foregroundRuns = {
			get: () => {
				if (failForegroundLookup) throw new Error("foreground state unavailable");
				return undefined;
			},
		} as never;
		const pi = makePi({ tools });
		const channel = createNativeSupervisorChannel(pi as never, state, { platform: "darwin" });
		const originalError = console.error;
		console.error = () => {};

		try {
			channel.start();
			const requestId = writeRequest({ sessionId, runId: workflowRunId });
			await tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });
			assert.equal(channel.pending.has(requestId), true, "precondition: the child is blocked on a registered ask");
			failForegroundLookup = true;

			const control = state.foregroundControls.get(workflowRunId)!;
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: workflowRunId },
				message: "RULING VIA STEER: proceed.",
			});

			const reply = path.join(resolveSupervisorChannelDir(workflowRunId, "worker", 0), "replies", `${requestId}.json`);
			assert.equal(fs.existsSync(reply), true, "precondition: the reply was published");
			assert.equal(result.details.steering?.state, "delivered", "a published reply is a real delivery");
			assert.deepEqual(queued, [], "the child must not also receive the message through child.steer");
		} finally {
			console.error = originalError;
			channel.dispose();
		}
	});

	it("falls back to the normal steer route and reports its real state when no ask is pending", async () => {
		const sessionId = `session-${randomUUID()}`;
		const workflowRunId = `workflow-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		const queued: string[] = [];
		registerWorkflowChild(state, workflowRunId, workflowRunId, async (input) => {
			queued.push(input.message);
			return { state: "queued" as const };
		});
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });

		try {
			channel.start();
			const control = state.foregroundControls.get(workflowRunId)!;
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: workflowRunId },
				message: "No ask is open here.",
			});

			// A queued in-memory steer reports `state: "pending"` with a queued target: the honest
			// receipt for a message that has not reached the child yet.
			assert.equal(result.details.steering?.state, "pending", "without a pending ask the receipt must stay honest");
			assert.equal(result.details.steering?.targets[0]?.state, "queued");
			assert.deepEqual(queued, ["No ask is open here."]);
		} finally {
			channel.dispose();
		}
	});

	it("does not answer an ask that belongs to a different child index", async () => {
		const sessionId = `session-${randomUUID()}`;
		const workflowRunId = `workflow-${randomUUID()}`;
		const tools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		const queued: string[] = [];
		registerWorkflowChild(state, workflowRunId, workflowRunId, async (input) => {
			queued.push(input.message);
			return { state: "queued" as const };
		});
		const channel = createNativeSupervisorChannel(makePi({ tools }) as never, state, { platform: "darwin" });

		try {
			channel.start();
			const otherIndexAsk = writeRequest({ sessionId, runId: workflowRunId, index: 3 });
			await tools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });
			assert.equal(channel.pending.has(otherIndexAsk), true, "precondition: index 3 has the open ask");

			const control = state.foregroundControls.get(workflowRunId)!;
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: workflowRunId },
				message: "Meant for index 0.",
			});

			assert.equal(result.details.steering?.state, "pending", "index 0 has no ask, so the normal route must be used");
			assert.equal(result.details.steering?.targets[0]?.state, "queued");
			assert.deepEqual(queued, ["Meant for index 0."]);
			assert.equal(channel.pending.has(otherIndexAsk), true, "index 3's ask must be left untouched");
		} finally {
			channel.dispose();
		}
	});

	// The end-to-end seam: drive the real child-side `contact_supervisor` tool and prove the
	// blocked child actually receives the steer text as its tool result.
	it("unblocks the real contact_supervisor tool call through a steer", async () => {
		const sessionId = `session-${randomUUID()}`;
		const workflowRunId = `workflow-${randomUUID()}`;
		const channelDir = resolveSupervisorChannelDir(workflowRunId, "worker", 0);
		createdChannels.push(channelDir);
		const supervisorTools = new Map<string, SupervisorTool>();
		const childTools = new Map<string, SupervisorTool>();
		const state = makeState(sessionId, makeCtx(sessionId));
		registerWorkflowChild(state, workflowRunId, workflowRunId, async () => ({ state: "queued" as const }));
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

			// The child blocks here exactly as it does in production: inside an open tool call,
			// polling its reply file.
			const blocked = childTools.get("contact_supervisor")!.execute("ask", {
				action: "ask",
				reason: "need_decision",
				message: "Which option should I take?",
			} as never);

			await waitForCondition(() => fs.readdirSync(path.join(channelDir, "requests")).length > 0, "the child's ask to reach disk");
			await supervisorTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });

			const control = state.foregroundControls.get(workflowRunId)!;
			const steerResult = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: workflowRunId },
				message: "RULING VIA STEER: take option A.",
			});
			assert.equal(steerResult.details.steering?.state, "delivered");

			const childResult = await blocked;
			assert.notEqual(childResult.isError, true, text(childResult));
			assert.match(text(childResult), /RULING VIA STEER: take option A\./, "the blocked child must receive the steer as its answer");
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
