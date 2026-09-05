import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { consumeStopRequestPayload, stopRequestPath, stopRequestsDir } from "../../src/runs/background/control-channel.ts";
import {
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REQUEST_EVENT,
	registerSubagentRpcBridge,
	subagentRpcReplyEvent,
	type SubagentRpcReplyEnvelope,
} from "../../src/extension/rpc.ts";
import { SUBAGENT_CHILD_STATUS_EVENT, type Details, type SubagentChildStatusEvent, type SubagentState } from "../../src/shared/types.ts";

class FakeEvents {
	readonly emitted: Array<{ event: string; data: unknown }> = [];
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			const current = this.handlers.get(event) ?? [];
			this.handlers.set(event, current.filter((candidate) => candidate !== handler));
		};
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

function ctx(sessionId = "session-123", sessionFile = "/sessions/parent.jsonl") {
	return {
		cwd: "/repo",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
	} as any;
}

async function request(events: FakeEvents, requestId: string, method: string, params?: unknown): Promise<SubagentRpcReplyEnvelope> {
	const reply = once(events, subagentRpcReplyEvent(requestId)) as Promise<SubagentRpcReplyEnvelope>;
	events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
		version: SUBAGENT_RPC_PROTOCOL_VERSION,
		requestId,
		method,
		...(params !== undefined ? { params } : {}),
	});
	return reply;
}

describe("subagent extension RPC bridge", () => {
	it("emits ready and answers ping with versioned capability metadata", async () => {
		const events = new FakeEvents();
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async () => assert.fail("ping should not call executor"),
		});

		const readyPromise = once(events, SUBAGENT_RPC_READY_EVENT);
		bridge.emitReady(ctx());
		const ready = await readyPromise as { version?: number; events?: { request?: string }; session?: { cwd?: string } };
		assert.equal(ready.version, SUBAGENT_RPC_PROTOCOL_VERSION);
		assert.equal(ready.events?.request, SUBAGENT_RPC_REQUEST_EVENT);
		assert.equal(ready.session?.cwd, "/repo");

		const reply = await request(events, "ping-1", "ping");
		assert.equal(reply.success, true);
		assert.equal(reply.method, "ping");
		assert.equal((reply as { data: { version?: number } }).data.version, SUBAGENT_RPC_PROTOCOL_VERSION);
		assert.equal(
			(reply as { data: { events?: { asyncComplete?: string } } }).data.events?.asyncComplete,
			"subagent:async-complete",
		);
		assert.equal(
			(reply as { data: { events?: { childStatus?: string } } }).data.events?.childStatus,
			SUBAGENT_CHILD_STATUS_EVENT,
		);
		assert.equal(
			(reply as { data: { capabilities?: { nonRecoveringSteer?: boolean } } }).data.capabilities?.nonRecoveringSteer,
			true,
		);
		assert.equal(
			(reply as { data: { capabilities?: { resume?: boolean } } }).data.capabilities?.resume,
			true,
		);
		assert.deepEqual(
			(reply as { data: { capabilities?: { managementActions?: unknown } } }).data.capabilities?.managementActions,
			["schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.delete"],
		);
		assert.deepEqual(
			(reply as { data: { capabilities?: { fleetStatus?: unknown } } }).data.capabilities?.fleetStatus,
			{ version: 1 },
		);
		assert.deepEqual(
			(reply as { data: { capabilities?: { asyncStatusSnapshot?: unknown } } }).data.capabilities?.asyncStatusSnapshot,
			{ kind: "pi-subagents.async-status-snapshot", version: 1 },
		);
		assert.deepEqual(
			(reply as { data: { capabilities?: { statusProjection?: unknown } } }).data.capabilities?.statusProjection,
			{ version: 1, untargeted: "in-memory-when-ready", targeted: "executor" },
		);

		bridge.dispose();
	});

	it("replies to malformed request ids on the safe unknown channel", async () => {
		const events = new FakeEvents();
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async () => assert.fail("malformed request should not call executor"),
		});
		const unsafeRequestId = "bad\nchannel";
		const replyPromise = once(events, subagentRpcReplyEvent("unknown")) as Promise<SubagentRpcReplyEnvelope>;

		events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: SUBAGENT_RPC_PROTOCOL_VERSION,
			requestId: unsafeRequestId,
			method: "ping",
		});
		const reply = await replyPromise;

		assert.equal(reply.success, false);
		assert.equal(reply.requestId, "unknown");
		assert.equal((reply as { error: { code: string } }).error.code, "invalid_request");
		assert.equal(events.emitted.some((entry) => entry.event === subagentRpcReplyEvent(unsafeRequestId)), false);

		bridge.dispose();
	});

	it("delegates status through the existing executor action", async () => {
		const events = new FakeEvents();
		let executedParams: unknown;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executedParams = params;
				return { content: [{ type: "text", text: "Run: abc123" }], details: { mode: "management", results: [] } } as any;
			},
		});

		const reply = await request(events, "status-1", "status", { id: "abc123" });

		assert.equal(reply.success, true);
		assert.deepEqual(executedParams, { action: "status", id: "abc123" });
		assert.equal((reply as { data: { text?: string } }).data.text, "Run: abc123");
		assert.deepEqual((reply as { data: { details?: unknown } }).data.details, { mode: "management", results: [] });
		assert.deepEqual((reply as { data: { fleet?: unknown } }).data.fleet, {
			version: 1, entries: [], totalActive: 0, topLevelAsyncCapacity: { used: 0, limit: 0 }, omitted: 0,
		});

		bridge.dispose();
	});

	it("serves untargeted status from restored in-memory projections", async () => {
		const events = new FakeEvents();
		const state = {
			currentSessionId: "session-123",
			statusProjectionSessionId: "session-123",
			foregroundControls: new Map(),
			asyncJobs: new Map([[
				"private-id",
				{ asyncId: "private-id", sessionId: "session-123", status: "running", mode: "single", startedAt: 100, agents: ["worker"] },
			]]),
		} as any;
		let executeCalls = 0;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx("session-123", "session-123"),
			state,
			execute: async () => {
				executeCalls += 1;
				return assert.fail("restored untargeted status should not call executor");
			},
		});

		const reply = await request(events, "status-memory", "status");

		assert.equal(reply.success, true);
		assert.equal(executeCalls, 0);
		assert.equal((reply as { data: { text?: string } }).data.text, "In-memory subagent status: 1 active child.");
		assert.deepEqual((reply as any).data.details, { mode: "management", results: [] });
		assert.equal((reply as any).data.fleet.totalActive, 1);
		assert.deepEqual((reply as any).data.asyncSnapshot.runs.map((run: { id: string }) => run.id), ["private-id"]);

		bridge.dispose();
	});

	it("falls back to executor status when projections are not restored or session identity is stale", async () => {
		const events = new FakeEvents();
		const state = {
			currentSessionId: "old-session",
			statusProjectionSessionId: null,
			foregroundControls: new Map(),
			asyncJobs: new Map(),
		} as any;
		const executed: unknown[] = [];
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx("session-123", "session-123"),
			state,
			execute: async (_id, params) => {
				executed.push(params);
				return { content: [{ type: "text", text: "canonical status" }], details: { mode: "single", results: [] } } as any;
			},
		});

		const reply = await request(events, "status-fallback", "status");

		assert.equal(reply.success, true);
		assert.deepEqual(executed, [{ action: "status" }]);
		assert.equal((reply as { data: { text?: string } }).data.text, "canonical status");

		state.currentSessionId = "session-123";
		executed.length = 0;
		const notRestored = await request(events, "status-not-restored", "status");
		assert.equal(notRestored.success, true);
		assert.deepEqual(executed, [{ action: "status" }]);

		bridge.dispose();
	});

	it("forwards and validates status view, lines, and index through the executor", async () => {
		const events = new FakeEvents();
		const executed: unknown[] = [];
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executed.push(params);
				return { content: [{ type: "text", text: "transcript" }], details: { mode: "single", results: [] } } as any;
			},
		});

		const reply = await request(events, "status-transcript", "status", { id: "run-1", view: "transcript", lines: 25, index: 2 });
		assert.equal(reply.success, true);
		assert.deepEqual(executed, [{ action: "status", id: "run-1", index: 2, view: "transcript", lines: 25 }]);

		const invalid = await request(events, "status-invalid-lines", "status", { lines: 0 });
		assert.equal(invalid.success, false);
		assert.equal((invalid as { error: { code: string } }).error.code, "invalid_params");
		assert.equal(executed.length, 1);

		bridge.dispose();
	});

	it("delegates allowlisted schedule management through the active session", async () => {
		const events = new FakeEvents();
		const executed: unknown[] = [];
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executed.push(params);
				return { content: [{ type: "text", text: "ok" }], details: { mode: "management", results: [] } } satisfies AgentToolResult<Details>;
			},
		});

		assert.equal((await request(events, "manage-list", "manage", { action: "schedule.list" })).success, true);
		assert.equal((await request(events, "manage-pause", "manage", { action: "schedule.pause", id: "nightly" })).success, true);
		assert.deepEqual(executed, [
			{ action: "schedule.list" },
			{ action: "schedule.pause", id: "nightly" },
		]);

		const denied = await request(events, "manage-denied", "manage", { action: "mission.close", id: "mission-1" });
		assert.equal(denied.success, false);
		assert.equal((denied as { error: { code: string } }).error.code, "invalid_params");
		const missingId = await request(events, "manage-missing", "manage", { action: "schedule.run" });
		assert.equal(missingId.success, false);
		assert.equal((missingId as { error: { code: string } }).error.code, "invalid_params");

		bridge.dispose();
	});

	it("projects bounded display-safe active fleet records without internal ids", async () => {
		const events = new FakeEvents();
		const state = {
			currentSessionId: "/sessions/parent.jsonl",
			foregroundControls: new Map(),
			asyncJobs: new Map([["async-private-id", {
				asyncId: "async-private-id", sessionId: "/sessions/parent.jsonl", status: "running", mode: "single",
				description: ["Review", "\u001b]8;;hostile\u0007", "the diff"].join("\n"),
				startedAt: 100, steps: [{ agent: "reviewer", label: "opaque label", status: "running", startedAt: 120, model: "anthropic/claude-opus-4-8:high", thinking: "high", tokens: { input: 12, output: 34, total: 46, window: 40, windowPeak: 44 } }],
			}]]),
		} as any;
		const bridge = registerSubagentRpcBridge({
			events, getContext: () => ctx("runtime-session-id", "/sessions/parent.jsonl"), state,
			execute: async () => ({ content: [{ type: "text", text: "Active async runs: 1" }], details: { mode: "management", results: [] } } as any),
		});
		const reply = await request(events, "fleet-status", "status");
		const fleet = (reply as { data: { fleet: { entries: Array<Record<string, unknown>> } } }).data.fleet;
		assert.equal(fleet.entries.length, 1);
		assert.equal((fleet as { totalActive?: number }).totalActive, 1);
		assert.equal((fleet as { omitted?: number }).omitted, 0);
		assert.deepEqual(fleet.entries[0], {
			key: "fleet-1", agent: "reviewer", role: "opaque label", model: "anthropic/claude-opus-4-8:high", effort: "high",
			startedAt: 120, tokens: { input: 12, output: 34, total: 46, window: 40, windowPeak: 44 },
		});
		assert.equal(JSON.stringify(fleet).includes("Review the diff"), false);
		assert.equal(JSON.stringify(fleet).includes("async-private-id"), false);
		bridge.dispose();
	});

	it("projects fleet text without control characters or malformed UTF-16", async () => {
		const events = new FakeEvents();
		const state = {
			currentSessionId: "session-123",
			foregroundControls: new Map(),
			asyncJobs: new Map([["unicode", {
				asyncId: "unicode", sessionId: "session-123", status: "running", mode: "single", startedAt: 1,
				description: "start\n" + "😀".repeat(257),
				agents: [`worker\ud800broken\udc00${"😀".repeat(45)}`],
			}]]),
		} as any;
		const bridge = registerSubagentRpcBridge({
			events, getContext: () => ctx("session-123", "session-123"), state,
			execute: async () => ({ content: [], details: { mode: "management", results: [] } } as any),
		});
		const reply = await request(events, "fleet-unicode", "status");
		const entry = (reply as any).data.fleet.entries[0];
		const malformedSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

		assert.doesNotMatch(entry.agent, malformedSurrogate);
		assert.equal(entry.goal, undefined);
		assert.ok(entry.agent.length <= 96);
		assert.match(entry.agent, /^worker broken/);
		bridge.dispose();
	});

	it("adds a bounded current async status snapshot to status replies", async () => {
		const events = new FakeEvents();
		const state = {
			currentSessionId: "/sessions/parent.jsonl",
			foregroundControls: new Map(),
			asyncJobs: new Map([["run-1", {
				asyncId: "run-1",
				asyncDir: "/tmp/PRIVATE_RPC_LEAK/run-1",
				cwd: "/repo/PRIVATE_RPC_LEAK",
				sessionDir: "/sessions/PRIVATE_RPC_LEAK",
				outputFile: "/tmp/PRIVATE_RPC_LEAK/output.log",
				sessionId: "/sessions/parent.jsonl",
				status: "running",
				mode: "single",
				agents: ["worker"],
				currentTool: "read",
				steps: [{ agent: "worker", status: "running", currentToolArgs: "PRIVATE_RPC_LEAK args", recentOutput: ["PRIVATE_RPC_LEAK output"] }],
			}]]),
			fleetJobs: new Map([["done", {
				asyncId: "done",
				asyncDir: "/tmp/done",
				sessionId: "/sessions/parent.jsonl",
				status: "complete",
				agents: ["reviewer"],
				updatedAt: 50,
			}]]),
		} as any;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx("runtime-session-id", "/sessions/parent.jsonl"),
			state,
			execute: async () => ({ content: [], details: { mode: "management", results: [] } } as any),
		});

		const reply = await request(events, "async-snapshot", "status");
		const snapshot = (reply as any).data.asyncSnapshot;
		assert.equal(snapshot.kind, "pi-subagents.async-status-snapshot");
		assert.equal(snapshot.version, 1);
		assert.deepEqual(snapshot.runs.map((run: { id: string }) => run.id).sort(), ["done", "run-1"]);
		assert.equal(JSON.stringify(snapshot).includes("PRIVATE_RPC_LEAK"), false);
		assert.equal(JSON.stringify(snapshot).includes("currentToolArgs"), false);
		assert.equal(JSON.stringify(snapshot).includes("recentOutput"), false);
		bridge.dispose();
	});

	it("projects resolved foreground model, effort, and split usage without prompt goals", async () => {
		const events = new FakeEvents();
		const state = {
			currentSessionId: "session-123",
			foregroundControls: new Map([["private-run", {
				runId: "private-run",
				sessionId: "session-123",
				mode: "single",
				startedAt: 90,
				activeChildren: new Map([[0, {
					index: 0,
					agent: "worker",
					description: "Implement the fix",
					startedAt: 100,
					updatedAt: 110,
					model: "openai/gpt-5.6-terra:high",
					thinking: "high",
					inputTokens: 321,
					outputTokens: 45,
					tokens: 366,
				}]]),
			}]]),
			asyncJobs: new Map(),
			activeAsyncCapacity: { used: 2, limit: 4 },
		} as any;
		state.foregroundControls.set("private-old", {
			runId: "private-old",
			sessionId: "old-session",
			mode: "single",
			startedAt: 50,
			currentAgent: "reviewer",
			description: "Old work",
		});
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx("session-123", "session-123"),
			state,
			execute: async () => ({ content: [], details: { mode: "management", results: [] } } as any),
		});
		const reply = await request(events, "foreground-fleet", "status");
		assert.deepEqual((reply as any).data.fleet, {
			version: 1,
			totalActive: 1,
			topLevelAsyncCapacity: { used: 2, limit: 4 },
			omitted: 0,
			entries: [{
				key: "fleet-1",
				agent: "worker",
				model: "openai/gpt-5.6-terra:high",
				effort: "high",
				startedAt: 100,
				tokens: { input: 321, output: 45, total: 366 },
			}],
		});
		assert.equal(JSON.stringify((reply as any).data.fleet).includes("private-run"), false);
		bridge.dispose();
	});

	it("uses monotonic opaque keys across removal/insertion and resets them per session", async () => {
		const events = new FakeEvents();
		const jobs = new Map<string, any>([
			["private-a", { asyncId: "private-a", sessionId: "A", status: "running", mode: "single", startedAt: 1, agents: ["alpha"] }],
			["private-b", { asyncId: "private-b", sessionId: "A", status: "running", mode: "single", startedAt: 2, agents: ["beta"] }],
			["private-unattributed", { asyncId: "private-unattributed", status: "running", mode: "single", startedAt: 3, agents: ["unknown"] }],
		]);
		const state = { currentSessionId: "A", foregroundControls: new Map(), asyncJobs: jobs } as any;
		let activeSession = "A";
		const bridge = registerSubagentRpcBridge({ events, getContext: () => ctx(activeSession, activeSession), state, execute: async () => ({ content: [], details: { mode: "management", results: [] } } as any) });
		const keys = async (id: string) => ((await request(events, id, "status")) as any).data.fleet.entries.map((entry: { key: string }) => entry.key);
		assert.deepEqual(await keys("keys-a"), ["fleet-1", "fleet-2"]);
		jobs.delete("private-b"); jobs.set("private-c", { asyncId: "private-c", sessionId: "A", status: "running", mode: "single", startedAt: 3, agents: ["gamma"] });
		assert.deepEqual(await keys("keys-b"), ["fleet-1", "fleet-3"]);
		state.currentSessionId = "B";
		activeSession = "B";
		assert.deepEqual(await keys("keys-c"), []);
		jobs.set("private-d", { asyncId: "private-d", sessionId: "B", status: "running", mode: "single", startedAt: 4, agents: ["delta"] });
		assert.deepEqual(await keys("keys-d"), ["fleet-1"]);
		bridge.dispose();
	});

	it("reports bounded overflow and excludes unattributed or foreign-session jobs", async () => {
		const events = new FakeEvents();
		const jobs = new Map<string, any>();
		for (let index = 0; index < 18; index += 1) {
			jobs.set(`private-${index}`, {
				asyncId: `private-${index}`,
				sessionId: "session-123",
				status: "running",
				mode: "single",
				startedAt: index + 1,
				agents: [`worker-${index}`],
			});
		}
		jobs.set("unattributed", { asyncId: "unattributed", status: "running", mode: "single", startedAt: 20, agents: ["hidden"] });
		jobs.set("foreign", { asyncId: "foreign", sessionId: "other", status: "running", mode: "single", startedAt: 21, agents: ["hidden"] });
		const state = { currentSessionId: "session-123", foregroundControls: new Map(), asyncJobs: jobs } as any;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx("session-123", "session-123"),
			state,
			execute: async () => ({ content: [], details: { mode: "management", results: [] } } as any),
		});
		const reply = await request(events, "fleet-overflow", "status");
		const fleet = (reply as any).data.fleet;
		assert.equal(fleet.entries.length, 16);
		assert.equal(fleet.totalActive, 18);
		assert.equal(fleet.omitted, 2);
		assert.equal(JSON.stringify(fleet).includes("unattributed"), false);
		assert.equal(JSON.stringify(fleet).includes("foreign"), false);
		bridge.dispose();
	});

	it("forces spawn requests onto the existing async execution path", async () => {
		const events = new FakeEvents();
		let executedParams: any;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executedParams = params;
				return {
					content: [{ type: "text", text: "Async: worker [run-1]" }],
					details: { mode: "single", results: [], asyncId: "run-1", asyncDir: "/tmp/run-1" },
				} as any;
			},
		});

		const reply = await request(events, "spawn-1", "spawn", { workflowScript: "return runs.run('main', { agent: 'worker', task: 'Do work' })" });

		assert.equal(reply.success, true);
		assert.equal(executedParams.workflowScript, "return runs.run('main', { agent: 'worker', task: 'Do work' })");
		assert.equal(executedParams.async, true);
		assert.equal("clarify" in executedParams, false);
		assert.equal((reply as { data: { details?: { asyncId?: string } } }).data.details?.asyncId, "run-1");

		bridge.dispose();
	});

	it("allows direct managed worktree spawn requests", async () => {
		const events = new FakeEvents();
		let executedParams: any;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executedParams = params;
				return { content: [{ type: "text", text: "Async: worker [run-1]" }], details: { mode: "single", results: [] } } as any;
			},
		});

		const reply = await request(events, "spawn-worktree", "spawn", { workflowScript: "return runs.run('main', { agent: 'worker', task: 'Do work' })", worktree: true });

		assert.equal(reply.success, true);
		assert.equal(executedParams.worktree, true);
		assert.equal(executedParams.async, true);
		bridge.dispose();
	});

	it("rejects removed top-level chain and parallel spawn inputs", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async () => { executeCalls++; throw new Error("unreachable"); },
		});

		const chainReply = await request(events, "spawn-chain", "spawn", { chain: [{ agent: "worker" }] });
		const parallelReply = await request(events, "spawn-parallel", "spawn", { tasks: [{ agent: "worker", task: "work" }] });
		const worktreeReply = await request(events, "spawn-worktree", "spawn", { worktree: true });

		assert.equal(chainReply.success, false);
		assert.equal(parallelReply.success, false);
		assert.equal(worktreeReply.success, false);
		assert.match((chainReply as { error?: { message?: string } }).error?.message ?? "", /workflowScript/);
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("passes structured single-child spawn requests to the direct async path", async () => {
		const events = new FakeEvents();
		let executedParams: any;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executedParams = params;
				return { content: [{ type: "text", text: "Async: worker [run-1]" }], details: { mode: "workflow", results: [], asyncId: "run-1" } } as any;
			},
		});

		const reply = await request(events, "spawn-structured", "spawn", { agent: "worker", task: "Do work" });
		assert.equal(reply.success, true);
		assert.equal(executedParams.agent, "worker");
		assert.equal(executedParams.task, "Do work");
		assert.equal(executedParams.async, true);
		assert.equal(executedParams.output, true);
		assert.equal(executedParams.workflowScript, undefined);
		bridge.dispose();
	});

	it("rejects foreground or management spawn requests before executor dispatch", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async () => {
				executeCalls++;
				return { content: [{ type: "text", text: "unexpected" }], details: { mode: "single", results: [] } } as any;
			},
		});

		const foreground = await request(events, "spawn-foreground", "spawn", { agent: "worker", task: "Do work", async: false });
		const management = await request(events, "spawn-management", "spawn", { action: "list" });

		assert.equal(foreground.success, false);
		assert.equal((foreground as { error: { code: string; message: string } }).error.code, "invalid_params");
		assert.match((foreground as { error: { message: string } }).error.message, /detached async/);
		assert.equal(management.success, false);
		assert.match((management as { error: { message: string } }).error.message, /does not accept management/);
		assert.equal(executeCalls, 0);

		bridge.dispose();
	});

	it("delegates acknowledged steering through the existing async action", async () => {
		const events = new FakeEvents();
		let executedParams: unknown;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executedParams = params;
				return {
					content: [{ type: "text", text: "Steering delivered." }],
					details: { mode: "management", results: [] },
				} as any;
			},
		});

		const reply = await request(events, "steer-1", "steer", {
			id: "abc123",
			index: 0,
			message: " Focus on the failing test. ",
			mode: "follow_up",
		});

		assert.equal(reply.success, true);
		assert.deepEqual(executedParams, {
			action: "steer",
			id: "abc123",
			index: 0,
			message: "Focus on the failing test.",
			mode: "follow_up",
			steeringRecovery: false,
		});
		assert.equal((reply as { data: { text?: string } }).data.text, "Steering delivered.");

		bridge.dispose();
	});

	it("rejects targetless RPC steering before executor dispatch", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async () => {
				executeCalls++;
				return { content: [], details: { mode: "management", results: [] } } as any;
			},
		});

		const reply = await request(events, "steer-no-target", "steer", {
			message: "keep going",
		});

		assert.equal(reply.success, false);
		assert.equal((reply as { error: { code: string } }).error.code, "invalid_params");
		assert.match((reply as { error: { message: string } }).error.message, /requires id, runId, or dir/);
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("rejects empty RPC steering before executor dispatch", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async () => {
				executeCalls++;
				return { content: [], details: { mode: "management", results: [] } } as any;
			},
		});

		const reply = await request(events, "steer-empty", "steer", {
			id: "abc123",
			message: "   ",
		});

		assert.equal(reply.success, false);
		assert.equal((reply as { error: { code: string } }).error.code, "invalid_params");
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("delegates resume through the existing package-owned revival action", async () => {
		const events = new FakeEvents();
		let executedParams: unknown;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executedParams = params;
				return {
					content: [{ type: "text", text: "Revived async subagent from run-1." }],
					details: { mode: "single", results: [], asyncId: "run-2", asyncDir: "/tmp/run-2" },
				} as any;
			},
		});

		const reply = await request(events, "resume-1", "resume", {
			id: "run-1",
			index: 0,
			message: " Continue with the focused review. ",
			output: " /tmp/revived-output.md ",
			outputMode: "file-only",
		});

		assert.equal(reply.success, true);
		assert.deepEqual(executedParams, {
			action: "resume",
			id: "run-1",
			index: 0,
			message: "Continue with the focused review.",
			output: "/tmp/revived-output.md",
			outputMode: "file-only",
		});
		assert.equal((reply as { data: { details?: { asyncId?: string } } }).data.details?.asyncId, "run-2");

		bridge.dispose();
	});

	it("rejects targetless or empty RPC resume before executor dispatch", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async () => {
				executeCalls++;
				return { content: [], details: { mode: "management", results: [] } } as any;
			},
		});

		const targetless = await request(events, "resume-no-target", "resume", { message: "continue" });
		const empty = await request(events, "resume-empty", "resume", { id: "run-1", message: "   " });
		const inlineOutput = await request(events, "resume-inline", "resume", {
			id: "run-1",
			message: "continue",
			output: "/tmp/output.md",
			outputMode: "inline",
		});

		assert.equal(targetless.success, false);
		assert.equal((targetless as { error: { code: string } }).error.code, "invalid_params");
		assert.match((targetless as { error: { message: string } }).error.message, /requires id, runId, or dir/);
		assert.equal(empty.success, false);
		assert.equal((empty as { error: { code: string } }).error.code, "invalid_params");
		assert.equal(inlineOutput.success, false);
		assert.match((inlineOutput as { error: { message: string } }).error.message, /file-only/);
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("delegates interrupt through the existing executor action", async () => {
		const events = new FakeEvents();
		let executedParams: unknown;
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => ctx(),
			execute: async (_id, params) => {
				executedParams = params;
				return { content: [{ type: "text", text: "Interrupt requested for async run abc123." }], details: { mode: "management", results: [] } } as any;
			},
		});

		const reply = await request(events, "interrupt-1", "interrupt", { id: "abc123" });

		assert.equal(reply.success, true);
		assert.deepEqual(executedParams, { action: "interrupt", id: "abc123" });

		bridge.dispose();
	});

	it("uses the async stop control path for stop", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-stop-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stop");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stop",
				sessionId: "/sessions/parent.jsonl",
				mode: "single",
				state: "running",
				pid: 4242,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			const bridge = registerSubagentRpcBridge({
				events,
				getContext: () => ctx(),
				execute: async () => assert.fail("stop should not call executor"),
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => true,
				now: () => 150,
			});

			const reply = await request(events, "stop-1", "stop", { id: "run-stop" });

			assert.equal(reply.success, true);
			assert.equal((reply as { data: { runId?: string; state?: string } }).data.runId, "run-stop");
			assert.equal((reply as { data: { state?: string } }).data.state, "stopping");
			assert.equal(consumeStopRequestPayload(asyncDir)?.type, "stop");

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("acknowledges RPC child stop for exactly one async child", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-child-stop-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stop-child");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stop-child",
				sessionId: "/sessions/parent.jsonl",
				mode: "parallel",
				state: "running",
				pid: 4242,
				startedAt: 100,
				lastUpdate: 100,
				steps: [
					{ agent: "fast", status: "running", runId: "child-a", startedAt: 100 },
					{ agent: "slow", status: "running", workflowKey: "review", startedAt: 100 },
				],
			}, null, 2), "utf-8");
			const bridge = registerSubagentRpcBridge({
				events,
				getContext: () => ctx(),
				execute: async () => assert.fail("stop should not call executor"),
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => true,
				now: () => 150,
			});

			const reply = await request(events, "stop-child-1", "stop", { id: "run-stop-child", childId: "review" });

			assert.equal(reply.success, true);
			assert.equal((reply as { data: { runId?: string; childId?: string; state?: string } }).data.runId, "run-stop-child");
			assert.equal((reply as { data: { childId?: string } }).data.childId, "review");
			assert.equal((reply as { data: { state?: string } }).data.state, "stopping");
			assert.deepEqual(consumeStopRequestPayload(asyncDir), { type: "stop", ts: 150, source: "rpc-stop", targetIndex: 1, childId: "review" });
			const childStatus = events.emitted.find((entry) => entry.event === SUBAGENT_CHILD_STATUS_EVENT)?.data as SubagentChildStatusEvent | undefined;
			assert.deepEqual(childStatus, {
				type: "subagent.child-status",
				version: 1,
				runId: "run-stop-child",
				childId: "review",
				status: "stopping",
				ts: 150,
				reason: "rpc",
				source: "rpc",
				asyncDir,
				stepIndex: 1,
				agent: "slow",
				workflowKey: "review",
			});

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the live workflow child stopper for RPC child stop", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-workflow-child-stop-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "workflow-stop-child");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "workflow-stop-child",
				sessionId: "/sessions/parent.jsonl",
				mode: "workflow",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				steps: [
					{ agent: "worker", status: "running", workflowKey: "slow", startedAt: 100 },
					{ agent: "worker", status: "running", workflowKey: "sibling", startedAt: 100 },
				],
			}, null, 2), "utf-8");
			const calls: Array<{ childId: string; message?: string }> = [];
			const state = { workflowChildStops: new Map([["workflow-stop-child", (childId: string, message?: string) => { calls.push({ childId, message }); return true; }]]) } as SubagentState;
			const bridge = registerSubagentRpcBridge({
				events,
				getContext: () => ctx(),
				execute: async () => assert.fail("stop should not call executor"),
				asyncDirRoot: asyncRoot,
				resultsDir,
				state,
			});

			const reply = await request(events, "stop-workflow-child", "stop", { id: "workflow-stop-child", childId: "slow" });

			assert.equal(reply.success, true);
			assert.equal((reply as { data: { childId?: string; state?: string } }).data.childId, "slow");
			assert.equal((reply as { data: { state?: string } }).data.state, "stopping");
			assert.deepEqual(calls, [{ childId: "slow", message: "Workflow child 'slow' stopped by RPC." }]);
			assert.equal(fs.existsSync(stopRequestPath(asyncDir)), false);
			const childStatus = events.emitted.find((entry) => entry.event === SUBAGENT_CHILD_STATUS_EVENT)?.data as SubagentChildStatusEvent | undefined;
			assert.equal(childStatus?.runId, "workflow-stop-child");
			assert.equal(childStatus?.childId, "slow");
			assert.equal(childStatus?.status, "stopping");
			assert.equal(childStatus?.reason, "rpc");
			assert.equal(childStatus?.source, "rpc");
			assert.equal(childStatus?.workflowKey, "slow");

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the live workflow controller for RPC run-level workflow stop", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-workflow-run-stop-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "workflow-run-stop");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "workflow-run-stop",
				sessionId: "/sessions/parent.jsonl",
				mode: "workflow",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				steps: [
					{ agent: "worker", status: "running", childId: "child-slow", workflowKey: "slow", startedAt: 100 },
					{ agent: "worker", status: "completed", workflowKey: "done", startedAt: 100, endedAt: 120 },
				],
			}, null, 2), "utf-8");
			const controller = new AbortController();
			const calls: Array<{ childId: string; message?: string }> = [];
			const state = {
				workflowControllers: new Map([["workflow-run-stop", controller]]),
				workflowChildStops: new Map([["workflow-run-stop", (childId: string, message?: string) => { calls.push({ childId, message }); return true; }]]),
			} as SubagentState;
			const bridge = registerSubagentRpcBridge({
				events,
				getContext: () => ctx(),
				execute: async () => assert.fail("stop should not call executor"),
				asyncDirRoot: asyncRoot,
				resultsDir,
				state,
			});

			const reply = await request(events, "stop-workflow-run", "stop", { id: "workflow-run-stop" });

			assert.equal(reply.success, true);
			assert.equal((reply as { data: { runId?: string; state?: string; childId?: string } }).data.runId, "workflow-run-stop");
			assert.equal((reply as { data: { state?: string } }).data.state, "stopping");
			assert.equal((reply as { data: { childId?: string } }).data.childId, undefined);
			assert.deepEqual(calls, [{ childId: "child-slow", message: "Workflow stopped by RPC." }]);
			assert.equal(controller.signal.aborted, true);
			assert.equal(controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason), "Workflow stopped by RPC.");
			assert.equal(fs.existsSync(stopRequestPath(asyncDir)), false);

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects RPC child stop when the child is absent or terminal", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-child-stop-reject-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stop-child-reject");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stop-child-reject",
				sessionId: "/sessions/parent.jsonl",
				mode: "parallel",
				state: "running",
				pid: 4242,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "done", status: "complete", workflowKey: "done", startedAt: 100, endedAt: 120 }],
			}, null, 2), "utf-8");
			const bridge = registerSubagentRpcBridge({
				events,
				getContext: () => ctx(),
				execute: async () => assert.fail("stop should not call executor"),
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => true,
				now: () => 150,
			});

			const missing = await request(events, "stop-child-missing", "stop", { id: "run-stop-child-reject", childId: "missing" });
			assert.equal(missing.success, false);
			assert.equal((missing as { error: { code: string } }).error.code, "not_found");
			const terminal = await request(events, "stop-child-terminal", "stop", { id: "run-stop-child-reject", childId: "done" });
			assert.equal(terminal.success, false);
			assert.equal((terminal as { error: { code: string; message: string } }).error.code, "invalid_state");
			assert.match((terminal as { error: { message: string } }).error.message, /complete/);
			assert.equal(fs.existsSync(stopRequestPath(asyncDir)), false);

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	for (const scenario of ["no-state", "empty-maps", "child-no-state", "child-controller-only", "child-callback-false", "run-callback-only"] as const) it(`rejects workflow stop without the required live control: ${scenario}`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-stop-workflow-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "workflow-run");
			let killCalls = 0;
			const controller = new AbortController();
			const calls: string[] = [];
			const stopChild = (childId: string) => { calls.push(childId); return false; };
			const childId = scenario.startsWith("child-") ? "worker" : undefined;
			const state = scenario === "no-state" || scenario === "child-no-state" ? undefined : {
				workflowControllers: new Map(scenario === "child-controller-only" || scenario === "child-callback-false" ? [["workflow-run", controller]] : []),
				workflowChildStops: new Map(scenario === "child-callback-false" || scenario === "run-callback-only" ? [["workflow-run", stopChild]] : []),
			} as SubagentState;
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "workflow-run",
				sessionId: "/sessions/parent.jsonl",
				mode: "workflow",
				state: "running",
				pid: 4242,
				startedAt: 100,
				lastUpdate: 100,
				steps: [
					{ workflowKey: "worker", agent: "worker", status: "running", startedAt: 100 },
					{ workflowKey: "sibling", agent: "worker", status: "running", startedAt: 100 },
				],
			}, null, 2), "utf-8");
			const statusBefore = fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8");
			const bridge = registerSubagentRpcBridge({
				events,
				state,
				getContext: () => ctx(),
				execute: async () => assert.fail("stop should not call executor"),
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => {
					killCalls++;
					return true;
				},
				now: () => 150,
			});

			const reply = await request(events, "stop-workflow", "stop", { id: "workflow-run", ...(childId ? { childId } : {}) });

			assert.equal(reply.success, false);
			assert.equal((reply as { error: { code: string } }).error.code, "invalid_state");
			assert.match((reply as { error: { message: string } }).error.message,
				scenario === "child-callback-false" ? /not available to stop/ : childId ? /no live stop callback/ : /no live run controller/);
			assert.equal(fs.existsSync(stopRequestPath(asyncDir)), false);
			assert.equal(fs.existsSync(stopRequestsDir(asyncDir)), false);
			assert.equal(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"), statusBefore);
			assert.equal(events.emitted.some(({ event }) => event === SUBAGENT_CHILD_STATUS_EVENT), false);
			assert.equal(controller.signal.aborted, false);
			assert.deepEqual(calls, scenario === "child-callback-false" ? ["worker"] : []);
			assert.equal(killCalls, 0);

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects stop requests for async runs from a different session", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-stop-session-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-other-session");
			let killCalls = 0;
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-other-session",
				sessionId: "other-session",
				mode: "single",
				state: "running",
				pid: 4242,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");
			const bridge = registerSubagentRpcBridge({
				events,
				getContext: () => ctx(),
				execute: async () => assert.fail("stop should not call executor"),
				asyncDirRoot: asyncRoot,
				resultsDir,
				kill: () => {
					killCalls++;
					return true;
				},
				now: () => 150,
			});

			const reply = await request(events, "stop-other-session", "stop", { id: "run-other-session" });

			assert.equal(reply.success, false);
			assert.equal((reply as { error: { code: string; message: string } }).error.code, "not_found");
			assert.match((reply as { error: { message: string } }).error.message, /active session/);
			assert.equal(fs.existsSync(stopRequestPath(asyncDir)), false);
			assert.equal(killCalls, 0);

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
