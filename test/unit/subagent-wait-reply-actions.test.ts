import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { createNativeSupervisorChannel, ensureSupervisorChannelDir, resolveSupervisorChannelDir } from "../../src/intercom/native-supervisor-channel.ts";
import { createWaitExecute } from "../../src/runs/background/wait-tool.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";

const SESSION = "session-wait-reply";

function setup() {
	const state = { ...createChildSafeState(), currentSessionId: SESSION, supervisorOwnerSessionId: SESSION };
	const pi = {
		events: { emit() {}, on() { return () => {}; } },
		on() {},
		getAllTools: () => [],
		registerTool() {},
		sendMessage() {},
		getSessionName: () => "parent",
	} as never;
	const channel = createNativeSupervisorChannel(pi, state);
	const executor = createSubagentExecutor({
		pi,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never,
		asyncByDefault: true,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: () => os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] }),
		wait: createWaitExecute(pi, state),
		runSupervisorAction: (input) => channel.runParentAction(input),
	});
	const ctx = {
		cwd: os.tmpdir(),
		hasUI: false,
		sessionManager: { getSessionId: () => SESSION, getSessionFile: () => null, getEntries: () => [], getBranch: () => [] },
		modelRegistry: { getAvailable: () => [] },
	} as never;
	const call = (params: Record<string, unknown>) => executor.execute(randomUUID(), params, new AbortController().signal, undefined, ctx);
	return { channel, call };
}

function writeAsk(runId: string, message: string): { requestId: string; channelDir: string } {
	const channelDir = resolveSupervisorChannelDir(runId, "worker", 0);
	ensureSupervisorChannelDir(channelDir);
	const requestId = randomUUID();
	fs.writeFileSync(path.join(channelDir, "requests", `${requestId}.json`), JSON.stringify({
		type: "subagent.supervisor.request", id: requestId, createdAt: Date.now(), reason: "need_decision", message,
		expectsReply: true, orchestratorSessionId: SESSION, orchestratorTarget: "parent", runId, agent: "worker", childIndex: 0,
	}));
	return { requestId, channelDir };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((item) => item.text ?? "").join("\n");

describe("subagent wait and reply actions", () => {
	it("status lists a child's question, reply answers it, and status then drops it", async () => {
		const { channel, call } = setup();
		const runId = `run-${randomUUID()}`;
		const { requestId, channelDir } = writeAsk(runId, "Rerun only the failed job?");
		try {
			const before = text(await call({ action: "status" }));
			assert.match(before, /Child questions waiting for an answer/);
			assert.match(before, new RegExp(`${requestId}[\\s\\S]*Rerun only the failed job\\?`));

			const reply = await call({ action: "reply", replyTo: requestId, message: "Yes, only that job." });
			assert.equal(reply.isError, undefined);
			assert.match(text(reply), new RegExp(`Replied to supervisor request ${requestId}`));
			const written = JSON.parse(fs.readFileSync(path.join(channelDir, "replies", `${requestId}.json`), "utf8"));
			assert.equal(written.message, "Yes, only that job.");

			assert.doesNotMatch(text(await call({ action: "status" })), /Child questions waiting/);
		} finally {
			channel.dispose();
			fs.rmSync(channelDir, { recursive: true, force: true });
		}
	});

	it("wait reports that no run matched, with its fields", async () => {
		const { channel, call } = setup();
		try {
			assert.match(text(await call({ action: "wait", id: "missing-run" })), /No active run matched "missing-run"\. Nothing to wait for\./);
			assert.match(text(await call({ action: "wait", all: true, timeoutMs: 50 })), /Nothing to wait for/);
		} finally {
			channel.dispose();
		}
	});
});
