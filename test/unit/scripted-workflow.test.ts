import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";

describe("scripted workflow runtime", () => {
	it("runs keyed children, captures output, and exposes no host capabilities", async () => {
		const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
		const result = await runWorkflowScript({
			script: `
				if (typeof process !== "undefined" || typeof require !== "undefined") throw new Error("host globals leaked");
				const scan = await runs.run("scan", { agent: "scout", task: "find targets" });
				const reviews = await runs.all(scan.structuredOutput.items.map((item) => ({ key: "review-" + item, agent: "reviewer", task: item })));
				emit({ count: reviews.length });
				console.log("reviewed", reviews.length);
				return { refs: runs.refs(reviews) };
			`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, params });
				return key === "scan"
					? { key, ok: true, runId: "run-scan", output: "targets", structuredOutput: { items: ["a", "b"] }, artifactPaths: ["/tmp/scan.json"], results: [] }
					: { key, ok: true, runId: `run-${key}`, output: `reviewed ${params.task}`, artifactPaths: [`/tmp/${key}.md`], results: [] };
			},
			async status(keyOrRunId) {
				return { key: keyOrRunId, ok: true, output: "complete", artifactPaths: [] };
			},
		});

		assert.deepEqual(launches.map(({ key }) => key), ["scan", "review-a", "review-b"]);
		assert.equal(launches.every(({ params }) => params.async === false), true);
		assert.deepEqual(result.emits, [{ count: 2 }]);
		assert.deepEqual(result.console, [{ level: "log", text: "reviewed 2" }]);
		assert.match(JSON.stringify(result.value), /run review-a; id=run-review-a; artifacts=\/tmp\/review-a\.md/);
		assert.equal(result.trace.filter((entry) => entry.state === "completed").length, 3);
	});

	it("rejects a duplicate key with incompatible params", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `
					await runs.run("same", { agent: "scout", task: "one" });
					await runs.run("same", { agent: "scout", task: "two" });
				`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /Duplicate workflow key 'same'/.test(error.message),
		);
	});

	it("aborts an unawaited child launch when the script completes", async () => {
		let childAborted = false;
		const result = await runWorkflowScript({
			script: `runs.run("bg", { agent: "worker", task: "fire and forget" }); return "done";`,
			timeoutMs: 2_000,
			launch(_key, _params, signal) {
				return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
					childAborted = true;
					reject(signal.reason);
				}, { once: true }));
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "done");
		assert.equal(childAborted, true);
	});

	it("terminates scripts and aborts an in-flight child at the controller timeout", async () => {
		let childAborted = false;
		await assert.rejects(
			runWorkflowScript({
				script: `await runs.run("slow", { agent: "worker", task: "wait" });`,
				timeoutMs: 500,
				launch(_key, _params, signal) {
					return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
						childAborted = true;
						reject(signal.reason);
					}, { once: true }));
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /timed out after 500ms/.test(error.message),
		);
		assert.equal(childAborted, true);
	});
});
