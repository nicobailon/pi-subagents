import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { it } from "node:test";
import { runSubagent } from "../../src/runs/background/subagent-runner.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

async function flushUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1000 && !predicate(); attempt++) await setImmediate();
	assert.ok(predicate(), "runner did not reach the expected boundary");
}

for (const mode of ["unbounded", "parallel-unbounded", "bounded", "omitted"] as const) {
	it(`runs the native background runner with ${mode} execution lifetime across the thirty minute boundary`, async (t) => {
		const dir = createTempDir("runner-lifetime-");
		t.after(() => removeTempDir(dir));
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const halfHour = 30 * 60 * 1000;
		fs.writeFileSync(path.join(dir, "default-response.json"), JSON.stringify({ delay: halfHour + 60_000, output: "long-running child completed" }));
		const children = createFakeChildSessions(() => dir);
		const unbounded = mode === "unbounded" || mode === "parallel-unbounded";
		const executionLifetime = mode === "omitted" ? undefined : unbounded ? { mode: "unbounded" as const } : { mode: "bounded" as const, timeoutMs: halfHour };
		const built = buildAsyncRunnerSteps("runner-lifetime", {
			chain: mode === "parallel-unbounded" ? [{ parallel: [{ agent: "echo", task: "first", acceptance: false }, { agent: "echo", task: "second", acceptance: false }], concurrency: 2 }] : [{ agent: "echo", task: "continue", acceptance: false }], agents: [makeAgent("echo")],
			ctx: { cwd: dir, currentSessionId: "lifetime-session", currentModel: undefined, currentModelProvider: undefined, modelScope: undefined },
			asyncDir: dir, maxSubagentDepth: 2, executionLifetime,
		});
		assert.ok("steps" in built);
		let settled = false;
		const resultPath = path.join(dir, "result.json");
		const promise = runSubagent({
			id: "runner-lifetime", sessionId: "lifetime-session", steps: built.steps, cwd: dir, asyncDir: dir, resultPath, placeholder: "", artifactConfig: { enabled: false },
			executionLifetime,
		}, children.factory).finally(() => { settled = true; });
		await flushUntil(() => mode === "parallel-unbounded" ? children.sessions.filter((session) => Boolean(session.task)).length === 2 : Boolean(children.sessions[0]?.task));
		await setImmediate();
		t.mock.timers.tick(halfHour + 1);
		await setImmediate();
		if (unbounded) {
			assert.equal(settled, false);
			assert.equal(children.sessions[0]?.aborted, false);
			assert.deepEqual(children.sessions[0]?.launch.runtime.executionLifetime, { mode: "unbounded" });
			t.mock.timers.tick(60_000);
		}
		await flushUntil(() => settled);
		await promise;
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
		assert.equal(result.success, unbounded, JSON.stringify(result));
		assert.deepEqual(status.effectiveExecutionLifetime, executionLifetime ?? { mode: "unbounded" });
		if (unbounded) {
			assert.equal(status.deadlineAt, undefined);
			assert.equal(status.timeoutMs, undefined);
		} else assert.equal(children.sessions[0]?.aborted, true);
	});
}
