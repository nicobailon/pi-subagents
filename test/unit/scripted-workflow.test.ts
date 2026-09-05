import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { formatWorkflowJsonPreview, previewSimpleWorkflowRun, runWorkflowScript, validateWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";

describe("scripted workflow runtime", () => {
	it("uses ordinary statement-body return semantics", async () => {
		const implicit = await runWorkflowScript({
			script: `({ answer: 42 });`,
			async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		const explicit = await runWorkflowScript({
			script: `return ({ answer: 42 });`,
			async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.equal(implicit.value, null);
		assert.deepEqual(explicit.value, { answer: 42 });
	});

	it("resolves the workflow parser from pi-subagents outside the project cwd", async () => {
		const originalCwd = process.cwd();
		const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-no-acorn-"));
		try {
			process.chdir(emptyCwd);
			const result = await runWorkflowScript({
				script: `return "done";`,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			});
			assert.equal(result.value, "done");
		} finally {
			process.chdir(originalCwd);
			fs.rmSync(emptyCwd, { recursive: true, force: true });
		}
	});

	it("guides invalid JavaScript caused by Markdown fence backticks", async () => {
		const script = [
			"const task = `Run:",
			"```bash",
			"npm test",
			"```;",
			"return task;",
		].join("\n");

		await assert.rejects(
			runWorkflowScript({
				script,
				async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("workflowScript must be valid JavaScript")
				&& error.message.includes('array joined with "\\n"')
				&& error.message.includes("Unexpected token")
				&& error.message.includes("SyntaxError"),
		);
	});

	it("validates workflow syntax and portable structure offline", () => {
		const syntax = validateWorkflowScript(["const value = 1;", "return (;"].join("\n"));
		assert.equal(syntax.ok, false);
		assert.equal(syntax.errors[0]?.line, 2);
		assert.ok((syntax.errors[0]?.column ?? 0) > 0);
		assert.doesNotMatch(syntax.errors[0]?.message ?? "", /\(3:\d+\)$/);

		const structural = validateWorkflowScript([
			`const results = await runs.all([{ key: "bad key", agent: "worker" }, { key: "someChild", agent: "reviewer" }]);`,
			`async function helper() { return "no"; }`,
			`return results.someChild;`,
		].join("\n"));
		assert.equal(structural.ok, false);
		assert.ok(structural.errors.some((error) => error.message.includes("runs.all item key")));
		assert.ok(structural.errors.some((error) => error.message.includes("nested async functions")));
		assert.ok(structural.errors.some((error) => error.message.includes("ordered array")));

		const invalidRunKey = validateWorkflowScript(`return runs.run("bad key", { agent: "worker" });`);
		assert.equal(invalidRunKey.ok, false);
		assert.ok(invalidRunKey.errors.some((error) => error.message.includes("runs.run key")));

		for (const script of [
			`return runs.run("single", { agent: "worker", task: undefined });`,
			`return runs.all([{ key: "same", agent: "worker", task: undefined }]);`,
		]) {
			const invalidParams = validateWorkflowScript(script);
			assert.equal(invalidParams.ok, false);
			assert.ok(invalidParams.errors.some((error) => error.message.includes("undefined is not JSON-representable")));
		}
		assert.deepEqual(validateWorkflowScript(`return runs.run("single", { agent: "worker", task: undefined, task: "real" });`), { ok: true, errors: [] });

		assert.deepEqual(validateWorkflowScript(`return runs.all([{ ...{ key: "bad key" }, agent: "worker" }]);`), { ok: true, errors: [] });
		assert.deepEqual(validateWorkflowScript(`return runs.run("same", { agent: selectedAgent });`), { ok: true, errors: [] });
	});

	it("reports literal child baseRef policy errors with source locations offline", () => {
		for (const [call, value] of [
			["run", JSON.stringify("a".repeat(40))],
			["run", JSON.stringify("A".repeat(64))],
			["all", JSON.stringify("A".repeat(40))],
			["all", "`" + "a".repeat(64) + "`"],
			["run", '"HEAD~1"'],
			["all", '"refs/heads/bad..ref"'],
			["run", "null"],
			["all", "42"],
			["run", "false"],
		]) {
			const script = [
				call === "run" ? 'return runs.run("child", {' : "return runs.all([{",
				'  key: "child", agent: "worker", task: "Check",',
				`  baseRef: ${value}`,
				call === "run" ? "});" : "}]);",
			].join("\n");
			const result = validateWorkflowScript(script);
			assert.equal(result.ok, false, script);
			assert.equal(result.errors.length, 1, script);
			assert.equal(result.errors[0]?.line, 3);
			assert.equal(result.errors[0]?.column, 12);
			assert.match(result.errors[0]!.message, new RegExp(`runs\\.${call}.*baseRef`));
			assert.match(result.errors[0]!.message, /HEAD.*named ref.*40\/64-character commit IDs.*revision expressions.*unsupported/);
		}
	});

	it("validates only the final statically known child baseRef without guessing overwrites", () => {
		for (const fields of [
			"",
			'baseRef: "HEAD"',
			'baseRef: "refs/heads/release"',
			'baseRef: "refs/tags/v1"',
			'baseRef: "origin/main"',
			'baseRef: "HEAD~1", baseRef: "HEAD"',
			'baseRef: "HEAD~1", ["baseRef"]: `HEAD`',
			'baseRef: "HEAD~1", baseRef: selectedRef',
			'baseRef: "HEAD~1", baseRef: "refs/heads/" + branch',
			'baseRef: "HEAD~1", ...overrides',
			'baseRef: "HEAD~1", [field]: "HEAD"',
			'baseRef: "HEAD~1", get baseRef() { return "HEAD"; }',
			'baseRef: "HEAD~1", set baseRef(value) {}',
		]) {
			for (const script of [
				`return runs.run("child", { agent: "worker", task: "Check", ${fields} });`,
				`return runs.all([{ key: "child", agent: "worker", task: "Check", ${fields} }]);`,
			]) assert.deepEqual(validateWorkflowScript(script), { ok: true, errors: [] }, script);
		}
		for (const fields of [
			'baseRef: "HEAD", baseRef: "HEAD~1"',
			'...defaults, baseRef: "HEAD~1"',
			'[field]: "HEAD", ["baseRef"]: "HEAD~1"',
			'get baseRef() { return "HEAD"; }, baseRef: "HEAD~1"',
		]) {
			const result = validateWorkflowScript(`return runs.run("child", { agent: "worker", task: "Check", ${fields} });`);
			assert.equal(result.ok, false, fields);
			assert.match(result.errors[0]!.message, /baseRef/);
		}
		assert.equal(validateWorkflowScript('return runs.run("child", { baseRef() { return "HEAD"; } });').ok, false);
	});

	it("validates runs.host shape offline without executing it", () => {
		assert.deepEqual(validateWorkflowScript(`return runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 1000, output: "reports/tests.log", role: "ci" });`), { ok: true, errors: [] });
		for (const script of [
			`return runs.host("tests", { command: "npm test", timeoutMs: 1000 });`,
			`return runs.host("tests", { kind: "http", command: "npm test", timeoutMs: 1000 });`,
			`return runs.host("tests", { kind: "command", command: "npm test" });`,
			`return runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 1000, output: "../tests.log" });`,
		]) assert.equal(validateWorkflowScript(script).ok, false);
		const cwd = validateWorkflowScript(`return runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 1000, cwd: "/tmp" });`);
		assert.equal(cwd.ok, false);
		assert.ok(cwd.errors.some((error) => /unsupported field 'cwd'.*does not accept per-step cwd.*workflow cwd.*outer subagent request.*cd \/path\/to\/worktree/.test(error.message)));
	});

	it("explains the workflow cwd workaround for dynamic runs.host params", async () => {
		let called = false;
		await assert.rejects(
			runWorkflowScript({
				script: `const params = { kind: "command", command: "npm test", timeoutMs: 1000, cwd: "/tmp" }; return await runs.host("tests", params);`,
				async host() {
					called = true;
					return { key: "tests", kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "", stderr: "", outputPath: "tests.log", durationMs: 1 };
				},
				async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& /does not accept per-step cwd.*workflow cwd.*outer subagent request.*cd \/path\/to\/worktree/.test(error.message),
		);
		assert.equal(called, false);
	});

	it("runs an awaited host command through the host boundary", async () => {
		const steps: string[] = [];
		const result = await runWorkflowScript({
			script: `return await runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 1000, role: "ci", provider: "local" });`,
			async host(key, params) {
				assert.equal(params.kind, "command");
				return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "ok", stderr: "", outputPath: "tests.log", durationMs: 2 };
			},
			onHostStep(step) { steps.push(`${step.state}:${step.role ?? ""}`); },
			async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
		});
		assert.equal((result.value as { state: string }).state, "passed");
		assert.deepEqual(steps, ["running:ci", "done:ci"]);
		assert.deepEqual(result.trace.map(({ operation, state }) => [operation, state]), [["host", "started"], ["host", "completed"]]);
	});

	it("fails the workflow when a host command fails", async () => {
		await assert.rejects(runWorkflowScript({
			script: `return await runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 1000 });`,
			async host(key) { return { key, kind: "command", ok: false, state: "failed", exitCode: 2, stdout: "", stderr: "bad", outputPath: "tests.log", durationMs: 2, error: "Command exited with code 2." }; },
			async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
		}), /Host command 'tests' failed/);
		await assert.rejects(runWorkflowScript({
			script: `return await runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 1000 });`,
			host() { throw new Error("host boundary failed"); },
			async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
		}), /host boundary failed/);
	});

	it("rejects an unawaited host command", async () => {
		await assert.rejects(runWorkflowScript({
			script: `runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 1000 }); return "done";`,
			async host(key) { return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "", stderr: "", outputPath: "tests.log", durationMs: 1 }; },
			async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
		}), /unawaited runs\.host/);
	});

	it("bounds host command rows", async () => {
		const calls = Array.from({ length: 33 }, (_, index) => `await runs.host("host-${index}", { kind: "command", command: "true", timeoutMs: 1000 });`).join("\n");
		await assert.rejects(runWorkflowScript({
			script: `${calls}\nreturn "done";`,
			async host(key) { return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "", stderr: "", outputPath: `${key}.log`, durationMs: 1 }; },
			async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
		}), /at most 32 runs\.host calls/);
	});

	it("keeps dynamic workflow keys silent during offline validation", () => {
		const result = validateWorkflowScript([
			`const prefix = "lane";`,
			`const child = await runs.run(prefix + "-writer", { agent: selectedAgent, task: taskText });`,
			`const results = await runs.all(items.map((item) => ({ key: item.key, agent: item.agent, task: item.task })));`,
			`return { child: child.output, outputs: results.map((entry) => entry.output) };`,
		].join("\n"));
		assert.deepEqual(result, { ok: true, errors: [] });
	});

	it("allows Array properties that match runs.all child keys", () => {
		const valid = validateWorkflowScript([
			`const mapResults = await runs.all([{ key: "map", agent: "reviewer", task: "Review" }]);`,
			`const lengthResults = await runs.all([{ key: "length", agent: "reviewer", task: "Review" }]);`,
			`return { outputs: mapResults.map((result) => result.output), count: lengthResults.length };`,
		].join("\n"));
		assert.deepEqual(valid, { ok: true, errors: [] });

		const keyed = validateWorkflowScript([
			`const results = await runs.all([{ key: "someChild", agent: "reviewer", task: "Review" }]);`,
			`return results.someChild;`,
		].join("\n"));
		assert.equal(keyed.ok, false);
		assert.ok(keyed.errors.some((error) => error.message.includes("'results.someChild' is keyed access")));
	});

	it("rejects statically non-JSON workflow boundary values", () => {
		assert.deepEqual(validateWorkflowScript(`return void 0;`), { ok: true, errors: [] });
		assert.deepEqual(validateWorkflowScript(`return undefined;`), { ok: true, errors: [] });
		assert.deepEqual(validateWorkflowScript(`return [void 0, { value: void 0 }];`), { ok: true, errors: [] });
		assert.deepEqual(validateWorkflowScript(`return [undefined, { value: undefined }];`), { ok: true, errors: [] });
		const result = validateWorkflowScript(`emit(void 0); emit(undefined); state.set("void", void 0); state.set("undefined", undefined); return [1, , 2];`);
		assert.equal(result.ok, false);
		assert.equal(result.errors.filter((error) => error.message.includes("undefined is not JSON-representable")).length, 4);
		assert.ok(result.errors.some((error) => error.message.includes("sparse arrays")));
	});

	it("previews only simple explicit-return child scripts", () => {
		assert.deepEqual(previewSimpleWorkflowRun(`return runs.run('main', { agent: 'worker', task: 'Review' });`), { agent: "worker", task: "Review" });
		assert.deepEqual(previewSimpleWorkflowRun(`return runs.run("main", {"agent":"scout","task":"Scan"})`), { agent: "scout", task: "Scan" });
		assert.equal(previewSimpleWorkflowRun(`const agent = "worker"; return runs.run("main", { agent });`), undefined);
		assert.deepEqual(previewSimpleWorkflowRun(`return runs.run("main", { agent: selected });`), {});
	});

	it("allows scripts to run without a timeout", async () => {
		const result = await runWorkflowScript({
			script: `return "done";`,
			async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.equal(result.value, "done");
	});

	it("exposes validated state only when a mission state adapter is present", async () => {
		const values = new Map<string, unknown>();
		const withState = await runWorkflowScript({
			script: `
				if (typeof state !== "object") throw new Error("state missing");
				await state.set("review.stage", { count: 2 });
				return await state.get("review.stage");
			`,
			state: {
				get: (key) => values.get(key),
				set: (key, value) => { values.set(key, value); },
			},
			async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(withState.value, { count: 2 });

		const withoutState = await runWorkflowScript({
			script: `return typeof state;`,
			async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(withoutState.value, "undefined");

		for (const script of [`return state.get("bad key");`, `return state.set("valid", undefined);`]) {
			await assert.rejects(
				runWorkflowScript({
					script,
					state: { get: () => undefined, set: () => undefined },
					async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /state/.test(error.message),
			);
		}
	});

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
		assert.equal(launches.every(({ params }) => !Object.prototype.hasOwnProperty.call(params, "async")), true);
		assert.deepEqual(result.emits, [{ count: 2 }]);
		assert.deepEqual(result.console, [{ level: "log", text: "reviewed 2" }]);
		assert.match(JSON.stringify(result.value), /\[run review-a; id=run-revi\]/);
		assert.doesNotMatch(JSON.stringify(result.value), /artifacts=/);
		assert.equal(result.trace.filter((entry) => entry.state === "completed").length, 3);
		assert.ok(traceSnapshots.length >= 6);
		assert.deepEqual(emitSnapshots, [1]);
	});

	it("passes a per-run intercom bridge override to the host launch", async () => {
		let launchParams: Record<string, unknown> | undefined;
		await runWorkflowScript({
			script: `return runs.run("isolated", { agent: "worker", task: "Run", intercomBridge: { mode: "off" } });`,
			async launch(key, params) {
				launchParams = params;
				return { key, ok: true, output: "done", artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(launchParams?.intercomBridge, { mode: "off" });
	});

	it("resolves a keyed workflow receipt before launching a retained child", async () => {
		let launchParams: Record<string, unknown> | undefined;
		let resolvedReference: unknown;
		const result = await runWorkflowScript({
			script: `return runs.run("cross-review", { resume: { workflowRunId: "workflow-1", key: "advisor", latest: true }, task: "Continue" });`,
			resolveResume(reference) {
				resolvedReference = reference;
				return { runId: "retained-run", runIds: ["ancestor-run", "retained-run"] };
			},
			async launch(key, params) {
				launchParams = params;
				return { key, ok: true, runId: "continued-run", output: "done", artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(resolvedReference, { workflowRunId: "workflow-1", key: "advisor", latest: true });
		assert.deepEqual(launchParams, { resume: "retained-run", task: "Continue" });
		assert.equal((result.value as { runId?: string }).runId, "continued-run");
		assert.deepEqual((result.value as { continuation?: { runIds?: string[] } }).continuation?.runIds, ["ancestor-run", "retained-run", "continued-run"]);
	});

	it("fails closed for invalid or unavailable keyed workflow receipt resume", async () => {
		for (const resume of [
			`{ workflowRunId: "workflow-1", key: "advisor", latest: false }`,
			`{ workflowRunId: "workflow-1", key: "bad key", latest: true }`,
			`{ workflowRunId: "workflow-1", key: "advisor", latest: true, extra: true }`,
		]) {
			await assert.rejects(
				runWorkflowScript({
					script: `return runs.run("cross-review", { resume: ${resume}, task: "Continue" });`,
					async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /keyed resume/.test(error.message),
			);
		}
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("cross-review", { resume: { workflowRunId: "workflow-1", key: "advisor", latest: true }, task: "Continue" });`,
				async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /unavailable in this host/.test(error.message),
		);
	});

	it("waits for every runs.all child and returns ordinary failures in input order", async () => {
		let delayedFinished = false;
		let delayedAborted = false;
		const result = await runWorkflowScript({
			script: `
				const children = await runs.all([
					{ key: "fails-first", agent: "worker", task: "fail" },
					{ key: "finishes-later", agent: "worker", task: "finish" }
				]);
				return children.map(({ key, ok, error, results }) => error === undefined ? { key, ok, results } : { key, ok, error, results });
			`,
			timeoutMs: 2_000,
			launch(key, _params, signal) {
				if (key === "fails-first") {
					return Promise.resolve({
						key,
						ok: false,
						output: "acceptance rejected",
						artifactPaths: [],
						results: [{ acceptance: { status: "rejected" } }],
					});
				}
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						delayedFinished = true;
						resolve({ key, ok: true, output: "completed", artifactPaths: [], results: [] });
					}, 50);
					signal.addEventListener("abort", () => {
						delayedAborted = !delayedFinished;
						clearTimeout(timer);
						reject(signal.reason);
					}, { once: true });
				});
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.equal(delayedFinished, true);
		assert.equal(delayedAborted, false);
		assert.deepEqual(result.value, [
			{ key: "fails-first", ok: false, error: "acceptance rejected", results: [{ acceptance: { status: "rejected" } }] },
			{ key: "finishes-later", ok: true, results: [] },
		]);
		assert.deepEqual(result.trace.filter((entry) => entry.operation === "run" && entry.state !== "started").map(({ key, state }) => ({ key, state })), [
			{ key: "fails-first", state: "failed" },
			{ key: "finishes-later", state: "completed" },
		]);
	});

	it("caps concurrent workflow child launches across runs.all", async () => {
		let active = 0;
		let maxActive = 0;
		const result = await runWorkflowScript({
			script: `return await runs.all([
				{ key: "one", agent: "worker", task: "one" },
				{ key: "two", agent: "worker", task: "two" },
				{ key: "three", agent: "worker", task: "three" },
				{ key: "four", agent: "worker", task: "four" }
			]);`,
			globalConcurrencyLimit: 2,
			async launch(key) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active -= 1;
				return { key, ok: true, output: key, artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.equal(maxActive, 2);
		assert.deepEqual((result.value as Array<{ key: string }>).map(({ key }) => key), ["one", "two", "three", "four"]);
	});

	it("runs parallel lane starts and sequential stages with retained resume", async () => {
		const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
		let active = 0;
		let maxActive = 0;
		let betaWriterDone = false;
		let alphaChallengeStartedBeforeBetaWriter = false;
		const result = await runWorkflowScript({
			script: `return await runs.lanes([
				{ key: "alpha", stages: [
					{ key: "writer", agent: "worker", task: "alpha write" },
					{ key: "challenge", resume: "previous", task: "alpha challenge" }
				] },
				{ key: "beta", stages: [
					{ key: "writer", agent: "worker", task: "beta write" },
					{ key: "review", agent: "reviewer", task: "beta review" }
				] }
			]);`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, params });
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, key === "beta.writer" ? 50 : 5));
				if (key === "beta.writer") betaWriterDone = true;
				if (key === "alpha.challenge") alphaChallengeStartedBeforeBetaWriter = !betaWriterDone;
				active -= 1;
				return {
					key,
					ok: true,
					runId: "run-" + key,
					output: key + " output",
					outputReference: "/tmp/" + key + ".md",
					artifactPaths: [],
					results: [],
				};
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.equal(maxActive, 2, "first stages should be admitted together");
		assert.equal(alphaChallengeStartedBeforeBetaWriter, true, "a settled lane should advance without waiting for slower siblings");
		assert.deepEqual(launches.map(({ key }) => key), ["alpha.writer", "beta.writer", "alpha.challenge", "beta.review"]);
		assert.deepEqual(launches.find(({ key }) => key === "alpha.challenge")?.params, { resume: "run-alpha.writer", task: "alpha challenge" });
		for (const lane of ["alpha", "beta"]) {
			const stageTrace = result.trace.filter((entry) => entry.operation === "run" && entry.key.startsWith(`${lane}.`));
			assert.ok(stageTrace.length > 0);
			assert.equal(stageTrace.every((entry) => entry.generatedLaneKey === lane), true);
		}
		assert.deepEqual(result.value, [
			{
				key: "alpha",
				state: "complete",
				stages: [
					{ key: "writer", runId: "run-alpha.writer", ok: true, state: "completed", outputReference: "/tmp/alpha.writer.md" },
					{ key: "challenge", runId: "run-alpha.challenge", ok: true, state: "completed", outputReference: "/tmp/alpha.challenge.md" },
				],
			},
			{
				key: "beta",
				state: "complete",
				stages: [
					{ key: "writer", runId: "run-beta.writer", ok: true, state: "completed", outputReference: "/tmp/beta.writer.md" },
					{ key: "review", runId: "run-beta.review", ok: true, state: "completed", outputReference: "/tmp/beta.review.md" },
				],
			},
		]);
	});

	it("marks only runs.lanes stages with generated lane provenance", async () => {
		const result = await runWorkflowScript({
			script: `const direct = await runs.run("audit.shadow", { agent: "worker", task: "direct" }); const lanes = await runs.lanes([{ key: "audit", stages: [{ key: "writer", agent: "worker", task: "generated" }] }]); return { direct: direct.output, lanes };`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, runId: "run-" + key, output: key, artifactPaths: [], results: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		const directTrace = result.trace.filter((entry) => entry.operation === "run" && entry.key === "audit.shadow");
		const generatedTrace = result.trace.filter((entry) => entry.operation === "run" && entry.key === "audit.writer");
		assert.ok(directTrace.length > 0);
		assert.equal(directTrace.every((entry) => entry.generatedLaneKey === undefined), true);
		assert.ok(generatedTrace.length > 0);
		assert.equal(generatedTrace.every((entry) => entry.generatedLaneKey === "audit"), true);
	});

	it("keeps a rejected first-stage result local to its lane", async () => {
		const launches: string[] = [];
		const result = await runWorkflowScript({
			script: `return await runs.lanes([
				{ key: "broken", stages: [
					{ key: "writer", agent: "worker", task: "boundary failure" },
					{ key: "review", agent: "reviewer", task: "must be skipped" }
				] },
				{ key: "healthy", stages: [
					{ key: "writer", agent: "worker", task: "continue" },
					{ key: "review", agent: "reviewer", task: "continue review" }
				] }
			]);`,
			timeoutMs: 2_000,
			async launch(key) {
				launches.push(key);
				if (key === "broken.writer") {
					const structuredOutput: Record<string, unknown> = {};
					structuredOutput.self = structuredOutput;
					return { key, ok: true, runId: "broken-run", output: "not persisted", structuredOutput, artifactPaths: [], results: [] };
				}
				return { key, ok: true, runId: "run-" + key, output: "done", artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(launches, ["broken.writer", "healthy.writer", "healthy.review"]);
		const board = result.value as Array<{ key: string; state: string; failedStage?: string; stages: Array<Record<string, unknown>> }>;
		assert.equal(board.length, 2);
		assert.deepEqual(board[0], {
			key: "broken",
			state: "blocked",
			failedStage: "writer",
			stages: [
				{ key: "writer", ok: false, state: "failed", error: board[0].stages[0].error },
				{ key: "review", state: "skipped" },
			],
		});
		assert.match(String(board[0].stages[0].error), /must contain only JSON data/);
		assert.deepEqual(board[1], {
			key: "healthy",
			state: "complete",
			stages: [
				{ key: "writer", runId: "run-healthy.writer", ok: true, state: "completed" },
				{ key: "review", runId: "run-healthy.review", ok: true, state: "completed" },
			],
		});
		assert.doesNotThrow(() => JSON.stringify(result));
		assert.equal(result.children.find((child) => child.key === "broken.writer")?.ok, false);
		assert.equal(result.children.find((child) => child.key === "broken.writer")?.structuredOutput, undefined);
		assert.equal(result.children.find((child) => child.key === "healthy.writer")?.ok, true);
	});

	it("blocks one lane on an explicit structured verdict while siblings continue", async () => {
		const launches: string[] = [];
		const result = await runWorkflowScript({
			script: `return await runs.lanes([
				{ key: "blocked", stages: [
					{ key: "review", agent: "reviewer", task: "block this lane" },
					{ key: "followup", agent: "worker", task: "must not run" }
				] },
				{ key: "healthy", stages: [
					{ key: "review", agent: "reviewer", task: "continue this lane" },
					{ key: "followup", agent: "worker", task: "continue followup" }
				] }
			]);`,
			timeoutMs: 2_000,
			async launch(key) {
				launches.push(key);
				return {
					key,
					ok: true,
					runId: "run-" + key,
					output: "done",
					structuredOutput: key === "blocked.review" ? { verdict: "blocked" } : { verdict: "ready" },
					artifactPaths: [],
					results: [],
				};
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(launches, ["blocked.review", "healthy.review", "healthy.followup"]);
		assert.deepEqual(result.value, [
			{
				key: "blocked",
				state: "blocked",
				failedStage: "review",
				stages: [
					{ key: "review", runId: "run-blocked.review", ok: true, state: "blocked", verdict: "blocked", error: "Stage returned a blocked verdict." },
					{ key: "followup", state: "skipped" },
				],
			},
			{
				key: "healthy",
				state: "complete",
				stages: [
					{ key: "review", runId: "run-healthy.review", ok: true, state: "completed", verdict: "ready" },
					{ key: "followup", runId: "run-healthy.followup", ok: true, state: "completed", verdict: "ready" },
				],
			},
		]);
	});

	it("settles a failed lane without aborting later stages in sibling lanes", async () => {
		const launches: string[] = [];
		const result = await runWorkflowScript({
			script: `return await runs.lanes([
				{ key: "fails", stages: [
					{ key: "writer", agent: "worker", task: "write" },
					{ key: "challenge", agent: "worker", task: "fail challenge" },
					{ key: "final", agent: "worker", task: "must be skipped" }
				] },
				{ key: "passes", stages: [
					{ key: "writer", agent: "worker", task: "write" },
					{ key: "challenge", agent: "worker", task: "pass challenge" }
				] }
			]);`,
			timeoutMs: 2_000,
			async launch(key) {
				launches.push(key);
				if (key === "fails.challenge") return { key, ok: false, runId: "failed-run", output: "challenge failed", error: "challenge failed", artifactPaths: [], results: [] };
				return { key, ok: true, runId: "run-" + key, output: "done", artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(launches, ["fails.writer", "passes.writer", "fails.challenge", "passes.challenge"]);
		assert.deepEqual(result.value, [
			{
				key: "fails",
				state: "blocked",
				failedStage: "challenge",
				stages: [
					{ key: "writer", runId: "run-fails.writer", ok: true, state: "completed" },
					{ key: "challenge", runId: "failed-run", ok: false, state: "failed", error: "challenge failed" },
					{ key: "final", state: "skipped" },
				],
			},
			{
				key: "passes",
				state: "complete",
				stages: [
					{ key: "writer", runId: "run-passes.writer", ok: true, state: "completed" },
					{ key: "challenge", runId: "run-passes.challenge", ok: true, state: "completed" },
				],
			},
		]);
	});

	it("gives actionable guidance for a retained stage-0 resume", async () => {
		let launches = 0;
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.lanes([{ key: "lane", stages: [{ key: "writer", resume: "retained-run", task: "continue" }] }]);`,
				timeoutMs: 2_000,
				async launch(key) { launches += 1; return { key, ok: true, output: "unexpected", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("runs.lanes lane 0 stage 0 cannot resume a retained run id in runs.lanes")
				&& error.message.includes("use runs.run(key, { resume: id }) outside lanes")
				&& error.message.includes('start the lane with an agent stage and use resume: "previous" later'),
		);
		assert.equal(launches, 0);
	});

	it("validates all lane stages before launching any child", async () => {
		const malformedScripts = [
			`return runs.lanes([{ key: "bad lane", stages: [{ key: "writer", agent: "worker", task: "write" }] }]);`,
			`return runs.lanes([{ key: "lane", stages: [{ key: "writer", agent: "worker", task: "write" }, { key: "writer", agent: "worker", task: "again" }] }]);`,
			`return runs.lanes([{ key: "lane", stages: [{ key: "writer", resume: "previous", task: "cannot start" }] }]);`,
			`return runs.lanes([{ key: "lane", stages: [{ key: "writer", agent: "worker", task: "write" }, { key: "review", resume: "raw-run-id", task: "invalid" }] }]);`,
		];
		for (const script of malformedScripts) {
			let launches = 0;
			await assert.rejects(
				runWorkflowScript({
					script,
					timeoutMs: 2_000,
					async launch(key) { launches += 1; return { key, ok: true, output: "unexpected", artifactPaths: [], results: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /runs\.lanes/.test(error.message),
			);
			assert.equal(launches, 0, script);
		}
	});

	it("rejects an invalid workflow concurrency limit before launching", async () => {
		let launches = 0;
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("one", { agent: "worker", task: "one" });`,
				globalConcurrencyLimit: 0,
				async launch(key) {
					launches += 1;
					return { key, ok: true, output: key, artifactPaths: [] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			/workflow script global concurrency limit must be a positive integer/,
		);
		assert.equal(launches, 0);
	});

	it("returns runs.all launch errors without aborting successful siblings", async () => {
		const result = await runWorkflowScript({
			script: `
				const children = await runs.all([
					{ key: "cannot-launch", agent: "missing", task: "fail" },
					{ key: "still-runs", agent: "worker", task: "finish" }
				]);
				return children.map(({ key, ok, error }) => error === undefined ? { key, ok } : { key, ok, error });
			`,
			timeoutMs: 2_000,
			launch(key) {
				if (key === "cannot-launch") throw new Error("agent is unavailable");
				return new Promise((resolve) => setTimeout(() => resolve({ key, ok: true, output: "completed", artifactPaths: [], results: [] }), 25));
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(result.value, [
			{ key: "cannot-launch", ok: false, error: "agent is unavailable" },
			{ key: "still-runs", ok: true },
		]);
		assert.deepEqual(result.children.map(({ key, ok, error }) => error === undefined ? { key, ok } : { key, ok, error }), [
			{ key: "cannot-launch", ok: false, error: "agent is unavailable" },
			{ key: "still-runs", ok: true },
		]);
	});

	it("accepts one gate command and rejects gate with acceptance", async () => {
		const launches: Record<string, unknown>[] = [];
		await runWorkflowScript({
			script: `return runs.run("gated", { agent: "worker", gate: "npm test" });`,
			async launch(key, params) { launches.push(params); return { key, ok: true, output: "done", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(launches[0]?.gate, "npm test");
		await runWorkflowScript({
			script: `return runs.run("gated-disabled", { agent: "worker", gate: "npm test", acceptance: false });`,
			async launch(key, params) { launches.push(params); return { key, ok: true, output: "done", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(launches[1]?.gate, "npm test");
		assert.equal(launches[1]?.acceptance, false);
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("invalid", { agent: "worker", gate: "npm test", acceptance: "checked" });`,
				async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /gate cannot be combined with acceptance/.test(error.message),
		);
	});

	it("reuses a gated key when acceptance false is explicit", async () => {
		const launches: string[] = [];
		const result = await runWorkflowScript({
			script: `
				const first = await runs.run("g", { agent: "worker", gate: "npm test" });
				const second = await runs.run("g", { agent: "worker", gate: "npm test", acceptance: false });
				return { first: first.key, second: second.key };
			`,
			timeoutMs: 2_000,
			async launch(key) {
				launches.push(key);
				return { key, ok: true, output: "ok", artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(result.value, { first: "g", second: "g" });
		assert.deepEqual(launches, ["g"]);
	});

	it("rejects retained resume with gate", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("resume", { resume: "retained-run", task: "Continue", gate: "npm test" });`,
				async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /gate is not supported with retained resume/.test(error.message),
		);
	});

	it("keeps runs.run fail-fast for ordinary child failures", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.run("fails", { agent: "worker", task: "fail" });`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: false, output: "failed", artifactPaths: [], results: [{ acceptance: { status: "rejected" } }] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /Run 'fails' failed: failed/.test(error.message),
		);
	});

	it("continues with a later review after a durable acceptance metadata rejection", async () => {
		const launches: string[] = [];
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "a".repeat(64),
		};
		const result = await runWorkflowScript({
			script: `
				const writer = await runs.run("writer", { agent: "worker", task: "write" });
				const review = await runs.run("review", { agent: "reviewer", task: "Read-only review. Do not edit files, commit, push, comment, merge, or launch subagents. Review the patch and return findings only. Do not run workers. Do not launch worker subagents. Do not hand off remediation to workers. Do not use worker subagents. Do not have a worker continue follow-up. Do not tell a worker to continue follow-up. Do not get a worker to continue follow-up. Do not let a worker continue follow-up. Do not request implementation follow-up from a worker. Do not ask a reviewer to implement changes. Do not ask for a review from another reviewer. Delta since prior review: fixed quoted git option handling and added exact regressions; mutation detection now includes move/rename/copy file mutation imperatives; Delegation now catches target-after-preposition forms using from/with/via/by and request phrasing: 'Get implementation follow-up via a worker.', 'Get a review via another reviewer.', 'Have implementation follow-up done by a worker.', and 'Request implementation follow-up from a worker.'; 'Launch two workers for implementation follow-up.' and 'Launch review subagents for follow-up.' are blocked; 'Launch two reviewers for follow-up.' is blocked; \`rm -rf .\` is blocked. RECOVERY_REVIEW_MUTATION_VERB_PATTERN now includes append, prepend, and save, with gerund forms. Added exact regressions for 'Append a regression test.', 'Prepend a guard clause.', and 'Save the updated report.' This keeps a later object phrase visible, so a prompt ending with \`save the updated report\` remains blocked. Accepted contract: after rejected durable acceptance-metadata recovery, sequential workflow continuation may only launch explicit read-only review children with acceptance:false, must not mutate durable state, and must not launch mutating/destructive work. state.get remains allowed; state.set, runs.host, runs.steer, ordinary/mutating children, and destructive command wording are blocked. Existing regressions cover plain rm and git clean/reset/restore. Prior regressions covering rm/git clean as evidence only. Validation after fix: npm exec -- tsx --test test/unit/scripted-workflow.test.ts --test-name-pattern \\\"acceptance metadata rejection|mission state writes\\\" (101 pass), npm run typecheck, git diff --check HEAD^..HEAD. (Validation after fix: npm run typecheck) Write findings to reports/review.md.", acceptance: false });
				return { writerOk: writer.ok, writerStatus: writer.results?.[0]?.acceptance?.status, writerRecovery: writer.recovery, reviewOk: review.ok };
			`,
			launch(key) {
				launches.push(key);
				if (key === "writer") {
					return Promise.resolve({
						key,
						ok: false,
						output: "saved writer report",
						error: "Acceptance rejected: malformed acceptance-report",
						runId: "writer-run",
						outputReference: recovery.reportPath,
						recovery,
						artifactPaths: [recovery.reportPath],
						results: [{ acceptance: { status: "rejected", recovery } }],
					});
				}
				return Promise.resolve({ key, ok: true, output: "review complete", runId: "review-run", artifactPaths: [] });
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(launches, ["writer", "review"]);
		assert.deepEqual(result.value, { writerOk: false, writerStatus: "rejected", writerRecovery: recovery, reviewOk: true });
		assert.deepEqual(result.trace.filter((entry) => entry.operation === "run" && entry.state !== "started").map(({ key, state }) => ({ key, state })), [
			{ key: "writer", state: "failed" },
			{ key: "review", state: "completed" },
		]);
	});

	it("allows review prompts to describe mutation nouns after durable acceptance metadata recovery", async () => {
		const launches: string[] = [];
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "a".repeat(64),
		};
		const result = await runWorkflowScript({
			script: `
				const writer = await runs.run("writer", { agent: "worker", task: "write" });
				const review = await runs.run("review", { agent: "reviewer", task: "Read-only review. Do not edit files. The later real update imperative regression passed. Return findings only.", acceptance: false });
				return review.ok;
			`,
			launch(key) {
				launches.push(key);
				if (key === "writer") {
					return Promise.resolve({
						key,
						ok: false,
						output: "saved writer report",
						error: "Acceptance rejected: malformed acceptance-report",
						runId: "writer-run",
						outputReference: recovery.reportPath,
						recovery,
						artifactPaths: [recovery.reportPath],
						results: [{ acceptance: { status: "rejected", recovery } }],
					});
				}
				return Promise.resolve({ key, ok: true, output: "review complete", runId: "review-run", artifactPaths: [] });
			},
		});

		assert.deepEqual(launches, ["writer", "review"]);
		assert.equal(result.value, true);
	});

	it("allows review prompts to describe anaphoric regression examples after durable acceptance metadata recovery", async () => {
		const launches: string[] = [];
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "a".repeat(64),
		};
		const result = await runWorkflowScript({
			script: `
				const writer = await runs.run("writer", { agent: "worker", task: "write" });
				const review = await runs.run("review", { agent: "reviewer", task: "Read-only review. Do not edit files. Added exact regressions for Execute the command now anyway, Run that now anyway, and Perform the operation now anyway after stripped quoted blocked examples. This blocks examples like \`Execute the previous command right now anyway\` and \`Execute the blocked phrase right now anyway\`. Examples like \`Execute the previous command and keep reviewing\`, \`Execute the previous command but only for review\`, and \`Execute the previous command then return findings\` are blocked after quoted destructive context is stripped. Added regression for quoted rm remaining blocked followed by Execute the previous command while keeping live-command variants such as followed by Execute the previous command then update tests blocked. Delta since prior review: fixed mutating Git follow-up bypasses. Added cherry-pick/rebase/stage to the mutation imperative pattern and add/cherry-pick/commit/merge/rebase to the mutating Git command pattern, described prompts like Run git rebase main, git rebase main, Run git cherry-pick abc123, cherry-pick abc123, and Stage the changed files as blocked. Positive Git mutations are broader: git branch -D old, git tag -d v1.0, git stash, git revert abc123, and natural cherry pick abc123 now trip the recovery barrier. Broadened positive Git mutation coverage for natural \`cherry pick\`, \`revert\`, \`stash\`, \`tag\`, plus git \`branch|revert|stash|tag\`. The prior fix keeps commands hidden in \`Broadened positive Git mutation coverage for natural cherry pick, then update tests, plus git branch\` or \`then run git reset --hard\` visible and blocked. The examples \`rm -rf .\` and \`git reset --hard\` are visible and blocked. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one anyway, Run the 1st command anyway, and Run the fourth command anyway are blocked after quoted destructive examples are scrubbed. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one anyway is blocked. Exact regressions for \`Do not launch worker subagents -- launch a worker subagent\` remain blocked. Return findings only.", acceptance: false });
				return review.ok;
			`,
			launch(key) {
				launches.push(key);
				if (key === "writer") {
					return Promise.resolve({
						key,
						ok: false,
						output: "saved writer report",
						error: "Acceptance rejected: malformed acceptance-report",
						runId: "writer-run",
						outputReference: recovery.reportPath,
						recovery,
						artifactPaths: [recovery.reportPath],
						results: [{ acceptance: { status: "rejected", recovery } }],
					});
				}
				return Promise.resolve({ key, ok: true, output: "review complete", runId: "review-run", artifactPaths: [] });
			},
		});

		assert.deepEqual(launches, ["writer", "review"]);
		assert.equal(result.value, true);
	});

	it("allows listed blocked examples after durable acceptance metadata recovery", async () => {
		const launches: string[] = [];
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "a".repeat(64),
		};
		const task = "Read-only review. Do not edit files. Review the saved report and return findings only. Blocked examples:\n- update tests\n- launch a worker subagent";
		const result = await runWorkflowScript({
			script: `
				const writer = await runs.run("writer", { agent: "worker", task: "write" });
				const review = await runs.run("review", { agent: "reviewer", task: ${JSON.stringify(task)}, acceptance: false });
				return review.ok;
			`,
			launch(key) {
				launches.push(key);
				if (key === "writer") {
					return Promise.resolve({ key, ok: false, output: "saved writer report", recovery, artifactPaths: [recovery.reportPath], results: [{ acceptance: { status: "rejected", recovery } }] });
				}
				return Promise.resolve({ key, ok: true, output: "review complete", artifactPaths: [] });
			},
		});

		assert.deepEqual(launches, ["writer", "review"]);
		assert.equal(result.value, true);
	});

	it("allows quoted blocked examples phrased as blocked examples after durable acceptance metadata recovery", async () => {
		const launches: string[] = [];
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "a".repeat(64),
		};
		const task = "Read-only review. Do not edit files. Review the saved report and return findings only. `update tests` is a blocked example.";
		const result = await runWorkflowScript({
			script: `
				const writer = await runs.run("writer", { agent: "worker", task: "write" });
				const review = await runs.run("review", { agent: "reviewer", task: ${JSON.stringify(task)}, acceptance: false });
				return review.ok;
			`,
			launch(key) {
				launches.push(key);
				if (key === "writer") {
					return Promise.resolve({ key, ok: false, output: "saved writer report", recovery, artifactPaths: [recovery.reportPath], results: [{ acceptance: { status: "rejected", recovery } }] });
				}
				return Promise.resolve({ key, ok: true, output: "review complete", artifactPaths: [] });
			},
		});

		assert.deepEqual(launches, ["writer", "review"]);
		assert.equal(result.value, true);
	});

	it("blocks mutating workflow work after a durable acceptance metadata rejection", async () => {
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "a".repeat(64),
		};
		for (const [agent, task] of [
			["worker", "Implement a follow-up change"],
			["worker", "Read-only review. Do not edit files. Return findings only."],
			["reviewer", "Review the saved report and delete files"],
			["custom-reviewer", "Review the saved report and add tests"],
			["oracle", "Review the saved report and create files"],
			["reviewer", "Review the saved report, then add a regression case"],
			["custom-reviewer", "Review the saved report and create a regression test"],
			["oracle", "Review the saved report and replace the brittle assertion"],
			["reviewer", "Review the saved report and patch src/parser.ts"],
			["reviewer", "Change src/parser.ts after reviewing the saved report"],
			["reviewer", "Read-only review. Do not edit files. Append a regression test."],
			["reviewer", "Read-only review. Do not edit files. Prepend a guard clause."],
			["reviewer", "Read-only review. Do not edit files. Save the updated report."],
			["reviewer", "Read-only review. Do not edit files. Move src/a.ts to src/b.ts."],
			["reviewer", "Read-only review. Do not edit files. Rename src/a.ts to src/b.ts."],
			["reviewer", "Read-only review. Do not edit files. Copy src/a.ts to src/b.ts."],
			["advisor", "Review only, then apply the fix"],
			["reviewer", "Read-only review. Do not edit files. Launch a worker subagent to continue."],
			["reviewer", "Read-only review. Do not edit files. Launch worker subagents for implementation follow-up."],
			["reviewer", "Read-only review. Do not edit files. Launch workers for implementation follow-up."],
			["reviewer", "Read-only review. Do not edit files. Launch two workers for implementation follow-up."],
			["reviewer", "Read-only review. Do not edit files. Launch review subagents for follow-up."],
			["reviewer", "Read-only review. Do not edit files. Launch two reviewers for follow-up."],
			["reviewer", "Read-only review. Do not edit files. Delegate remediation to a worker."],
			["reviewer", "Read-only review. Do not edit files. Hand off remediation to a worker."],
			["reviewer", "Read-only review. Do not edit files. Assign implementation follow-up to a worker."],
			["reviewer", "Read-only review. Do not edit files. Assign implementation follow-up to workers."],
			["reviewer", "Read-only review. Do not edit files. Ask a worker to implement the fix."],
			["reviewer", "Read-only review. Do not edit files. Ask a reviewer to review the saved report."],
			["reviewer", "Read-only review. Do not edit files. Ask another reviewer to review the saved report."],
			["reviewer", "Read-only review. Do not edit files. Ask for a review from another reviewer."],
			["reviewer", "Read-only review. Do not edit files. Do not ask for a review from another reviewer and ask for a review from a worker."],
			["reviewer", "Read-only review. Do not edit files. Do not ask for a review from another reviewer however ask for a review from a worker."],
			["reviewer", "Read-only review. Do not edit files. Use a worker subagent for follow-up."],
			["reviewer", "Read-only review. Do not edit files. Get a worker to continue follow-up."],
			["reviewer", "Read-only review. Do not edit files. Let a worker continue follow-up."],
			["reviewer", "Read-only review. Do not edit files. Ask a worker for follow-up."],
			["reviewer", "Read-only review. Do not edit files. Get implementation follow-up from a worker."],
			["reviewer", "Read-only review. Do not edit files. Get a review from another reviewer."],
			["reviewer", "Read-only review. Do not edit files. Let follow-up continue with a worker."],
			["reviewer", "Read-only review. Do not edit files. Get implementation follow-up via a worker."],
			["reviewer", "Read-only review. Do not edit files. Get a review via another reviewer."],
			["reviewer", "Read-only review. Do not edit files. Have implementation follow-up done by a worker."],
			["reviewer", "Read-only review. Do not edit files. Request implementation follow-up from a worker."],
			["reviewer", "Read-only review. Do not edit files. Have a worker continue follow-up."],
			["reviewer", "Read-only review. Do not edit files. Tell a worker to continue follow-up."],
			["reviewer", "Read-only review. Do not edit files. Do not launch worker subagents and launch a worker subagent to continue."],
			["reviewer", "Read-only review. Do not edit files. Do not launch worker subagents however launch a worker subagent to continue."],
			["reviewer", "Read-only review. Do not edit files. Do not launch worker subagents — launch a worker subagent. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Do not execute the previous command — delete src/a. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Do not launch worker subagents -- launch a worker subagent. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Do not execute the previous command -- delete src/a. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Do not launch worker subagents: launch a worker subagent. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Do not run workers: run a worker. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Do not execute the previous command: delete src/a. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Do not launch worker subagents / launch a worker subagent. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. `update tests` is a blocked example, then update tests."],
			["reviewer", "Read-only review. Do not edit files. Blocked examples:\n- update tests\n- launch a worker subagent\nThen update tests."],
			["reviewer", "Read-only review. Do not edit files. Not blocked examples:\n- launch a worker subagent"],
			["reviewer", "Read-only review. Do not edit files. Destructive command wording is blocked, then run rm -rf ."],
			["reviewer", "Read-only review. Do not edit files. state.set is forbidden. Run rm -rf . This is blocked."],
			["reviewer", "Read-only review. Do not edit files. state.set: Run rm -rf /tmp/worktree because it is blocked."],
			["reviewer", "Read-only review. Do not edit files. Prior validation after the fix: npm run typecheck."],
			["reviewer", "Read-only review. Do not edit files. Validation after fix: npm run typecheck, then update tests."],
			["reviewer", "Read-only review. Do not edit files. Validation after fix: npm run typecheck and update tests."],
			["reviewer", "Read-only review. Do not edit files. Validation after fix: npm run typecheck and launch a worker subagent."],
			["reviewer", "Read-only review. Do not edit files. Validation after fix: npm run typecheck and run a worker subagent."],
			["reviewer", "Read-only review. Do not edit files. Mutation detection now includes move/rename/copy file mutation imperatives, then update tests."],
			["reviewer", "Read-only review. Do not edit files. Mutation detection now includes delete src/a.ts. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Delegation detection now blocks get/let/have/tell/ask follow-up forms, then launch a worker subagent."],
			["reviewer", "Read-only review. Do not edit files. Delegation detection now blocks get/let/have/tell/ask follow-up forms and then launch a worker subagent."],
			["reviewer", "Read-only review. Do not edit files. Mutation detection now includes move/rename/copy file mutation imperatives and update tests."],
			["reviewer", "Read-only review. Do not edit files. Delegation detection now blocks get/let/have/tell/ask follow-up forms and launch a worker subagent."],
			["reviewer", "Read-only review. Do not edit files. RECOVERY_REVIEW_MUTATION_VERB_PATTERN now includes append, prepend, and save, then update tests."],
			["reviewer", "Read-only review. Do not edit files. RECOVERY_REVIEW_MUTATION_VERB_PATTERN now includes append, prepend, and save the updated report."],
			["reviewer", "Read-only review. Do not edit files. A prompt ending with `save the updated report` remains blocked, then update tests."],
			["reviewer", "Read-only review. Do not edit files. Prompts like update tests are blocked, then update tests. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Examples like `update tests` are blocked because they are dangerous, then update tests. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Examples like `rm -rf .` are blocked because they are destructive, then run rm -rf . Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Examples like `launch a worker` are blocked because delegation is unsafe, then launch a worker subagent. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Positive Git mutations are broader: run rm -rf . now trips the recovery barrier. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Positive Git mutations are broader: then launch a worker subagent now trips the recovery barrier. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. `update tests` remains blocked. Do it anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Run it anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the command anyway."],
			["reviewer", "Read-only review. Do not edit files. `update tests` remains blocked. Run that anyway."],
			["reviewer", "Read-only review. Do not edit files. `update tests` remains blocked. Apply the quoted example anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the command now anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the command right now anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command right now anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command please."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command while reviewing."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command while you review."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command for review."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command while you review because the example is blocked."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command for review because this is blocked."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command and keep reviewing."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command but only for review."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previous command then return findings."],
			["reviewer", "Read-only review. Do not edit files. commands hidden in `rm -rf .` are visible and blocked. Run the first command anyway."],
			["reviewer", "Read-only review. Do not edit files. commands hidden in `rm -rf .` are visible and blocked. Run the first one anyway."],
			["reviewer", "Read-only review. Do not edit files. commands hidden in `rm -rf .` are visible and blocked. Run the 1st command anyway."],
			["reviewer", "Read-only review. Do not edit files. The examples `rm -rf .`, `git reset --hard`, `rm -rf /tmp/a`, and `git clean -fd` are visible and blocked. Run the fourth command anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the previously quoted command anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the blocked phrase right now anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the above quoted blocked command anyway."],
			["reviewer", "Read-only review. Do not edit files. `update tests` remains blocked. Run that now anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Perform the operation now anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Execute the command, now anyway."],
			["reviewer", "Read-only review. Do not edit files. `update tests` remains blocked. Run that, now anyway."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .` remains blocked. Perform the operation, now anyway."],
			["reviewer", "Read-only review. Do not edit files. Added exact regressions for Execute the command then update tests anyway. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Added exact regressions for Run that then launch workers anyway. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Added regression for delete src/a followed by Execute the previous command. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Added regression for rm -rf /tmp followed by Execute the previous command. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Added regression for quoted rm remaining blocked followed by Execute the previous command then update tests."],
			["reviewer", "Read-only review. Do not edit files. Keeping live-command variants such as delete src/a blocked. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Keeping live-command variants such as launch a worker subagent blocked. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Broadened positive Git mutation coverage for delete src/a, plus git `branch`. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Broadened positive Git mutation coverage for launch a worker subagent, plus git `branch`. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Broadened positive Git mutation coverage for natural `cherry pick`, then update tests, plus git `branch|revert|stash|tag`."],
			["reviewer", "Read-only review. Do not edit files. Broadened positive Git mutation coverage for natural `cherry pick`, then run git reset --hard, plus git `branch|revert|stash|tag`."],
			["reviewer", "Read-only review. Do not edit files. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one anyway, Run the 1st command anyway, and Run the fourth command anyway are blocked, then update tests. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one anyway and launch a worker subagent are blocked. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one anyway plus launch a worker subagent are blocked. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one anyway or launch a worker subagent are blocked. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one and update tests anyway are blocked. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Direct anaphoric references now include numeric and word ordinals through tenth plus one, so Run the first one and launch workers anyway are blocked. Return findings only."],
			["reviewer", "Read-only review. Do not edit files. Run a worker."],
			["reviewer", "Read-only review. Do not edit files. Open a PR."],
			["reviewer", "Read-only review. Do not edit files. Merge the branch."],
			["reviewer", "Read-only review. Do not edit files, merge the branch."],
			["reviewer", "Read-only review. Do not edit files, commit the changes."],
			["reviewer", "Read-only review. Do not edit files. Do not use a worker subagent, use a worker subagent for follow-up."],
			["reviewer", "Read-only review. Do not edit files. Do not hand off to a worker, hand off remediation to a worker."],
			["reviewer", "Read-only review. Do not edit files. Do not assign this to a worker, assign implementation follow-up to a worker."],
			["reviewer", "Read-only review. Do not edit files; update tests."],
			["reviewer", "Read-only review. Do not edit files; updating tests is required."],
			["reviewer", "Do not edit files, run git clean -fd"],
			["reviewer", "Review only; do not edit files. Run git clean -fd"],
			["reviewer", "Read-only review. Do not edit files. Validation after fix: rm -rf ."],
			["reviewer", "Read-only review. Do not edit files. Existing regressions cover plain rm, then run rm -rf ."],
			["reviewer", "Read-only review. Do not edit files. git clean -fd; existing regressions cover git clean."],
			["reviewer", "Read-only review. Do not edit files. Existing regressions cover rm/git clean. Write findings."],
			["reviewer", "Read-only review. Do not edit files. Existing regressions cover rm. Write findings."],
			["reviewer", "Read-only review. Do not edit files. Existing regressions cover git clean and run git clean -fd."],
			["reviewer", "Read-only review. Do not edit files. Existing regressions cover git clean and launch a worker subagent."],
			["reviewer", "Read-only review. Do not edit files. rm -rf ."],
			["reviewer", "Read-only review. Do not edit files. `rm -rf .`"],
			["reviewer", "Read-only review. Do not edit files. 'rm -rf .'"],
			["reviewer", "Read-only review. Do not edit files. /bin/rm -rf ."],
			["reviewer", "Read-only review. Do not edit files. /usr/bin/rm -rf ."],
			["reviewer", "Read-only review. Do not edit files. /usr/local/bin/rm -rf ."],
			["reviewer", "Read-only review. Do not edit files. Validation after fix: git -C . reset --hard."],
			["reviewer", "Read-only review. Do not edit files. git --work-tree . reset --hard."],
			["reviewer", "Read-only review. Do not edit files. git --work-tree \"/tmp/my repo\" reset --hard."],
			["reviewer", "Read-only review. Do not edit files. git --work-tree '/tmp/my repo' reset --hard."],
			["reviewer", "Read-only review. Do not edit files. Run git rebase main."],
			["reviewer", "Read-only review. Do not edit files. git rebase main."],
			["reviewer", "Read-only review. Do not edit files. Run git cherry-pick abc123."],
			["reviewer", "Read-only review. Do not edit files. cherry-pick abc123."],
			["reviewer", "Read-only review. Do not edit files. cherry pick abc123."],
			["reviewer", "Read-only review. Do not edit files. git branch -D old."],
			["reviewer", "Read-only review. Do not edit files. git tag -d v1.0."],
			["reviewer", "Read-only review. Do not edit files. git stash."],
			["reviewer", "Read-only review. Do not edit files. git revert abc123."],
			["reviewer", "Read-only review. Do not edit files. Stage the changed files."],
			["reviewer", "Read-only review. Do not edit files. git reset --hard"],
			["reviewer", "Read-only review. Do not edit files. git restore src/workflows/scripted-workflow.ts"],
		]) {
			const launches: string[] = [];
			await assert.rejects(
				runWorkflowScript({
					script: `
						await runs.run("writer", { agent: "worker", task: "write" });
						await runs.run("mutate", { agent: ${JSON.stringify(agent)}, task: ${JSON.stringify(task)}, acceptance: false });
					`,
					launch(key) {
						launches.push(key);
						if (key === "mutate") return Promise.resolve({ key, ok: true, output: "mutated", artifactPaths: [] });
						return Promise.resolve({
							key,
							ok: false,
							output: "saved writer report",
							error: "Acceptance rejected: malformed acceptance-report",
							runId: "writer-run",
							outputReference: recovery.reportPath,
							recovery,
							artifactPaths: [recovery.reportPath],
							results: [{ acceptance: { status: "rejected", recovery } }],
						});
					},
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /only explicit read-only review children with acceptance:false may follow/.test(error.message),
			);
			assert.deepEqual(launches, ["writer"]);
		}
	});

	it("blocks mission state writes after a durable acceptance metadata rejection", async () => {
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "a".repeat(64),
		};
		const values = new Map<string, unknown>();
		const launches: string[] = [];
		await assert.rejects(
			runWorkflowScript({
				script: `
					const writer = await runs.run("writer", { agent: "worker", task: "write" });
					await state.set("recovered.output", writer.output);
				`,
				state: {
					get: (key) => values.get(key),
					set: (key, value) => { values.set(key, value); },
				},
				launch(key) {
					launches.push(key);
					return Promise.resolve({
						key,
						ok: false,
						output: "saved writer report",
						error: "Acceptance rejected: malformed acceptance-report",
						runId: "writer-run",
						outputReference: recovery.reportPath,
						recovery,
						artifactPaths: [recovery.reportPath],
						results: [{ acceptance: { status: "rejected", recovery } }],
					});
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /Run 'state\.set\('recovered\.output'\)' cannot launch after run 'writer' returned rejected acceptance recovery/.test(error.message),
		);
		assert.deepEqual(launches, ["writer"]);
		assert.deepEqual([...values.entries()], []);
	});

	it("tags only fail-fast detached child errors as detached-child", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.run("detaches", { agent: "worker", task: "ask" });`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: false, detached: true, output: "reply first", error: "reply first", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.errorKind === "detached-child" && /Run 'detaches' detached/.test(error.message),
		);

		await assert.rejects(
			runWorkflowScript({
				script: `
					await runs.all([{ key: "detaches", agent: "worker", task: "ask" }]);
					throw new Error("manual hard failure");
				`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: false, detached: true, output: "reply first", error: "reply first", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.errorKind === undefined
				&& /manual hard failure/.test(error.message)
				&& error.partial.children[0]?.detached === true,
		);
	});

	it("validates every runs.all item before launching children", async () => {
		const malformedScripts = [
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, null]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "bad key", agent: "worker", task: "run" }]);`,
			`return await runs.all([{ key: "same", agent: "worker", task: "one" }, { key: "same", agent: "worker", task: "two" }]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "nested", workflowScript: "return null" }]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "legacy", agent: "worker", task: "run", parallel: [{ task: "nested" }] }]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "undefined-action", agent: "worker", task: "run", action: undefined }]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "uncloneable", agent: "worker", task: () => "run" }]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "bad-binding", agent: "worker", task: "run", extensionBindings: { invalid: true } }]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "bad-capacity", agent: "worker", task: "run", globalConcurrencyLimit: 2 }]);`,
			`return await runs.all([{ key: "valid", agent: "worker", task: "run" }, { key: "bad-budget", agent: "worker", task: "run", maxSubagentSpawnsPerRun: 2 }]);`,
			`const items = []; items[1] = { key: "valid", agent: "worker", task: "run" }; return await runs.all(items);`,
		];
		for (const script of malformedScripts) {
			let launches = 0;
			await assert.rejects(
				runWorkflowScript({
					script,
					timeoutMs: 2_000,
					async launch(key) { launches++; return { key, ok: true, output: "unexpected", artifactPaths: [], results: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /runs\.all|Duplicate workflow key/.test(error.message),
			);
			assert.equal(launches, 0, script);
		}
	});

	it("rejects a runs.all batch incompatible with an earlier key before dispatching the batch", async () => {
		const launches: string[] = [];
		await assert.rejects(
			runWorkflowScript({
				script: `
					await runs.run("same", { agent: "worker", task: "one" });
					return await runs.all([
						{ key: "valid", agent: "worker", task: "run" },
						{ key: "same", agent: "worker", task: "two" }
					]);
				`,
				timeoutMs: 2_000,
				async launch(key) { launches.push(key); return { key, ok: true, output: "ok", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /Duplicate workflow key 'same'/.test(error.message),
		);
		assert.deepEqual(launches, ["same"]);
	});

	it("reports host-side children in launch order", async () => {
		const result = await runWorkflowScript({
			script: `return await runs.all([
				{ key: "slow", agent: "worker", task: "slow" },
				{ key: "fast", agent: "worker", task: "fast" }
			]);`,
			timeoutMs: 2_000,
			launch(key) {
				return new Promise((resolve) => setTimeout(() => resolve({ key, ok: true, output: key, artifactPaths: [], results: [] }), key === "slow" ? 30 : 0));
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual((result.value as Array<{ key: string }>).map(({ key }) => key), ["slow", "fast"]);
		assert.deepEqual(result.children.map(({ key }) => key), ["slow", "fast"]);
	});

	it("omits undefined child result fields before a script returns them", async () => {
		const result = await runWorkflowScript({
			script: `return await runs.run("artifact-only", { agent: "worker", task: "write output" });`,
			timeoutMs: 2_000,
			async launch(key) {
				return {
					key,
					ok: true,
					output: "Saved output.",
					artifactPaths: ["/tmp/output.md"],
					results: [{ messages: undefined, savedOutputPath: "/tmp/output.md" }],
				};
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(result.value, {
			key: "artifact-only",
			ok: true,
			output: "Saved output.",
			artifactPaths: ["/tmp/output.md"],
			results: [{ savedOutputPath: "/tmp/output.md" }],
		});
	});

	it("omits undefined fields in workflow return objects", async () => {
		const result = await runWorkflowScript({
			script: `
				const children = await runs.all([{ key: "review", agent: "worker", task: "review" }]);
				return children.map((child) => ({
					key: child.key,
					status: child.status,
					output: child.output,
					values: [child.status],
				}));
			`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "completed", artifactPaths: [], results: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(result.value, [{ key: "review", output: "completed", values: [null] }]);
	});

	it("reports completed child references when return serialization fails", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `const child = await runs.run("writer", { agent: "worker", task: "write" }); return { child, invalid: new Map([["key", "value"]]) };`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, runId: "run-writer", output: "saved", outputReference: "/tmp/writer-output.md", artifactPaths: ["/tmp/writer-artifact.md"] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("return.invalid must contain only plain JSON objects")
				&& error.message.includes("Child work completed before return serialization failed")
				&& error.message.includes("'writer' (runId=run-writer, outputReference=/tmp/writer-output.md, artifact=/tmp/writer-artifact.md)")
				&& error.message.includes("Return a plain projection")
				&& error.partial.children[0]?.runId === "run-writer",
		);
	});

	it("omits non-JSON child result metadata before returning reused runs.run results", async () => {
		let launches = 0;
		const result = await runWorkflowScript({
			script: `
				const first = await runs.run("non-plain", { agent: "worker", task: "write output" });
				const reused = await runs.run("non-plain", { agent: "worker", task: "write output" });
				return [first, reused];
			`,
			timeoutMs: 2_000,
			async launch(key) {
				launches++;
				return { key, ok: true, output: "Saved output.", artifactPaths: [], results: [{ metadata: new Map([["source", "worker"]]) }] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.equal(launches, 1);
		assert.deepEqual(result.value, [
			{ key: "non-plain", ok: true, output: "Saved output.", artifactPaths: [] },
			{ key: "non-plain", ok: true, output: "Saved output.", artifactPaths: [] },
		]);
		assert.equal((result.value as Array<{ results?: unknown }>)[0]?.results, undefined);
		assert.equal((result.value as Array<{ results?: unknown }>)[1]?.results, undefined);
		assert.ok(result.children[0]?.results?.[0] && (result.children[0].results[0] as { metadata?: unknown }).metadata instanceof Map);
	});

	it("passes retained resume items and rejects agent overrides", async () => {
		let launchParams: Record<string, unknown> | undefined;
		const resumed = await runWorkflowScript({
			script: `return runs.run("continue", { resume: "retained-run", task: "Apply the follow-up" });`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launchParams = params;
				return { key, ok: true, runId: "revived-run", output: "continued", artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(launchParams, { resume: "retained-run", task: "Apply the follow-up" });
		assert.equal((resumed.value as { runId?: string }).runId, "revived-run");

		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("invalid", { resume: "retained-run", agent: "worker", task: "Override" });`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /resume and agent are mutually exclusive/.test(error.message),
		);
	});

	it("passes per-child baseRef through runs.run and runs.all", async () => {
		const launches: Array<{ key: string; baseRef: unknown }> = [];
		await runWorkflowScript({
			script: `
				const one = await runs.run("one", { agent: "worker", task: "one", baseRef: "refs/heads/release" });
				const rest = await runs.all([
					{ key: "two", agent: "worker", task: "two", baseRef: "refs/heads/topic" },
					{ key: "head", agent: "worker", task: "head", baseRef: "HEAD" },
					{ key: "default", agent: "worker", task: "default" }
				]);
				return [one.key, ...rest.map((entry) => entry.key)];
			`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, baseRef: params.baseRef });
				return { key, ok: true, output: key, artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(launches, [
			{ key: "one", baseRef: "refs/heads/release" },
			{ key: "two", baseRef: "refs/heads/topic" },
			{ key: "head", baseRef: "HEAD" },
			{ key: "default", baseRef: undefined },
		]);
	});

	it("rejects unsupported literal and computed child baseRef values before dispatch", async () => {
		const launches: string[] = [];
		for (const [call, expression] of [
			["run", JSON.stringify("a".repeat(40))],
			["all", JSON.stringify("A".repeat(64))],
			["run", '"a".repeat(64)'],
			["all", '"A".repeat(40)'],
			["run", '"HEAD" + "~1"'],
			["all", '"@"'],
			["run", "42"],
		]) {
			const script = call === "run"
				? `return runs.run("invalid", { agent: "worker", task: "Check", baseRef: ${expression} });`
				: `return runs.all([{ key: "valid", agent: "worker", task: "Check", baseRef: "HEAD" }, { key: "invalid", agent: "worker", task: "Check", baseRef: ${expression} }]);`;
			if (expression.includes("repeat") || expression.includes(" + ")) {
				assert.deepEqual(validateWorkflowScript(script), { ok: true, errors: [] });
			}
			await assert.rejects(
				runWorkflowScript({
					script,
					timeoutMs: 2_000,
					async launch(key) {
						launches.push(key);
						return { key, ok: true, output: key, artifactPaths: [], results: [] };
					},
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError
					&& /baseRef.*HEAD.*named ref.*40\/64-character commit IDs.*revision expressions.*unsupported/.test(error.message),
			);
		}
		assert.deepEqual(launches, []);
	});

	it("leaves accessor-derived baseRef values to runtime validation", async () => {
		for (const baseRef of ["HEAD", "HEAD~1"]) {
			const script = `return runs.run("child", { agent: "worker", task: "Check", baseRef: "invalid..ref", get baseRef() { return ${JSON.stringify(baseRef)}; } });`;
			assert.deepEqual(validateWorkflowScript(script), { ok: true, errors: [] });
			const launches: unknown[] = [];
			const result = runWorkflowScript({
				script,
				timeoutMs: 2_000,
				async launch(key, params) {
					launches.push(params.baseRef);
					return { key, ok: true, output: key, artifactPaths: [] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			});
			if (baseRef === "HEAD") {
				await result;
				assert.deepEqual(launches, ["HEAD"]);
			} else {
				await assert.rejects(result, /baseRef.*revision expressions.*unsupported/);
				assert.deepEqual(launches, []);
			}
		}
	});

	it("passes per-child workflow controls through runs.run and runs.all", async () => {
		const launches: Array<{ key: string; worktree: unknown; control: unknown }> = [];
		await runWorkflowScript({
			script: `
				const one = await runs.run("one", { agent: "worker", task: "one", worktree: true, control: { needsAttentionAfterMs: 111 } });
				const rest = await runs.all([
					{ key: "two", agent: "worker", task: "two", worktree: true, control: { activeNoticeAfterMs: 222 } },
					{ key: "three", agent: "reviewer", task: "three", worktree: false, control: { enabled: false } }
				]);
				return [one.key, ...rest.map((entry) => entry.key)];
			`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, worktree: params.worktree, control: params.control });
				return { key, ok: true, output: key, artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(launches, [
			{ key: "one", worktree: true, control: { needsAttentionAfterMs: 111 } },
			{ key: "two", worktree: true, control: { activeNoticeAfterMs: 222 } },
			{ key: "three", worktree: false, control: { enabled: false } },
		]);
	});

	it("validates bounded lane metadata and passes it to child launch", async () => {
		const launches: Array<{ key: string; lane: unknown }> = [];
		await runWorkflowScript({
			script: `return runs.run("writer", { agent: "worker", task: "write", lane: { version: 1, key: "writer", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["src/shared/types.ts"], outputPaths: ["reports/writer.md"] } });`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, lane: params.lane });
				return { key, ok: true, output: key, artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(launches, [{ key: "writer", lane: { version: 1, key: "writer", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["src/shared/types.ts"], outputPaths: ["reports/writer.md"] } }]);

		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("writer", { agent: "worker", task: "write", lane: { version: 1, key: "other" } });`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /must match workflow key/.test(error.message),
		);
	});

	it("passes distinct namespaced bindings to parallel children", async () => {
		const launches: Array<{ key: string; bindings: unknown }> = [];
		await runWorkflowScript({
			script: `return runs.all([
				{ key: "coder", agent: "worker", task: "code", extensionBindings: { "shepherd.dispatch/1": { role: "coder" } } },
				{ key: "reviewer", agent: "reviewer", task: "review", extensionBindings: { "shepherd.dispatch/1": { role: "reviewer" } } }
			]);`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, bindings: params.extensionBindings });
				return { key, ok: true, output: key, artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(launches, [
			{ key: "coder", bindings: { "shepherd.dispatch/1": { role: "coder" } } },
			{ key: "reviewer", bindings: { "shepherd.dispatch/1": { role: "reviewer" } } },
		]);
	});

	it("composes dynamic sequential and parallel phases with per-child controls", async () => {
		const launches: Array<{ key: string; agent: unknown; task: unknown; worktree: unknown }> = [];
		const result = await runWorkflowScript({
			script: `
				const plan = await runs.run("plan", { agent: "planner", task: "plan", worktree: true });
				const targets = ["api", "ui"];
				const built = await runs.all(targets.map((target) => ({
					key: "build-" + target,
					agent: "worker",
					task: plan.output + ":" + target,
					worktree: true
				})));
				const review = await runs.run("review", {
					agent: "reviewer",
					task: built.map((child) => child.key).join(","),
					worktree: false
				});
				return { plan: plan.key, built: built.map((child) => child.key), review: review.key };
			`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, agent: params.agent, task: params.task, worktree: params.worktree });
				return { key, ok: true, output: key, artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(result.value, { plan: "plan", built: ["build-api", "build-ui"], review: "review" });
		assert.deepEqual(launches, [
			{ key: "plan", agent: "planner", task: "plan", worktree: true },
			{ key: "build-api", agent: "worker", task: "plan:api", worktree: true },
			{ key: "build-ui", agent: "worker", task: "plan:ui", worktree: true },
			{ key: "review", agent: "reviewer", task: "build-api,build-ui", worktree: false },
		]);
	});

	it("rejects legacy orchestration params in runs.run", async () => {
		for (const params of [`tasks: [{ agent: "scout", task: "scan" }]`, `parallel: [{ agent: "scout", task: "scan" }]`, `globalConcurrencyLimit: 2`, `maxSubagentSpawnsPerRun: 2`]) {
			let launches = 0;
			await assert.rejects(
				runWorkflowScript({
					script: `return await runs.run("legacy", { ${params} });`,
					timeoutMs: 2_000,
					launch: async () => { launches++; return { ok: true, output: "unexpected" }; },
					status: async () => ({ ok: true, output: "unused" }),
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /accepts one child.*runs\.all/i.test(error.message),
			);
			assert.equal(launches, 0);
		}
	});

	it("rejects clarify UI on workflow children", async () => {
		let launches = 0;
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("clarify", { agent: "worker", task: "Review", clarify: true });`,
				timeoutMs: 2_000,
				launch: async () => { launches++; return { ok: true, output: "unexpected" }; },
				status: async () => ({ ok: true, output: "unused" }),
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /does not support clarify UI/.test(error.message),
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

	it("validates runs.steer input before calling the host", async () => {
		for (const script of [
			`return runs.steer("bad key", "guide");`,
			`return runs.steer("writer", " ");`,
			`return runs.steer("writer", "guide", { mode: "later" });`,
			`return runs.steer("writer", "guide", { index: -1 });`,
			`return runs.steer("writer", "guide", { ackTimeoutMs: 0 });`,
			`return runs.steer("writer", "guide", { runId: "raw-id" });`,
		]) {
			let steerCalls = 0;
			await assert.rejects(
				runWorkflowScript({
					script,
					async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
					async steer(key) { steerCalls++; return { key, state: "delivered" }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && /runs\.steer/.test(error.message),
			);
			assert.equal(steerCalls, 0);
		}
	});

	it("steers a still-running sibling after Promise.race and awaits both children", async () => {
		let resolveSlow!: (result: { key: string; ok: true; output: string; artifactPaths: never[] }) => void;
		const result = await runWorkflowScript({
			script: `
				const fast = runs.run("fast", { agent: "worker", task: "fast" });
				const slow = runs.run("slow", { agent: "worker", task: "slow" });
				const first = await Promise.race([fast, slow]);
				const receipt = await runs.steer("slow", "Focus on tests.", { mode: "auto", index: 0, ackTimeoutMs: 100 });
				const children = await Promise.all([fast, slow]);
				return { first: first.key, receipt, children: children.map((child) => child.key) };
			`,
			launch(key) {
				if (key === "fast") return Promise.resolve({ key, ok: true, output: "fast", artifactPaths: [] });
				return new Promise((resolve) => { resolveSlow = resolve; });
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			async steer(key, message, options) {
				assert.equal(key, "slow");
				assert.equal(message, "Focus on tests.");
				assert.deepEqual(options, { mode: "auto", index: 0, ackTimeoutMs: 100 });
				resolveSlow({ key, ok: true, output: "slow", artifactPaths: [] });
				return { key, state: "delivered", requestId: "request-1", deliveryStatus: "delivered", targets: [{ index: 0, state: "delivered" }] };
			},
		});

		assert.deepEqual(result.value, {
			first: "fast",
			receipt: { key: "slow", state: "delivered", requestId: "request-1", deliveryStatus: "delivered", targets: [{ index: 0, state: "delivered" }] },
			children: ["fast", "slow"],
		});
		assert.deepEqual(result.trace.filter((entry) => entry.operation === "steer").map(({ state }) => state), ["started", "delivered"]);
	});

	it("uses Promise.race to roll through child completions and steer the remaining work", async () => {
		let resolveBeta!: (result: { key: string; ok: true; output: string; artifactPaths: never[] }) => void;
		let resolveGamma!: (result: { key: string; ok: true; output: string; artifactPaths: never[] }) => void;
		const result = await runWorkflowScript({
			script: `
				let pending = [
					{ key: "alpha", promise: runs.run("alpha", { agent: "worker", task: "alpha" }).then((result) => ({ key: "alpha", result })) },
					{ key: "beta", promise: runs.run("beta", { agent: "worker", task: "beta" }).then((result) => ({ key: "beta", result })) },
					{ key: "gamma", promise: runs.run("gamma", { agent: "worker", task: "gamma" }).then((result) => ({ key: "gamma", result })) },
				];
				const first = await Promise.race(pending.map((child) => child.promise));
				pending = pending.filter((child) => child.key !== first.key);
				const target = pending.find((child) => child.key === "gamma") ?? pending[0];
				const receipt = await runs.steer(target.key, "Challenge the first result: " + first.result.output, { mode: "auto", ackTimeoutMs: 100 });
				const second = await Promise.race(pending.map((child) => child.promise));
				pending = pending.filter((child) => child.key !== second.key);
				const rest = await Promise.all(pending.map((child) => child.promise));
				return { first: first.key, second: second.key, rest: rest.map((child) => child.key), receipt };
			`,
			launch(key) {
				if (key === "alpha") return Promise.resolve({ key, ok: true, output: "alpha done", artifactPaths: [] });
				if (key === "beta") return new Promise((resolve) => { resolveBeta = resolve; });
				return new Promise((resolve) => { resolveGamma = resolve; });
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			async steer(key, message, options) {
				assert.equal(key, "gamma");
				assert.equal(message, "Challenge the first result: alpha done");
				assert.deepEqual(options, { mode: "auto", ackTimeoutMs: 100 });
				resolveGamma({ key, ok: true, output: "gamma done", artifactPaths: [] });
				setTimeout(() => resolveBeta({ key: "beta", ok: true, output: "beta done", artifactPaths: [] }), 5);
				return { key, state: "delivered", requestId: "request-rolling", deliveryStatus: "delivered", targets: [{ index: 0, state: "delivered" }] };
			},
		});

		assert.deepEqual(result.value, {
			first: "alpha",
			second: "gamma",
			rest: ["beta"],
			receipt: { key: "gamma", state: "delivered", requestId: "request-rolling", deliveryStatus: "delivered", targets: [{ index: 0, state: "delivered" }] },
		});
		assert.deepEqual(result.children.map((child) => child.key), ["alpha", "beta", "gamma"]);
		assert.deepEqual(result.trace.filter((entry) => entry.operation === "run" && entry.state === "completed").map((entry) => entry.key), ["alpha", "gamma", "beta"]);
		assert.deepEqual(result.trace.filter((entry) => entry.operation === "steer").map(({ key, state }) => ({ key, state })), [{ key: "gamma", state: "started" }, { key: "gamma", state: "delivered" }]);
	});

	it("waits for and rejects an unawaited runs.steer side effect", async () => {
		let steerSettled = false;
		await assert.rejects(
			runWorkflowScript({
				script: `await runs.run("writer", { agent: "worker", task: "work" }); runs.steer("writer", "Checkpoint."); return "done";`,
				async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async steer(key) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					steerSettled = true;
					return { key, state: "queued" };
				},
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("unawaited runs.steer call(s): 'writer'")
				&& error.partial.trace.some((entry) => entry.operation === "steer" && entry.state === "queued"),
		);
		assert.equal(steerSettled, true);
	});

	it("rejects an unawaited runs.steer host-invariant failure", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `runs.steer("missing", "Checkpoint."); return "done";`,
				async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async steer(key) { return { key, state: "delivered" }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& (error.message.includes("unawaited runs.steer call(s): 'missing'") || error.message.includes("runs.steer('missing') requires a prior runs.run/runs.all launch with that key"))
				&& error.partial.trace.some((entry) => entry.operation === "steer" && entry.state === "failed"),
		);
	});

	it("rejects and aborts an unawaited child launch when the script completes", async () => {
		let childAborted = false;
		await assert.rejects(
			runWorkflowScript({
				script: `runs.run("bg", { agent: "worker", task: "fire and forget" }); return "done";`,
				timeoutMs: 2_000,
				launch(_key, _params, signal) {
					return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
						childAborted = true;
						reject(signal.reason);
					}, { once: true }));
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("unawaited runs.run launch(es): 'bg'")
				&& error.message.includes("await runs.all([{key, agent, task}, ...])"),
		);
		assert.equal(childAborted, true);
	});

	it("rejects an unawaited child launch that settles before the script completes", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `runs.run("fast", { agent: "worker", task: "quick" }); await runs.status("probe"); return "done";`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "fast output", artifactPaths: [] }; },
				async status(key) {
					await Promise.resolve();
					return { key, ok: true, output: "ok", artifactPaths: [] };
				},
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("unawaited runs.run launch(es): 'fast'")
				&& error.partial.children.some((child) => child.key === "fast"),
		);
	});

	it("rejects an unawaited runs.all launch group", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `runs.all([{ key: "a", agent: "worker", task: "one" }]); return "done";`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.message.includes("unawaited runs.run launch(es): 'a'"),
		);
	});

	it("rejects an unawaited runs.lanes launch", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `runs.lanes([{ key: "lane", stages: [{ key: "writer", agent: "worker", task: "write" }] }]); return "done";`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "done", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.message.includes("unawaited runs.run launch(es): 'lane.writer'"),
		);
	});

	it("rejects an unawaited native Promise.all over runs.run", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `Promise.all([runs.run("native", { agent: "worker", task: "one" })]); return "done";`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.message.includes("unawaited runs.run launch(es): 'native'"),
		);
	});

	it("rejects an unawaited new Promise wrapper over runs.run", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `new Promise((resolve) => resolve(runs.run("wrapped", { agent: "worker", task: "fire" }))); return "done";`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.message.includes("unawaited runs.run launch(es): 'wrapped'"),
		);
	});

	it("rejects nested async helper syntax for portable workflow parity", async () => {
		const scripts = [
			`async function helper() { return runs.run("async-function", { agent: "worker", task: "run" }); } const child = await helper(); return child.output;`,
			`const helper = async () => runs.run("async-arrow", { agent: "worker", task: "run" }); const child = await helper(); return child.output;`,
			`const helpers = { async scan() { return runs.run("async-method", { agent: "worker", task: "run" }); } }; return helpers.scan();`,
			`const helpers = { async ["scan"]() { return runs.run("async-computed-method", { agent: "worker", task: "run" }); } }; helpers.scan(); return "done";`,
		];
		for (const script of scripts) {
			await assert.rejects(
				runWorkflowScript({
					script,
					timeoutMs: 2_000,
					async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError
					&& error.message.includes("does not support nested async functions")
					&& error.partial.children.length === 0,
			);
		}
	});

	it("rejects nested async helpers before launching children", async () => {
		let launches = 0;
		await assert.rejects(
			runWorkflowScript({
				script: `async function patchLane(key) { const writer = await runs.run(key, { agent: "worker", task: "write" }); return runs.run(key + "-review", { agent: "reviewer", task: writer.output }); } await Promise.all([patchLane("lane")]);`,
				timeoutMs: 2_000,
				async launch(key) {
					launches++;
					return { key, ok: true, output: "unexpected", artifactPaths: [] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("does not support nested async functions")
				&& error.message.includes("validation failed before child launch; no children launched")
				&& error.message.includes("Parallel plus sequential rewrite")
				&& error.message.includes("const [aResult] = await Promise.all([a])")
				&& error.partial.children.length === 0,
		);
		assert.equal(launches, 0);
	});

	it("ignores async-looking text in regex literals", async () => {
		const result = await runWorkflowScript({
			script: [
				`const pattern = /async function helper/;`,
				`if (true) /async function helper/.test("async function helper");`,
				`if (true) /* comment */ /async function helper/.test("async function helper");`,
				`const inResult = "async function helper" in /async function helper/;`,
				`const inBlockComment = "async function helper" in /* comment */ /async function helper/;`,
				`const inLineComment = "async function helper" in // comment`,
				`/async function helper/;`,
				`let instanceResult = false;`,
				`try { instanceResult = {} instanceof /* comment */ /async function helper/; } catch {}`,
				`function helper() { return runs.run("regex-text", { agent: "worker", task: "run" }); }`,
				`const child = await helper();`,
				`return pattern.test("async function helper") && !inResult && !inBlockComment && !inLineComment && !instanceResult ? child.output : "missing";`,
			].join("\n"),
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "regex output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "regex output");
	});

	it("rejects nested async helper syntax inside template expressions", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: "const value = `${(async () => runs.run(\"template-async\", { agent: \"worker\", task: \"run\" }))()}`; return value;",
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "unexpected", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("does not support nested async functions")
				&& error.partial.children.length === 0,
		);
	});

	it("accepts portable plain helper wrappers over runs.run", async () => {
		const result = await runWorkflowScript({
			script: `function helper() { return runs.run("plain-helper", { agent: "worker", task: "run" }); } const child = await helper(); return child.output;`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "helper output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "helper output");
	});

	it("accepts Promise.all over a portable plain helper wrapper", async () => {
		const result = await runWorkflowScript({
			script: `function helper() { return runs.run("plain-helper-all", { agent: "worker", task: "run" }); } const children = await Promise.all([helper()]); return children[0].output;`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "helper all output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "helper all output");
	});

	it("accepts awaited Promise.all over then chains that return child launches", async () => {
		const result = await runWorkflowScript({
			script: `
				function patchLane(key) {
					return runs.run(key + "-writer", { agent: "worker", task: "write " + key })
						.then((writer) => runs.run(key + "-review", { agent: "reviewer", task: "review " + writer.output }));
				}
				const reviews = await Promise.all([patchLane("alpha"), patchLane("beta")]);
				return reviews.map((review) => review.key);
			`,
			timeoutMs: 2_000,
			async launch(key, params) {
				if (key.endsWith("-review")) assert.match(String(params.task), /review .* writer output/);
				return { key, ok: true, output: key + " writer output", artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(result.value, ["alpha-review", "beta-review"]);
		assert.deepEqual(result.children.map((child) => child.key), ["alpha-writer", "beta-writer", "alpha-review", "beta-review"]);
	});

	it("accepts awaited and returned handlers on portable plain helper wrappers", async () => {
		const handlers = [
			{ name: "then", chain: "then((value) => value)" },
			{ name: "catch", chain: "catch(() => ({ output: 'fallback' }))" },
			{ name: "finally", chain: "finally(() => {})" },
		];
		for (const mode of ["await", "return"] as const) {
			for (const { name, chain } of handlers) {
				const key = `${mode}-${name}`;
				const expression = `helper().${chain}`;
				const result = await runWorkflowScript({
					script: `function helper() { return runs.run("${key}", { agent: "worker", task: "run" }); } ${mode === "await" ? `const child = await ${expression}; return child.output;` : `return ${expression};`}`,
					timeoutMs: 2_000,
					async launch(key) { return { key, ok: true, output: "helper chain output", artifactPaths: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				});
				assert.equal(mode === "await" ? result.value : (result.value as { output: string }).output, "helper chain output");
			}
		}
	});

	it("accepts awaited and returned nested plain helper wrappers", async () => {
		for (const mode of ["await", "return"] as const) {
			const key = `nested-${mode}`;
			const result = await runWorkflowScript({
				script: `function inner() { return runs.run("${key}", { agent: "worker", task: "run" }); } function outer() { return inner(); } ${mode === "await" ? "const child = await outer(); return child.output;" : "return outer();"}`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "nested output", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			});
			assert.equal(mode === "await" ? result.value : (result.value as { output: string }).output, "nested output");
		}
	});

	it("rejects a launch passed to an ignored repeated Promise resolution", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `
				await new Promise((resolve) => {
					resolve("done");
					Promise.resolve().then(() => resolve(runs.run("ignored", { agent: "worker", task: "fire" })));
				});
				return "done";
			`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.message.includes("unawaited runs.run launch(es): 'ignored'"),
		);
	});

	it("rejects fire-and-forget callbacks on a runs.run promise", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `runs.run("bg", { agent: "worker", task: "fire" }).then(() => {}); return "done";`,
				timeoutMs: 2_000,
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.message.includes("unawaited runs.run launch(es): 'bg'"),
		);
	});

	it("rejects detached promise handlers after an await", async () => {
		const handlers = [
			{ key: "bg-then", chain: "then(() => {})" },
			{ key: "bg-catch", chain: "catch(() => {})" },
			{ key: "bg-finally", chain: "finally(() => {})" },
		];
		for (const { key, chain } of handlers) {
			await assert.rejects(
				runWorkflowScript({
					script: `await Promise.resolve(); runs.run("${key}", { agent: "worker", task: "fire" }).${chain}; return "done";`,
					timeoutMs: 2_000,
					async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
					async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				}),
				(error: unknown) => error instanceof WorkflowScriptError && error.message.includes(`unawaited runs.run launch(es): '${key}'`),
			);
		}
	});

	it("rejects reading output from an unawaited runs.run promise", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("x", { agent: "worker", task: "run" }).output;`,
				timeoutMs: 2_000,
				launch(_key, _params, signal) {
					return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("unawaited runs.run launch(es): 'x'")
				&& error.message.includes("do not read .output from unawaited launches"),
		);
	});

	it("names every outstanding workflow launch", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `runs.run("first", { agent: "worker", task: "one" }); runs.run("second", { agent: "worker", task: "two" }); return null;`,
				timeoutMs: 2_000,
				launch(_key, _params, signal) {
					return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message.includes("'first', 'second'")
				&& error.partial.children.length === 0,
		);
	});

	it("accepts a directly returned runs.run promise", async () => {
		const result = await runWorkflowScript({
			script: `return runs.run("direct", { agent: "worker", task: "run" });`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "direct output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal((result.value as { output?: string }).output, "direct output");
	});

	it("accepts a docs-style awaited runs.run launch", async () => {
		const result = await runWorkflowScript({
			script: `const child = await runs.run("awaited", { agent: "worker", task: "run" }); return child.output;`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "awaited output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "awaited output");
	});

	it("accepts a docs-style awaited runs.all launch group", async () => {
		const result = await runWorkflowScript({
			script: `const children = await runs.all([{ key: "one", agent: "worker", task: "run" }]); return children[0].output;`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "group output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "group output");
	});

	it("accepts sequential awaited launches that use the first output", async () => {
		const tasks: unknown[] = [];
		const result = await runWorkflowScript({
			script: `
				const first = await runs.run("first", { agent: "worker", task: "plan" });
				const second = await runs.run("second", { agent: "worker", task: first.output });
				return second.output;
			`,
			timeoutMs: 2_000,
			async launch(key, params) {
				tasks.push(params.task);
				return { key, ok: true, output: key === "first" ? "first output" : "second output", artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(tasks, ["plan", "first output"]);
		assert.equal(result.value, "second output");
	});

	it("accepts an awaited native Promise combinator over launches", async () => {
		const result = await runWorkflowScript({
			script: `const children = await Promise.all([runs.run("native", { agent: "worker", task: "run" })]); return children[0].output;`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "native output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "native output");
	});

	it("accepts Promise.resolve over a pending helper wrapper", async () => {
		const result = await runWorkflowScript({
			script: `
				const helper = new Promise((resolve) => Promise.resolve().then(() =>
					resolve(runs.run("resolve-helper", { agent: "worker", task: "run" }))
				));
				const child = await Promise.resolve(helper);
				return child.output;
			`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "resolved helper output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "resolved helper output");
	});

	it("accepts Promise.all over a pending helper wrapper", async () => {
		const result = await runWorkflowScript({
			script: `
				const helper = new Promise((resolve) => Promise.resolve().then(() =>
					resolve(runs.run("combo-later", { agent: "worker", task: "run" }))
				));
				const children = await Promise.all([helper]);
				return children[0].output;
			`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "pending helper output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "pending helper output");
	});

	it("accepts an awaited then chain over a pending helper wrapper", async () => {
		const result = await runWorkflowScript({
			script: `
				const helper = new Promise((resolve) => Promise.resolve().then(() =>
					resolve(runs.run("chain-later", { agent: "worker", task: "run" }))
				));
				const child = await helper.then((value) => value);
				return child.output;
			`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "chain output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "chain output");
	});

	it("accepts an awaited new Promise wrapper over runs.run", async () => {
		const result = await runWorkflowScript({
			script: `const child = await new Promise((resolve) => resolve(runs.run("wrapped", { agent: "worker", task: "run" }))); return child.output;`,
			timeoutMs: 2_000,
			async launch(key) { return { key, ok: true, output: "wrapped output", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.equal(result.value, "wrapped output");
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
			`const value = {}; value[Symbol("hidden")] = true; return value;`,
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

	it("flushes result assembly after abort when every child is terminal", async () => {
		const controller = new AbortController();
		let launchCount = 0;
		const result = await runWorkflowScript({
			script: `const child = await runs.run("done", { agent: "worker", task: "finish" }); return { phase: "assembled", output: child.output };`,
			signal: controller.signal,
			continueAfterAbortWhenChildrenSettled: (error) => error.message === "Workflow stopped because the extension session was replaced or reloaded.",
			onTrace(trace) {
				if (!controller.signal.aborted && trace.some((entry) => entry.operation === "run" && entry.key === "done" && entry.state === "completed")) controller.abort(new Error("Workflow stopped because the extension session was replaced or reloaded."));
			},
			async launch(key) {
				launchCount += 1;
				return { key, ok: true, output: "child output", artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.deepEqual(result.value, { phase: "assembled", output: "child output" });
		assert.equal(launchCount, 1);
	});

	it("fails closed with diagnostics when graceful-abort eligibility throws", async () => {
		const controller = new AbortController();
		await assert.rejects(
			runWorkflowScript({
				script: `await runs.run("done", { agent: "worker", task: "finish" }); return { phase: "assembled" };`,
				signal: controller.signal,
				continueAfterAbortWhenChildrenSettled: () => { throw new Error("liveness unavailable"); },
				onTrace(trace) {
					if (!controller.signal.aborted && trace.some((entry) => entry.operation === "run" && entry.key === "done" && entry.state === "completed")) controller.abort(new Error("Workflow stopped because the extension session was replaced or reloaded."));
				},
				async launch(key) {
					return { key, ok: true, output: "child output", artifactPaths: [], results: [] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /liveness unavailable/.test(error.message),
		);
	});

	it("fails closed if assembly tries to launch after a graceful abort", async () => {
		const controller = new AbortController();
		let launchCount = 0;
		await assert.rejects(
			runWorkflowScript({
				script: `await runs.run("done", { agent: "worker", task: "finish" }); return runs.run("late", { agent: "worker", task: "must not launch" });`,
				signal: controller.signal,
				continueAfterAbortWhenChildrenSettled: (error) => error.message === "Workflow stopped because the extension session was replaced or reloaded.",
				onTrace(trace) {
					if (!controller.signal.aborted && trace.some((entry) => entry.operation === "run" && entry.key === "done" && entry.state === "completed")) controller.abort(new Error("Workflow stopped because the extension session was replaced or reloaded."));
				},
				async launch(key) {
					launchCount += 1;
					return { key, ok: true, output: "child output", artifactPaths: [], results: [] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && error.message === "Workflow stopped because the extension session was replaced or reloaded.",
		);
		assert.equal(launchCount, 1);
	});

	it("ignores a queued child launch message after workflow abort", async () => {
		const originalOn = Worker.prototype.on;
		const controller = new AbortController();
		let launchCount = 0;
		let deliverCapturedRunMessage: (() => void) | undefined;
		let markRunMessageCaptured!: () => void;
		const runMessageCaptured = new Promise<void>((resolve) => { markRunMessageCaptured = resolve; });

		(Worker.prototype as unknown as { on: typeof Worker.prototype.on }).on = function (event: string | symbol, listener: (...args: unknown[]) => void) {
			if (event !== "message") return originalOn.call(this, event, listener);
			const wrapped = (message: Record<string, unknown>) => {
				if (message.type === "call" && message.method === "run") {
					deliverCapturedRunMessage = () => listener.call(this, message);
					markRunMessageCaptured();
					return;
				}
				listener.call(this, message);
			};
			return originalOn.call(this, event, wrapped);
		};

		try {
			const workflow = runWorkflowScript({
				script: `await runs.run("late", { agent: "worker", task: "wait" });`,
				signal: controller.signal,
				async launch(key) {
					launchCount += 1;
					return { key, ok: true, output: "too late", artifactPaths: [] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			});

			await runMessageCaptured;
			controller.abort(new Error("Workflow stopped by user."));
			await assert.rejects(workflow, (error: unknown) => error instanceof WorkflowScriptError && error.message === "Workflow stopped by user.");
			deliverCapturedRunMessage?.();
			await new Promise((resolve) => queueMicrotask(resolve));
			assert.equal(launchCount, 0);
		} finally {
			Worker.prototype.on = originalOn;
		}
	});

	it("marks a child stopped when abort fires during the started trace callback", async () => {
		const controller = new AbortController();
		let admitCount = 0;
		let launchCount = 0;

		await assert.rejects(
			runWorkflowScript({
				script: `await runs.run("slow", { agent: "worker", task: "wait" });`,
				signal: controller.signal,
				onTrace(trace) {
					const started = trace.some((entry) => entry.operation === "run" && entry.key === "slow" && entry.state === "started");
					if (started && !controller.signal.aborted) controller.abort(new Error("Workflow stopped by user."));
				},
				admit() {
					admitCount += 1;
				},
				async launch(key) {
					launchCount += 1;
					return { key, ok: true, output: "done", artifactPaths: [] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message === "Workflow stopped by user."
				&& error.partial.trace.some((entry) => entry.operation === "run" && entry.key === "slow" && entry.state === "stopped")
				&& !error.partial.trace.some((entry) => entry.operation === "run" && entry.key === "slow" && entry.state === "failed"),
		);
		await new Promise((resolve) => queueMicrotask(resolve));
		assert.equal(admitCount, 0);
		assert.equal(launchCount, 0);
	});

	it("does not launch a child after admission settles following workflow abort", async () => {
		const controller = new AbortController();
		let launchCount = 0;
		let resolveAdmission!: () => void;
		let markAdmissionStarted!: () => void;
		const admissionStarted = new Promise<void>((resolve) => { markAdmissionStarted = resolve; });

		const workflow = runWorkflowScript({
			script: `await runs.run("slow", { agent: "worker", task: "wait" });`,
			signal: controller.signal,
			admit() {
				markAdmissionStarted();
				return new Promise<void>((resolve) => { resolveAdmission = resolve; });
			},
			async launch(key) {
				launchCount += 1;
				return { key, ok: true, output: "done", artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		await admissionStarted;
		controller.abort(new Error("Workflow stopped by user."));
		await assert.rejects(workflow, (error: unknown) => error instanceof WorkflowScriptError
			&& error.message === "Workflow stopped by user."
			&& error.partial.trace.some((entry) => entry.operation === "run" && entry.key === "slow" && entry.state === "stopped")
			&& !error.partial.trace.some((entry) => entry.operation === "run" && entry.key === "slow" && entry.state === "failed"));
		resolveAdmission();
		await new Promise((resolve) => queueMicrotask(resolve));
		assert.equal(launchCount, 0);
	});

	it("drops a child response that settles after the workflow aborts", async () => {
		const workerPrototype = Worker.prototype as unknown as { postMessage(value: unknown, ...args: unknown[]): void };
		const originalPostMessage = workerPrototype.postMessage;
		const controller = new AbortController();
		let workflowSettled = false;
		let postSettlementResponses = 0;
		let resolveLaunch!: (result: { key: string; ok: true; output: string; artifactPaths: string[]; results: never[] }) => void;
		let markLaunchStarted!: () => void;
		const launchStarted = new Promise<void>((resolve) => { markLaunchStarted = resolve; });
		workerPrototype.postMessage = function (value, ...args) {
			if (workflowSettled && typeof value === "object" && value !== null && "type" in value && value.type === "response") postSettlementResponses++;
			originalPostMessage.call(this, value, ...args);
		};

		try {
			const workflow = runWorkflowScript({
				script: `await runs.run("slow", { agent: "worker", task: "wait" });`,
				signal: controller.signal,
				launch() {
					markLaunchStarted();
					return new Promise((resolve) => { resolveLaunch = resolve; });
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			});
			await launchStarted;
			controller.abort(new Error("Workflow stopped by user."));
			await assert.rejects(workflow, (error: unknown) => error instanceof WorkflowScriptError
				&& error.message === "Workflow stopped by user."
				&& error.partial.trace.some((entry) => entry.operation === "run" && entry.key === "slow" && entry.state === "stopped" && entry.error === "Workflow stopped by user.")
				&& !error.partial.trace.some((entry) => entry.operation === "run" && entry.key === "slow" && entry.state === "failed"));
			workflowSettled = true;
			resolveLaunch({ key: "slow", ok: true, output: "done", artifactPaths: [], results: [] });
			await new Promise((resolve) => queueMicrotask(resolve));
			assert.equal(postSettlementResponses, 0);
		} finally {
			workerPrototype.postMessage = originalPostMessage;
		}
	});

	it("does not dispatch status after abort fires during the status started trace callback", async () => {
		const controller = new AbortController();
		let statusCount = 0;

		await assert.rejects(
			runWorkflowScript({
				script: `await runs.status("probe");`,
				signal: controller.signal,
				onTrace(trace) {
					const started = trace.some((entry) => entry.operation === "status" && entry.key === "probe" && entry.state === "started");
					if (started && !controller.signal.aborted) controller.abort(new Error("Workflow stopped by user."));
				},
				async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
				async status(key) {
					statusCount += 1;
					return { key, ok: true, output: "done", artifactPaths: [] };
				},
			}),
			(error: unknown) => error instanceof WorkflowScriptError
				&& error.message === "Workflow stopped by user."
				&& error.partial.trace.some((entry) => entry.operation === "status" && entry.key === "probe" && entry.state === "started")
				&& !error.partial.trace.some((entry) => entry.operation === "status" && entry.key === "probe" && entry.state === "completed"),
		);
		await new Promise((resolve) => queueMicrotask(resolve));
		assert.equal(statusCount, 0);
	});

	it("drops a status response that settles after the workflow aborts", async () => {
		const controller = new AbortController();
		let traceLengths: number[] = [];
		let resolveStatus!: (result: { key: string; ok: true; output: string; artifactPaths: string[] }) => void;
		let markStatusStarted!: () => void;
		const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });

		const workflow = runWorkflowScript({
			script: `await runs.status("probe");`,
			signal: controller.signal,
			onTrace(trace) { traceLengths.push(trace.length); },
			async launch(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			status(key) {
				markStatusStarted();
				return new Promise((resolve) => { resolveStatus = resolve; });
			},
		});

		await statusStarted;
		controller.abort(new Error("Workflow stopped by user."));
		await assert.rejects(workflow, (error: unknown) => error instanceof WorkflowScriptError
			&& error.message === "Workflow stopped by user."
			&& error.partial.trace.some((entry) => entry.operation === "status" && entry.key === "probe" && entry.state === "started")
			&& !error.partial.trace.some((entry) => entry.operation === "status" && entry.key === "probe" && entry.state === "completed"));
		const finalTraceLength = traceLengths.at(-1);
		resolveStatus({ key: "probe", ok: true, output: "done", artifactPaths: [] });
		await new Promise((resolve) => queueMicrotask(resolve));
		assert.equal(traceLengths.at(-1), finalTraceLength);
	});

	it("keeps every child alive when a host trace callback throws", async () => {
		// Regression: hosts persist a status journal from onTrace, and onTrace is called
		// from inside the run-promise handlers. A failed status write used to reject the
		// child promise, so one locked status.json marked a finished child failed and
		// aborted its still-running siblings through Promise.all inside runs.all.
		let thrown = 0;
		const abortedWhileRunning: string[] = [];
		const result = await runWorkflowScript({
			script: `return await runs.all([{ key: "a", agent: "worker", task: "one" }, { key: "b", agent: "worker", task: "two" }, { key: "c", agent: "worker", task: "three" }]);`,
			timeoutMs: 5_000,
			onTrace(trace) {
				if (thrown === 0 && trace.some((entry) => entry.operation === "run" && entry.state === "completed")) {
					thrown += 1;
					throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
				}
			},
			async launch(key, _params, signal) {
				if (key !== "a") await new Promise((resolve) => setTimeout(resolve, 10));
				if (signal?.aborted) abortedWhileRunning.push(key);
				return { key, ok: true, output: `${key} done`, artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});

		assert.equal(thrown, 1, "the trace callback should have thrown once");
		assert.deepEqual(abortedWhileRunning, [], "no sibling should be aborted by a journal failure");
		const children = result.value as Array<{ key: string; ok: boolean }>;
		assert.deepEqual(children.map((child) => child.key), ["a", "b", "c"]);
		assert.ok(children.every((child) => child.ok), "every child should still report success");
		assert.equal(result.children.filter((child) => !child.ok).length, 0);
	});
});
