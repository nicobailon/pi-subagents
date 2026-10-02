/**
 * Dispatch-path tests for the Claude Code model and thinking override.
 *
 * These drive the real step builder and the real launch validation, so they
 * prove the request reaches the adapter instead of only that the token helper
 * returns the expected array. They assert on built steps rather than on a
 * spawned CLI: the adapter runs its command with `shell: false`, and Node
 * refuses to spawn a `.cmd` that way, so a fake command cannot run on Windows.
 * The tokens-to-argv link is covered by `claude-code-adapter.test.ts`, which
 * spawns the real Node binary.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerSteps, executeAsyncSingle, resolveClaudeCodeThinking } from "../../src/runs/background/async-execution.ts";
import { resolveClaudeCodeLaunch } from "../../src/runs/shared/claude-code-adapter.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const artifactsOff = { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 };

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "You are a test agent.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `${name}.md`,
		runner: { type: "external-cli", adapter: "claude-code", command: "claude", promptDelivery: "stdin" },
		...overrides,
	} as AgentConfig;
}

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: undefined,
	currentModelProvider: undefined,
	modelScope: undefined,
};

function build(chain: Parameters<typeof buildAsyncRunnerSteps>[1]["chain"], agents: AgentConfig[], overrides: Record<string, unknown> = {}) {
	return buildAsyncRunnerSteps("cc-dispatch", {
		chain,
		agents,
		ctx,
		asyncDir: path.join(process.cwd(), ".tmp-cc-dispatch"),
		maxSubagentDepth: 2,
		...overrides,
	} as Parameters<typeof buildAsyncRunnerSteps>[1]);
}

function firstArgs(built: ReturnType<typeof buildAsyncRunnerSteps>): string[] | undefined {
	if (!("steps" in built)) return undefined;
	const step = built.steps[0] as { claudeCodeOverrideArgs?: string[] } | undefined;
	return step?.claudeCodeOverrideArgs;
}

describe("Claude Code override dispatch", () => {
	it("carries a model suffix into --model and --effort", () => {
		const built = build([{ agent: "claude-code", task: "Review", model: "claude-opus-5.5:high" }], [agent("claude-code")]);
		assert.deepEqual(firstArgs(built), ["--model", "claude-opus-5.5", "--effort", "high"]);
	});

	it("takes a bare level on the agent's own model", () => {
		const built = build([{ agent: "claude-code", task: "Review", model: ":medium" }], [agent("claude-code")]);
		assert.deepEqual(firstArgs(built), ["--effort", "medium"]);

		const pinned = build([{ agent: "claude-code", task: "Review", model: ":medium" }], [agent("claude-code", { model: "sonnet" })]);
		assert.deepEqual(firstArgs(pinned), ["--model", "sonnet", "--effort", "medium"]);
	});

	it("gives each chain step and each parallel item its own flags", () => {
		const built = build(
			[
				{ agent: "claude-code", task: "First", model: "sonnet:low" },
				{ agent: "claude-code", task: "Second", model: "haiku:xhigh" },
			],
			[agent("claude-code")],
		);
		assert.ok("steps" in built);
		assert.deepEqual((built.steps[0] as { claudeCodeOverrideArgs?: string[] }).claudeCodeOverrideArgs, ["--model", "sonnet", "--effort", "low"]);
		assert.deepEqual((built.steps[1] as { claudeCodeOverrideArgs?: string[] }).claudeCodeOverrideArgs, ["--model", "haiku", "--effort", "xhigh"]);

		const parallel = build(
			[{ parallel: [{ agent: "claude-code", task: "A", model: "sonnet:low" }, { agent: "claude-code", task: "B", model: "haiku:xhigh" }] }],
			[agent("claude-code")],
		);
		assert.ok("steps" in parallel);
		const items = (parallel.steps[0] as { parallel?: Array<{ claudeCodeOverrideArgs?: string[] }> }).parallel ?? [];
		assert.deepEqual(items.map((item) => item.claudeCodeOverrideArgs), [
			["--model", "sonnet", "--effort", "low"],
			["--model", "haiku", "--effort", "xhigh"],
		]);
	});

	it("never passes a Pi default model to the CLI", () => {
		const model = "anthropic/claude-sonnet-4-5";
		const fromSettings = agent("claude-code", {
			model,
			modelSource: { type: "subagents.defaultModel", scope: "user", path: "/tmp/settings.json", model },
		});
		assert.equal(firstArgs(build([{ agent: "claude-code", task: "Review" }], [fromSettings])), undefined);

		// A frontmatter model the operator wrote still reaches the CLI.
		const pinned = agent("claude-code", { model: "claude-opus-5.5", modelSource: { type: "subagents.defaultModel", scope: "user", path: "/tmp/settings.json", model } });
		assert.deepEqual(firstArgs(build([{ agent: "claude-code", task: "Review" }], [pinned])), ["--model", "claude-opus-5.5"]);
	});

	it("honors an explicit thinking clear instead of the agent default", () => {
		const withDefault = agent("claude-code", { thinking: "high" });
		assert.deepEqual(firstArgs(build([{ agent: "claude-code", task: "Review" }], [withDefault])), ["--effort", "high"]);
		// An explicit clear must not fall back to the level it cleared. Chain steps
		// carry no thinking field, so the per-step override is the channel.
		assert.equal(firstArgs(build([{ agent: "claude-code", task: "Review" }], [withDefault], { thinkingOverridesByFlatIndex: [false] })), undefined);
		assert.deepEqual(firstArgs(build([{ agent: "claude-code", task: "Review" }], [withDefault], { thinkingOverridesByFlatIndex: ["low"] })), ["--effort", "low"]);

		// The same precedence drives the single path.
		assert.equal(resolveClaudeCodeThinking(false, "high"), undefined);
		assert.equal(resolveClaudeCodeThinking(undefined, "high"), "high");
		assert.equal(resolveClaudeCodeThinking("low", "high"), "low");
		assert.equal(resolveClaudeCodeThinking(false, false), undefined);
	});

	it("hands the built step's tokens to the adapter launch", () => {
		const built = build([{ agent: "claude-code", task: "Review", model: "claude-opus-5.5:high" }], [agent("claude-code")]);
		// The runner passes the step field straight through as overrideArgs.
		const launch = resolveClaudeCodeLaunch({ adapter: "claude-code", command: "claude", overrideArgs: firstArgs(built) });
		assert.deepEqual(launch.args.slice(-4), ["--model", "claude-opus-5.5", "--effort", "high"]);
		assert.deepEqual(launch.preflight.versionArgs, ["--version"]);
		assert.deepEqual(launch.preflight.helpArgs, ["--help"]);
	});

	it("rejects an effort above maxThinking before the child starts", () => {
		const built = build([{ agent: "claude-code", task: "Review", model: "sonnet:max" }], [agent("claude-code", { maxThinking: "low" })]);
		assert.ok("error" in built);
		assert.match(built.error, /Thinking level 'max' exceeds configured maximum 'low'/);

		// The boundary compares the requested level, not the effort it maps to.
		const boundary = build([{ agent: "claude-code", task: "Review", model: "sonnet:minimal" }], [agent("claude-code", { maxThinking: "minimal" })]);
		assert.deepEqual(firstArgs(boundary), ["--model", "sonnet", "--effort", "low"]);
	});

	it("fails closed on an enforced model scope for a chain step", () => {
		const scoped = { ...ctx, modelScope: { enforce: true, allow: ["anthropic/claude-opus-4-5"] } };
		const outside = buildAsyncRunnerSteps("cc-scope-out", {
			chain: [{ agent: "claude-code", task: "Review", model: "opus" }],
			agents: [agent("claude-code")],
			ctx: scoped,
			asyncDir: path.join(process.cwd(), ".tmp-cc-dispatch"),
			maxSubagentDepth: 2,
		} as Parameters<typeof buildAsyncRunnerSteps>[1]);
		assert.ok("error" in outside);
		assert.match(outside.error, /outside the configured subagent model scope/);

		const unnamed = buildAsyncRunnerSteps("cc-scope-none", {
			chain: [{ agent: "claude-code", task: "Review" }],
			agents: [agent("claude-code")],
			ctx: scoped,
			asyncDir: path.join(process.cwd(), ".tmp-cc-dispatch"),
			maxSubagentDepth: 2,
		} as Parameters<typeof buildAsyncRunnerSteps>[1]);
		assert.ok("error" in unnamed);
		assert.match(unnamed.error, /cannot be checked against an enforced subagent model scope/);
	});

	it("rejects the same limits on the single path before anything launches", () => {
		const single = (params: Record<string, unknown>) =>
			executeAsyncSingle(`cc-single-${Date.now().toString(36)}`, {
				agent: "claude-code",
				task: "Review",
				agentConfig: agent("claude-code"),
				ctx: { pi: { events: { emit() {} } }, cwd: process.cwd(), currentSessionId: "session-1", ...(params.ctx as object | undefined) },
				artifactConfig: artifactsOff,
				shareEnabled: false,
				...params,
			});

		const overCeiling = single({ modelOverride: "sonnet:max", agentConfig: agent("claude-code", { maxThinking: "low" }) });
		assert.equal(overCeiling.isError, true);
		assert.match(overCeiling.content[0]?.text ?? "", /Thinking level 'max' exceeds configured maximum 'low'/);

		const outside = single({ modelOverride: "opus", ctx: { modelScope: { enforce: true, allow: ["anthropic/claude-opus-4-5"] } } });
		assert.equal(outside.isError, true);
		assert.match(outside.content[0]?.text ?? "", /outside the configured subagent model scope/);

		const unnamed = single({ ctx: { modelScope: { enforce: true, allow: ["anthropic/claude-opus-4-5"] } } });
		assert.equal(unnamed.isError, true);
		assert.match(unnamed.content[0]?.text ?? "", /cannot be checked against an enforced subagent model scope/);
	});
});
