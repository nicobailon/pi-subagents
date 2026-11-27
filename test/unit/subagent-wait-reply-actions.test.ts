import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { createNativeSupervisorChannel, ensureSupervisorChannelDir, resolveSupervisorChannelDir } from "../../src/intercom/native-supervisor-channel.ts";
import { ACTIVE_RUN_INDEX_DIR } from "../../src/runs/background/active-run-index.ts";
import { createWaitExecute } from "../../src/runs/background/wait-tool.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { DIRS } from "../../src/shared/types.ts";

const SESSION = "session-wait-reply";

function setup(caller: "parent" | "child" = "parent") {
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
		allowMutatingManagementActions: caller === "parent",
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
	for (const caller of ["parent", "child"] as const) it(`${caller} can read and answer its child's question without a foreground run`, async () => {
		const { channel, call } = setup(caller);
		const runId = `run-${randomUUID()}`;
		const { requestId, channelDir } = writeAsk(runId, "Rerun only the failed job?");
		try {
			const before = await call({ action: "status" });
			assert.notEqual(before.isError, true, text(before));
			assert.match(text(before), /Child questions waiting for an answer/);
			assert.match(text(before), new RegExp(`${requestId}[\\s\\S]*Rerun only the failed job\\?`));

			const reply = await call({ action: "reply", replyTo: requestId, message: "Yes, only that job." });
			assert.equal(reply.isError, undefined);
			assert.match(text(reply), new RegExp(`Replied to supervisor request ${requestId}`));
			const written = JSON.parse(fs.readFileSync(path.join(channelDir, "replies", `${requestId}.json`), "utf8"));
			assert.equal(written.message, "Yes, only that job.");

			const after = await call({ action: "status" });
			assert.doesNotMatch(text(after), /Child questions waiting/);
			if (caller === "child") {
				assert.equal(after.isError, true);
				assert.match(text(after), /requires an id/);
			}
		} finally {
			channel.dispose();
			fs.rmSync(channelDir, { recursive: true, force: true });
		}
	});

	it("reports a failed run listing alongside the pending child question", async () => {
		const { channel, call } = setup();
		const { requestId, channelDir } = writeAsk(`run-${randomUUID()}`, "Which job should I rerun?");
		const runs = fs.mkdtempSync(path.join(os.tmpdir(), "status-list-error-"));
		const previousRuns = DIRS.async;
		try {
			fs.writeFileSync(path.join(runs, ACTIVE_RUN_INDEX_DIR), "not a directory");
			DIRS.async = runs;
			const result = await call({ action: "status" });
			const message = text(result);
			assert.equal(result.isError, true, message);
			assert.match(message, /Failed to list async runs/);
			assert.ok(message.includes(requestId));
			assert.match(message, /Which job should I rerun\?/);
		} finally {
			DIRS.async = previousRuns;
			channel.dispose();
			fs.rmSync(channelDir, { recursive: true, force: true });
			fs.rmSync(runs, { recursive: true, force: true });
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
