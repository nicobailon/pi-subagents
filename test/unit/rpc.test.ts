import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { stopRequestPath } from "../../src/runs/background/control-channel.ts";
import {
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REQUEST_EVENT,
	registerSubagentRpcBridge,
	subagentRpcReplyEvent,
	type SubagentRpcReplyEnvelope,
} from "../../src/extension/rpc.ts";

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
			(reply as { data: { capabilities?: { nonRecoveringSteer?: boolean } } }).data.capabilities?.nonRecoveringSteer,
			true,
		);
		assert.equal(
			(reply as { data: { capabilities?: { resume?: boolean } } }).data.capabilities?.resume,
			true,
		);
		assert.deepEqual(
			(reply as { data: { capabilities?: { fleetStatus?: unknown } } }).data.capabilities?.fleetStatus,
			{ version: 1 },
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
		assert.deepEqual((reply as { data: { fleet?: unknown } }).data.fleet, {
			version: 1, entries: [], totalActive: 0, omitted: 0,
		});

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
				startedAt: 100, steps: [{ agent: "reviewer", label: "opaque label", status: "running", startedAt: 120, model: "anthropic/claude-opus-4-8:high", thinking: "high", tokens: { input: 12, output: 34, total: 46 } }],
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
			startedAt: 120, tokens: { input: 12, output: 34, total: 46 }, goal: "Review the diff",
		});
		assert.equal(JSON.stringify(fleet).includes("async-private-id"), false);
		bridge.dispose();
	});

	it("projects resolved foreground model, effort, split usage, and goal", async () => {
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
			omitted: 0,
			entries: [{
				key: "fleet-1",
				agent: "worker",
				model: "openai/gpt-5.6-terra:high",
				effort: "high",
				startedAt: 100,
				tokens: { input: 321, output: 45, total: 366 },
				goal: "Implement the fix",
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

		const direct = await request(events, "spawn-direct", "spawn", { agent: "worker", task: "Do work" });
		const foreground = await request(events, "spawn-foreground", "spawn", { workflowScript: "return runs.run('main', { agent: 'worker' })", async: false });
		const management = await request(events, "spawn-management", "spawn", { action: "list" });

		assert.equal(direct.success, false);
		assert.match((direct as { error: { message: string } }).error.message, /Direct execution was removed/);

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
			assert.equal(fs.existsSync(stopRequestPath(asyncDir)), true);

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
