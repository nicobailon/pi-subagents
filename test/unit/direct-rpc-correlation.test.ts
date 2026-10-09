import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { DIRS, SUBAGENT_ASYNC_STARTED_EVENT, type AsyncStatus, type Details, type SubagentState } from "../../src/shared/types.ts";
import { registerSubagentRpcBridge, SUBAGENT_RPC_REQUEST_EVENT, subagentRpcReplyEvent, type SubagentRpcReplyEnvelope } from "../../src/extension/rpc.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, mockPi, tempDir, waitForAsyncResultFile } from "../support/async-execution-fixture.ts";

function host() {
	const events = createEventBus();
	const ctx = makeMinimalCtx(tempDir) as ExtensionContext;
	const state: SubagentState = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
	const executor = createSubagentExecutor({
		pi: { events, getSessionName: () => undefined, sendMessage() {} } as ExtensionAPI,
		state, config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => tempDir, expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [makeAgent("worker") as AgentConfig] }),
	});
	const bridge = registerSubagentRpcBridge({ events, state, getContext: () => ctx, execute: executor.executePublic });
	async function rpc(method: string, params: unknown, requestId = randomUUID()): Promise<SubagentRpcReplyEnvelope> {
		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => { dispose(); reject(new Error(`RPC ${method} timed out`)); }, 15_000);
			const dispose = events.on(subagentRpcReplyEvent(requestId), (reply) => {
				clearTimeout(timeout); dispose(); resolve(reply as SubagentRpcReplyEnvelope);
			});
			events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId, method, params });
		});
	}
	return { events, ctx, executor, rpc, dispose: () => bridge.dispose() };
}

function status(id: string): AsyncStatus {
	return JSON.parse(fs.readFileSync(path.join(DIRS.async, id, "status.json"), "utf8")) as AsyncStatus;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "timed out waiting for runner evidence");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// A new OS process has no live jobs, status cache, or launch response. It only
// receives the original tool-call alias and reads the existing persisted indexes.
function freshLookup(id: string, sessionId = "session-123", view?: "transcript") {
	const script = `
		import { resolveSubagentRunId } from ${JSON.stringify(new URL("../../src/runs/background/run-id-resolver.ts", import.meta.url).href)};
		import { inspectSubagentStatus } from ${JSON.stringify(new URL("../../src/runs/background/run-status.ts", import.meta.url).href)};
		const state = { baseCwd: ${JSON.stringify(tempDir)}, currentSessionId: ${JSON.stringify(sessionId)}, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
		const params = ${JSON.stringify({ id, ...(view ? { view } : {}) })};
		let resolved, error;
		try { resolved = resolveSubagentRunId(params.id, { state }); } catch (e) { error = e.message; }
		const result = inspectSubagentStatus(params, { state });
		console.log(JSON.stringify({ pid: process.pid, resolved, error, result }));
	`;
	return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "-e", script], {
		encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
	})) as { pid: number; resolved?: { kind: string; id: string }; error?: string; result: { isError?: boolean; details: Details; content: Array<{ text: string }> } };
}

function assertIdentity(id: string, toolCallId: string) {
	const recovered = freshLookup(toolCallId);
	assert.notEqual(recovered.pid, process.pid);
	assert.equal(recovered.resolved?.id, id, "persisted tool-call alias must resolve in a fresh process");
	assert.equal(recovered.resolved?.kind, "async");
	assert.equal(recovered.result.isError, undefined);
	assert.equal(recovered.result.details.runId, id);
	assert.equal(recovered.result.details.toolCallId, toolCallId);
	return recovered;
}

describe("direct RPC correlation", () => {
	installAsyncExecutionHooks();

	it("recovers a dropped direct spawn response while running and after runner completion without launching twice", async (t) => {
		const runtime = host();
		t.after(runtime.dispose);
		const requestId = randomUUID();
		const toolCallId = `rpc-spawn-${requestId}`;
		const release = path.join(tempDir, "release-worker");
		const sideEffect = path.join(tempDir, "worker-proof");
		mockPi.onCall({ waitForPath: release, output: "worker completed once", writeFiles: [{ path: sideEffect, content: "done" }] });
		let runId: string | undefined;
		let initialToolCallId: string | undefined;
		let eventToolCallId: string | undefined;
		runtime.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (value) => {
			const event = value as { id: string; toolCallId?: string };
			runId = event.id;
			eventToolCallId = event.toolCallId;
			initialToolCallId = status(event.id).toolCallId;
		});
		// Do not subscribe to the response channel: the caller loses its receipt.
		runtime.events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId, method: "spawn", params: { agent: "worker", task: "Do the bounded work", context: "fresh", acceptance: false } });
		await waitFor(() => runId !== undefined);
		const id = runId!; // independent lifecycle observation, not recovery input
		try {
			await waitFor(() => mockPi.callCount() === 1 && status(id).steps?.[0]?.status === "running");
			assert.equal(status(id).state, "running");
			assertIdentity(id, toolCallId);
			assert.equal(initialToolCallId, toolCallId, "launch persists identity before announcing startup");
			assert.equal(eventToolCallId, toolCallId);
			assert.equal(status(id).toolCallId, toolCallId, "runner rewrite retains launch identity");
			const unknown = freshLookup(requestId);
			assert.equal(unknown.resolved, undefined, "raw request UUID is not a run alias");
			assert.equal(unknown.result.isError, true);
			assert.equal(unknown.result.details.runId, undefined, "not-found supplies no execution evidence");
			const foreign = freshLookup(toolCallId, "foreign-session", "transcript");
			assert.equal(foreign.result.isError, true);
			assert.match(foreign.result.content[0]!.text, /only available.*current session/);
			const original = runtime.ctx.sessionManager.getSessionId;
			runtime.ctx.sessionManager.getSessionId = () => "foreign-session";
			try {
				const stopped = await runtime.rpc("stop", { id: toolCallId });
				assert.equal(stopped.success, false);
				if (!stopped.success) assert.equal(stopped.error.code, "not_found");
			} finally { runtime.ctx.sessionManager.getSessionId = original; }
		} finally {
			fs.writeFileSync(release, "release");
			await waitForAsyncResultFile(id);
			await waitFor(() => status(id).processTerminal?.state === "observed");
		}
		assert.equal(status(id).state, "complete");
		assert.equal(fs.readFileSync(sideEffect, "utf8"), "done");
		const sideEffectTime = fs.statSync(sideEffect).mtimeMs;
		assertIdentity(id, toolCallId);
		const result = JSON.parse(fs.readFileSync(path.join(DIRS.results, `${id}.json`), "utf8"));
		assert.equal(result.toolCallId, toolCallId);
		assert.equal(result.results[0].output, "worker completed once");
		// Prove terminal result indexing independently of retained status/active indexes.
		fs.rmSync(path.join(DIRS.async, id), { recursive: true });
		assertIdentity(id, toolCallId);
		assert.equal(fs.statSync(sideEffect).mtimeMs, sideEffectTime, "recovery does not repeat the worker write");
		assert.equal(mockPi.callCount(), 1);
	});

	it("keeps workflow parent and direct async child identities distinct", async (t) => {
		const runtime = host();
		t.after(runtime.dispose);
		mockPi.onCall({ output: "workflow child complete" });
		const parentToolCallId = `workflow-${randomUUID()}`;
		const launched = await runtime.executor.execute(parentToolCallId, {
			workflowScript: 'return await runs.run("child", { agent: "worker", task: "Do work", async: true, context: "fresh", acceptance: false });',
			async: true, mission: false,
		}, new AbortController().signal, undefined, runtime.ctx);
		assert.equal(launched.isError, undefined);
		const parentId = launched.details.asyncId;
		assert.ok(parentId);
		const result = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(parentId), "utf8"));
		assert.equal(result.success, true);
		const childId = status(parentId).steps?.[0]?.runId;
		assert.ok(childId);
		const childResult = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(childId), "utf8"));
		await waitFor(() => status(childId).processTerminal?.state === "observed");
		assert.equal(childResult.results[0].output, "workflow child complete");
		const child = status(childId);
		assert.equal(child.parentWorkflowRunId, parentId);
		assert.ok(child.toolCallId);
		assert.notEqual(child.toolCallId, parentToolCallId);
		assertIdentity(parentId, parentToolCallId);
		assertIdentity(childId, child.toolCallId);
		assert.equal(mockPi.callCount(), 1);
	});
});
