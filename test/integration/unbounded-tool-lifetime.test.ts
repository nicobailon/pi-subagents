import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { runSubagent } from "../../src/runs/background/subagent-runner.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";
import { createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import { installSingleExecutionHooks, makeExecutor, mockPi, tempDir } from "../support/single-execution-fixture.ts";

const LONG_TOOL_MS = 31 * 60 * 1000;
const response = { steps: [
	{ jsonl: [{ type: "tool_execution_start", toolCallId: "long-read", toolName: "read", args: { path: "large-file" } }] },
	{ delay: LONG_TOOL_MS, jsonl: [
		{ type: "tool_execution_end", toolCallId: "long-read", toolName: "read", isError: false, result: { content: [{ type: "text", text: "completed" }] } },
		events.assistantMessage("Long tool completed"),
	] },
] };

async function flushUntil(predicate: () => boolean, advance?: () => void): Promise<void> {
	for (let attempt = 0; attempt < 1000 && !predicate(); attempt++) { advance?.(); await setImmediate(); }
	assert.ok(predicate(), "execution did not reach the expected boundary");
}

for (const explicitBudget of [undefined, 1000]) it(`native runner ${explicitBudget ? "preserves an explicit tool budget" : "keeps a healthy open tool alive beyond thirty minutes"}`, async (t) => {
	const dir = createTempDir("unbounded-tool-");
	t.after(() => removeTempDir(dir));
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	fs.writeFileSync(path.join(dir, "default-response.json"), JSON.stringify(response));
	const children = createFakeChildSessions(() => dir);
	const built = buildAsyncRunnerSteps("long-tool", {
		chain: [{ agent: "worker", task: "Run", acceptance: false }], agents: [{ ...makeAgent("worker"), defaultToolTimeoutMs: 20 }],
		ctx: { cwd: dir, currentSessionId: "long-tool-session" }, asyncDir: dir, maxSubagentDepth: 2,
		executionLifetime: { mode: "unbounded" }, configToolTimeoutMs: 30, toolTimeoutMsEnv: "40", callToolTimeoutMs: explicitBudget,
	});
	assert.ok("steps" in built);
	const resultPath = path.join(dir, "result.json");
	let settled = false;
	const running = runSubagent({ id: "long-tool", sessionId: "long-tool-session", steps: built.steps, cwd: dir, asyncDir: dir, resultPath, placeholder: "", artifactConfig: { enabled: false }, executionLifetime: { mode: "unbounded" } }, children.factory).finally(() => { settled = true; });
	await flushUntil(() => fs.existsSync(path.join(dir, "status.json")) && JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")).currentTool === "read", () => t.mock.timers.tick(100));
	await setImmediate();
	t.mock.timers.tick(explicitBudget === undefined ? 30 * 60 * 1000 + 1 : explicitBudget + 1);
	await setImmediate();
	if (explicitBudget === undefined) {
		assert.equal(settled, false);
		assert.equal(children.sessions[0]?.aborted, false);
		t.mock.timers.tick(60_000);
	}
	await flushUntil(() => settled, () => t.mock.timers.tick(100));
	await running;
	const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
	assert.equal(result.success, explicitBudget === undefined, JSON.stringify(result));
	if (explicitBudget !== undefined) assert.equal(children.sessions[0]?.aborted, true);
});

describe("foreground open-tool lifetime", () => {
	installSingleExecutionHooks();
	it("suppresses inherited and built-in tool deadlines for an unbounded foreground worker", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		mockPi.onCall(response);
		const executor = makeExecutor([{ ...makeAgent("worker"), defaultToolTimeoutMs: 20 }], { toolTimeoutMs: 30 });
		let settled = false;
		const running = executor.executePublic("foreground-tool", { agent: "worker", task: "Run", async: false, executionLifetime: { mode: "unbounded" }, acceptance: false }, new AbortController().signal, undefined, makeMinimalCtx(tempDir)).finally(() => { settled = true; });
		await flushUntil(() => mockPi.sessions.length === 1);
		await setImmediate();
		t.mock.timers.tick(30 * 60 * 1000 + 1);
		await setImmediate();
		assert.equal(settled, false);
		assert.equal(mockPi.sessions[0]?.aborted, false);
		t.mock.timers.tick(60_000);
		await flushUntil(() => settled);
		assert.equal((await running).isError, undefined);
	});
});
