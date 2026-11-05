import assert from "node:assert/strict";
import { it } from "node:test";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

// Each onTrace call is a full status.json rewrite plus a journal line carrying the whole trace,
// so re-delivering an already-reused runs.run key must not add a trace entry.
it("traces each key's reuse once when re-deliveries of several keys interleave", async () => {
	let launches = 0;
	let traceWrites = 0;
	const result = await runWorkflowScript({
		script: `
			const params = { agent: "worker", task: "reply with PONG" };
			const calls = [];
			for (let index = 0; index < 25; index += 1) for (const key of ["a", "b"]) calls.push(runs.run(key, params));
			const children = await Promise.all(calls);
			return children.map((child) => child.output);
		`,
		launch: async (key: string) => {
			launches += 1;
			return { key, ok: true, output: `done ${key}`, artifactPaths: [] };
		},
		status: async (key: string) => ({ key, ok: true, output: "unused", artifactPaths: [] }),
		onTrace: () => { traceWrites += 1; },
	});
	const reused = (key: string) => result.trace.filter((entry) => entry.operation === "run" && entry.key === key && entry.state === "reused").length;
	assert.equal((result.value as unknown[]).length, 50);
	assert.equal(launches, 2);
	assert.equal(reused("a"), 1);
	assert.equal(reused("b"), 1);
	// started + reused + completed per key
	assert.ok(traceWrites <= 6, `expected at most 6 trace writes, got ${traceWrites}`);
});
