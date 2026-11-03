import assert from "node:assert/strict";
import { it } from "node:test";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

/**
 * Field incident: a workflow re-delivered `runs.run("q_a", params)` in a hot loop. Every
 * delivery is valid (an existing key is reused), but each one appended an identical
 * `{ state: "reused" }` trace entry, and every trace change re-serialized the whole trace
 * into `status.json` and `events.jsonl` (14,116 entries, ~11 GB written).
 *
 * `onTrace` calls are the bound that matters: each one is a full `status.json` rewrite plus
 * a `subagent.workflow.trace` journal line carrying the whole trace.
 */
async function redeliver(keys: string[], rounds: number) {
	let launches = 0;
	let traceWrites = 0;
	const result = await runWorkflowScript({
		script: `
			const params = { agent: "worker", task: "reply with PONG" };
			const calls = [];
			for (let index = 0; index < ${rounds}; index += 1) for (const key of ${JSON.stringify(keys)}) calls.push(runs.run(key, params));
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
	return { result, launches, traceWrites, reused };
}

it("traces a re-delivered runs.run key once, however often it is delivered", async () => {
	const { result, launches, traceWrites, reused } = await redeliver(["q_a"], 25);
	assert.equal((result.value as unknown[]).length, 25);
	assert.equal(launches, 1);
	assert.equal(reused("q_a"), 1);
	// started + reused + completed
	assert.ok(traceWrites <= 3, `expected at most 3 trace writes, got ${traceWrites}`);
});

it("traces each key's reuse once when re-deliveries of several keys interleave", async () => {
	const { result, launches, traceWrites, reused } = await redeliver(["a", "b"], 25);
	assert.equal((result.value as unknown[]).length, 50);
	assert.equal(launches, 2);
	assert.equal(reused("a"), 1);
	assert.equal(reused("b"), 1);
	assert.ok(traceWrites <= 6, `expected at most 6 trace writes, got ${traceWrites}`);
});
