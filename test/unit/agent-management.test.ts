import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { editableAgentConfig, handleCreate, handleList, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";
import { EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";
import { EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, registerExternalJobProvider } from "../../src/api/external-job-provider.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { openSubagentsAdmin } from "../../src/slash/subagents-admin.ts";

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

	it("lists compact declared capabilities without exposing system prompts", () => {
		const agentsDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "capability-worker.md"), [
			"---",
			"name: capability-worker",
			"description: Capability worker",
			"aliases: capability",
			"tools: read, grep, mcp:github/search",
			"model: openai/gpt-5-mini",
			"fallbackModels: openai/gpt-5-mini-fallback",
			"async: true",
			"timeoutMs: 123",
			"thinking: high",
			"skills: typescript-code",
			"extensions: github",
			"subagentOnlyExtensions: surf",
			"mutationTools: edit, write",
			"output: report.md",
			"outputMode: file-only",
			"---",
			"SYSTEM_PROMPT_SENTINEL",
			"---",
		].join("\n"));

		const capabilityRequest = { agentScope: "project", capabilities: true };
		const listed = handleManagementAction("list", capabilityRequest, {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [] },
		});
		assert.equal(listed.isError, false);
		const text = readText(listed);
		assert.match(text, /^Executable agents \(capabilities\):/);
		assert.match(text, /- capability-worker \(project, aliases: capability\): Description: Capability worker; Tools: read, grep, mcp:github\/search; Model: openai\/gpt-5-mini; Thinking: high/);
		assert.doesNotMatch(text, /System Prompt:|SYSTEM_PROMPT_SENTINEL/);
		const capabilities = listed.details?.agentCapabilities;
		assert.ok(capabilities);
		const row = capabilities.agents.find((agent) => agent.name === "capability-worker");
		assert.ok(row);
		assert.equal(row.executable, true);
		assert.deepEqual(row.tools, { ambient: false, names: ["read", "grep"], mcpDirectTools: ["github/search"], mutationTools: ["edit", "write"] });
		assert.deepEqual(row.model, { value: "openai/gpt-5-mini", fallbackModels: ["openai/gpt-5-mini-fallback"], thinking: "high" });
		assert.deepEqual(row.execution, { defaultAsync: true, timeoutMs: 123 });
		assert.deepEqual(row.output, { path: "report.md", mode: "file-only" });
		assert.deepEqual(row.extensions, { names: ["github"], subagentOnly: ["surf"], skills: ["typescript-code"] });
		assert.equal(JSON.stringify(capabilities).includes("SYSTEM_PROMPT_SENTINEL"), false);
	});

	it("rejects management attempts to widen the reserved read-only Claude profile", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const writerRunner = { type: "external-cli", adapter: "claude-code-writer", command: "claude" };
		const unsafeCreate = handleCreate({ config: { name: "claude-code", description: "Unsafe shadow", scope: "project", runner: writerRunner } }, ctx);
		assert.equal(unsafeCreate.isError, true);
		assert.match(readText(unsafeCreate), /reserved for the read-only 'claude-code' adapter/);
		const unsafeLocalName = handleCreate({ config: { name: "claude-code", package: "custom", description: "Unsafe local name", scope: "project", runner: writerRunner } }, ctx);
		assert.equal(unsafeLocalName.isError, true);
		assert.match(readText(unsafeLocalName), /Selection name 'claude-code' is reserved/);
		const unsafeAlias = handleCreate({ config: { name: "aliased-writer", aliases: ["claude-code"], description: "Unsafe alias", scope: "project", runner: writerRunner } }, ctx);
		assert.equal(unsafeAlias.isError, true);
		assert.match(readText(unsafeAlias), /Selection name 'claude-code' is reserved/);

		const readOnlyCreate = handleCreate({ config: { name: "claude-code", description: "Narrow shadow", scope: "project", runner: { type: "external-cli", adapter: "claude-code", command: "claude" } } }, ctx);
		assert.equal(readOnlyCreate.isError, false);
		const unsafeUpdate = handleUpdate({ agent: "claude-code", agentScope: "project", config: { runner: writerRunner } }, ctx);
		assert.equal(unsafeUpdate.isError, true);
		assert.match(readText(unsafeUpdate), /reserved for the read-only 'claude-code' adapter/);
		assert.match(fs.readFileSync(path.join(tempDir, ".pi", "agents", "claude-code.md"), "utf-8"), /adapter: claude-code\n/);

		const writerCreate = handleCreate({ config: { name: "custom-writer", description: "Writer", scope: "project", runner: writerRunner } }, ctx);
		assert.equal(writerCreate.isError, false);
		const unsafeAliasUpdate = handleUpdate({ agent: "custom-writer", agentScope: "project", config: { aliases: ["claude-code"] } }, ctx);
		assert.equal(unsafeAliasUpdate.isError, true);
		assert.match(readText(unsafeAliasUpdate), /Selection name 'claude-code' is reserved/);
		const unsafeRename = handleUpdate({ agent: "custom-writer", agentScope: "project", config: { name: "claude-code" } }, ctx);
		assert.equal(unsafeRename.isError, true);
		assert.match(readText(unsafeRename), /reserved for the read-only 'claude-code' adapter/);
	});

	it("rejects create, update, alias, and rename widening for Codex and Cursor", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		for (const [readOnly, writer, command] of [["codex-exec", "codex-exec-writer", "codex"], ["cursor-agent", "cursor-agent-writer", "cursor-agent"]] as const) {
			const writerRunner = { type: "external-cli", adapter: writer, command };
			assert.equal(handleCreate({ config: { name: readOnly, description: "Unsafe shadow", scope: "project", runner: writerRunner } }, ctx).isError, true);
			assert.equal(handleCreate({ config: { name: readOnly, package: `custom-${readOnly}`, description: "Unsafe local name", scope: "project", runner: writerRunner } }, ctx).isError, true);
			assert.equal(handleCreate({ config: { name: `${readOnly}-alias`, aliases: [readOnly], description: "Unsafe alias", scope: "project", runner: writerRunner } }, ctx).isError, true);

			const readOnlyCreate = handleCreate({ config: { name: readOnly, description: "Narrow shadow", scope: "project", runner: { type: "external-cli", adapter: readOnly, command } } }, ctx);
			assert.equal(readOnlyCreate.isError, false);
			assert.equal(handleUpdate({ agent: readOnly, agentScope: "project", config: { runner: writerRunner } }, ctx).isError, true);

			const customName = `custom-${writer}`;
			assert.equal(handleCreate({ config: { name: customName, description: "Writer", scope: "project", runner: writerRunner } }, ctx).isError, false);
			assert.equal(handleUpdate({ agent: customName, agentScope: "project", config: { aliases: [readOnly] } }, ctx).isError, true);
			assert.equal(handleUpdate({ agent: customName, agentScope: "project", config: { name: readOnly } }, ctx).isError, true);
		}
	});

	it("lists valid agents and diagnoses malformed agent definitions", () => {
		const agentsDir = path.join(tempDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "broken.md"), "---\nname: broken\ndescription: Broken\nrunner:\n  type: unknown\n---\nBroken agent.\n");
		fs.writeFileSync(path.join(agentsDir, "working.md"), "---\nname: working\ndescription: Working\n---\nWorking agent.\n");
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };

		const listed = handleList({}, ctx);
		assert.equal(listed.isError, false);
		assert.match(readText(listed), /- working \(project/);
		assert.match(readText(listed), /Invalid agent definitions:\n- broken \(project\): Agent 'broken' has invalid runner\.type/);

		const invalid = handleManagementAction("get", { agent: "broken" }, ctx);
		assert.equal(invalid.isError, true);
		assert.match(readText(invalid), /Agent 'broken' has invalid configuration: Agent 'broken' has invalid runner\.type/);
		fs.writeFileSync(path.join(agentsDir, "bad-agent.md"), "---\nname: bad-agent\ndescription: Bad agent\nrunner:\n  type: unknown\n---\nBroken agent.\n");
		const normalizedInvalid = handleManagementAction("get", { agent: "Bad Agent" }, ctx);
		assert.equal(normalizedInvalid.isError, true);
		assert.match(readText(normalizedInvalid), /Agent 'Bad Agent' has invalid configuration: Agent 'bad-agent' has invalid runner\.type/);

		fs.writeFileSync(path.join(agentsDir, "code-analysis.zeta-worker.md"), "---\nname: zeta-worker\npackage: code-analysis\ndescription: Broken packaged worker\nrunner:\n  type: unknown\n---\nBroken agent.\n");
		const invalidPackaged = handleManagementAction("get", { agent: "code-analysis.zeta-worker" }, ctx);
		assert.equal(invalidPackaged.isError, true);
		assert.match(readText(invalidPackaged), /Agent 'code-analysis\.zeta-worker' has invalid configuration: Agent 'zeta-worker' has invalid runner\.type/);

		fs.writeFileSync(path.join(agentsDir, "reviewer.md"), "---\nname: reviewer\ndescription: Broken reviewer\nrunner:\n  type: unknown\n---\nBroken agent.\n");
		const invalidShadow = handleManagementAction("get", { agent: "reviewer" }, ctx);
		assert.equal(invalidShadow.isError, true);
		assert.match(readText(invalidShadow), /Agent 'reviewer' has invalid configuration: Agent 'reviewer' has invalid runner\.type/);
	});

	it("gets only the effective agent detail and respects explicit scope", () => {
		const projectAgentsDir = path.join(tempDir, ".pi", "agents");
		const userAgentsDir = path.join(tempDir, "agent-home", "agents");
		const packageDir = path.join(tempDir, ".pi", "npm", "node_modules", "test-agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.mkdirSync(path.join(packageDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(projectAgentsDir, "worker.md"), "---\nname: worker\ndescription: Project worker override\n---\n\nProject worker.\n");
		fs.writeFileSync(path.join(userAgentsDir, "worker.md"), "---\nname: worker\ndescription: User worker override\n---\n\nUser worker.\n");
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["agents"] } }));
		fs.writeFileSync(path.join(packageDir, "agents", "worker.md"), "---\nname: worker\ndescription: Package worker override\n---\n\nPackage worker.\n");
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };

		const effective = readText(handleManagementAction("get", { agent: "worker" }, ctx));
		assert.match(effective, /Agent: worker \(project\)/);
		assert.match(effective, /Description: Project worker override/);
		assert.doesNotMatch(effective, /User worker override|Package worker override|Implementation agent for normal tasks/);

		const userScoped = readText(handleManagementAction("get", { agent: "worker", agentScope: "user" }, ctx));
		assert.match(userScoped, /Agent: worker \(user\)/);
		assert.match(userScoped, /Description: User worker override/);
		assert.doesNotMatch(userScoped, /Project worker override|Implementation agent for normal tasks/);

	});

	it("surfaces package source and external-job provider status in list and get", () => {
		const packageDir = path.join(tempDir, ".pi", "npm", "node_modules", "test-surf");
		fs.mkdirSync(path.join(packageDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "test-surf",
			version: "9.8.7",
			pi: { subagents: { agents: ["agents"] } },
		}));
		fs.writeFileSync(path.join(packageDir, "agents", "gpt-pro.md"), `---
name: gpt-pro
description: ChatGPT Pro advisor via Surf
runner:
  type: external-job
  provider: test-surf-oracle
  options:
    model: pro
async: true
---
Advise only.
`);
		const dispose = registerExternalJobProvider({
			name: "test-surf-oracle",
			start: () => ({ providerJobId: "job", state: "completed" }),
			status: () => ({ providerJobId: "job", state: "completed" }),
			result: () => ({ providerJobId: "job", state: "completed", output: "ok" }),
			reattach: () => ({ providerJobId: "job", state: "completed" }),
		});
		try {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const listed = readText(handleList({}, ctx));
			assert.match(listed, /Package agents/);
			assert.match(listed, /- gpt-pro \(test-surf@9\.8\.7, external-job:test-surf-oracle ✓\): ChatGPT Pro advisor via Surf/);

			const detail = readText(handleManagementAction("get", { agent: "gpt-pro" }, ctx));
			assert.match(detail, /Source package: test-surf@9\.8\.7/);
			assert.match(detail, new RegExp(`Package root: ${packageDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.match(detail, /Runner: external-job via test-surf-oracle ✓/);
			assert.match(detail, /Runner options: {"model":"pro"}/);
		} finally {
			dispose();
		}
	});

	it("keeps external-job provider registry errors visible", () => {
		const packageDir = path.join(tempDir, ".pi", "npm", "node_modules", "test-surf");
		fs.mkdirSync(path.join(packageDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "test-surf",
			version: "9.8.7",
			pi: { subagents: { agents: ["agents"] } },
		}));
		fs.writeFileSync(path.join(packageDir, "agents", "gpt-pro.md"), `---
name: gpt-pro
description: ChatGPT Pro advisor via Surf
runner:
  type: external-job
  provider: test-surf-oracle
---
Advise only.
`);
		const key = Symbol.for(EXTERNAL_JOB_PROVIDER_REGISTRY_KEY);
		const globals = globalThis as Record<PropertyKey, unknown>;
		const previous = globals[key];
		globals[key] = { version: 0, providers: new Map() };
		try {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const listed = readText(handleList({}, ctx));
			assert.match(listed, /- gpt-pro \(test-surf@9\.8\.7, external-job:test-surf-oracle \?\): ChatGPT Pro advisor via Surf/);
			assert.match(listed, /External-job provider registry unavailable: Unsupported external-job provider registry/);

			const detail = readText(handleManagementAction("get", { agent: "gpt-pro" }, ctx));
			assert.match(detail, /Runner: external-job via test-surf-oracle \?/);
			assert.match(detail, /External-job provider registry unavailable: Unsupported external-job provider registry/);
		} finally {
			if (previous === undefined) delete globals[key];
			else globals[key] = previous;
		}
	});

	it("does not apply a malformed project diagnostic to an explicit user get", () => {
		const projectAgentsDir = path.join(tempDir, ".pi", "agents");
		const userAgentsDir = path.join(tempDir, "agent-home", "agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.writeFileSync(path.join(userAgentsDir, "worker.md"), "---\nname: worker\ndescription: User worker\n---\nUser worker.\n");
		fs.writeFileSync(path.join(projectAgentsDir, "worker.md"), "---\nname: worker\ndescription: Broken project worker\nrunner:\n  type: unknown\n---\nBroken worker.\n");
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };

		const userScoped = handleManagementAction("get", { agent: "worker", agentScope: "user" }, ctx);
		assert.equal(userScoped.isError, false);
		assert.match(readText(userScoped), /Agent: worker \(user\)/);
		assert.match(readText(userScoped), /Description: User worker/);
	});

	it("blocks a malformed higher-precedence user agent from an extra user agent", () => {
		const previousExtraDirs = process.env[EXTRA_AGENT_DIRS_ENV];
		const extraAgentsDir = path.join(tempDir, "extra-agents");
		try {
			process.env[EXTRA_AGENT_DIRS_ENV] = extraAgentsDir;
			fs.mkdirSync(extraAgentsDir, { recursive: true });
			fs.writeFileSync(path.join(extraAgentsDir, "foo.md"), "---\nname: foo\ndescription: Extra user foo\n---\nExtra user foo.\n");
			fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "agents"), { recursive: true });
			fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "foo.md"), "---\nname: foo\ndescription: Broken configured user foo\nrunner:\n  type: unknown\n---\nBroken user foo.\n");
			const result = handleManagementAction("get", { agent: "foo", agentScope: "user" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } });
			assert.equal(result.isError, true);
			assert.match(readText(result), /Agent 'foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
		} finally {
			if (previousExtraDirs === undefined) delete process.env[EXTRA_AGENT_DIRS_ENV];
			else process.env[EXTRA_AGENT_DIRS_ENV] = previousExtraDirs;
		}
	});

	it("blocks a malformed higher-precedence package agent from a lower package agent", () => {
		const highPackage = path.join(tempDir, "high-package");
		const lowPackage = path.join(tempDir, "low-package");
		for (const packageRoot of [highPackage, lowPackage]) {
			fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["agents"] } }));
		}
		fs.writeFileSync(path.join(highPackage, "agents", "foo.md"), "---\nname: foo\npackage: acme\ndescription: Broken high package foo\nrunner:\n  type: unknown\n---\nBroken foo.\n");
		fs.writeFileSync(path.join(lowPackage, "agents", "foo.md"), "---\nname: foo\npackage: acme\ndescription: Valid low package foo\n---\nValid foo.\n");
		fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), JSON.stringify({ packages: [highPackage, lowPackage] }));

		const result = handleManagementAction("get", { agent: "acme.foo" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } });
		assert.equal(result.isError, true);
		assert.match(readText(result), /Agent 'acme\.foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
		const localResult = handleManagementAction("get", { agent: "foo" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } });
		assert.equal(localResult.isError, true);
		assert.match(readText(localResult), /Agent 'foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
	});

	it("reports a malformed project agent before lower-priority ambiguity", () => {
		const packageRoot = path.join(tempDir, "package");
		fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["agents"] } }));
		fs.writeFileSync(path.join(packageRoot, "agents", "foo.md"), "---\nname: foo\npackage: acme\ndescription: Package foo\n---\nPackage foo.\n");
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		fs.writeFileSync(path.join(tempDir, ".pi", "agents", "foo.md"), "---\nname: foo\ndescription: Broken project foo\nrunner:\n  type: unknown\n---\nBroken foo.\n");
		fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR!, "agents"), { recursive: true });
		fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "foo.md"), "---\nname: foo\ndescription: User foo\n---\nUser foo.\n");
		const result = handleManagementAction("get", { agent: "foo" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } });
		assert.equal(result.isError, true);
		assert.match(readText(result), /Agent 'foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
	});

	it("does not let malformed packaged diagnostics block an un-packaged local name", () => {
		const projectAgentsDir = path.join(tempDir, ".pi", "agents");
		const userAgentsDir = path.join(tempDir, "agent-home", "agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.writeFileSync(path.join(userAgentsDir, "foo.md"), "---\nname: foo\ndescription: User foo\n---\nUser foo.\n");
		fs.writeFileSync(path.join(projectAgentsDir, "acme.foo.md"), "---\nname: foo\npackage: acme\ndescription: Broken packaged foo\nrunner:\n  type: unknown\n---\nBroken foo.\n");
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };

		const local = handleManagementAction("get", { agent: "foo" }, ctx);
		assert.equal(local.isError, false);
		assert.match(readText(local), /Agent: foo \(user\)/);
		const packaged = handleManagementAction("get", { agent: "acme.foo" }, ctx);
		assert.equal(packaged.isError, true);
		assert.match(readText(packaged), /Agent 'acme\.foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
	});

	it("blocks a malformed invalid-package override of a local agent", () => {
		const projectAgentsDir = path.join(tempDir, ".pi", "agents");
		const userAgentsDir = path.join(tempDir, "agent-home", "agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.writeFileSync(path.join(userAgentsDir, "foo.md"), "---\nname: foo\ndescription: User foo\n---\nUser foo.\n");
		fs.writeFileSync(path.join(projectAgentsDir, "foo.md"), "---\nname: foo\npackage: !!!\ndescription: Broken package\n---\nBroken foo.\n");
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };

		const result = handleManagementAction("get", { agent: "foo" }, ctx);
		assert.equal(result.isError, true);
		assert.match(readText(result), /Agent 'foo' has invalid configuration: Agent 'foo' package is invalid after sanitization/);
	});

	it("blocks a malformed .pi agent from falling back to a legacy project agent", () => {
		const canonicalAgentsDir = path.join(tempDir, ".pi", "agents");
		const legacyAgentsDir = path.join(tempDir, ".agents");
		fs.mkdirSync(canonicalAgentsDir, { recursive: true });
		fs.mkdirSync(legacyAgentsDir, { recursive: true });
		fs.writeFileSync(path.join(legacyAgentsDir, "shared.md"), "---\nname: shared\ndescription: Legacy shared\n---\nLegacy shared.\n");
		fs.writeFileSync(path.join(canonicalAgentsDir, "shared.md"), "---\nname: shared\ndescription: Broken canonical shared\nrunner:\n  type: unknown\n---\nBroken shared.\n");
		const result = handleManagementAction("get", { agent: "shared" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } });
		assert.equal(result.isError, true);
		assert.match(readText(result), /Agent 'shared' has invalid configuration: Agent 'shared' has invalid runner\.type/);
	});

	it("blocks a malformed custom canonical agent directory from falling back to legacy", () => {
		const previousPackageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		const packageRoot = path.join(tempDir, "coding-agent-root");
		try {
			fs.mkdirSync(packageRoot, { recursive: true });
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", piConfig: { configDir: ".custom-pi" } }));
			process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = packageRoot;
			const canonicalAgentsDir = path.join(tempDir, ".custom-pi", "agents");
			const legacyAgentsDir = path.join(tempDir, ".agents");
			fs.mkdirSync(canonicalAgentsDir, { recursive: true });
			fs.mkdirSync(legacyAgentsDir, { recursive: true });
			fs.writeFileSync(path.join(legacyAgentsDir, "shared.md"), "---\nname: shared\ndescription: Legacy shared\n---\nLegacy shared.\n");
			fs.writeFileSync(path.join(canonicalAgentsDir, "shared.md"), "---\nname: shared\ndescription: Broken canonical shared\nrunner:\n  type: unknown\n---\nBroken shared.\n");
			const result = handleManagementAction("get", { agent: "shared" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } });
			assert.equal(result.isError, true);
			assert.match(readText(result), /Agent 'shared' has invalid configuration: Agent 'shared' has invalid runner\.type/);
		} finally {
			if (previousPackageRoot === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
			else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousPackageRoot;
		}
	});

	it("blocks a malformed canonical .agents/agents definition from legacy .agents", () => {
		const previousPackageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		const packageRoot = path.join(tempDir, "coding-agent-root");
		try {
			fs.mkdirSync(packageRoot, { recursive: true });
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", piConfig: { configDir: ".agents" } }));
			process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = packageRoot;
			const legacyAgentsDir = path.join(tempDir, ".agents");
			const canonicalAgentsDir = path.join(legacyAgentsDir, "agents");
			fs.mkdirSync(canonicalAgentsDir, { recursive: true });
			fs.writeFileSync(path.join(legacyAgentsDir, "foo.md"), "---\nname: foo\ndescription: Legacy foo\n---\nLegacy foo.\n");
			fs.writeFileSync(path.join(canonicalAgentsDir, "foo.md"), "---\nname: foo\ndescription: Broken canonical foo\nrunner:\n  type: unknown\n---\nBroken foo.\n");
			const result = handleManagementAction("get", { agent: "foo" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } });
			assert.equal(result.isError, true);
			assert.match(readText(result), /Agent 'foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
		} finally {
			if (previousPackageRoot === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
			else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousPackageRoot;
		}
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

	it("rejects durable chain definitions", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "Review Flow", description: "Review flow", scope: "project", steps: [{ agent: "scout", task: "Inspect" }] } },
			ctx,
		);
		assert.equal(created.isError, true);
		assert.match(readText(created), /Durable chain definitions were removed/);

		const agent = handleCreate(
			{ config: { name: "Scout", description: "Scout", scope: "project" } },
			ctx,
		);
		assert.equal(agent.isError, false);
		const updated = handleUpdate(
			{ agent: "scout", config: JSON.stringify({ steps: [{ agent: "scout", task: "Inspect" }] }) },
			ctx,
		);
		assert.equal(updated.isError, true);
		assert.match(readText(updated), /Durable chain definitions were removed/);
	});

	it("ignores discovered legacy chains during agent management", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const chainsDir = path.join(tempDir, ".pi", "chains");
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(chainsDir, "scout.chain.md"), "---\nname: scout\ndescription: Old scout flow\n---\n\n## worker\nInspect\n", "utf-8");
		fs.writeFileSync(path.join(chainsDir, "scout-review.chain.md"), "---\nname: scout-review\ndescription: Old review flow\n---\n\n## worker\nReview\n", "utf-8");
		fs.writeFileSync(path.join(chainsDir, "reference.chain.md"), "---\nname: reference\ndescription: Old reference flow\n---\n\n## scout-review\nUse old agent\n", "utf-8");

		const created = handleCreate(
			{ config: { name: "Scout", description: "Scout", scope: "project" } },
			ctx,
		);
		assert.equal(created.isError, false);

		const updated = handleUpdate(
			{ agent: "scout", config: { name: "Scout Review" } },
			ctx,
		);
		assert.equal(updated.isError, false);
		assert.doesNotMatch(readText(updated), /chains/i);

		const deleted = handleManagementAction("delete", { agent: "scout-review" }, ctx);
		assert.equal(deleted.isError, false);
		assert.doesNotMatch(readText(deleted), /chains/i);
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
					acceptance: { level: "none", reason: "lightweight reviewer" },
					outputMode: "file-only",
				},
			},
			ctx,
		);

		assert.equal(result.isError, false);
		const filePath = path.join(tempDir, ".pi", "agents", "background-reviewer.md");
		let content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^async: false$/m);
		assert.match(content, /^timeoutMs: 120000$/m);
		assert.match(content, /^acceptance: \{"level":"none","reason":"lightweight reviewer"\}$/m);
		assert.match(content, /^outputMode: file-only$/m);

		const got = handleManagementAction("get", { agent: "background-reviewer" }, ctx);
		assert.equal(got.isError, false);
		assert.match(readText(got), /Async: false/);
		assert.match(readText(got), /Timeout: 120000ms/);
		assert.match(readText(got), /Acceptance: \{"level":"none","reason":"lightweight reviewer"\}/);
		assert.match(readText(got), /Output mode: file-only/);

		const updated = handleUpdate(
			{ agent: "background-reviewer", config: { async: true, timeoutMs: false, acceptance: "", outputMode: "inline" } },
			ctx,
		);
		assert.equal(updated.isError, false);
		content = fs.readFileSync(filePath, "utf-8");
		assert.match(content, /^async: true$/m);
		assert.doesNotMatch(content, /^timeoutMs:/m);
		assert.doesNotMatch(content, /^acceptance:/m);
		assert.match(content, /^outputMode: inline$/m);

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

		const invalidOutputMode = handleCreate(
			{
				config: {
					name: "bad-output-mode",
					description: "Bad output mode",
					scope: "project",
					outputMode: false,
				},
			},
			{ cwd: tempDir, modelRegistry: { getAvailable: () => [] } },
		);
		assert.equal(invalidOutputMode.isError, true);
		assert.match(readText(invalidOutputMode), /config\.outputMode must be 'inline' or 'file-only'/);
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
			{ config: { name: "bad-chain-budget", description: "Bad budget", scope: "project", steps: [{ agent: "reviewer" }] } },
			ctx,
		);
		assert.equal(chainResult.isError, true);
		assert.match(readText(chainResult), /Durable chain definitions were removed/);
	});

	it("creates, updates, reports, clears, and validates acceptance roles", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const created = handleCreate(
			{ config: { name: "explorer", description: "Explore code", scope: "project", acceptanceRole: "read-only" } },
			ctx,
		);
		assert.equal(created.isError, false);

		const filePath = path.join(tempDir, ".pi", "agents", "explorer.md");
		assert.match(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole: read-only$/m);
		assert.match(readText(handleManagementAction("get", { agent: "explorer" }, ctx)), /Acceptance role: read-only/);

		const updated = handleUpdate({ agent: "explorer", config: { acceptanceRole: "writer" } }, ctx);
		assert.equal(updated.isError, false);
		assert.match(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole: writer$/m);

		const cleared = handleUpdate({ agent: "explorer", config: { acceptanceRole: false } }, ctx);
		assert.equal(cleared.isError, false);
		assert.doesNotMatch(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole:/m);

		assert.equal(handleUpdate({ agent: "explorer", config: { acceptanceRole: "read-only" } }, ctx).isError, false);
		assert.equal(handleUpdate({ agent: "explorer", config: { acceptanceRole: "" } }, ctx).isError, false);
		assert.doesNotMatch(fs.readFileSync(filePath, "utf-8"), /^acceptanceRole:/m);

		const invalid = handleUpdate({ agent: "explorer", config: { acceptanceRole: "observer" } }, ctx);
		assert.equal(invalid.isError, true);
		assert.match(readText(invalid), /config\.acceptanceRole must be 'read-only', 'writer', or false/);
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
		assert.ok(readText(got).includes("Subagent-only extensions: " + path.join(tempDir, ".pi", "agents", "tools", "child-only.ts") + ", /opt/pi/child.ts"));
	});

	it("preserves relative extension paths during unrelated updates", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const agentPath = path.join(tempDir, ".pi", "agents", "portable.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(
			agentPath,
			"---\nname: portable\ndescription: Portable agent\nextensions: ./tools/parent.ts, package-extension\nsubagentOnlyExtensions: ../child.ts, ~/shared.ts\n---\nOriginal prompt.\n",
		);

		const updated = handleUpdate({ agent: "portable", config: { description: "Updated agent" } }, ctx);

		assert.equal(updated.isError, false);
		const content = fs.readFileSync(agentPath, "utf-8");
		assert.match(content, /^description: Updated agent$/m);
		assert.match(content, /^extensions: \.\/tools\/parent\.ts, package-extension$/m);
		assert.match(content, /^subagentOnlyExtensions: \.\.\/child\.ts, ~\/shared\.ts$/m);
		assert.ok(!content.includes(tempDir));
	});

	it("fails when extension frontmatter cannot be reread", () => {
		const filePath = path.join(tempDir, ".pi", "agents", "removed.md");
		assert.throws(
			() => editableAgentConfig({
				name: "removed",
				description: "Removed agent",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				systemPrompt: "Original prompt.",
				source: "project",
				filePath,
				extensions: [path.join(tempDir, ".pi", "agents", "tools", "parent.ts")],
			}),
			/ENOENT/,
		);
	});

	it("returns a structured error when a definition disappears after discovery", () => {
		const agentPath = path.join(tempDir, ".pi", "agents", "removed-during-update.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(
			agentPath,
			"---\nname: removed-during-update\ndescription: Temporary agent\nextensions: ./tools/parent.ts\n---\nOriginal prompt.\n",
		);
		let cwdReads = 0;
		const ctx = {
			get cwd() {
				cwdReads += 1;
				// handleUpdate reads cwd again after discovery, which models the definition disappearing between reads.
				if (cwdReads === 2) fs.unlinkSync(agentPath);
				return tempDir;
			},
			modelRegistry: { getAvailable: () => [] },
		};

		const updated = handleUpdate({ agent: "removed-during-update", config: { description: "Updated agent" } }, ctx);

		assert.equal(updated.isError, true);
		assert.match(readText(updated), /Could not reread agent definition .*removed-during-update\.md before updating 'removed-during-update':.*ENOENT/);
		assert.equal(fs.existsSync(agentPath), false);
	});

	it("does not serialize settings overrides into custom agent frontmatter during updates", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] } };
		const userSettingsPath = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
		fs.writeFileSync(userSettingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					implementer: {
						output: "user.md",
						defaultReads: ["user.md"],
						model: "anthropic/claude-sonnet-4-6",
					},
				},
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					implementer: {
						output: "artifacts/implementer.md",
						outputMode: "file-only",
						defaultReads: ["CONTEXT.md"],
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
		assert.match(beforeText, /Output: artifacts\/implementer\.md/);
		assert.match(beforeText, /Output mode: file-only/);
		assert.match(beforeText, /Reads: CONTEXT\.md/);
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
		assert.doesNotMatch(content, /^output:/m);
		assert.doesNotMatch(content, /^outputMode:/m);
		assert.doesNotMatch(content, /^defaultReads:/m);
		assert.doesNotMatch(content, /^model:/m);
		assert.doesNotMatch(content, /^systemPromptMode:/m);
		assert.doesNotMatch(content, /^inheritProjectContext:/m);
		assert.doesNotMatch(content, /^inheritSkills:/m);

		const gotAfter = handleManagementAction("get", { agent: "implementer" }, ctx);
		assert.equal(gotAfter.isError, false);
		const afterText = readText(gotAfter);
		assert.match(afterText, /Output: artifacts\/implementer\.md/);
		assert.match(afterText, /Output mode: file-only/);
		assert.match(afterText, /Reads: CONTEXT\.md/);
		assert.match(afterText, /Model: anthropic\/claude-sonnet-4-6/);
		assert.match(afterText, /System prompt mode: append/);
		assert.match(afterText, /Inherit project context: true/);
		assert.match(afterText, /Inherit skills: true/);
	});

	it("does not serialize settings descriptions, fast, or defaults into custom agent frontmatter during updates", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: {
				defaultModel: "openai/gpt-default",
				defaultThinking: "high",
				agentOverrides: {
					implementer: { description: "Settings description", output: "settings.md", fast: true },
				},
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: Frontmatter description
---

Drive the failing test first.
`, "utf-8");

		const beforeText = readText(handleManagementAction("get", { agent: "implementer" }, ctx));
		assert.match(beforeText, /Description: Settings description/);
		assert.match(beforeText, /Model: openai\/gpt-default/);
		assert.match(beforeText, /Thinking: high/);

		const updated = handleUpdate({ agent: "implementer", config: { output: "local.md" } }, ctx);
		assert.equal(updated.isError, false);

		const content = fs.readFileSync(agentPath, "utf-8");
		assert.match(content, /^description: Frontmatter description$/m);
		assert.match(content, /^output: local\.md$/m);
		assert.doesNotMatch(content, /^fast:/m);
		assert.doesNotMatch(content, /^model:/m);
		assert.doesNotMatch(content, /^thinking:/m);
	});

	it("keeps same-value custom override ownership for interactive admin edits", async () => {
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: {
				agentOverrides: { implementer: { model: "anthropic/claude-old" } },
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: Frontmatter description
model: anthropic/claude-old
---

Drive the failing test first.
`, "utf-8");
		const sent: unknown[] = [];
		const notified: string[] = [];

		await openSubagentsAdmin(
			{ sendMessage: (message: unknown) => sent.push(message) } as never,
			{
				cwd: tempDir,
				hasUI: true,
				modelRegistry: {
					getAvailable: () => [
						{ provider: "anthropic", id: "claude-old" },
						{ provider: "anthropic", id: "claude-new" },
					],
				},
				ui: {
					select: async () => "anthropic/claude-new",
					notify: (message: string) => notified.push(message),
				},
			} as never,
			"implementer model",
		);

		assert.match(notified[0] ?? "", /Saved project settings override/);
		assert.match(JSON.stringify(sent), /Saved project settings override/);
		assert.match(fs.readFileSync(agentPath, "utf-8"), /^model: anthropic\/claude-old$/m);
		assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf-8")).subagents.agentOverrides.implementer.model, "anthropic/claude-new");
		const after = readText(handleManagementAction("get", { agent: "implementer" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } }));
		assert.match(after, /Model: anthropic\/claude-new/);
	});

	it("promotes cross-scope custom override edits to project settings", async () => {
		const userSettingsPath = path.join(tempDir, "agent-home", "settings.json");
		const projectSettingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(userSettingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					implementer: { model: "anthropic/claude-old" },
					critic: { thinking: "high" },
					speaker: { systemPrompt: "Shared prompt" },
				},
			},
		}, null, 2), "utf-8");
		fs.writeFileSync(projectSettingsPath, JSON.stringify({
			subagents: { defaultModel: "openai/gpt-default" },
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: Frontmatter description
---

Drive the failing test first.
`, "utf-8");
		fs.writeFileSync(path.join(path.dirname(agentPath), "critic.md"), `---
name: critic
description: Thinking critic
thinking: false
---

Keep thinking off.
`, "utf-8");
		fs.writeFileSync(path.join(path.dirname(agentPath), "speaker.md"), `---
name: speaker
description: Prompt speaker
---

Base prompt.
`, "utf-8");
		const sent: unknown[] = [];
		const notified: string[] = [];

		await openSubagentsAdmin(
			{ sendMessage: (message: unknown) => sent.push(message) } as never,
			{
				cwd: tempDir,
				hasUI: true,
				modelRegistry: {
					getAvailable: () => [
						{ provider: "anthropic", id: "claude-old" },
						{ provider: "anthropic", id: "claude-new" },
					],
				},
				ui: {
					select: async () => "anthropic/claude-new",
					notify: (message: string) => notified.push(message),
				},
			} as never,
			"implementer model",
		);

		assert.match(notified[0] ?? "", /Saved project settings override/);
		assert.match(JSON.stringify(sent), /Saved project settings override/);
		assert.doesNotMatch(fs.readFileSync(agentPath, "utf-8"), /^model:/m);
		assert.equal(JSON.parse(fs.readFileSync(userSettingsPath, "utf-8")).subagents.agentOverrides.implementer.model, "anthropic/claude-old");
		assert.equal(JSON.parse(fs.readFileSync(projectSettingsPath, "utf-8")).subagents.agentOverrides.implementer.model, "anthropic/claude-new");
		const after = readText(handleManagementAction("get", { agent: "implementer" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } }));
		assert.match(after, /Model: anthropic\/claude-new/);

		await openSubagentsAdmin(
			{ sendMessage: (message: unknown) => sent.push(message) } as never,
			{
				cwd: tempDir,
				hasUI: true,
				modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-new" }] },
				ui: {
					select: async () => "Default / inherit session model",
					notify: (message: string) => notified.push(message),
				},
			} as never,
			"implementer model",
		);

		assert.equal(JSON.parse(fs.readFileSync(userSettingsPath, "utf-8")).subagents.agentOverrides.implementer.model, "anthropic/claude-old");
		assert.equal(JSON.parse(fs.readFileSync(projectSettingsPath, "utf-8")).subagents.agentOverrides.implementer.model, "openai/gpt-default");
		const cleared = readText(handleManagementAction("get", { agent: "implementer" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } }));
		assert.match(cleared, /Model: openai\/gpt-default/);
		assert.doesNotMatch(cleared, /Model: anthropic\/claude-old|Model: anthropic\/claude-new/);

		await openSubagentsAdmin(
			{ sendMessage: (message: unknown) => sent.push(message) } as never,
			{
				cwd: tempDir,
				hasUI: true,
				modelRegistry: { getAvailable: () => [] },
				ui: {
					select: async () => "Default / inherit session thinking",
					notify: (message: string) => notified.push(message),
				},
			} as never,
			"critic thinking",
		);

		assert.equal(JSON.parse(fs.readFileSync(userSettingsPath, "utf-8")).subagents.agentOverrides.critic.thinking, "high");
		assert.equal(JSON.parse(fs.readFileSync(projectSettingsPath, "utf-8")).subagents.agentOverrides.critic.thinking, "off");
		const thinkingCleared = readText(handleManagementAction("get", { agent: "critic" }, { cwd: tempDir, modelRegistry: { getAvailable: () => [] } }));
		assert.match(thinkingCleared, /Thinking: off/);

		await openSubagentsAdmin(
			{ sendMessage: (message: unknown) => sent.push(message) } as never,
			{
				cwd: tempDir,
				hasUI: true,
				modelRegistry: { getAvailable: () => [] },
				ui: {
					editor: async () => "Shared prompt",
					notify: (message: string) => notified.push(message),
				},
			} as never,
			"speaker system-prompt",
		);

		assert.equal(JSON.parse(fs.readFileSync(userSettingsPath, "utf-8")).subagents.agentOverrides.speaker.systemPrompt, "Shared prompt");
		assert.equal(JSON.parse(fs.readFileSync(projectSettingsPath, "utf-8")).subagents.agentOverrides.speaker.systemPrompt, "Shared prompt");
	});

	it("preserves blank output and defaultReads frontmatter while settings overrides replace them", () => {
		const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		const agentPath = path.join(tempDir, ".pi", "agents", "implementer.md");
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			subagents: { agentOverrides: { implementer: { output: "settings.md", defaultReads: ["settings.md"] } } },
		}, null, 2), "utf-8");
		fs.writeFileSync(agentPath, `---
name: implementer
description: TDD implementer
output:
defaultReads:
---

Drive the failing test first.
`, "utf-8");

		const updated = handleUpdate({ agent: "implementer", config: { description: "Updated implementer" } }, ctx);
		assert.equal(updated.isError, false);

		const content = fs.readFileSync(agentPath, "utf-8");
		assert.match(content, /^output: ?$/m);
		assert.match(content, /^defaultReads: ?$/m);
		const after = readText(handleManagementAction("get", { agent: "implementer" }, ctx));
		assert.match(after, /Output: settings\.md/);
		assert.match(after, /Reads: settings\.md/);
	});

	it("preserves explicit default-like frontmatter while settings overrides replace it", () => {
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
		assert.match(beforeText, /Thinking: high/);
		assert.doesNotMatch(beforeText, /Thinking: off/);

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
		assert.match(afterText, /Thinking: high/);
		assert.doesNotMatch(afterText, /Thinking: off/);
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
		assert.match(text, /^Subagent models/m);
		assert.match(text, /Current session model:\n  openai\/gpt-5-mini/);
		assert.match(text, /(?:^|\n)scout\n  model:\n    openai\/gpt-5-mini\n  source: inherits current session model(?:\n|$)/);
		assert.match(text, /(?:^|\n)advisor\n  model:\n    openai\/gpt-5-mini\n  source: inherits current session model(?:\n|$)/);
		assert.doesNotMatch(text, /advisor\n  model:\n    \(builtin definition not found\)/);
		assert.match(text, /Available models in this session's registry/);
		assert.match(text, /  anthropic\/claude-sonnet-4\n  openai\/gpt-5-mini/);
		assert.match(text, /Use an exact provider\/id from this list when you pass model/);
	});

	it("resolves the advisor builtin alias in a filtered model mapping", () => {
		const result = handleManagementAction("models", { agent: "advisor" }, {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5-mini" }] },
			model: { provider: "openai", id: "gpt-5-mini" },
		});
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /Agent: advisor/);
		assert.match(text, /Effective model:\n  openai\/gpt-5-mini/);
		assert.doesNotMatch(text, /Builtin agent 'advisor' not found|source: missing/);
	});

	it("reports effective model mappings for discovered package, user, and project agents", () => {
		const projectAgentsDir = path.join(tempDir, ".pi", "agents");
		const userAgentsDir = path.join(tempDir, "agent-home", "agents");
		const packageDir = path.join(tempDir, ".pi", "npm", "node_modules", "model-agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.mkdirSync(path.join(packageDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "model-agents",
			version: "1.2.3",
			pi: { subagents: { agents: ["agents"] } },
		}));
		const writeAgent = (dir: string, name: string, model: string, thinking: string, fallback: string) => fs.writeFileSync(path.join(dir, `${name}.md`), [
			"---",
			`name: ${name}`,
			`description: ${name} model mapping`,
			`model: ${model}`,
			`thinking: ${thinking}`,
			`fallbackModels: ${fallback}`,
			"---",
			"Model mapping test agent.",
		].join("\n"));
		writeAgent(path.join(packageDir, "agents"), "package-worker", "anthropic/claude-sonnet-4", "low", "openai/gpt-5-mini");
		writeAgent(userAgentsDir, "user-worker", "gpt-5-mini", "medium", "claude-sonnet-4");
		writeAgent(userAgentsDir, "shadowed", "openai/gpt-5-mini", "low", "anthropic/claude-sonnet-4");
		writeAgent(projectAgentsDir, "project-worker", "anthropic/claude-sonnet-4", "high", "openai/gpt-5-mini");
		writeAgent(projectAgentsDir, "shadowed", "openai/gpt-5-mini", "high", "anthropic/claude-sonnet-4");
		fs.writeFileSync(path.join(projectAgentsDir, "off-worker.md"), [
			"---",
			"name: off-worker",
			"description: off-worker model mapping",
			"model: openai/gpt-5-mini",
			"thinking: false",
			"---",
			"Explicitly disable thinking.",
		].join("\n"));
		const settingsPath = path.join(tempDir, ".pi", "settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ subagents: { agentOverrides: { reviewer: { disabled: true } } } }));

		const ctx = {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [
				{ provider: "openai", id: "gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4" },
			] },
			model: { provider: "openai", id: "gpt-5-mini" },
		};
		const result = handleManagementAction("models", {}, ctx);
		const text = readText(result);
		assert.equal(result.isError, false);
		assert.match(text, /package-worker\n  model:\n    anthropic\/claude-sonnet-4\n  source: package agent config\n  thinking: low\n  fallback models:\n    openai\/gpt-5-mini/);
		assert.match(text, /user-worker\n  model:\n    openai\/gpt-5-mini\n  source: user agent config\n  thinking: medium/);
		assert.match(text, /project-worker\n  model:\n    anthropic\/claude-sonnet-4\n  source: project agent config\n  thinking: high/);
		assert.match(text, /off-worker\n  model:\n    openai\/gpt-5-mini\n  source: project agent config\n  thinking: off/);
		assert.match(text, /shadowed\n  model:\n    openai\/gpt-5-mini\n  source: project agent config/);
		assert.doesNotMatch(text, /shadowed\n  model:\n    openai\/gpt-5-mini\n  source: user agent config/);
		assert.match(text, /reviewer\n  model:\n    openai\/gpt-5-mini\n  source: inherits current session model; disabled/);
		assert.doesNotMatch(text, /api[_-]?key|token|secret/i);
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
		assert.match(text, /^Subagent model/m);
		assert.match(text, /Agent: reviewer/);
		assert.match(text, /Effective model:\n  anthropic\/claude-sonnet-4/);
		assert.match(text, /Source: project override/);
		assert.match(text, /Requested model setting:\n  claude-sonnet-4/);
		assert.match(text, /Disabled: true/);
		assert.match(text.replaceAll("\\", "/"), /Override file:\n  .*\.pi\/settings\.json/);
	});

	it("rejects unknown agents for runtime model mappings", () => {
		const result = handleManagementAction("models", { agent: "not-a-builtin" }, {
			cwd: tempDir,
			modelRegistry: { getAvailable: () => [] },
		});

		assert.equal(result.isError, true);
		assert.match(readText(result), /Agent 'not-a-builtin' not found/);
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
