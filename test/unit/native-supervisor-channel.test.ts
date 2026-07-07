import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
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
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";

const createdChannels: string[] = [];
const savedEnv = {
	[SUBAGENT_CHILD_AGENT_ENV]: process.env[SUBAGENT_CHILD_AGENT_ENV],
	[SUBAGENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_CHILD_INDEX_ENV],
	[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV]: process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV],
	[SUBAGENT_ORCHESTRATOR_TARGET_ENV]: process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV],
	[SUBAGENT_RUN_ID_ENV]: process.env[SUBAGENT_RUN_ID_ENV],
	[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV]: process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV],
};

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

function writeRequest(input: { sessionId: string; runId: string; agent?: string; index?: number; message?: string; createdAt?: number; expiresAt?: number }): string {
	const agent = input.agent ?? "worker";
	const index = input.index ?? 0;
	const channelDir = resolveSupervisorChannelDir(input.runId, agent, index);
	createdChannels.push(channelDir);
	ensureSupervisorChannelDir(channelDir);
	const requestId = randomUUID();
	fs.writeFileSync(path.join(channelDir, "requests", `${requestId}.json`), JSON.stringify({
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt: input.createdAt ?? Date.now(),
		...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
		reason: "need_decision",
		message: input.message ?? "Need a decision",
		expectsReply: true,
		orchestratorSessionId: input.sessionId,
		orchestratorTarget: "shared-name",
		runId: input.runId,
		agent,
		childIndex: index,
	}, null, "\t"));
	return requestId;
}

function requestFile(runId: string, requestId: string, agent = "worker", index = 0): string {
	return path.join(resolveSupervisorChannelDir(runId, agent, index), "requests", `${requestId}.json`);
}

function replyFile(runId: string, requestId: string, agent = "worker", index = 0): string {
	return path.join(resolveSupervisorChannelDir(runId, agent, index), "replies", `${requestId}.json`);
}

function makeEmptyChannel(runId: string): string {
	const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
	createdChannels.push(channelDir);
	ensureSupervisorChannelDir(channelDir);
	return channelDir;
}

function ageChannel(channelDir: string, ageMs: number): void {
	const timestamp = new Date(Date.now() - ageMs);
	for (const dir of [path.join(channelDir, "requests"), path.join(channelDir, "replies"), channelDir]) {
		fs.utimesSync(dir, timestamp, timestamp);
	}
}

function restoreEnv(): void {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
	for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

describe("native supervisor channel", () => {
	it("delivers requests only to the exact current session id", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const otherSessionId = `session-${randomUUID()}`;
		const matchingId = writeRequest({ sessionId: currentSessionId, runId: `run-${randomUUID()}` });
		const otherId = writeRequest({ sessionId: otherSessionId, runId: `run-${randomUUID()}` });
		const sent: Array<{ content?: string; details?: { id?: string } }> = [];
		const registeredTools: string[] = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [],
			registerTool: (tool: { name: string }) => { registeredTools.push(tool.name); },
			sendMessage: (message: { content?: string; details?: { id?: string } }) => { sent.push(message); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		assert.deepEqual(registeredTools, []);
		channel.start();
		channel.dispose();

		assert.deepEqual(registeredTools, [NATIVE_SUPERVISOR_TOOL_NAME, "intercom"]);
		assert.deepEqual(sent.map((message) => message.details?.id), [matchingId]);
		assert.equal(channel.pending.has(matchingId), false, "disposed channel clears pending requests");
		assert.equal(sent.some((message) => message.details?.id === otherId), false);
	});

	it("prunes stale empty supervisor channel directories before polling", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const staleEmptyChannel = makeEmptyChannel(`run-${randomUUID()}`);
		ageChannel(staleEmptyChannel, 2 * 60 * 1000);
		const sent: Array<{ details?: { id?: string } }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [],
			registerTool: () => {},
			sendMessage: (message: { details?: { id?: string } }) => { sent.push(message); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		channel.start();
		channel.dispose();

		assert.equal(fs.existsSync(staleEmptyChannel), false);
		assert.deepEqual(sent, []);
	});

	it("preserves fresh empty and stale non-empty supervisor channel directories", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const freshEmptyChannel = makeEmptyChannel(`run-${randomUUID()}`);
		const staleWithReply = makeEmptyChannel(`run-${randomUUID()}`);
		fs.writeFileSync(path.join(staleWithReply, "replies", "reply.json"), "{}");
		ageChannel(staleWithReply, 2 * 60 * 1000);
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [],
			registerTool: () => {},
			sendMessage: () => {},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		channel.start();
		channel.dispose();

		assert.equal(fs.existsSync(freshEmptyChannel), true);
		assert.equal(fs.existsSync(staleWithReply), true);
	});

	it("emits foreground detach only after displaying a pending supervisor request", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({ sessionId: currentSessionId, runId, agent: "worker", index: 2 });
		const log: string[] = [];
		const emitted: Array<{ channel: string; payload: { requestId?: string; runId?: string; agent?: string; childIndex?: number } }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [],
			registerTool: () => {},
			sendMessage: () => { log.push("send"); },
			events: {
				emit: (channel: string, payload: { requestId?: string; runId?: string; agent?: string; childIndex?: number }) => {
					log.push("emit");
					emitted.push({ channel, payload });
				},
			},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		channel.start();
		try {
			assert.deepEqual(log, ["send", "emit"]);
			assert.deepEqual(emitted, [{
				channel: INTERCOM_DETACH_REQUEST_EVENT,
				payload: { requestId, runId, agent: "worker", childIndex: 2 },
			}]);
			assert.equal(channel.pending.has(requestId), true);
		} finally {
			channel.dispose();
		}
	});

	it("matches supervisor requests against the runtime session id instead of persisted session file path", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const persistedSessionFile = path.join(os.tmpdir(), `${currentSessionId}.jsonl`);
		const matchingId = writeRequest({ sessionId: currentSessionId, runId: `run-${randomUUID()}` });
		const sent: Array<{ details?: { id?: string } }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => persistedSessionFile,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [],
			registerTool: () => {},
			sendMessage: (message: { details?: { id?: string } }) => { sent.push(message); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(persistedSessionFile, ctx));

		channel.start();
		channel.dispose();

		assert.deepEqual(sent.map((message) => message.details?.id), [matchingId]);
	});

	it("keeps an installed intercom tool and still exposes a native supervisor reply path", async () => {
		const currentSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({ sessionId: currentSessionId, runId });
		const registeredTools = new Map<string, { execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }>();
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [{ name: "intercom" }, ...[...registeredTools.keys()].map((name) => ({ name }))],
			registerTool: (tool: { name: string; execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }) => {
				registeredTools.set(tool.name, tool);
			},
			sendMessage: () => {},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		try {
			assert.deepEqual([...registeredTools.keys()], []);
			channel.start();

			assert.deepEqual([...registeredTools.keys()], [NATIVE_SUPERVISOR_TOOL_NAME]);
			await registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)?.execute("reply", { action: "reply", replyTo: requestId, message: "Approved" });
			const reply = JSON.parse(fs.readFileSync(replyFile(runId, requestId), "utf-8")) as { message?: string; requestId?: string };
			assert.equal(reply.requestId, requestId);
			assert.equal(reply.message, "Approved");
			assert.equal(fs.existsSync(requestFile(runId, requestId)), false);
		} finally {
			channel.dispose();
		}
	});

	it("suppresses resolved, expired, and inactive requests before displaying them", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const resolvedRunId = `run-${randomUUID()}`;
		const expiredRunId = `run-${randomUUID()}`;
		const inactiveRunId = `run-${randomUUID()}`;
		const resolvedId = writeRequest({ sessionId: currentSessionId, runId: resolvedRunId });
		const expiredId = writeRequest({ sessionId: currentSessionId, runId: expiredRunId, expiresAt: Date.now() - 1 });
		const inactiveId = writeRequest({ sessionId: currentSessionId, runId: inactiveRunId });
		fs.writeFileSync(replyFile(resolvedRunId, resolvedId), JSON.stringify({
			type: "subagent.supervisor.reply",
			requestId: resolvedId,
			createdAt: Date.now(),
			message: "Already handled",
		}), "utf-8");
		const sent: Array<{ details?: { id?: string } }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const state = makeState(currentSessionId, ctx);
		state.foregroundRuns = new Map([[inactiveRunId, {
			runId: inactiveRunId,
			mode: "single",
			cwd: process.cwd(),
			updatedAt: Date.now(),
			children: [{ agent: "worker", index: 0, status: "completed", updatedAt: Date.now() }],
		}]]);
		const pi = {
			getAllTools: () => [],
			registerTool: () => {},
			sendMessage: (message: { details?: { id?: string } }) => { sent.push(message); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, state);

		channel.start();
		channel.dispose();

		assert.deepEqual(sent, []);
		assert.equal(fs.existsSync(requestFile(resolvedRunId, resolvedId)), false);
		assert.equal(fs.existsSync(requestFile(expiredRunId, expiredId)), false);
		assert.equal(fs.existsSync(requestFile(inactiveRunId, inactiveId)), false);
	});

	it("refreshes pending requests before listing or replying", async () => {
		const currentSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({ sessionId: currentSessionId, runId });
		const registeredTools = new Map<string, { execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<{ content: Array<{ text: string }>; details?: { pending?: unknown[] } }> }>();
		const sent: Array<{ details?: { id?: string } }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			sessionManager: {
				getSessionId: () => currentSessionId,
				getSessionFile: () => null,
				getEntries: () => [],
			},
		};
		const pi = {
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<{ content: Array<{ text: string }>; details?: { pending?: unknown[] } }> }) => {
				registeredTools.set(tool.name, tool);
			},
			sendMessage: (message: { details?: { id?: string } }) => { sent.push(message); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		try {
			channel.start();
			assert.deepEqual(sent.map((message) => message.details?.id), [requestId]);
			assert.equal(channel.pending.has(requestId), true);

			fs.rmSync(requestFile(runId, requestId), { force: true });
			const pendingResult = await registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("pending", { action: "pending" });

			assert.match(pendingResult.content[0]!.text, /No pending supervisor requests/);
			assert.deepEqual(pendingResult.details?.pending, []);
			assert.equal(channel.pending.has(requestId), false);
			await assert.rejects(
				() => registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", { action: "reply", replyTo: requestId, message: "Too late" }),
				new RegExp(`No pending supervisor request found for replyTo '${requestId}'`),
			);
		} finally {
			channel.dispose();
		}
	});

	it("removes the request file when a child supervisor ask is cancelled", async () => {
		const runId = `run-${randomUUID()}`;
		const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
		createdChannels.push(channelDir);
		process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = "shared-name";
		process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
		process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
		process.env[SUBAGENT_RUN_ID_ENV] = runId;
		process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
		process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
		const registeredTools = new Map<string, { execute: (_id: string, params: { reason: string; message?: string }, signal?: AbortSignal) => Promise<unknown> | unknown }>();
		const pi = {
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { reason: string; message?: string }, signal?: AbortSignal) => Promise<unknown> | unknown }) => {
				registeredTools.set(tool.name, tool);
			},
		};
		registerNativeSupervisorClient(pi as never, { includeIntercomFallback: false });
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			() => registeredTools.get("contact_supervisor")!.execute("contact", { reason: "need_decision", message: "Need a decision" }, controller.signal),
			/Supervisor request cancelled/,
		);

		assert.deepEqual(fs.readdirSync(path.join(channelDir, "requests")), []);
	});
});
