import assert from "node:assert/strict";
import { it } from "node:test";
import { runWorkflowScript } from "../../src/workflows/scripted-workflow.ts";

/**
 * Field incident: a workflow re-delivered `runs.run("q_a", params)` in a hot loop. Every
 * delivery is valid (an existing key is reused), but each one used to append a
 * byte-identical `{ state: "reused" }` trace entry, and every trace change re-serialized
 * the whole trace into `status.json` and `events.jsonl` — 14,116 entries, ~11 GB written,
 * 28 GB in a second incident.
 *
 * The bound that matters here is `onTrace` invocations: each one is a full
 * `status.json` rewrite plus a `subagent.workflow.trace` journal line carrying the whole array.
 */
it("folds a re-delivered runs.run into one trace entry and stops re-serializing the trace", async () => {
	let launches = 0;
	const emittedLengths: number[] = [];
	const result = await runWorkflowScript({
		script: `
			const params = { agent: "worker", task: "reply with PONG" };
			const calls = [];
			for (let index = 0; index < 25; index += 1) calls.push(runs.run("q_a", params));
			const children = await Promise.all(calls);
			return { calls: calls.length, outputs: children.map((child) => child.output) };
		`,
		launch: async (key: string) => {
			launches += 1;
			return { key, ok: true, output: `done ${key}`, artifactPaths: [] };
		},
		status: async (key: string) => ({ key, ok: true, output: "unused", artifactPaths: [] }),
		onTrace: (trace: unknown[]) => emittedLengths.push(trace.length),
	});

	assert.deepEqual(result.value, { calls: 25, outputs: Array.from({ length: 25 }, () => "done q_a") });
	assert.equal(launches, 1, "25 deliveries of the same key must reuse the one launch");

	const reused = result.trace.filter((entry) => entry.operation === "run" && entry.key === "q_a" && entry.state === "reused");
	assert.equal(reused.length, 1, "consecutive duplicate `reused` entries must be folded");

	// started + reused + settled. Not 26, and certainly not O(n²) bytes.
	assert.ok(result.trace.length <= 4, `expected a bounded trace, got ${result.trace.length} entries`);
	assert.ok(
		emittedLengths.length <= 4,
		`each onTrace call rewrites status.json and appends the whole trace to events.jsonl; expected <=4, got ${emittedLengths.length}`,
	);
});

it("still records every distinct trace transition", async () => {
	const emitted: string[] = [];
	const result = await runWorkflowScript({
		script: `
			await runs.run("a", { agent: "worker", task: "one" });
			await runs.run("b", { agent: "worker", task: "two" });
			return "ok";
		`,
		launch: async (key: string) => ({ key, ok: true, output: `done ${key}`, artifactPaths: [] }),
		status: async (key: string) => ({ key, ok: true, output: "unused", artifactPaths: [] }),
		onTrace: (trace: Array<{ key?: string }>) => emitted.push(...trace.slice(emitted.length).map((entry) => entry.key ?? "")),
	});

	assert.equal(result.value, "ok");
	assert.deepEqual(new Set(emitted), new Set(["a", "b"]));
	const states = result.trace.filter((entry) => entry.operation === "run").map((entry) => `${entry.key}:${entry.state}`);
	assert.deepEqual(states, ["a:started", "a:completed", "b:started", "b:completed"]);
});
