import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { formatWorkflowJsonPreview, previewSimpleWorkflowRun, runWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";

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
		assert.equal(launches.every(({ params }) => params.async === false), true);
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
		await assert.rejects(
			runWorkflowScript({
				script: `return runs.run("invalid", { agent: "worker", gate: "npm test", acceptance: "checked" });`,
				async launch(key) { return { key, ok: true, output: "done", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /gate cannot be combined with acceptance/.test(error.message),
		);
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
				async launch(key) { return { key, ok: false, output: "failed", artifactPaths: [], results: [] }; },
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /Run 'fails' failed: failed/.test(error.message),
		);
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

	it("rejects non-plain child result values", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.run("non-plain", { agent: "worker", task: "write output" });`,
				timeoutMs: 2_000,
				async launch(key) {
					return { key, ok: true, output: "Saved output.", artifactPaths: [], results: [{ metadata: new Map([["source", "worker"]]) }] };
				},
				async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /return.*plain JSON objects/i.test(error.message),
		);
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
		assert.deepEqual(launchParams, { resume: "retained-run", task: "Apply the follow-up", async: false });
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

	it("passes per-child worktree controls through runs.run and runs.all", async () => {
		const launches: Array<{ key: string; worktree: unknown }> = [];
		await runWorkflowScript({
			script: `
				const one = await runs.run("one", { agent: "worker", task: "one", worktree: true });
				const rest = await runs.all([
					{ key: "two", agent: "worker", task: "two", worktree: true },
					{ key: "three", agent: "reviewer", task: "three", worktree: false }
				]);
				return [one.key, ...rest.map((entry) => entry.key)];
			`,
			timeoutMs: 2_000,
			async launch(key, params) {
				launches.push({ key, worktree: params.worktree });
				return { key, ok: true, output: key, artifactPaths: [], results: [] };
			},
			async status(key) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
		});
		assert.deepEqual(launches, [
			{ key: "one", worktree: true },
			{ key: "two", worktree: true },
			{ key: "three", worktree: false },
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
		for (const params of [`tasks: [{ agent: "scout", task: "scan" }]`, `parallel: [{ agent: "scout", task: "scan" }]`]) {
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
				&& error.message.includes("Await or return each launch"),
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
			(error: unknown) => error instanceof WorkflowScriptError && error.message.includes("unawaited runs.run launch(es): 'x'"),
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
});
