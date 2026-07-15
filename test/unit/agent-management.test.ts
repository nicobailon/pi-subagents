import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleList, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";

let tempDir = "";
let oldAgentDir: string | undefined;

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text;
}

describe("agent management config parsing", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-management-"));
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
		clearSkillCache();
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("surfaces JSON parse errors for create config strings", () => {
		const result = handleCreate(
			{ config: '{"name":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("hides lower-priority agents shadowed by project agents in list output", () => {
		const agentsDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), "---\nname: scout\ndescription: Project scout override\n---\n\nProject scout agent.\n");

		const result = handleList(
			{ agentScope: "project" },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, false);
		assert.match(readText(result), /- scout \(project\): Project scout override/);
		assert.doesNotMatch(readText(result), /- scout \(builtin/);
	});

	it("surfaces JSON parse errors for update config strings", () => {
		const result = handleUpdate(
			{ agent: "reviewer", config: '{"description":' },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config must be valid JSON:/);
	});

	it("creates, gets, updates, and deletes a packaged agent by runtime name", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "Code Analysis", description: "Fast recon", scope: "project", systemPrompt: "Inspect" } },
			ctx,
		);

		assert.equal(created.isError, false);
		assert.match(readText(created), /Created agent 'code-analysis.scout'/);
		const filePath = path.join(tempDir, ".pi", "agents", "code-analysis.scout.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.doesNotMatch(content, /^name: code-analysis\.scout$/m);

		const got = handleManagementAction("get", { agent: "code-analysis.scout" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Agent: code-analysis\.scout/);
		assert.match(readText(got), /Local name: scout/);
		assert.match(readText(got), /Package: code-analysis/);

		const updated = handleUpdate(
			{ agent: "code-analysis.scout", config: { package: "documentation" } },
			ctx,
		);
		assert.equal(updated.isError, false);
		assert.match(readText(updated), /code-analysis\.scout' to 'documentation\.scout'/);
		assert.equal(fs.existsSync(filePath), false);
		const updatedPath = path.join(tempDir, ".pi", "agents", "documentation.scout.md");
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: scout$/m);
		assert.match(content, /^package: documentation$/m);

		const deleted = handleManagementAction("delete", { agent: "documentation.scout" }, ctx);
		assert.equal(deleted.isError, false);
		assert.equal(fs.existsSync(updatedPath), false);
	});

	it("creates, reports, and clears agent-local skill paths", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const skillFile = path.join(tempDir, ".pi", "agents", "skills", "private", "SKILL.md");
		fs.mkdirSync(path.dirname(skillFile), { recursive: true });
		fs.writeFileSync(skillFile, "---\ndescription: Private skill\n---\nbody\n", "utf-8");

		const created = handleCreate({ config: {
			name: "Local",
			description: "Local skills",
			scope: "project",
			skills: "private",
			skillPath: ["./skills", "./skills"],
		} }, ctx);
		assert.equal(created.isError, false);
		assert.doesNotMatch(readText(created), /skills not found/);
		const filePath = path.join(tempDir, ".pi", "agents", "local.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^skillPath: \.\/skills$/m);

		const got = handleManagementAction("get", { agent: "local" }, ctx);
		assert.match(readText(got), /^Skill paths: \.\/skills$/m);

		const updated = handleUpdate({ agent: "local", config: { skills: false, skillPath: false } }, ctx);
		assert.equal(updated.isError, false);
		content = fs.readFileSync(filePath, "utf-8");
		assert.doesNotMatch(content, /^skills?:/m);
		assert.doesNotMatch(content, /^skillPath:/m);

		const invalid = handleUpdate({ agent: "local", config: { skillPath: ["./skills", 1] } }, ctx);
		assert.equal(invalid.isError, true);
		assert.match(readText(invalid), /config\.skillPath must be/);
	});

	it("rejects package values that cannot be normalized", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Scout", package: "!!!", description: "Fast recon", scope: "project" } },
			ctx,
		);

		assert.equal(created.isError, true);
		assert.match(readText(created), /config\.package is invalid/);
	});

	it("creates and updates packaged chains while preserving packaged step names", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "agents", "code-analysis.scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`, "utf-8");

		const created = handleCreate(
			{ config: { name: "Review Flow", package: "Code Analysis", description: "Review flow", scope: "project", steps: [{ agent: "code-analysis.scout", task: "Inspect", toolBudget: { soft: 3, hard: 5, block: ["read"] } }] } },
			ctx,
		);
		assert.equal(created.isError, false);
		assert.match(readText(created), /Created chain 'code-analysis.review-flow'/);
		const filePath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.match(content, /^package: code-analysis$/m);
		assert.match(content, /^## code-analysis\.scout$/m);
		assert.match(content, /^toolBudget: \{"soft":3,"hard":5,"block":\["read"\]\}$/m);

		const updated = handleUpdate(
			{ chainName: "code-analysis.review-flow", config: { package: false } },
			ctx,
		);
		assert.equal(updated.isError, false);
		const updatedPath = path.join(tempDir, ".pi", "chains", "review-flow.chain.md");
		assert.equal(fs.existsSync(filePath), false);
		content = fs.readFileSync(updatedPath, "utf-8");
		assert.match(content, /^name: review-flow$/m);
		assert.doesNotMatch(content, /^package:/m);
	});

	it("creates and updates agents with single-agent launch defaults", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{
				config: {
					name: "background-reviewer",
					description: "Review in the background",
					scope: "project",
					async: false,
					timeoutMs: 120_000,
					turnBudget: { maxTurns: 8, graceTurns: 2 },
					acceptance: { level: "none", reason: "lightweight reviewer" },
				},
			},
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "background-reviewer.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^async: false$/m);
		assert.match(content, /^timeoutMs: 120000$/m);
		assert.match(content, /^turnBudget: \{"maxTurns":8,"graceTurns":2\}$/m);
		assert.match(content, /^acceptance: \{"level":"none","reason":"lightweight reviewer"\}$/m);

		const got = handleManagementAction("get", { agent: "background-reviewer" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Async: false/);
		assert.match(readText(got), /Timeout: 120000ms/);
		assert.match(readText(got), /Turn budget: \{"maxTurns":8,"graceTurns":2\}/);
		assert.match(readText(got), /Acceptance: \{"level":"none","reason":"lightweight reviewer"\}/);

		const updated = handleUpdate(
			{ agent: "background-reviewer", config: { async: true, timeoutMs: false, turnBudget: false, acceptance: "" } },
			ctx,
		);
		assert.equal(updated.isError, false);
		content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^async: true$/m);
		assert.doesNotMatch(content, /^timeoutMs:/m);
		assert.doesNotMatch(content, /^turnBudget:/m);
		assert.doesNotMatch(content, /^acceptance:/m);

		const deprecatedFalse = handleUpdate(
			{ agent: "background-reviewer", config: { acceptance: false } },
			ctx,
		);
		assert.equal(deprecatedFalse.isError, false);
		content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^acceptance: false$/m);
	});

	it("rejects invalid single-agent launch defaults", () => {
		const result = handleCreate(
			{
				config: {
					name: "bad-launch-defaults",
					description: "Bad defaults",
					scope: "project",
					timeoutMs: 0,
				},
			},
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config\.timeoutMs must be a positive integer/);

		const invalidAcceptance = handleCreate(
			{
				config: {
					name: "bad-acceptance-default",
					description: "Bad acceptance",
					scope: "project",
					acceptance: "none",
				},
			},
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);
		assert.equal(invalidAcceptance.isError, true);
		assert.match(readText(invalidAcceptance), /config\.acceptance level "none" requires a reason/);
	});

	it("creates and updates agents with tool budgets", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "budgeted-reviewer", description: "Review with a budget", scope: "project", toolBudget: { soft: 4, hard: 7, block: ["read", "grep"] } } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "budgeted-reviewer.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^toolBudget: \{"soft":4,"hard":7,"block":\["read","grep"\]\}$/m);

		const got = handleManagementAction("get", { agent: "budgeted-reviewer" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Tool budget: \{"soft":4,"hard":7,"block":\["read","grep"\]\}/);

		const updated = handleUpdate(
			{ agent: "budgeted-reviewer", config: { toolBudget: { hard: 3, block: "*" } } },
			ctx,
		);
		assert.equal(updated.isError, false);
		content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^toolBudget: \{"hard":3,"block":"\*"\}$/m);
	});

	it("rejects invalid tool budget management config", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const agentResult = handleCreate(
			{ config: { name: "bad-budget", description: "Bad budget", scope: "project", toolBudget: { soft: 5, hard: 4 } } },
			ctx,
		);
		assert.equal(agentResult.isError, true);
		assert.match(readText(agentResult), /config\.toolBudget\.soft must be <= config\.toolBudget\.hard/);

		const chainResult = handleCreate(
			{ config: { name: "bad-chain-budget", description: "Bad budget", scope: "project", steps: [{ agent: "reviewer", toolBudget: { hard: 2, block: [] } }] } },
			ctx,
		);
		assert.equal(chainResult.isError, true);
		assert.match(readText(chainResult), /config\.steps\[0\]\.toolBudget\.block must contain at least one tool name/);
	});

	it("creates agents with completion guard disabled", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", tools: "read, grep, bash, ls", completionGuard: false } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "test-runner.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^completionGuard: false$/m);

		const got = handleManagementAction("get", { agent: "test-runner" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Completion guard: false/);
	});

	it("rejects non-boolean completion guard config", () => {
		const result = handleCreate(
			{ config: { name: "test-runner", description: "Run tests", scope: "project", completionGuard: "false" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, true);
		assert.match(readText(result), /config\.completionGuard must be a boolean/);
	});

	it("creates agents with subagent-only extensions", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const result = handleCreate(
			{ config: { name: "child-tool-user", description: "Uses child tools", scope: "project", subagentOnlyExtensions: "./tools/child-only.ts, /opt/pi/child.ts" } },
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "child-tool-user.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^subagentOnlyExtensions: \.\/tools\/child-only\.ts, \/opt\/pi\/child\.ts$/m);

		const got = handleManagementAction("get", { agent: "child-tool-user" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Subagent-only extensions: \.\/tools\/child-only\.ts, \/opt\/pi\/child\.ts/);
	});

	it("does not serialize settings overrides into custom agent frontmatter during updates", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] } };
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					implementer: {
						model: "anthropic/claude-sonnet-4-6",
						systemPromptMode: "append",
						inheritProjectContext: true,
						inheritSkills: true,
					},
				},
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: TDD implementer
---

Drive the failing test first.
`, "utf-8");

		const got = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(got.isError, false);
		const beforeText = readText(got);
		assert.match(beforeText, /Model: anthropic\/claude-sonnet-4-6/);
		assert.match(beforeText, /System prompt mode: append/);
		assert.match(beforeText, /Inherit project context: true/);
		assert.match(beforeText, /Inherit skills: true/);

		const updated = handleUpdate(
			{ agent: "implementer", config: { description: "Updated implementer" } },
			ctx,
		);
		assert.equal(updated.isError, false);

		const content = fs.readFileSync(agentPath, "utf-8");
		assert.match(content, /^description: Updated implementer$/m);
		assert.doesNotMatch(content, /^model:/m);
		assert.doesNotMatch(content, /^systemPromptMode:/m);
		assert.doesNotMatch(content, /^inheritProjectContext:/m);
		assert.doesNotMatch(content, /^inheritSkills:/m);

		const gotAfter = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(gotAfter.isError, false);
		const afterText = readText(gotAfter);
		assert.match(afterText, /Model: anthropic\/claude-sonnet-4-6/);
		assert.match(afterText, /System prompt mode: append/);
		assert.match(afterText, /Inherit project context: true/);
		assert.match(afterText, /Inherit skills: true/);
	});

	it("preserves explicit default-like frontmatter that blocks settings overrides during updates", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					implementer: {
						thinking: "high",
						fallbackModels: ["openai/gpt-5-mini"],
						tools: ["bash"],
						skills: ["override-skill"],
						defaultContext: "fork",
						completionGuard: false,
						toolBudget: { hard: 3 },
					},
				},
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: TDD implementer
fallbackModels:
thinking: off
tools:
skills:
defaultContext:
completionGuard: true
toolBudget:
---

Drive the failing test first.
`, "utf-8");

		const got = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(got.isError, false);
		const beforeText = readText(got);
		assert.match(beforeText, /Thinking: off/);
		assert.doesNotMatch(beforeText, /Thinking: high/);

		const updated = handleUpdate(
			{ agent: "implementer", config: { description: "Updated implementer" } },
			ctx,
		);
		assert.equal(updated.isError, false);

		const content = fs.readFileSync(agentPath, "utf-8");
		assert.match(content, /^description: Updated implementer$/m);
		assert.match(content, /^fallbackModels: ?$/m);
		assert.match(content, /^thinking: off$/m);
		assert.match(content, /^tools: ?$/m);
		assert.match(content, /^skills: ?$/m);
		assert.match(content, /^defaultContext: ?$/m);
		assert.match(content, /^completionGuard: true$/m);
		assert.match(content, /^toolBudget: ?$/m);

		const gotAfter = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(gotAfter.isError, false);
		const afterText = readText(gotAfter);
		assert.match(afterText, /Thinking: off/);
		assert.doesNotMatch(afterText, /Thinking: high/);
	});

	it("updates JSON chain descriptions without rewriting them as markdown", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");

		const updated = handleUpdate({ chainName: "dynamic-review", config: { description: "Updated dynamic review" } }, ctx);

		assert.equal(updated.isError, false);
		const content = fs.readFileSync(chainPath, "utf-8");
		assert.doesNotMatch(content, /^---/);
		const parsed = JSON.parse(content) as { description?: string; chain?: Array<{ collect?: { as?: string } }> };
		assert.equal(parsed.description, "Updated dynamic review");
		assert.equal(parsed.chain?.[1]?.collect?.as, "reviews");
	});

	it("renames and repackages JSON chains while preserving JSON format and extension", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainPath = path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json");
		fs.mkdirSync(path.dirname(chainPath), { recursive: true });
		fs.writeFileSync(chainPath, JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [{ agent: "scout", task: "Return targets" }],
		}), "utf-8");

		const updated = handleUpdate({ chainName: "dynamic-review", config: { name: "Review Flow", package: "Code Analysis" } }, ctx);

		assert.equal(updated.isError, false);
		const updatedPath = path.join(tempDir, ".pi", "chains", "code-analysis.review-flow.chain.json");
		assert.equal(fs.existsSync(chainPath), false);
		const content = fs.readFileSync(updatedPath, "utf-8");
		assert.doesNotMatch(content, /^---/);
		const parsed = JSON.parse(content) as { name?: string; package?: string; chain?: Array<{ agent?: string }> };
		assert.equal(parsed.name, "review-flow");
		assert.equal(parsed.package, "code-analysis");
		assert.equal(parsed.chain?.[0]?.agent, "scout");
	});

	it("gets dynamic JSON chain details and lists invalid chain diagnostics", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "chains"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "chains", "dynamic-review.chain.json"), JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");
		fs.writeFileSync(path.join(tempDir, ".pi", "chains", "broken.chain.json"), "{", "utf-8");

		const got = handleManagementAction("get", { chainName: "dynamic-review" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Dynamic fanout -> reviews/);
		assert.match(readText(got), /Expand: targets\/items/);
		assert.match(readText(got), /Agent: reviewer/);

		const listed = handleManagementAction("list", {}, ctx);
		assert.equal(listed.isError, false);
		assert.match(readText(listed), /Chain diagnostics:/);
		assert.match(readText(listed), /broken\.chain\.json/);
		assert.match(readText(listed), /Invalid JSON chain/);
	});

	it("reports builtin runtime-loaded model mappings from current session state", () => {
		const ctx = {
			cwd: tempDir,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-5-mini" },
					{ provider: "anthropic", id: "claude-sonnet-4" },
				],
			},
			model: { provider: "openai", id: "gpt-5-mini" },
		};

		const result = handleManagementAction("models", {}, ctx);
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /^Builtin subagent models/m);
		assert.match(text, /Current session model:\n  openai\/gpt-5-mini/);
		assert.match(text, /(?:^|\n)scout\n  model:\n    openai\/gpt-5-mini\n  source: inherits current session model(?:\n|$)/);
	});

	it("reports override source and disabled builtin state in runtime model mappings", () => {
		const projectSettingsPath = path.join(tempDir, ".pi", "settings.json");
		fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
		fs.writeFileSync(projectSettingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					reviewer: { model: "claude-sonnet-4", disabled: true },
				},
			},
		}, null, 2), "utf-8");

		const ctx = {
			cwd: tempDir,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-5-mini" },
					{ provider: "anthropic", id: "claude-sonnet-4" },
				],
			},
			model: { provider: "openai", id: "gpt-5-mini" },
		};

		const result = handleManagementAction("models", { agent: "reviewer" }, ctx);
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /^Builtin subagent model/m);
		assert.match(text, /Agent: reviewer/);
		assert.match(text, /Effective model:\n  anthropic\/claude-sonnet-4/);
		assert.match(text, /Source: project override/);
		assert.match(text, /Requested model setting:\n  claude-sonnet-4/);
		assert.match(text, /Disabled: true/);
		assert.match(text.replaceAll("\\", "/"), /Override file:\n  .*\.pi\/settings\.json/);
	});

	it("rejects unknown builtin filters for runtime model mappings", () => {
		const result = handleManagementAction("models", { agent: "not-a-builtin" }, {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [] },
		});

		assert.equal(result.isError, true);
		assert.match(readText(result), /Builtin agent 'not-a-builtin' not found/);
	});

	it("creates delegate with its builtin prompt defaults", () => {
		const result = handleCreate(
			{ config: { name: "delegate", description: "Delegate helper", scope: "project" } },
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "delegate.md");
		const content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /systemPromptMode: append/);
		assert.match(content, /inheritProjectContext: true/);
		assert.match(content, /inheritSkills: false/);
	});

	it("lists proactive skill subagent suggestions from repeated configured skill use", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pi", "skills", "deslop"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "skills", "deslop", "SKILL.md"), `---
description: Cleanup review.
---

Review for cleanup.
`, "utf-8");
		for (const name of ["cleanup-a", "cleanup-b"]) {
			fs.writeFileSync(path.join(tempDir, ".pi", "agents", `${name}.md`), `---
name: ${name}
description: Cleanup ${name}
skills: deslop
---

Inspect cleanup.
`, "utf-8");
		}

		const listed = handleManagementAction("list", {}, ctx);
		const text = readText(listed);
		assert.match(text, /Proactive skill subagent suggestions:/);
		assert.match(text, /- deslop via reviewer/);
		assert.match(text, /Cleanup review\./);
	});

	it("can disable proactive skill subagent suggestions in config", () => {
		const ctx = {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [] },
			config: { proactiveSkillSubagents: false },
		};
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pi", "skills", "deslop"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "skills", "deslop", "SKILL.md"), "Review for cleanup.\n", "utf-8");
		for (const name of ["cleanup-a", "cleanup-b"]) {
			fs.writeFileSync(path.join(tempDir, ".pi", "agents", `${name}.md`), `---
name: ${name}
description: Cleanup ${name}
skills: deslop
---

Inspect cleanup.
`, "utf-8");
		}

		const listed = handleManagementAction("list", {}, ctx);
		assert.doesNotMatch(readText(listed), /Proactive skill subagent suggestions:/);
	});

});
