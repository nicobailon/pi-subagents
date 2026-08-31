import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAsyncRunnerSteps, DEFAULT_ASYNC_TIMEOUT_MS, emitProcessTerminalEvent, formatAsyncStartedMessage, resolveAsyncRunnerLogPaths } from "../../src/runs/background/async-execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { SUBAGENT_PROCESS_TERMINAL_EVENT } from "../../src/shared/types.ts";

const agent = (name: string, toolBudget?: AgentConfig["toolBudget"]): AgentConfig => ({
	name,
	description: `${name} agent`,
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "You are a test agent.",
	source: "project",
	filePath: `${name}.md`,
	...(toolBudget ? { toolBudget } : {}),
});

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: undefined,
	currentModelProvider: undefined,
	modelScope: undefined,
};

describe("async runner execution", () => {
	it("uses supplied discovery context for missing async agents", () => {
		const result = buildAsyncRunnerSteps("missing-agent", {
			chain: [{ agent: "missing", task: "Do not launch" }],
			agents: [agent("arbitrary")],
			unknownAgentDiagnosticContext: {
				cwd: path.resolve(ctx.cwd),
				scope: "both",
				directories: [{ source: "project", path: path.join(ctx.cwd, ".pi", "agents"), state: "empty" }],
				agents: [agent("discovered")],
			},
			ctx,
			maxSubagentDepth: 1,
			asyncDir: path.join(process.cwd(), ".tmp-missing-agent"),
		});
		assert.ok("error" in result);
		assert.match(result.error, /^Unknown agent: missing\nEffective cwd: /);
		assert.match(result.error, /discovered \(project\)/);
		assert.doesNotMatch(result.error, /arbitrary \(project\)/);
	});

	it("uses the resolved cwd override for no-context missing-agent fallback discovery", () => {
		const override = path.join("diagnostic-cwd-override", "nested");
		const result = buildAsyncRunnerSteps("missing-agent-cwd", {
			chain: [{ agent: "missing", task: "Do not launch" }],
			agents: [agent("arbitrary")],
			ctx,
			cwd: override,
			maxSubagentDepth: 1,
			asyncDir: path.join(process.cwd(), ".tmp-missing-agent-cwd"),
		});
		assert.ok("error" in result);
		assert.ok(result.error.startsWith(`Unknown agent: missing\nEffective cwd: ${path.resolve(ctx.cwd, override)}`));
		assert.doesNotMatch(result.error, /arbitrary \(project\)/);
	});

	it("formats interactive yield and headless auto-drain guidance separately", () => {
		const interactive = formatAsyncStartedMessage("Async: worker [interactive]", true);
		assert.match(interactive, /interactive session[\s\S]*return control/i);
		assert.match(interactive, /native completion notification/i);
		assert.match(interactive, /does not need a wait call/i);
		assert.match(interactive, /provider, detached, or other background work that lacks a native completion notification/i);
		assert.doesNotMatch(interactive, /bg_wait\(\{ id:/i);
		assert.doesNotMatch(interactive, /auto-drains current-session background work/i);

		const headless = formatAsyncStartedMessage("Async: worker [headless]", false);
		assert.match(headless, /non-interactive run.*auto-drains current-session subagent work at agent_end/i);
		assert.match(headless, /Use bg_wait only.*provider, detached, or other background-work results.*no native completion notification/i);
		assert.doesNotMatch(headless, /nonBlocking: true/);
		assert.doesNotMatch(headless, /By default, return control to the user/i);
	});

	it("places detached runner stdio logs in the async run directory", () => {
		const asyncDir = path.join("tmp", "async-run");
		assert.deepEqual(resolveAsyncRunnerLogPaths({ asyncDir }), {
			stdoutPath: path.join(asyncDir, "runner.stdout.log"),
			stderrPath: path.join(asyncDir, "runner.stderr.log"),
		});
	});

	it("omits runner log paths when asyncDir is unavailable", () => {
		assert.equal(resolveAsyncRunnerLogPaths({}), undefined);
	});

	it("resolves async step tool budgets with step over run over agent over config precedence", () => {
		const result = buildAsyncRunnerSteps("run-1", {
			chain: [
				{ agent: "worker", task: "agent beats config" },
				{ agent: "worker", task: "step beats run", toolBudget: { hard: 2, block: ["grep"] } },
			],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			waitToolEnabled: false,
			toolBudget: { hard: 3, block: ["find"] },
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 3, block: ["find"] });
		assert.equal(result.steps[0]?.waitToolEnabled, false);
		assert.deepEqual(result.steps[1]?.toolBudget, { hard: 2, block: ["grep"] });
	});
	it("carries the resolved model context window into async runner steps", () => {
		const result = buildAsyncRunnerSteps("context-limit-run", {
			chain: [{ agent: "worker", task: "inspect context" }],
			agents: [{ ...agent("worker"), model: "mock/context" }],
			availableModels: [{ provider: "mock", id: "context", fullId: "mock/context", contextWindow: 128_000 }],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-context-limit-test"),
			maxSubagentDepth: 2,
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.equal(result.steps[0]?.contextLimit, 128_000);
	});

	it("carries explicit nested fanout authorization into async runner steps", () => {
		const nestedAgent = { ...agent("delegator"), allowNestedSubagents: true };
		const result = buildAsyncRunnerSteps("nested-fanout-run", {
			chain: [{ agent: "delegator", task: "delegate" }],
			agents: [nestedAgent],
			ctx,
		});

		assert.equal(result.error, undefined);
		assert.equal(result.steps[0]?.allowNestedSubagents, true);
	});

	it("assigns default and agent-level deadlines to async serial and parallel children", () => {
		const result = buildAsyncRunnerSteps("timeout-run", {
			chain: [
				{ agent: "default-worker", task: "default serial timeout" },
				{
					parallel: [
						{ agent: "default-worker", task: "default parallel timeout" },
						{ agent: "custom-worker", task: "custom parallel timeout" },
					],
				},
			],
			agents: [agent("default-worker"), { ...agent("custom-worker"), defaultTimeoutMs: 7_000 }],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-timeout-test"),
			maxSubagentDepth: 2,
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.equal(result.steps[0]?.timeoutMs, DEFAULT_ASYNC_TIMEOUT_MS);
		const parallel = result.steps[1];
		assert.ok(parallel && "parallel" in parallel && Array.isArray(parallel.parallel));
		assert.deepEqual(parallel.parallel.map((step) => step.timeoutMs), [DEFAULT_ASYNC_TIMEOUT_MS, 7_000]);
	});

	it("uses agent tool budget before config default when no run override exists", () => {
		const result = buildAsyncRunnerSteps("run-2", {
			chain: [{ agent: "worker", task: "agent beats config" }],
			agents: [agent("worker", { hard: 4, block: ["read"] })],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 4, block: ["read"] });
	});

	it("attaches external runner config and rejects unsupported Pi-only overrides", () => {
		const external = agent("external");
		external.runner = { type: "external-cli", command: process.execPath, args: ["fake.mjs"] };
		const built = buildAsyncRunnerSteps("external-run", {
			chain: [{ agent: "external", task: "review" }],
			agents: [external],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-external-test"),
			maxSubagentDepth: 2,
		});
		assert.ok("steps" in built);
		assert.deepEqual(built.steps[0]?.runner, external.runner);
		assert.equal(built.steps[0]?.model, undefined);

		const rejected = buildAsyncRunnerSteps("external-rejected", {
			chain: [{ agent: "external", task: "review", model: "provider/model" }],
			agents: [external],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-external-test"),
			maxSubagentDepth: 2,
		});
		assert.deepEqual(rejected, { error: "Agent 'external' uses runner.type='external-cli' and does not support: model override." });
	});

	it("uses config default when no step, run, or agent budget exists", () => {
		const result = buildAsyncRunnerSteps("run-3", {
			chain: [{ agent: "worker", task: "config default" }],
			agents: [agent("worker")],
			ctx,
			asyncDir: path.join(process.cwd(), ".tmp-async-test"),
			maxSubagentDepth: 2,
			configToolBudget: { hard: 5, block: ["ls"] },
		});

		assert.ok("steps" in result, "expected successful step build");
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 5, block: ["ls"] });
	});
});

describe("async runner process terminal events", () => {
	const proof = { version: 1, runId: "run-terminal", runnerProcessInstanceId: "runner-1", state: "unknown", reason: "writer-close-unverified" };
	const staleMessage = "This extension ctx is stale after session replacement or reload.";

	const makeCtx = (emit: (name: string, payload?: unknown) => unknown) => ({
		...ctx,
		pi: { events: { emit } } as unknown as ExtensionAPI,
	});

	it("emits the process terminal proof on a live event bus", () => {
		const emitted: Array<[string, unknown]> = [];
		emitProcessTerminalEvent(makeCtx((name, payload) => { emitted.push([name, payload]); }), proof);

		assert.deepEqual(emitted, [[SUBAGENT_PROCESS_TERMINAL_EVENT, proof]]);
	});

	it("drops stale extension ctx failures without throwing", () => {
		assert.doesNotThrow(() => emitProcessTerminalEvent(makeCtx(() => {
			throw new Error(staleMessage);
		}), proof));
	});

	it("logs non-stale event bus failures without throwing", () => {
		const originalError = console.error;
		let logged: unknown[] | undefined;
		console.error = (...args: unknown[]) => { logged = args; };
		try {
			assert.doesNotThrow(() => emitProcessTerminalEvent(makeCtx(() => {
				throw new Error("event bus unavailable");
			}), proof));
		} finally {
			console.error = originalError;
		}

		assert.ok(logged?.some((arg) => arg instanceof Error && arg.message === "event bus unavailable"));
	});
});
