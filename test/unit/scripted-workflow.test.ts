import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatWorkflowJsonPreview, runWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";

describe("scripted workflow runtime", () => {
	it("runs keyed children, streams progress, and exposes no host capabilities", async () => {
		const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
		const traceSnapshots: number[] = [];
		const emitSnapshots: number[] = [];
		const result = await runWorkflowScript({
			onTrace: (trace) => traceSnapshots.push(trace.length),
			onEmit: (emits) => emitSnapshots.push(emits.length),
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
					: { key, ok: true, runId: `run-${key}-complete`, output: `reviewed ${params.task}`, artifactPaths: [`/tmp/${key}.md`], results: [] };
			},
			async status(keyOrRunId) {
				return { key: keyOrRunId, ok: true, output: "complete", artifactPaths: [] };
			},
		});

		assert.deepEqual(launches.map(({ key }) => key), ["scan", "review-a", "review-b"]);
		assert.equal(launches.every(({ params }) => params.async === false), true);
		assert.deepEqual(result.emits, [{ count: 2 }]);
		assert.deepEqual(result.console, [{ level: "log", text: "reviewed 2" }]);
		assert.match(JSON.stringify(result.value), /run review-a; id=run-review-a-complete; artifacts=\/tmp\/review-a\.md/);
		assert.equal(result.trace.filter((entry) => entry.state === "completed").length, 3);
		assert.ok(traceSnapshots.length >= 6);
		assert.deepEqual(emitSnapshots, [1]);
	});

	it("rejects legacy orchestration params in runs.run", async () => {
		let launches = 0;
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.run("legacy", { tasks: [{ agent: "scout", task: "scan" }] });`,
				timeoutMs: 2_000,
				launch: async () => { launches++; return { ok: true, output: "unexpected" }; },
				status: async () => ({ ok: true, output: "unused" }),
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /accepts one child.*runs\.all/i.test(error.message),
		);
		assert.equal(launches, 0);
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

	it("rejects non-JSON-safe emitted values without persisting them", async () => {
		const invalidScripts = [
			`emit(undefined);`,
			`emit(NaN);`,
			`emit(Infinity);`,
			`emit(new Map([["a", 1]]));`,
			`emit(new Set([1]));`,
			`emit(new (class Value { constructor() { this.ok = true; } })());`,
			`emit(new (class Object { constructor() { this.ok = true; } })());`,
			`emit(() => true);`,
			`emit(Symbol("value"));`,
			`const value = {}; value.self = value; emit(value);`,
			`emit(1n);`,
		];
		for (const script of invalidScripts) {
			await assert.rejects(
				runWorkflowScript({
					script,
					timeoutMs: 2_000,
					async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [], results: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && error.partial.emits.length === 0,
			);
		}
	});

	it("rejects non-JSON-safe workflow return values", async () => {
		const invalidScripts = [
			`return new Map([["a", 1]]);`,
			`return NaN;`,
			`return 1n;`,
			`return new (class Object { constructor() { this.ok = true; } })();`,
			`const value = {}; value.self = value; return value;`,
			`return () => true;`,
			`return Symbol("value");`,
		];
		for (const script of invalidScripts) {
			await assert.rejects(
				runWorkflowScript({
					script,
					timeoutMs: 2_000,
					async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [], results: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /return/.test(error.message),
			);
		}
	});

	it("normalizes omitted and explicit undefined workflow returns to null", async () => {
		for (const script of [`await Promise.resolve();`, `return undefined;`]) {
			const result = await runWorkflowScript({
				script,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			});
			assert.equal(result.value, null);
		}
	});

	it("accepts a JSON-safe workflow return value", async () => {
		const result = await runWorkflowScript({
			script: `return { ok: true, values: [1, "two", null] };`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [], results: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(result.value, { ok: true, values: [1, "two", null] });
	});

	it("formats persisted JSON values without assuming stringify returns a string", () => {
		assert.equal(formatWorkflowJsonPreview(undefined, 120), undefined);
		assert.equal(formatWorkflowJsonPreview(NaN, 120), undefined);
		assert.equal(formatWorkflowJsonPreview(new Map(), 120), undefined);
		assert.equal(formatWorkflowJsonPreview({ stage: ["review", 2] }, 120), '{"stage":["review",2]}');
	});

	it("accepts JSON-safe object and array emits", async () => {
		const result = await runWorkflowScript({
			script: `emit({ ok: true, values: [1, "two", null] }); return "done";`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [], results: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(result.emits, [{ ok: true, values: [1, "two", null] }]);
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
