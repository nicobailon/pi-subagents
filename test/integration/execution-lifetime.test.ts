import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { prepareWorkflowLaunchParams } from "../../src/runs/foreground/subagent-executor.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installSingleExecutionHooks, makeExecutor, mockPi, tempDir } from "../support/single-execution-fixture.ts";

const HALF_HOUR = 30 * 60 * 1000;

async function flushUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1000 && !predicate(); attempt++) await setImmediate();
	assert.ok(predicate(), "execution did not reach the expected boundary");
}

describe("execution lifetime at the executor boundary", () => {
	installSingleExecutionHooks();

	it("rejects a bounded timer overflow before child launch", async () => {
		const result = await makeExecutor([makeAgent("echo")]).executePublic("overflow", {
			agent: "echo", task: "continue", async: false, executionLifetime: { mode: "bounded", timeoutMs: 2_147_483_648 },
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /executionLifetime/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("keeps an explicitly unbounded foreground child alive beyond thirty minutes", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		mockPi.onCall({ delay: HALF_HOUR + 60_000, output: "completed after thirty minutes" });
		const executor = makeExecutor([{ ...makeAgent("echo"), defaultTimeoutMs: 500 }], { timeoutMs: 200 });
		let settled = false;
		const resultPromise = executor.executePublic("unbounded", {
			agent: "echo", task: "continue", executionLifetime: { mode: "unbounded" }, async: false, context: "fresh", acceptance: false, mission: false,
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir)).finally(() => { settled = true; });
		await flushUntil(() => mockPi.callCount() === 1);
		await setImmediate();
		t.mock.timers.tick(HALF_HOUR + 1);
		await setImmediate();
		assert.equal(settled, false);
		assert.equal(mockPi.sessions[0]?.aborted, false);
		assert.deepEqual(mockPi.sessions[0]?.launch.runtime.executionLifetime, { mode: "unbounded" });
		t.mock.timers.tick(60_000);
		await flushUntil(() => settled);
		const result = await resultPromise;
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.deepEqual(result.details.effectiveExecutionLifetime, { mode: "unbounded" });
	});

	it("keeps an unbounded workflow child independent of the parent deadline", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		mockPi.onCall({ delay: HALF_HOUR + 60_000, output: "workflow child completed" });
		const params = prepareWorkflowLaunchParams(
			{ executionLifetime: { mode: "unbounded" }, async: false, context: "fresh", acceptance: false, mission: false },
			{ agent: "echo", task: "continue" },
			"workflow-parent",
			"worker",
			{ parentDeadlineAt: Date.now() + 500 },
		);
		assert.deepEqual(params.executionLifetime, { mode: "unbounded" });
		assert.equal(params.workflowParentDeadlineAt, undefined);
		const executor = makeExecutor([{ ...makeAgent("echo"), defaultTimeoutMs: 500 }], { timeoutMs: 200 });
		let settled = false;
		const resultPromise = executor.execute("workflow-child", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir)).finally(() => { settled = true; });
		await flushUntil(() => mockPi.callCount() === 1);
		await setImmediate();
		t.mock.timers.tick(HALF_HOUR + 1);
		await setImmediate();
		assert.equal(settled, false);
		assert.equal(mockPi.sessions[0]?.aborted, false);
		assert.deepEqual(mockPi.sessions[0]?.launch.runtime.executionLifetime, { mode: "unbounded" });
		t.mock.timers.tick(60_000);
		await flushUntil(() => settled);
		assert.equal((await resultPromise).isError, undefined);
	});

	for (const lifetime of [undefined, { mode: "bounded" as const, timeoutMs: 1000 }]) {
		it(`enforces ${lifetime ? "the explicit bounded deadline" : "the omitted lifetime's thirty minute default"}`, async (t) => {
			t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
			mockPi.onCall({ hangUntilAbort: true });
			const executor = makeExecutor([makeAgent("echo")]);
			let settled = false;
			const resultPromise = executor.executePublic("bounded", {
				agent: "echo", task: "continue", async: false, context: "fresh", acceptance: false, mission: false,
				executionLifetime: lifetime,
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir)).finally(() => { settled = true; });
			await flushUntil(() => mockPi.callCount() === 1);
			await setImmediate();
			t.mock.timers.tick((lifetime?.timeoutMs ?? HALF_HOUR) + 1);
			await flushUntil(() => settled);
			const result = await resultPromise;
			assert.equal(result.isError, true);
			assert.equal(mockPi.sessions[0]?.aborted, true);
			assert.deepEqual(result.details.effectiveExecutionLifetime, lifetime ?? { mode: "bounded", timeoutMs: HALF_HOUR });
		});
	}

	it("inherits unbounded lifetime through a nested executor beyond thirty minutes", async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		mockPi.onCall({ delay: HALF_HOUR + 60_000, output: "nested child completed" });
		const executor = makeExecutor([{ ...makeAgent("echo"), defaultTimeoutMs: 500 }], { timeoutMs: 200 }, false, undefined, true, new Map(), undefined, undefined, createEventBus(), undefined, {
			fanoutChild: true, depth: 1, maxDepth: 3, waitTool: { enabled: true }, fast: false, executionLifetime: { mode: "unbounded" },
		});
		let settled = false;
		const resultPromise = executor.execute("nested-unbounded", { agent: "echo", task: "Continue nested work", async: false, acceptance: false }, new AbortController().signal, undefined, makeMinimalCtx(tempDir)).finally(() => { settled = true; });
		await flushUntil(() => mockPi.callCount() === 1);
		await setImmediate();
		t.mock.timers.tick(HALF_HOUR + 1);
		await setImmediate();
		assert.equal(settled, false);
		assert.equal(mockPi.sessions[0]?.aborted, false);
		assert.deepEqual(mockPi.sessions[0]?.launch.runtime.executionLifetime, { mode: "unbounded" });
		t.mock.timers.tick(60_000);
		await flushUntil(() => settled);
		assert.equal((await resultPromise).isError, undefined);
	});
});
