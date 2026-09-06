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
import { SUPERVISOR_REPLY_ENTRY_TYPE, SUPERVISOR_REQUEST_MESSAGE_TYPE } from "../../src/intercom/supervisor-ui.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, type SubagentState } from "../../src/shared/types.ts";

const createdChannels: string[] = [];

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

function writeRequest(input: { sessionId: string; runId: string; agent?: string; index?: number; message?: string; reason?: "need_decision" | "interview_request" | "progress_update"; childTarget?: string; interview?: unknown; createdAt?: number; expiresAt?: number }): string {
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
		reason: input.reason ?? "need_decision",
		message: input.message ?? "Need a decision",
		expectsReply: input.reason !== "progress_update",
		orchestratorSessionId: input.sessionId,
		orchestratorTarget: "shared-name",
		runId: input.runId,
		agent,
		childIndex: index,
		...(input.childTarget ? { childTarget: input.childTarget } : {}),
		...(input.interview !== undefined ? { interview: input.interview } : {}),
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

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
	for (const channel of createdChannels.splice(0)) fs.rmSync(channel, { recursive: true, force: true });
});

describe("native supervisor channel", () => {
	it("delivers requests only to the exact current session id and wakes the parent", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const otherSessionId = `session-${randomUUID()}`;
		const matchingId = writeRequest({ sessionId: currentSessionId, runId: `run-${randomUUID()}` });
		const otherId = writeRequest({ sessionId: otherSessionId, runId: `run-${randomUUID()}` });
		const sent: Array<{
			message: { content?: string; details?: { id?: string } };
			options?: { triggerTurn?: boolean };
		}> = [];
		const registeredTools: Array<{ name: string; parameters: { properties: { action: unknown } } }> = [];
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
			registerTool: (tool: typeof registeredTools[number]) => { registeredTools.push(tool); },
			sendMessage: (
				message: { content?: string; details?: { id?: string } },
				options?: { triggerTurn?: boolean },
			) => { sent.push({ message, options }); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx), { platform: "darwin" });

		assert.deepEqual(registeredTools, []);
		channel.start();
		channel.dispose();

		assert.deepEqual(registeredTools.map((tool) => tool.name), [NATIVE_SUPERVISOR_TOOL_NAME]);
		assert.deepEqual(registeredTools[0]?.parameters.properties.action, { type: "string", enum: ["list", "pending", "status", "reply"] });
		assert.deepEqual(sent.map(({ message }) => message.details?.id), [matchingId]);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true });
		assert.equal(channel.pending.has(matchingId), false, "disposed channel clears pending requests");
		assert.equal(sent.some(({ message }) => message.details?.id === otherId), false);
	});

	it("uses polling instead of native watchers on Windows", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const requestId = writeRequest({ sessionId: currentSessionId, runId: `run-${randomUUID()}` });
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
		let watchCalls = 0;
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx), {
			platform: "win32",
			watch: (() => {
				watchCalls += 1;
				throw new Error("Windows supervisor channel must not call fs.watch.");
			}) as never,
		});

		channel.start();
		channel.dispose();

		assert.equal(watchCalls, 0);
		assert.deepEqual(sent.map((message) => message.details?.id), [requestId]);
	});

	it("registers idle Darwin sessions without native watchers or polling", () => {
		const currentSessionId = `session-${randomUUID()}`;
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
		let watchCalls = 0;
		const intervals: number[] = [];
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx), {
			platform: "darwin",
			watch: (() => { watchCalls += 1; throw new Error("Darwin must not call fs.watch."); }) as never,
			timers: {
				setInterval: ((_handler: () => void, delay?: number) => { intervals.push(delay ?? 0); return { unref() {} } as NodeJS.Timeout; }) as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
				setImmediate,
				clearImmediate,
			},
		});

		channel.start();
		channel.dispose();

		assert.equal(watchCalls, 0);
		assert.deepEqual(intervals, []);
	});

	it("activates Darwin supervisor polling only while child work is live", () => {
		const currentSessionId = `session-${randomUUID()}`;
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
		const state = makeState(currentSessionId, ctx);
		state.foregroundControls.set("run-a", { runId: "run-a", startedAt: Date.now(), updatedAt: Date.now(), activeChildren: new Map(), schedulingOwners: 1 } as never);
		const intervals: number[] = [];
		const channel = createNativeSupervisorChannel(pi as never, state, {
			platform: "darwin",
			watch: (() => { throw new Error("Darwin must not call fs.watch."); }) as never,
			timers: {
				setInterval: ((_handler: () => void, delay?: number) => { intervals.push(delay ?? 0); return { unref() {} } as NodeJS.Timeout; }) as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
				setImmediate,
				clearImmediate,
			},
		});

		channel.start();
		channel.activateTransport();
		channel.dispose();

		assert.deepEqual(intervals, [250]);
	});

	it("delivers requests written under an existing request directory by watch event", async () => {
		const currentSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		makeEmptyChannel(runId);
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
		const watchListeners: fs.WatchListener<string>[] = [];
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx), {
			platform: "linux",
			watch: ((_filename: fs.PathLike, listener: fs.WatchListener<string>) => {
				watchListeners.push(listener);
				return { on: () => {}, close: () => {}, unref: () => {} } as unknown as fs.FSWatcher;
			}) as never,
		});

		try {
			channel.start();
			const requestId = writeRequest({ sessionId: currentSessionId, runId });
			for (const listener of watchListeners) listener("rename", `${requestId}.json`);
			await waitForCondition(() => sent.some((message) => message.details?.id === requestId), "supervisor request watch delivery");
		} finally {
			channel.dispose();
		}
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

	it("re-arms remembered foreground attention for each blocking supervisor request", async () => {
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
		const state = makeState(currentSessionId, ctx);
		state.foregroundRuns = new Map([[runId, {
			runId,
			mode: "single",
			cwd: process.cwd(),
			sessionId: currentSessionId,
			updatedAt: 1,
			children: [{ agent: "worker", index: 0, status: "detached", updatedAt: 1 }],
		}]]);
		const pi = {
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }) => {
				registeredTools.set(tool.name, tool);
			},
			sendMessage: () => {},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, state);

		try {
			channel.start();
			const child = state.foregroundRuns.get(runId)!.children[0]!;
			assert.equal(child.activityState, "needs_attention");
			assert.equal(child.currentTool, "contact_supervisor");

			await registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", {
				action: "reply",
				replyTo: requestId,
				message: "Approved",
			});
			assert.equal(child.activityState, undefined);
			assert.equal(child.currentTool, undefined);
		} finally {
			channel.dispose();
		}
	});

	it("marks attention after detach when the reply has not landed yet", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		writeRequest({ sessionId: currentSessionId, runId });
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
		const pi = {
			getAllTools: () => [],
			registerTool: () => {},
			sendMessage: () => {},
			events: {
				emit: () => {
					state.foregroundRuns = new Map([[runId, {
						runId,
						mode: "single",
						cwd: process.cwd(),
						sessionId: currentSessionId,
						updatedAt: Date.now(),
						children: [{ agent: "worker", index: 0, status: "detached", updatedAt: Date.now() }],
					}]]);
				},
			},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, state);
		try {
			channel.start();
			const child = state.foregroundRuns.get(runId)!.children[0]!;
			assert.equal(child.activityState, "needs_attention");
			assert.equal(child.currentTool, "contact_supervisor");
		} finally {
			channel.dispose();
		}
	});

	it("skips restamping attention when the reply already landed during detach", async () => {
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
		const state = makeState(currentSessionId, ctx);
		state.foregroundRuns = new Map();
		const pi = {
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }) => {
				registeredTools.set(tool.name, tool);
			},
			sendMessage: () => {
				void registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", {
					action: "reply",
					replyTo: requestId,
					message: "Approved",
				});
			},
			events: {
				emit: () => {
					state.foregroundRuns = new Map([[runId, {
						runId,
						mode: "single",
						cwd: process.cwd(),
						sessionId: currentSessionId,
						updatedAt: Date.now(),
						children: [{ agent: "worker", index: 0, status: "detached", updatedAt: Date.now() }],
					}]]);
				},
			},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, state);
		try {
			channel.start();
			const child = state.foregroundRuns.get(runId)!.children[0]!;
			assert.equal(child.status, "detached");
			assert.equal(child.activityState, undefined);
			assert.equal(child.currentTool, undefined);
			assert.equal(channel.pending.has(requestId), false);
		} finally {
			channel.dispose();
		}
	});

	it("clears remembered attention even when currentTool is not contact_supervisor", async () => {
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
		const state = makeState(currentSessionId, ctx);
		state.foregroundRuns = new Map([[runId, {
			runId,
			mode: "single",
			cwd: process.cwd(),
			sessionId: currentSessionId,
			updatedAt: 1,
			children: [{ agent: "worker", index: 0, status: "detached", activityState: "needs_attention", currentTool: "edit", updatedAt: 1 }],
		}]]);
		const pi = {
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }) => {
				registeredTools.set(tool.name, tool);
			},
			sendMessage: () => {},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, state);
		try {
			channel.start();
			state.foregroundRuns.get(runId)!.children[0]!.currentTool = "edit";
			await registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", {
				action: "reply",
				replyTo: requestId,
				message: "Approved",
			});
			const child = state.foregroundRuns.get(runId)!.children[0]!;
			assert.equal(child.activityState, undefined);
			assert.equal(child.currentTool, undefined);
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

	it("includes supervisor request metadata and journals a successful reply", async () => {
		const currentSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({
			sessionId: currentSessionId,
			runId,
			agent: "worker",
			index: 2,
			message: "Should this change be applied?",
			reason: "interview_request",
			childTarget: "child-worker",
			interview: { approved: "boolean", rationale: "string" },
		});
		const sent: Array<{ customType?: string; content?: string; details?: Record<string, unknown> }> = [];
		const entries: Array<{ customType: string; data?: Record<string, unknown> }> = [];
		const journalState = { replyExistsAtAppend: false, requestExistsAtAppend: true };
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
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }) => {
				registeredTools.set(tool.name, tool);
			},
			sendMessage: (message: { customType?: string; content?: string; details?: Record<string, unknown> }) => { sent.push(message); },
			appendEntry: (customType: string, data?: Record<string, unknown>) => {
				journalState.replyExistsAtAppend = fs.existsSync(replyFile(runId, requestId, "worker", 2));
				journalState.requestExistsAtAppend = fs.existsSync(requestFile(runId, requestId, "worker", 2));
				entries.push({ customType, data });
			},
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		try {
			channel.start();
			assert.equal(sent.length, 1);
			assert.equal(sent[0]?.customType, SUPERVISOR_REQUEST_MESSAGE_TYPE);
			assert.match(sent[0]?.content ?? "", /Subagent requests a structured supervisor interview\./);
			assert.match(sent[0]?.content ?? "", /Should this change be applied\?/);
			assert.ok(sent[0]?.content?.includes(`Reply with: subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`));
			assert.ok(sent[0]?.content?.includes(`Live guidance: subagent({ action: "steer", id: "${runId}", index: 2, message: "..." }) (Reply to the pending request first.)`));
			assert.doesNotMatch(sent[0]?.content ?? "", /Child intercom target:|child-worker/);
			assert.deepEqual(sent[0]?.details, {
				id: requestId,
				requestId,
				reason: "interview_request",
				expectsReply: true,
				runId,
				agent: "worker",
				childIndex: 2,
				childTarget: "child-worker",
				interview: { approved: "boolean", rationale: "string" },
				requestBody: "Should this change be applied?",
				replyHint: `subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`,
			});

			await registeredTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", {
				action: "reply",
				replyTo: requestId,
				message: "Approved with rationale",
			});

			assert.equal(entries.length, 1);
			assert.equal(entries[0]?.customType, SUPERVISOR_REPLY_ENTRY_TYPE);
			assert.deepEqual(journalState, { replyExistsAtAppend: true, requestExistsAtAppend: false });
			assert.deepEqual({ ...entries[0]?.data, createdAt: undefined }, {
				requestId,
				reason: "interview_request",
				runId,
				agent: "worker",
				childIndex: 2,
				childTarget: "child-worker",
				message: "Approved with rationale",
				createdAt: undefined,
			});
			assert.equal(typeof entries[0]?.data?.createdAt, "number");
			const reply = JSON.parse(fs.readFileSync(replyFile(runId, requestId, "worker", 2), "utf-8")) as { message?: string };
			assert.equal(reply.message, "Approved with rationale");
			assert.equal(fs.existsSync(requestFile(runId, requestId, "worker", 2)), false);
		} finally {
			channel.dispose();
		}
	});

	it("keeps message-less interview metadata visible to the parent model", () => {
		const currentSessionId = `session-${randomUUID()}`;
		const runId = `run-${randomUUID()}`;
		const requestId = writeRequest({ sessionId: currentSessionId, runId, reason: "interview_request", message: "", interview: { approved: "boolean" } });
		const sent: Array<{ content?: string; details?: Record<string, unknown> }> = [];
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
			sendMessage: (message: { content?: string; details?: Record<string, unknown> }) => { sent.push(message); },
			getSessionName: () => "shared-name",
		};
		const channel = createNativeSupervisorChannel(pi as never, makeState(currentSessionId, ctx));

		channel.start();
		channel.dispose();

		assert.equal(sent.length, 1);
		assert.match(sent[0]?.content ?? "", /Structured response requested/);
		assert.match(sent[0]?.content ?? "", /"approved": "boolean"/);
		assert.match(sent[0]?.content ?? "", new RegExp(`replyTo: "${requestId}"`));
		assert.equal(sent[0]?.details?.requestBody, "");
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

	it("stores only the child-authored supervisor message in the request body", async () => {
		const runId = `run-${randomUUID()}`;
		const channelDir = resolveSupervisorChannelDir(runId, "worker", 3);
		createdChannels.push(channelDir);
		const registeredTools = new Map<string, { execute: (_id: string, params: { reason: string; message?: string }) => Promise<unknown> | unknown }>();
		const pi = {
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { reason: string; message?: string }) => Promise<unknown> | unknown }) => {
				registeredTools.set(tool.name, tool);
			},
		};
		registerNativeSupervisorClient(pi as never, {
			channelDir,
			runId,
			agent: "worker",
			childIndex: 3,
			orchestratorTarget: "shared-name",
			orchestratorSessionId: "session-parent",
		});

		await assert.rejects(
			() => registeredTools.get("contact_supervisor")!.execute("blank-progress", { reason: "progress_update" }),
			/message is required for supervisor decisions and progress updates/,
		);
		await registeredTools.get("contact_supervisor")!.execute("contact", {
			reason: "progress_update",
			message: "  Finished the first review pass.  ",
		});

		const [file] = fs.readdirSync(path.join(channelDir, "requests"));
		const request = JSON.parse(fs.readFileSync(path.join(channelDir, "requests", file!), "utf-8")) as { message?: string; runId?: string; agent?: string; childIndex?: number };
		assert.equal(request.message, "Finished the first review pass.");
		assert.equal(request.runId, runId);
		assert.equal(request.agent, "worker");
		assert.equal(request.childIndex, 3);
	});

	it("removes the request file when a child supervisor ask is cancelled", async () => {
		const runId = `run-${randomUUID()}`;
		const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
		createdChannels.push(channelDir);
		const registeredTools = new Map<string, { execute: (_id: string, params: { reason: string; message?: string }, signal?: AbortSignal) => Promise<unknown> | unknown }>();
		const pi = {
			getAllTools: () => [...registeredTools.keys()].map((name) => ({ name })),
			registerTool: (tool: { name: string; execute: (_id: string, params: { reason: string; message?: string }, signal?: AbortSignal) => Promise<unknown> | unknown }) => {
				registeredTools.set(tool.name, tool);
			},
		};
		registerNativeSupervisorClient(pi as never, {
			channelDir,
			runId,
			agent: "worker",
			childIndex: 0,
			orchestratorTarget: "shared-name",
			orchestratorSessionId: "session-parent",
		});
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			() => registeredTools.get("contact_supervisor")!.execute("contact", { reason: "need_decision", message: "Need a decision" }, controller.signal),
			/Supervisor request cancelled/,
		);

		assert.deepEqual(fs.readdirSync(path.join(channelDir, "requests")), []);
	});
});
