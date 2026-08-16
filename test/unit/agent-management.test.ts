import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCreate, handleList, handleManagementAction, handleUpdate } from "../../src/agents/agent-management.ts";
import { EXTRA_AGENT_DIRS_ENV } from "../../src/agents/agents.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

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
