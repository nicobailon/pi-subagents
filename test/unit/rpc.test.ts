import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { timeoutRequestPath } from "../../src/runs/background/control-channel.ts";
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

function ctx() {
	return {
		cwd: "/repo",
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => "/sessions/parent.jsonl",
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

		const reply = await request(events, "spawn-1", "spawn", { agent: "worker", task: "Do work" });

		assert.equal(reply.success, true);
		assert.equal(executedParams.agent, "worker");
		assert.equal(executedParams.task, "Do work");
		assert.equal(executedParams.async, true);
		assert.equal(executedParams.clarify, false);
		assert.equal((reply as { data: { details?: { asyncId?: string } } }).data.details?.asyncId, "run-1");

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

	it("uses the existing async timeout control path for stop", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-stop-"));
		try {
			const events = new FakeEvents();
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const asyncDir = path.join(asyncRoot, "run-stop");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "run-stop",
				sessionId: "session-123",
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
			assert.equal(fs.existsSync(timeoutRequestPath(asyncDir)), true);

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
			assert.equal(fs.existsSync(timeoutRequestPath(asyncDir)), false);
			assert.equal(killCalls, 0);

			bridge.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
