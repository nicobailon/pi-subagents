import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerWorkflowResource } from "../../src/api/workflow-resources.ts";
import { consumeWorkflowResourcePermit } from "../../src/shared/workflow-child-permit.ts";
import { resolveStructuredWorkflowResource, resolveWorkflowResource } from "../../src/workflows/workflow-resources.ts";
import { runWorkflowScript, validateWorkflowScript, WorkflowScriptError, type WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";

type Launch = { key: string; agent: unknown; task: unknown };

function resolveScript(input: Parameters<typeof resolveStructuredWorkflowResource>[0]): string {
	const resolved = resolveStructuredWorkflowResource(input);
	if (!resolved.ok) assert.fail(resolved.error);
	assert.deepEqual(validateWorkflowScript(resolved.resource.script), { ok: true, errors: [] });
	return resolved.resource.script;
}

/** Run a resolved script with fake children. `respond` returns the child result; default output echoes the key. */
async function runScript(script: string, respond: (launch: Launch) => Partial<WorkflowScriptChildResult> | Promise<Partial<WorkflowScriptChildResult>> = () => ({})) {
	const launches: Launch[] = [];
	const execution = await runWorkflowScript({
		script,
		timeoutMs: 5_000,
		async launch(key, params) {
			const launch = { key, agent: params.agent, task: params.task };
			launches.push(launch);
			const result = await respond(launch);
			return { key, ok: true, output: `out:${key}`, artifactPaths: [], ...result };
		},
		async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
	});
	return { value: execution.value, launches };
}

/** Run a script expected to fail; returns the error message and the settled children the runtime kept. */
async function runFailingScript(script: string, respond: Parameters<typeof runScript>[1]) {
	const launches: Launch[] = [];
	const error = await runScript(script, (launch) => {
		launches.push(launch);
		return respond!(launch);
	}).then(() => assert.fail("script should fail"), (reason: unknown) => reason);
	assert.ok(error instanceof WorkflowScriptError, String(error));
	const children = error.partial.children.map(({ key, ok, output, error: childError }) => ({ key, ok, output, ...(childError ? { error: childError } : {}) }));
	return { message: error.message, children, launches };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("structured workflow resources", () => {
	it("issues a package-owned chain resource with a one-use permit and named provenance", () => {
		const resolved = resolveStructuredWorkflowResource({ kind: "chain", steps: [{ agent: "worker", task: "Do it" }] });
		assert.ok(resolved.ok);
		assert.deepEqual(resolved.resource.provenance, {
			kind: "workflow", name: "chain", version: 1, invocation: "named", expansion: "resolved", id: resolved.resource.provenance.id,
		});
		assert.equal(typeof consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script), "object");
		assert.match(consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script) as string, /already consumed/);
		const tasks = resolveStructuredWorkflowResource({ kind: "tasks", steps: [{ agent: "worker", task: "Do it" }] });
		assert.equal(tasks.ok && tasks.resource.provenance.name, "tasks");
	});

	it("runs a chain with {task}, {previous}, named outputs, a taskless step and an ordered parallel group", async () => {
		const script = resolveScript({
			kind: "chain",
			task: "Fix login",
			steps: [
				{ agent: "scout", task: "Scout: {task}", as: "scan" },
				{ agent: "planner", task: "Plan from {previous}" },
				{ parallel: [{ agent: "a", task: "A {previous} / {outputs.scan}" }, { agent: "b", task: "B {task}" }] },
				{ agent: "writer" },
			],
		});
		const { value, launches } = await runScript(script, async ({ key }) => {
			// The first group member settles last; the joined output must still follow input order.
			if (key === "step-3-1") await delay(30);
			return {};
		});
		assert.deepEqual(launches, [
			{ key: "step-1", agent: "scout", task: "Scout: Fix login" },
			{ key: "step-2", agent: "planner", task: "Plan from out:step-1" },
			{ key: "step-3-1", agent: "a", task: "A out:step-2 / out:step-1" },
			{ key: "step-3-2", agent: "b", task: "B Fix login" },
			{ key: "step-4", agent: "writer", task: "out:step-3-1\n\nout:step-3-2" },
		]);
		assert.deepEqual(value, {
			ok: true,
			children: [
				{ key: "step-1", agent: "scout", ok: true, output: "out:step-1" },
				{ key: "step-2", agent: "planner", ok: true, output: "out:step-2" },
				{ key: "step-3-1", agent: "a", ok: true, output: "out:step-3-1" },
				{ key: "step-3-2", agent: "b", ok: true, output: "out:step-3-2" },
				{ key: "step-4", agent: "writer", ok: true, output: "out:step-4" },
			],
		});
	});

	it("substitutes placeholders in a single pass and keeps other brace text literal", async () => {
		const script = resolveScript({
			kind: "chain",
			task: "orig {previous} {outputs.first}",
			steps: [
				{ agent: "one", task: "{task} {other} { task } {outputs.bad-name} {outputs.} {Task}", as: "first" },
				{ agent: "two", task: "{previous}|{outputs.first}|{task}" },
			],
		});
		const { launches } = await runScript(script, ({ key }) => ({ output: key === "step-1" ? "{task} {previous} {outputs.first}" : "done" }));
		assert.equal(launches[0]!.task, "orig {previous} {outputs.first} {other} { task } {outputs.bad-name} {outputs.} {Task}");
		assert.equal(launches[1]!.task, "{task} {previous} {outputs.first}|{task} {previous} {outputs.first}|orig {previous} {outputs.first}");
	});

	it("fails the chain at a failed step and keeps earlier results", async () => {
		const script = resolveScript({ kind: "chain", steps: [{ agent: "one", task: "first" }, { agent: "two" }, { agent: "three" }] });
		const { message, children, launches } = await runFailingScript(script, ({ key }) => key === "step-2" ? { ok: false, output: "boom", error: "boom" } : {});
		assert.deepEqual(launches.map(({ key }) => key), ["step-1", "step-2"]);
		assert.match(message, /chain stopped at step 2: step-2 \(two\) failed: boom/);
		assert.deepEqual(children, [
			{ key: "step-1", ok: true, output: "out:step-1" },
			{ key: "step-2", ok: false, output: "boom", error: "boom" },
		]);
	});

	it("waits for every group sibling, then stops the chain when any member failed", async () => {
		let slowFinished = false;
		const script = resolveScript({
			kind: "chain",
			steps: [{ parallel: [{ agent: "fast", task: "fail" }, { agent: "slow", task: "finish" }] }, { agent: "next" }],
		});
		const { message, children, launches } = await runFailingScript(script, async ({ key }) => {
			if (key === "step-1-1") return { ok: false, output: "rejected", error: "rejected" };
			await delay(40);
			slowFinished = true;
			return {};
		});
		assert.equal(slowFinished, true);
		assert.deepEqual(launches.map(({ key }) => key), ["step-1-1", "step-1-2"]);
		assert.match(message, /chain stopped at step 1: step-1-1 \(fast\) failed: rejected/);
		assert.deepEqual(new Set(children.map((child) => JSON.stringify(child))), new Set([
			JSON.stringify({ key: "step-1-1", ok: false, output: "rejected", error: "rejected" }),
			JSON.stringify({ key: "step-1-2", ok: true, output: "out:step-1-2" }),
		]));
	});

	it("fails tasks after every child settles when one failed", async () => {
		const script = resolveScript({
			kind: "tasks",
			task: "the request",
			steps: [{ agent: "a", task: "A: {task}" }, { agent: "b", task: "B" }, { agent: "c", task: "C {other}" }],
		});
		const { message, children, launches } = await runFailingScript(script, async ({ key }) => {
			if (key === "task-1") await delay(20);
			return key === "task-2" ? { ok: false, output: "bad", error: "bad" } : {};
		});
		assert.deepEqual(new Set(launches.map(({ key }) => key)), new Set(["task-1", "task-2", "task-3"]));
		assert.equal(launches.find(({ key }) => key === "task-1")!.task, "A: the request");
		assert.equal(launches.find(({ key }) => key === "task-3")!.task, "C {other}");
		assert.match(message, /tasks failed: task-2 \(b\) failed: bad/);
		assert.deepEqual(new Set(children.map((child) => JSON.stringify(child))), new Set([
			JSON.stringify({ key: "task-1", ok: true, output: "out:task-1" }),
			JSON.stringify({ key: "task-2", ok: false, output: "bad", error: "bad" }),
			JSON.stringify({ key: "task-3", ok: true, output: "out:task-3" }),
		]));
		const allOk = await runScript(resolveScript({ kind: "tasks", steps: [{ agent: "a", task: "A" }] }));
		assert.deepEqual(allOk.value, { ok: true, children: [{ key: "task-1", agent: "a", ok: true, output: "out:task-1" }] });
	});

	it("embeds caller text as data, never as code", async () => {
		const hostile = `"); await runs.host("x", { kind: "command", command: "bad", timeoutMs: 1 }); //\` \${globalThis.pwned = 1} ' `;
		const agent = `worker"]); throw new Error("injected"); //`;
		for (const kind of ["tasks", "chain"] as const) {
			const script = resolveScript({ kind, task: hostile, steps: [{ agent, task: `${hostile} {task} \${1+1}` }] });
			const { value, launches } = await runScript(script);
			assert.deepEqual(launches.map(({ agent: launched, task }) => ({ agent: launched, task })), [{ agent, task: `${hostile} ${hostile} \${1+1}` }]);
			assert.equal((value as { ok: boolean }).ok, true);
		}
	});

	it("rejects unsupported fields, malformed shapes and invalid placeholders before launch", () => {
		const cases: Array<[Parameters<typeof resolveStructuredWorkflowResource>[0], RegExp]> = [
			[{ kind: "other" as "tasks", steps: [{ agent: "a", task: "t" }] }, /kind must be 'tasks' or 'chain'/],
			[{ kind: "tasks", steps: [] }, /tasks must be a non-empty array/],
			[{ kind: "chain", steps: { agent: "a", task: "t" } }, /chain must be a non-empty array/],
			[{ kind: "tasks", steps: [{ agent: "a", task: "t", model: "x" }] }, /tasks\[0\] contains unsupported fields: model/],
			[{ kind: "tasks", steps: [{ agent: "a", task: "t", count: 2 }] }, /unsupported fields: count/],
			[{ kind: "tasks", steps: [{ agent: "a" }] }, /tasks\[0\]\.task must be a non-empty string/],
			[{ kind: "tasks", steps: [{ task: "t" }] }, /tasks\[0\]\.agent must be a non-empty string/],
			[{ kind: "tasks", steps: [{ agent: "a", task: 3 }] }, /tasks\[0\]\.task must be a non-empty string/],
			[{ kind: "tasks", steps: ["a"] }, /tasks\[0\] must be an object/],
			[{ kind: "tasks", steps: [{ agent: "a", task: "{previous}" }] }, /tasks\[0\]\.task cannot use \{previous\}; tasks items may only use \{task\}/],
			[{ kind: "tasks", steps: [{ agent: "a", task: "{outputs.x}" }] }, /cannot use \{outputs\.x\}; tasks items may only use \{task\}/],
			[{ kind: "tasks", steps: [{ agent: "a", task: "{task}" }] }, /tasks\[0\]\.task references \{task\}, but no top-level task was provided/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t", skill: "s" }] }, /chain\[0\] contains unsupported fields: skill/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t", outputSchema: {} }] }, /unsupported fields: outputSchema/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t" }, { agent: "b", reads: ["x"] }] }, /chain\[1\] contains unsupported fields: reads/],
			[{ kind: "chain", steps: [{ parallel: [{ agent: "a", task: "t" }], as: "x" }] }, /chain\[0\] contains unsupported fields: as\. A parallel step accepts only parallel/],
			[{ kind: "chain", steps: [{ parallel: [{ agent: "a", task: "t" }], agent: "b" }] }, /unsupported fields: agent/],
			[{ kind: "chain", steps: [{ parallel: [{ agent: "a", task: "t" }], failFast: true }] }, /unsupported fields: failFast/],
			[{ kind: "chain", steps: [{ parallel: [{ agent: "a", task: "t", model: "m" }] }] }, /chain\[0\]\.parallel\[0\] contains unsupported fields: model/],
			[{ kind: "chain", steps: [{ parallel: [{ agent: "a" }] }] }, /chain\[0\]\.parallel\[0\]\.task must be a non-empty string/],
			[{ kind: "chain", steps: [{ parallel: [] }] }, /chain\[0\]\.parallel must be a non-empty array/],
			[{ kind: "chain", steps: [{ expand: {} }] }, /unsupported fields: expand/],
			[{ kind: "chain", steps: [{ agent: "a" }] }, /chain\[0\]\.task is required/],
			[{ kind: "chain", steps: [{ agent: "a", task: "Use {previous}" }] }, /chain\[0\]\.task cannot use \{previous\}; the first chain step has no previous output/],
			[{ kind: "chain", steps: [{ parallel: [{ agent: "a", task: "{previous}" }] }] }, /chain\[0\]\.parallel\[0\]\.task cannot use \{previous\}/],
			[{ kind: "chain", steps: [{ agent: "a", task: "Do {task}" }] }, /chain\[0\]\.task references \{task\}, but no top-level task was provided/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t" }, { agent: "b", task: "{outputs.missing}" }] }, /chain\[1\]\.task references \{outputs\.missing\}, but no earlier sequential step sets as: "missing"/],
			[{ kind: "chain", steps: [{ agent: "a", task: "{outputs.later}" }, { agent: "b", task: "t", as: "later" }] }, /chain\[0\]\.task references \{outputs\.later\}/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t", as: "self" }, { agent: "b", task: "t" }, { parallel: [{ agent: "c", task: "{outputs.selff}" }] }] }, /chain\[2\]\.parallel\[0\]\.task references \{outputs\.selff\}/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t", as: "bad-name" }] }, /chain\[0\]\.as must be an identifier/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t", as: 1 }] }, /chain\[0\]\.as must be an identifier/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t", as: "x" }, { agent: "b", as: "x" }] }, /chain\[1\]\.as 'x' is already used/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t" }], task: " " }, /task must be a non-empty string when provided/],
			[{ kind: "chain", steps: [{ agent: "a", task: "t" }], task: 42 }, /task must be a non-empty string when provided/],
			[{ kind: "chain", steps: [{ agent: "a", task: "" }] }, /chain\[0\]\.task must not be empty/],
			[{ kind: "tasks", steps: [{ agent: "a", task: "x".repeat(16 * 1024 + 1) }] }, /tasks\[0\]\.task exceeds 16384 bytes/],
			[{ kind: "tasks", steps: [{ agent: "a", task: "t" }], task: "x".repeat(16 * 1024 + 1) }, /task exceeds 16384 bytes/],
			[{ kind: "tasks", steps: Array.from({ length: 3 }, () => ({ agent: "a", task: "x".repeat(6000) })) }, /tasks input exceeds 16384 bytes/],
			[{ kind: "tasks", steps: Array.from({ length: 65 }, () => ({ agent: "a", task: "t" })) }, /tasks contains too many items/],
			[{ kind: "tasks", steps: [{ agent: "a", task: new Date() }] }, /must contain plain JSON data/],
		];
		for (const [input, pattern] of cases) {
			const result = resolveStructuredWorkflowResource(input);
			assert.equal(result.ok, false, JSON.stringify(input).slice(0, 200));
			if (!result.ok) assert.match(result.error, pattern, JSON.stringify(input).slice(0, 200));
			assert.equal("resource" in result, false);
		}
	});

	it("is not reachable through public named lookup and reserves its names", () => {
		for (const name of ["chain", "tasks"]) {
			const result = resolveWorkflowResource(name, { steps: [{ agent: "a", task: "t" }] });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.error, `Unknown workflow resource '${name}'. Available resources: review, run-ci, parallel.`);
			assert.throws(
				() => registerWorkflowResource({ sessionId: "structured", definition: { name, version: 1, resolve: () => ({ script: "return true;" }) } }),
				/protected builtin/,
			);
			assert.equal(resolveWorkflowResource(name, {}, "structured").ok, false);
		}
	});
});
