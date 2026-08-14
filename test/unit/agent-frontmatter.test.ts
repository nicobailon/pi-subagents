import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { parseChain, serializeChain } from "../../src/agents/chain-serializer.ts";
import { discoverAgents, discoverAgentsAll, type AgentConfig } from "../../src/agents/agents.ts";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import { THINKING_LEVELS } from "../../src/shared/model-info.ts";

const tempDirs: string[] = [];

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function createNestedLinkedWorktree(): { repo: string; worktree: string } {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-linked-worktree-"));
	tempDirs.push(repo);
	execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
	execFileSync("git", ["add", "base.txt"], { cwd: repo });
	execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });

	const worktree = path.join(repo, ".worktrees", "linked");
	execFileSync("git", ["worktree", "add", "-b", "linked", worktree], { cwd: repo, stdio: "ignore" });
	return { repo, worktree };
}

function writeLinkedWorktreePackage(repo: string): { packageAgentName: string; packageAgentPath: string; settingsPath: string } {
	const packageAgentName = "issue950-workflow.reviewer";
	const packageRoot = path.join(repo, ".pi", "vendor", "workflow");
	const packageAgentPath = path.join(packageRoot, "agents", "reviewer.md");
	const settingsPath = path.join(repo, ".pi", "settings.json");
	writeJson(settingsPath, {
		packages: [{ source: "file:./vendor/workflow" }],
		subagents: {
			projectRootResolution: "git-root",
			agentOverrides: {
				reviewer: { model: "issue950/outer-model" },
			},
		},
	});
	writeJson(path.join(packageRoot, "package.json"), {
		name: "issue950-workflow",
		"pi-subagents": { agents: ["./agents"] },
	});
	writeAgent(packageAgentPath, `---
name: reviewer
package: issue950-workflow
description: Review from the primary checkout.
---

Review the linked worktree.
`);
	return { packageAgentName, packageAgentPath, settingsPath };
}

function withTempHome<T>(fn: (home: string) => T): T {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-home-"));
	tempDirs.push(home);
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
	const oldPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	try {
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		if (oldPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiCodingAgentDir;
		if (oldExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = oldExtraAgentDirs;
	}
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("folded frontmatter blocks", () => {
	it("folds ordinary lines and paragraph breaks for > and >-", () => {
		const expected = "first line second line\nthird line";
		const folded = parseFrontmatter(`---
name: worker
description: >
  first line
  second line

  third line
---
body`);
		const stripped = parseFrontmatter(`---
name: worker
description: >-
  first line
  second line

  third line
---
body`);

		assert.equal(folded.frontmatter.description, expected);
		assert.equal(stripped.frontmatter.description, expected);
		assert.equal(folded.frontmatter.name, "worker");
	});

	it("keeps quoted indicators as literal values", () => {
		const parsed = parseFrontmatter(`---
description: ">"
other: '>-'
---
body`);

		assert.equal(parsed.frontmatter.description, ">");
		assert.equal(parsed.frontmatter.other, ">-");
	});

	it("preserves lines for | and |-", () => {
		for (const indicator of ["|", "|-"]) {
			const parsed = parseFrontmatter(`---
description: ${indicator}
  first line
  second line
---
body`);
			assert.equal(parsed.frontmatter.description, "first line\nsecond line");
		}
	});

	it("preserves more-indented lines and repeated whitespace-only separators", () => {
		const parsed = parseFrontmatter(`---
description: >
  normal
    code
  next

  first

  ${" ".repeat(3)}
  second
name: worker
---
body`);

		assert.equal(parsed.frontmatter.description, "normal\n  code\nnext\nfirst\n\nsecond");
		assert.equal(parsed.frontmatter.name, "worker");
	});

	it("keeps paragraph breaks adjacent to more-indented lines", () => {
		const afterIndented = parseFrontmatter(`---
description: >
  normal
    code

  next
---
body`);
		const beforeIndented = parseFrontmatter(`---
description: >
  normal

    code
  next
---
body`);

		assert.equal(afterIndented.frontmatter.description, "normal\n  code\n\nnext");
		assert.equal(beforeIndented.frontmatter.description, "normal\n\n  code\nnext");
	});
});

describe("agent runner frontmatter", () => {
	it("parses and serializes an external-cli runner", () => withTempHome(() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runner-agent-"));
		tempDirs.push(project);
		writeAgent(path.join(project, ".pi", "agents", "external.md"), `---
name: external
 description: External runner
runner:
  type: external-cli
  command: ${JSON.stringify(process.execPath)}
  args: ["-e", "process.stdin.pipe(process.stdout)"]
  promptDelivery: stdin
async: true
---
Review carefully.`.replace(" description:", "description:"));

		const external = discoverAgents(project, "project").agents.find((agent) => agent.name === "external")!;
		assert.deepEqual(external.runner, { type: "external-cli", command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], promptDelivery: "stdin" });
		assert.match(serializeAgent(external), /runner:\n  type: external-cli\n  command:/);
		assert.deepEqual(discoverAgents(project, "project").agents.find((agent) => agent.name === "external")?.runner, external.runner);
	}));

	it("rejects invalid and Pi-only external runner fields", () => withTempHome(() => {
		const invalidCases = [
			"type: unknown\n  command: node",
			"type: external-cli\n  command: ''",
			"type: external-cli\n  command: node\n  args: nope",
			"type: external-cli\n  command: node\n  args: [ok, 1]",
			"type: external-cli\n  command: node\n  promptDelivery: argv",
		];
		for (const [index, runner] of invalidCases.entries()) {
			const project = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagents-invalid-runner-${index}-`));
			tempDirs.push(project);
			writeAgent(path.join(project, ".pi", "agents", "external.md"), `---\nname: external\ndescription: External\nrunner:\n  ${runner}\n---\nBody`);
			assert.throws(() => discoverAgents(project, "project"), /invalid runner\.type|non-empty command|args must be an array of strings|promptDelivery must be 'stdin'/);
		}
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runner-pi-only-"));
		tempDirs.push(project);
		writeAgent(path.join(project, ".pi", "agents", "external.md"), `---\nname: external\ndescription: External\nrunner:\n  type: external-cli\n  command: node\nmodel: provider/model\n---\nBody`);
		assert.throws(() => discoverAgents(project, "project"), /unsupported Pi-only fields: model/);
	}));
});

describe("agent skillPath frontmatter", () => {
	it("parses and serializes comma-separated paths", () => withTempHome(() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-skill-path-agent-"));
		tempDirs.push(project);
		writeAgent(path.join(project, ".pi", "agents", "worker.md"), `---
name: worker
description: Worker
skillPath: ./skills, ../shared-skills
---
body`);

		const worker = discoverAgents(project, "both").agents.find((agent) => agent.name === "worker")!;
		assert.deepEqual(worker.skillPath, ["./skills", "../shared-skills"]);
		assert.match(serializeAgent(worker), /^skillPath: \.\/skills, \.\.\/shared-skills$/m);
	}));
});

describe("agent aliases", () => {
	it("parses and serializes agent aliases", () => withTempHome(() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-alias-agent-"));
		tempDirs.push(project);
		writeAgent(path.join(project, ".pi", "agents", "worker.md"), `---
name: worker
description: Worker
aliases: developer, coder, worker
---
body`);

		const worker = discoverAgents(project, "both").agents.find((agent) => agent.name === "worker")!;
		assert.deepEqual(worker.aliases, ["developer", "coder"]);
		assert.match(serializeAgent(worker), /^aliases: developer, coder$/m);

		const ctx = { cwd: project, modelRegistry: { getAvailable: () => [] } };
		assert.match(handleManagementAction("list", {}, ctx).content[0]?.text ?? "", /aliases: developer, coder/);
		assert.match(handleManagementAction("get", { agent: "developer" }, ctx).content[0]?.text ?? "", /Agent: worker/);
	}));

	it("reports management alias collisions as ambiguous", () => withTempHome(() => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-alias-collision-"));
		tempDirs.push(project);
		writeAgent(path.join(project, ".pi", "agents", "review-agent.md"), `---
name: review-agent
description: Custom reviewer
aliases: developer
---
body`);

		const ctx = { cwd: project, modelRegistry: { getAvailable: () => [] } };
		const getResult = handleManagementAction("get", { agent: "developer" }, ctx);
		assert.equal(getResult.isError, true);
		assert.match(getResult.content[0]?.text ?? "", /Ambiguous agent alias or name 'developer': review-agent, worker/);

		const disableResult = handleManagementAction("disable", { agent: "developer" }, ctx);
		assert.equal(disableResult.isError, true);
		assert.match(disableResult.content[0]?.text ?? "", /Ambiguous agent alias 'developer': worker, review-agent|Ambiguous agent alias 'developer': review-agent, worker/);
	}));
});

describe("agent simple-scalar list frontmatter", () => {
	it("discovers newline block lists for all list fields and routes MCP tools", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-block-list-frontmatter-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "worker.md"), `---
name: worker
description: Worker
tools:
  - read-only
  - mcp:github/search_repositories
defaultReads:
  - input-one.md
  - input-two.md
skill:
  - review-checklist
  - safe-bash
skillPath:
  - ./private-skills
  - ../shared-skills
fallbackModels:
  - openai/gpt-5-mini
  - anthropic/claude-sonnet-4
extensions:
  - ./extension-one.ts
  - ./extension-two.ts
subagentOnlyExtensions:
  - ./child-only.ts
  - ./child-helper.ts
---

Do work
`);

		const worker = discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker");
		assert.deepEqual(worker?.tools, ["read-only"]);
		assert.deepEqual(worker?.mcpDirectTools, ["github/search_repositories"]);
		assert.deepEqual(worker?.defaultReads, ["input-one.md", "input-two.md"]);
		assert.deepEqual(worker?.skills, ["review-checklist", "safe-bash"]);
		assert.deepEqual(worker?.skillPath, ["./private-skills", "../shared-skills"]);
		assert.deepEqual(worker?.fallbackModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.deepEqual(worker?.extensions, ["./extension-one.ts", "./extension-two.ts"]);
		assert.deepEqual(worker?.subagentOnlyExtensions, ["./child-only.ts", "./child-helper.ts"]);
	});

	it("preserves MCP-only tools as an explicit empty builtin allowlist", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-mcp-only-frontmatter-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "mcp-only.md"), `---
name: mcp-only
description: MCP only
tools: mcp:github/search_repositories
---

Do MCP work
`);

		const agent = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "mcp-only");
		assert.deepEqual(agent?.tools, []);
		assert.deepEqual(agent?.mcpDirectTools, ["github/search_repositories"]);
		assert.match(serializeAgent(agent!), /^tools: mcp:github\/search_repositories$/m);
	});

	it("preserves comma-separated syntax across all list fields", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-comma-list-frontmatter-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "worker.md"), `---
name: worker
description: Worker
tools: read-only, mcp:github/search_repositories
defaultReads: input-one.md, input-two.md
skills: review-checklist, safe-bash
skillPath: ./private-skills, ../shared-skills
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
extensions: ./extension-one.ts, ./extension-two.ts
subagentOnlyExtensions: ./child-only.ts, ./child-helper.ts
---

Do work
`);

		const worker = discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker");
		assert.deepEqual(worker?.tools, ["read-only"]);
		assert.deepEqual(worker?.mcpDirectTools, ["github/search_repositories"]);
		assert.deepEqual(worker?.defaultReads, ["input-one.md", "input-two.md"]);
		assert.deepEqual(worker?.skills, ["review-checklist", "safe-bash"]);
		assert.deepEqual(worker?.skillPath, ["./private-skills", "../shared-skills"]);
		assert.deepEqual(worker?.fallbackModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.deepEqual(worker?.extensions, ["./extension-one.ts", "./extension-two.ts"]);
		assert.deepEqual(worker?.subagentOnlyExtensions, ["./child-only.ts", "./child-helper.ts"]);
	});
});

describe("agent permission frontmatter", () => {
	it("parses and preserves explicit non-bash permission rules", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-permission-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
tools: bash,read,write
permission:
  read: allow
  write: ask
  edit: deny
---

Do work
`, "utf-8");

		const worker = discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker");
		assert.deepEqual(worker?.permissions, { read: "allow", write: "ask", edit: "deny" });
		assert.equal(worker?.extraFields?.permission, undefined);
		assert.match(serializeAgent(worker!), /^permissions:\n  read: allow\n  write: ask\n  edit: deny$/m);
	});

	it("rejects bash permission rules and conflicting aliases", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-permission-invalid-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---\nname: worker\ndescription: Worker\npermission:\n  bash: deny\n---\n`, "utf-8");
		assert.throws(() => discoverAgents(dir, "project"), /pi-guard/);

		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---\nname: worker\ndescription: Worker\npermission:\n  write: ask\npermissions:\n  edit: deny\n---\n`, "utf-8");
		assert.throws(() => discoverAgents(dir, "project"), /cannot declare both permission and permissions/);
	});
});

describe("agent frontmatter defaultContext", () => {
	it("serializes defaultContext into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
			defaultContext: "fork",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /defaultContext: fork/);
	});

	it("parses defaultContext from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-default-context-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
defaultContext: fork
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.defaultContext, "fork");
	});

	it("loads packaged worker and oracle with fork defaultContext and advisor alias", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-default-context-"));
		tempDirs.push(dir);
		const agents = discoverAgentsAll(dir).builtin;

		for (const name of ["worker", "oracle"]) {
			const agent = agents.find((candidate) => candidate.name === name);
			assert.equal(agent?.defaultContext, "fork", `${name} should default to fork context`);
		}
		const oracle = agents.find((candidate) => candidate.name === "oracle");
		assert.deepEqual(oracle?.aliases, ["advisor"]);
		assert.doesNotMatch(oracle?.tools?.join(",") ?? "", /contact_supervisor/);
		for (const name of ["scout", "researcher", "oracle", "reviewer"]) {
			assert.equal(agents.find((candidate) => candidate.name === name)?.tools?.includes("intercom"), false, `${name} should not require generic intercom`);
		}
		assert.match(oracle?.systemPrompt ?? "", /asking or consulting the oracle/);
		assert.match(oracle?.systemPrompt ?? "", /When runtime bridge instructions provide `contact_supervisor`/);
		assert.match(oracle?.systemPrompt ?? "", /If no supervisor channel is available/);
		assert.equal(agents.some((candidate) => candidate.name === "planner"), false);
		assert.equal(agents.some((candidate) => candidate.name === "context-builder"), false);
	});
});

describe("agent frontmatter launch defaults", () => {
	it("serializes and discovers single-agent launch defaults", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-launch-defaults-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, ".pi", "agents", "worker.md");
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath,
			defaultAsync: false,
			defaultTimeoutMs: 90_000,
			defaultToolTimeoutMs: 600_000,
			defaultTurnBudget: { maxTurns: 12, graceTurns: 2 },
			defaultAcceptance: { level: "none", reason: "lightweight lookup" },
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /^async: false$/m);
		assert.match(serialized, /^timeoutMs: 90000$/m);
		assert.match(serialized, /^toolTimeoutMs: 600000$/m);
		assert.match(serialized, /^turnBudget: \{"maxTurns":12,"graceTurns":2\}$/m);
		assert.match(serialized, /^acceptance: \{"level":"none","reason":"lightweight lookup"\}$/m);
		writeAgent(filePath, serialized);

		const worker = discoverAgents(dir, "project").agents.find((candidate) => candidate.name === "worker");
		assert.equal(worker?.defaultAsync, false);
		assert.equal(worker?.defaultTimeoutMs, 90_000);
		assert.equal(worker?.defaultToolTimeoutMs, 600_000);
		assert.deepEqual(worker?.defaultTurnBudget, { maxTurns: 12, graceTurns: 2 });
		assert.deepEqual(worker?.defaultAcceptance, { level: "none", reason: "lightweight lookup" });
	});

	it("parses scalar acceptance defaults and rejects invalid policies", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-acceptance-defaults-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, ".pi", "agents", "worker.md");
		writeAgent(filePath, `---
name: worker
description: Worker
acceptance: checked
---

Do work
`);
		assert.equal(discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker")?.defaultAcceptance, "checked");

		writeAgent(filePath, `---
name: worker
description: Worker
acceptance: { level: "none", reason: "NA" }
---

Do work
`);
		assert.deepEqual(
			discoverAgents(dir, "project").agents.find((agent) => agent.name === "worker")?.defaultAcceptance,
			{ level: "none", reason: "NA" },
		);

		writeAgent(filePath, `---
name: worker
description: Worker
acceptance: none
---

Do work
`);
		assert.throws(
			() => discoverAgents(dir, "project"),
			/Agent 'worker' acceptance frontmatter level "none" requires a reason/,
		);
	});

	it("parses, serializes, and validates acceptance roles", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-acceptance-role-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, ".pi", "agents", "explorer.md");
		writeAgent(filePath, `---
name: explorer
description: Explorer
acceptanceRole: read-only
---

Explore the codebase
`);

		const explorer = discoverAgents(dir, "project").agents.find((agent) => agent.name === "explorer");
		assert.equal(explorer?.acceptanceRole, "read-only");
		assert.match(serializeAgent(explorer!), /^acceptanceRole: read-only$/m);
		assert.equal(explorer?.extraFields?.acceptanceRole, undefined);

		writeAgent(filePath, `---
name: explorer
description: Explorer
acceptanceRole: observer
---

Explore the codebase
`);
		assert.throws(
			() => discoverAgents(dir, "project"),
			/Agent 'explorer' has invalid acceptanceRole frontmatter; expected 'read-only' or 'writer'/,
		);
	});

	it("rejects invalid launch defaults instead of silently ignoring them", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-invalid-launch-defaults-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "worker.md"), `---
name: worker
description: Worker
async: sometimes
---

Do work
`);

		assert.throws(
			() => discoverAgents(dir, "project"),
			/Agent 'worker' has invalid async frontmatter; expected true or false/,
		);
	});

	it("rejects oversized toolTimeoutMs frontmatter at discovery", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-oversized-tool-timeout-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".pi", "agents", "worker.md"), `---
name: worker
description: Worker
toolTimeoutMs: 2147483648
---

Do work
`);

		assert.throws(
			() => discoverAgents(dir, "project"),
			/Agent 'worker' has invalid toolTimeoutMs frontmatter; expected a positive integer no larger than 2147483647/,
		);
	});
});

describe("chain discovery", () => {
	it("prefers same-scope .chain.json over .chain.md for the same runtime name", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-chain-format-precedence-"));
		tempDirs.push(dir);
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(chainsDir, "dynamic-review.chain.md"), `---
name: dynamic-review
description: Markdown fallback
---

## scout

Run the markdown chain
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "dynamic-review.chain.json"), JSON.stringify({
			name: "dynamic-review",
			description: "JSON dynamic chain",
			chain: [
				{
					agent: "scout",
					task: "Return targets",
					as: "targets",
					outputSchema: { type: "object" },
				},
				{
					expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {item.path}" },
					collect: { as: "reviews" },
				},
			],
		}), "utf-8");

		const result = discoverAgentsAll(dir);
		const chain = result.chains.find((candidate) => candidate.name === "dynamic-review");
		assert.equal(chain?.description, "JSON dynamic chain");
		assert.equal(chain?.filePath.endsWith(".chain.json"), true);
		assert.equal("expand" in (chain?.steps[1] ?? {}), true);
	});
});

describe("package-provided agents and chains", () => {
	it("discovers package agents and chains from installed package manifests", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-discovery-"));
		tempDirs.push(dir);
		const workflowRoot = path.join(dir, ".pi", "npm", "node_modules", "my-pi-workflow");
		const chainsRoot = path.join(dir, ".pi", "npm", "node_modules", "@scope", "chain-workflow");
		writeJson(path.join(workflowRoot, "package.json"), {
			name: "my-pi-workflow",
			"pi-subagents": {
				agents: ["./agents"],
			},
		});
		writeAgent(path.join(workflowRoot, "agents", "reviewer.md"), `---
name: reviewer
package: my-workflow
description: Review changes for this workflow.
---

Review the workflow.
`);
		writeJson(path.join(chainsRoot, "package.json"), {
			name: "@scope/chain-workflow",
			pi: {
				subagents: {
					chains: ["./chains"],
				},
			},
		});
		writeAgent(path.join(chainsRoot, "chains", "review.chain.md"), `---
name: review
package: my-workflow
description: Run workflow review.
---

## my-workflow.reviewer

Review the task.
`);

		const all = discoverAgentsAll(dir);
		const packagedAgent = all.package.find((agent) => agent.name === "my-workflow.reviewer");
		assert.ok(packagedAgent);
		assert.equal(packagedAgent.source, "package");
		assert.equal(packagedAgent.filePath, path.join(workflowRoot, "agents", "reviewer.md"));
		assert.equal(discoverAgents(dir, "both").agents.find((agent) => agent.name === "my-workflow.reviewer")?.source, "package");

		const packagedChain = all.chains.find((chain) => chain.name === "my-workflow.review");
		assert.ok(packagedChain);
		assert.equal(packagedChain.source, "package");
		assert.equal(packagedChain.steps[0]?.agent, "my-workflow.reviewer");
	}));

	it("loads packages referenced from Pi settings", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-settings-package-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "vendor", "workflow");
		writeJson(path.join(dir, ".pi", "settings.json"), {
			packages: [{ source: "file:./vendor/workflow" }],
		});
		writeJson(path.join(packageRoot, "package.json"), {
			name: "settings-workflow",
			pi: {
				subagents: {
					agents: ["./agents"],
				},
			},
		});
		writeAgent(path.join(packageRoot, "agents", "planner.md"), `---
name: planner
package: settings-workflow
description: Plan from a settings-installed package.
---

Plan the work.
`);

		const agent = discoverAgents(dir, "both").agents.find((candidate) => candidate.name === "settings-workflow.planner");
		assert.ok(agent);
		assert.equal(agent.source, "package");
	}));

	it("discovers project package agents when cwd is nested below the project root", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-nested-package-discovery-"));
		tempDirs.push(dir);
		const nested = path.join(dir, "packages", "app", "src");
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "nested-workflow");
		fs.mkdirSync(nested, { recursive: true });
		writeJson(path.join(packageRoot, "package.json"), {
			name: "nested-workflow",
			"pi-subagents": {
				agents: ["./agents"],
			},
		});
		writeAgent(path.join(packageRoot, "agents", "reviewer.md"), `---
name: reviewer
package: nested-workflow
description: Review from a project package.
---

Review nested project work.
`);

		const agent = discoverAgents(nested, "both").agents.find((candidate) => candidate.name === "nested-workflow.reviewer");
		assert.ok(agent);
		assert.equal(agent.source, "package");
		assert.equal(agent.filePath, path.join(packageRoot, "agents", "reviewer.md"));
	}));

	it("keeps nearest project root discovery by default when a nested .pi exists", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-nearest-root-default-"));
		tempDirs.push(dir);
		const nested = path.join(dir, "packages", "app", "src");
		const nestedConfigDir = path.join(dir, "packages", "app", ".pi");
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "outer-workflow");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(nestedConfigDir, { recursive: true });
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
		writeJson(path.join(packageRoot, "package.json"), {
			name: "outer-workflow",
			"pi-subagents": { agents: ["./agents"] },
		});
		writeAgent(path.join(packageRoot, "agents", "planner.md"), `---
name: planner
package: outer-workflow
description: Plan from the outer project package.
---

Plan outer project work.
`);

		const agent = discoverAgents(nested, "both").agents.find((candidate) => candidate.name === "outer-workflow.planner");
		assert.equal(agent, undefined);
	}));

	it("can resolve project packages and overrides from the git root", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-git-root-resolution-"));
		tempDirs.push(dir);
		const nested = path.join(dir, "packages", "app", "src");
		const nestedConfigDir = path.join(dir, "packages", "app", ".pi");
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "outer-workflow");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(nestedConfigDir, { recursive: true });
		fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../.git/worktrees/app\n", "utf-8");
		writeJson(path.join(dir, ".pi", "settings.json"), {
			subagents: {
				projectRootResolution: "git-root",
				agentOverrides: {
					reviewer: { model: "openai/gpt-5.4" },
				},
			},
		});
		writeJson(path.join(packageRoot, "package.json"), {
			name: "outer-workflow",
			"pi-subagents": { agents: ["./agents"] },
		});
		writeAgent(path.join(packageRoot, "agents", "planner.md"), `---
name: planner
package: outer-workflow
description: Plan from the outer project package.
---

Plan outer project work.
`);

		const agents = discoverAgents(nested, "both").agents;
		const packageAgent = agents.find((candidate) => candidate.name === "outer-workflow.planner");
		assert.ok(packageAgent);
		assert.equal(packageAgent.source, "package");
		assert.equal(packageAgent.filePath, path.join(packageRoot, "agents", "planner.md"));
		const reviewer = agents.find((candidate) => candidate.name === "reviewer");
		assert.equal(reviewer?.model, "openai/gpt-5.4");
		assert.equal(reviewer?.override?.path, path.join(dir, ".pi", "settings.json"));
	}));

	it("keeps git-root discovery stable when a nested linked worktree creates incidental .pi state", () => withTempHome(() => {
		const { repo, worktree } = createNestedLinkedWorktree();
		const { packageAgentName, packageAgentPath, settingsPath } = writeLinkedWorktreePackage(repo);

		const before = discoverAgents(worktree, "both").agents;
		const beforePackageAgent = before.find((candidate) => candidate.name === packageAgentName);
		assert.ok(beforePackageAgent);
		assert.equal(beforePackageAgent.source, "package");
		assert.equal(beforePackageAgent.filePath, packageAgentPath);
		assert.equal(before.find((candidate) => candidate.name === "reviewer")?.override?.path, settingsPath);

		fs.mkdirSync(path.join(worktree, ".pi", "todos"), { recursive: true });

		const after = discoverAgents(worktree, "both").agents;
		const all = discoverAgentsAll(worktree);
		const afterPackageAgent = after.find((candidate) => candidate.name === packageAgentName);
		const allPackageAgent = all.package.find((candidate) => candidate.name === packageAgentName);
		assert.equal(afterPackageAgent?.source, beforePackageAgent.source);
		assert.equal(afterPackageAgent?.filePath, beforePackageAgent.filePath);
		assert.equal(allPackageAgent?.filePath, afterPackageAgent.filePath);
		assert.equal(all.projectSettingsPath, settingsPath);
		assert.equal(after.find((candidate) => candidate.name === "reviewer")?.override?.path, all.projectSettingsPath);
	}));

	it("lets a linked worktree opt back into nearest-root discovery", () => withTempHome(() => {
		const { repo, worktree } = createNestedLinkedWorktree();
		const { packageAgentName } = writeLinkedWorktreePackage(repo);
		const worktreeSettingsPath = path.join(worktree, ".pi", "settings.json");
		writeJson(worktreeSettingsPath, {
			subagents: {
				projectRootResolution: "nearest",
				agentOverrides: {
					reviewer: { model: "issue950/worktree-model" },
				},
			},
		});

		const discovered = discoverAgents(worktree, "both").agents;
		const all = discoverAgentsAll(worktree);
		assert.equal(discovered.find((candidate) => candidate.name === packageAgentName), undefined);
		assert.equal(all.package.find((candidate) => candidate.name === packageAgentName), undefined);
		assert.equal(discovered.find((candidate) => candidate.name === "reviewer")?.model, "issue950/worktree-model");
		assert.equal(all.projectSettingsPath, worktreeSettingsPath);
	}));

	it("does not register legacy skill files from broad package agent roots", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-broad-package-skills-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "broad-workflow");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "broad-workflow",
			"pi-subagents": {
				agents: ["."],
			},
		});
		writeAgent(path.join(packageRoot, "agent.md"), `---
name: package-agent
description: Package agent
---

Package prompt
`);
		writeAgent(path.join(packageRoot, ".agents", "skills", "package-skill", "SKILL.md"), `---
name: package-skill
description: Package skill
---

Skill prompt
`);
		writeAgent(path.join(packageRoot, "agents", "SKILL.md"), `---
name: skill-named-package-agent
description: Skill-named package agent
---

Agent prompt
`);

		const packageAgents = discoverAgentsAll(dir).package;
		assert.ok(packageAgents.find((agent) => agent.name === "package-agent" && agent.filePath === path.join(packageRoot, "agent.md")));
		assert.ok(packageAgents.find((agent) => agent.name === "skill-named-package-agent" && agent.filePath === path.join(packageRoot, "agents", "SKILL.md")));
		assert.equal(packageAgents.some((agent) => agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)), false);
		assert.equal(packageAgents.some((agent) => agent.name === "package-skill"), false);
	}));

	it("prunes repo internals and nested project roots from broad package discovery", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-broad-package-prune-"));
		tempDirs.push(dir);
		writeJson(path.join(dir, "package.json"), {
			name: "repo-root-workflow",
			pi: {
				subagents: {
					agents: ["."],
					chains: ["."],
				},
			},
		});
		writeAgent(path.join(dir, "root-agent.md"), `---
name: root-agent
description: Root package agent
---

Root prompt
`);
		writeAgent(path.join(dir, "root.chain.md"), `---
name: root-chain
description: Root package chain
---

## root-agent

Run root agent
`);
		writeAgent(path.join(dir, "node_modules", "bad-agent.md"), `---
name: node-modules-agent
description: Should not be discovered
---

Ignored
`);
		writeAgent(path.join(dir, ".git", "hooks", "bad-agent.md"), `---
name: git-agent
description: Should not be discovered
---

Ignored
`);
		writeAgent(path.join(dir, "vendor", "submodule", "submodule-agent.md"), `---
name: submodule-agent
description: Should not be discovered
---

Ignored
`);
		fs.writeFileSync(path.join(dir, "vendor", "submodule", ".git"), "gitdir: ../.git/modules/submodule\n", "utf-8");
		writeAgent(path.join(dir, "packages", "app", "local-agent.md"), `---
name: nested-project-agent
description: Should not be discovered
---

Ignored
`);
		fs.mkdirSync(path.join(dir, "packages", "app", ".pi"), { recursive: true });
		writeAgent(path.join(dir, "node_modules", "bad.chain.md"), `---
name: node-modules-chain
description: Should not be discovered
---

## root-agent

Ignored
`);

		const all = discoverAgentsAll(dir);
		assert.ok(all.package.find((agent) => agent.name === "root-agent" && agent.filePath === path.join(dir, "root-agent.md")));
		for (const name of ["node-modules-agent", "git-agent", "submodule-agent", "nested-project-agent"]) {
			assert.equal(all.package.some((agent) => agent.name === name), false, `${name} should be pruned`);
		}
		assert.ok(all.chains.find((chain) => chain.name === "root-chain" && chain.filePath === path.join(dir, "root.chain.md")));
		assert.equal(all.chains.some((chain) => chain.name === "node-modules-chain"), false);
	}));

	it("keeps package definitions below user and project overrides", () => withTempHome((home) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-precedence-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "override-workflow");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "override-workflow",
			"pi-subagents": {
				agents: ["./agents"],
				chains: ["./chains"],
			},
		});
		writeAgent(path.join(packageRoot, "agents", "scout.md"), `---
name: scout
description: Package scout
---

Package scout.
`);
		writeAgent(path.join(packageRoot, "chains", "shared.chain.md"), `---
name: shared
description: Package chain
---

## scout

Package chain.
`);
		writeAgent(path.join(home, ".pi", "agent", "agents", "scout.md"), `---
name: scout
description: User scout
---

User scout.
`);
		writeAgent(path.join(dir, ".pi", "agents", "scout.md"), `---
name: scout
description: Project scout
---

Project scout.
`);
		writeAgent(path.join(home, ".pi", "agent", "chains", "shared.chain.md"), `---
name: shared
description: User chain
---

## scout

User chain.
`);
		writeAgent(path.join(dir, ".pi", "chains", "shared.chain.md"), `---
name: shared
description: Project chain
---

## scout

Project chain.
`);

		assert.equal(discoverAgents(dir, "user").agents.find((agent) => agent.name === "scout")?.source, "user");
		assert.equal(discoverAgents(dir, "project").agents.find((agent) => agent.name === "scout")?.source, "project");
		const chainByName = new Map(discoverAgentsAll(dir).chains.map((chain) => [chain.name, chain]));
		assert.equal(chainByName.get("shared")?.source, "project");
	}));

	it("does not allow management updates to package agents", () => withTempHome(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-readonly-"));
		tempDirs.push(dir);
		const packageRoot = path.join(dir, ".pi", "npm", "node_modules", "readonly-workflow");
		writeJson(path.join(packageRoot, "package.json"), {
			name: "readonly-workflow",
			"pi-subagents": {
				agents: ["./agents"],
			},
		});
		writeAgent(path.join(packageRoot, "agents", "reviewer.md"), `---
name: reviewer
package: readonly-workflow
description: Read-only package reviewer.
---

Review only.
`);

		const result = handleManagementAction("update", {
			agent: "readonly-workflow.reviewer",
			config: { description: "Changed" },
		}, {
			cwd: dir,
			modelRegistry: { getAvailable: () => [] },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /read-only/);
	}));
});

describe("agent frontmatter completionGuard", () => {
	it("serializes disabled completion guard into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "test-runner",
			description: "Test runner",
			systemPrompt: "Validate changes",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/test-runner.md",
			completionGuard: false,
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /completionGuard: false/);
	});

	it("omits enabled completion guard from serialized frontmatter", () => {
		const agent: AgentConfig = {
			name: "test-runner",
			description: "Test runner",
			systemPrompt: "Validate changes",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/test-runner.md",
			completionGuard: true,
		};

		const serialized = serializeAgent(agent);
		assert.doesNotMatch(serialized, /completionGuard:/);
	});

	it("parses completionGuard from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-completion-guard-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "test-runner.md"), `---
name: test-runner
description: Test runner
completionGuard: false
---

Validate changes
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const runner = result.agents.find((agent) => agent.name === "test-runner");
		assert.equal(runner?.completionGuard, false);
		assert.equal(runner?.extraFields?.completionGuard, undefined);
	});
});

describe("agent frontmatter maxSubagentDepth", () => {
	it("serializes maxSubagentDepth into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "scout",
			description: "Scout",
			systemPrompt: "Inspect code",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/scout.md",
			maxSubagentDepth: 1,
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /maxSubagentDepth: 1/);
	});

	it("parses maxSubagentDepth from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
description: Scout
maxSubagentDepth: 1
---

Inspect code
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const scout = result.agents.find((agent) => agent.name === "scout");
		assert.equal(scout?.maxSubagentDepth, 1);
	});
});

describe("agent frontmatter thinking", () => {
	it("coerces frontmatter false strings to disabled thinking", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-thinking-false-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		for (const [name, value] of [["unquoted", "false"], ["quoted", "\"false\""]] as const) {
			fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---
name: ${name}
description: ${name}
model: glm-5.2-short-fast
thinking: ${value}
---

Do work
`, "utf-8");
		}

		const agents = discoverAgents(dir, "project").agents;
		for (const name of ["unquoted", "quoted"]) {
			const agent = agents.find((candidate) => candidate.name === name);
			assert.ok(agent);
			assert.equal(agent.thinking, false);

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				model: agent.model,
				thinking: agent.thinking,
				inheritProjectContext: agent.inheritProjectContext,
				inheritSkills: agent.inheritSkills,
			});

			assert.ok(args.includes("--model"));
			assert.ok(args.includes("glm-5.2-short-fast"));
			assert.ok(!args.some((arg) => arg.includes(":false")));
		}
	});

	it("preserves supported frontmatter thinking strings", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-thinking-levels-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		for (const level of THINKING_LEVELS) {
			fs.writeFileSync(path.join(agentsDir, `${level}.md`), `---
name: thinker-${level}
description: Thinking ${level}
thinking: ${level}
---

Do work
`, "utf-8");
		}

		const agents = discoverAgents(dir, "project").agents;
		for (const level of THINKING_LEVELS) {
			const agent = agents.find((candidate) => candidate.name === `thinker-${level}`);
			assert.ok(agent);
			assert.equal(agent.thinking, level);
		}
	});
});

describe("agent frontmatter fallbackModels", () => {
	it("serializes fallbackModels into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
			fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /fallbackModels: openai\/gpt-5-mini, anthropic\/claude-sonnet-4/);
	});

	it("parses fallbackModels from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-fallback-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.deepEqual(worker?.fallbackModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
	});
});

describe("agent frontmatter systemPromptMode", () => {
	it("serializes systemPromptMode into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /systemPromptMode: replace/);
	});

	it("parses systemPromptMode from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-prompt-mode-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
systemPromptMode: replace
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.systemPromptMode, "replace");
	});
});

describe("agent frontmatter prompt inheritance flags", () => {
	it("serializes inheritProjectContext and inheritSkills into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: true,
			source: "project",
			filePath: "/tmp/worker.md",
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /inheritProjectContext: true/);
		assert.match(serialized, /inheritSkills: true/);
	});

	it("parses inheritProjectContext and inheritSkills from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-prompt-inheritance-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
inheritProjectContext: true
inheritSkills: true
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.inheritProjectContext, true);
		assert.equal(worker?.inheritSkills, true);
	});
});

describe("agent frontmatter subagentOnlyExtensions", () => {
	it("serializes subagentOnlyExtensions into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Do work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
			subagentOnlyExtensions: ["./tools/child-search.ts", "/opt/pi/child-only.ts"],
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /subagentOnlyExtensions: \.\/tools\/child-search\.ts, \/opt\/pi\/child-only\.ts/);
	});

	it("parses subagentOnlyExtensions from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-child-ext-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
subagentOnlyExtensions: ./tools/child-search.ts, /opt/pi/child-only.ts
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.deepEqual(worker?.subagentOnlyExtensions, ["./tools/child-search.ts", "/opt/pi/child-only.ts"]);
	});
});

describe("agent frontmatter prompt assembly defaults", () => {
	it("defaults ordinary agents to replace mode with no inherited context or skills", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-default-prompt-settings-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "worker.md"), `---
name: worker
description: Worker
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.systemPromptMode, "replace");
		assert.equal(worker?.inheritProjectContext, false);
		assert.equal(worker?.inheritSkills, false);
	});

	it("builtin agents inherit project context by default", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-default-prompt-settings-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-default-home-"));
		tempDirs.push(dir);
		tempDirs.push(homeDir);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;

			const result = discoverAgents(dir, "both");
			const scout = result.agents.find((agent) => agent.name === "scout");
			const reviewer = result.agents.find((agent) => agent.name === "reviewer");
			const delegate = result.agents.find((agent) => agent.name === "delegate");
			assert.equal(scout?.inheritProjectContext, true);
			assert.equal(reviewer?.inheritProjectContext, true);
			assert.equal(delegate?.inheritProjectContext, true);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("bundled agents all have explicit tool allowlists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-tools-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-tools-home-"));
		tempDirs.push(dir);
		tempDirs.push(homeDir);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;
			const builtins = discoverAgentsAll(dir).builtin;
			assert.ok(builtins.length > 0);
			for (const agent of builtins) {
				assert.ok(agent.tools && agent.tools.length > 0, `${agent.name} should have explicit tools frontmatter`);
			}
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("worker and delegate include the child-facing supervisor tool", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-supervisor-tool-"));
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-builtin-supervisor-tool-home-"));
		tempDirs.push(dir);
		tempDirs.push(homeDir);
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;

		try {
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;
			const agents = discoverAgentsAll(dir).builtin;
			for (const name of ["worker", "delegate"]) {
				const agent = agents.find((candidate) => candidate.name === name);
				assert.ok(agent, `${name} builtin should be discovered`);
				assert.deepEqual(agent?.tools, ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"]);
			}
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it("defaults delegate to append mode with inherited project context", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-delegate-default-prompt-settings-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "delegate.md"), `---
name: delegate
description: Delegate
---

Do work
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const delegate = result.agents.find((agent) => agent.name === "delegate");
		assert.equal(delegate?.systemPromptMode, "append");
		assert.equal(delegate?.inheritProjectContext, true);
		assert.equal(delegate?.inheritSkills, false);
	});
});

describe("packaged agent and chain discovery", () => {
	it("recursively discovers nested project agents while keeping chain files separate", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-recursive-agent-discovery-"));
		tempDirs.push(dir);
		const nestedDir = path.join(dir, ".pi", "agents", "code-analysis", "deep");
		const nestedChainDir = path.join(dir, ".pi", "chains", "code-analysis", "deep");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.mkdirSync(nestedChainDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "scout.md"), `---
name: scout
description: Nested scout
---

Inspect code
`, "utf-8");
		fs.writeFileSync(path.join(nestedChainDir, "review.chain.md"), `---
name: review-flow
description: Review flow
---

## scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.ok(result.project.find((agent) => agent.name === "scout" && agent.filePath === path.join(nestedDir, "scout.md")));
		assert.ok(result.chains.find((chain) => chain.name === "review-flow" && chain.filePath === path.join(nestedChainDir, "review.chain.md")));
		assert.equal(result.project.some((agent) => agent.filePath.endsWith("review.chain.md")), false);
	});

	it("registers packaged agents by runtime name and serializes local name plus package", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-agent-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect code
`, "utf-8");

		const scout = discoverAgents(dir, "project").agents.find((agent) => agent.name === "code-analysis.scout");
		assert.ok(scout);
		assert.equal(scout.localName, "scout");
		assert.equal(scout.packageName, "code-analysis");
		const serialized = serializeAgent(scout);
		assert.match(serialized, /^name: scout$/m);
		assert.match(serialized, /^package: code-analysis$/m);
		assert.doesNotMatch(serialized, /^name: code-analysis\.scout$/m);
	});

	it("recursively discovers packaged chains by runtime name and preserves package on serialize", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-chain-"));
		tempDirs.push(dir);
		const nestedDir = path.join(dir, ".pi", "chains", "flows");
		fs.mkdirSync(nestedDir, { recursive: true });
		const content = `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Inspect {task}
`;
		fs.writeFileSync(path.join(nestedDir, "review.chain.md"), content, "utf-8");

		const chain = discoverAgentsAll(dir).chains.find((candidate) => candidate.name === "code-analysis.review-flow");
		assert.ok(chain);
		assert.equal(chain.localName, "review-flow");
		assert.equal(chain.packageName, "code-analysis");
		assert.equal(chain.steps[0]?.agent, "code-analysis.scout");
		const serialized = serializeChain(chain);
		assert.match(serialized, /^name: review-flow$/m);
		assert.match(serialized, /^package: code-analysis$/m);
		assert.match(serialized, /^## code-analysis\.scout$/m);
		assert.doesNotMatch(serialized, /^name: code-analysis\.review-flow$/m);
	});

	it("keeps packaged and un-packaged runtime names distinct while preserving un-packaged precedence", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-packaged-collisions-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "scout.md"), `---
name: scout
description: Legacy scout
---

Legacy
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "scout.md"), `---
name: scout
description: Project scout
---

Project
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "packaged.md"), `---
name: scout
package: code-analysis
description: Packaged scout
---

Packaged
`, "utf-8");

		const agents = discoverAgents(dir, "project").agents;
		const unqualified = agents.find((agent) => agent.name === "scout");
		const packaged = agents.find((agent) => agent.name === "code-analysis.scout");
		assert.equal(unqualified?.description, "Project scout");
		assert.equal(unqualified?.filePath, path.join(dir, ".pi", "agents", "scout.md"));
		assert.equal(packaged?.description, "Packaged scout");
	});

	it("parses packaged chains directly from serializer helpers", () => {
		const parsed = parseChain(`---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Inspect
`, "project", "/tmp/review.chain.md");

		assert.equal(parsed.name, "code-analysis.review-flow");
		assert.equal(parsed.localName, "review-flow");
		assert.equal(parsed.packageName, "code-analysis");
		assert.match(serializeChain(parsed), /^name: review-flow$/m);
	});

	it("normalizes package frontmatter consistently for agents and chains", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-package-normalize-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: Code Analysis!
description: Fast recon
---

Inspect
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "review.chain.md"), `---
name: review-flow
package: Code Analysis!
description: Review flow
---

## code-analysis.scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.ok(result.project.find((agent) => agent.name === "code-analysis.scout"));
		assert.ok(result.chains.find((chain) => chain.name === "code-analysis.review-flow"));
	});

	it("skips invalid package frontmatter that cannot be normalized", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-invalid-package-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		const chainsDir = path.join(dir, ".pi", "chains");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.mkdirSync(chainsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
package: !!!
description: Fast recon
---

Inspect
`, "utf-8");
		fs.writeFileSync(path.join(chainsDir, "review.chain.md"), `---
name: review-flow
package: !!!
description: Review flow
---

## scout

Review
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.equal(result.project.some((agent) => agent.filePath.endsWith("scout.md")), false);
		assert.equal(result.chains.some((chain) => chain.filePath.endsWith("review.chain.md")), false);
	});
});

describe("project agent directory discovery", () => {
	it("discovers project agents from both .agents and .pi/agents", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-dirs-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "legacy.md"), `---
name: legacy
description: Legacy
---

Legacy prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "canonical.md"), `---
name: canonical
description: Canonical
---

Canonical prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "SKILL.md"), `---
name: skill-named-agent
description: Skill-named agent
---

Skill-named agent prompt
`, "utf-8");

		const result = discoverAgents(dir, "project");
		assert.ok(result.agents.find((agent) => agent.name === "legacy" && agent.filePath === path.join(dir, ".agents", "legacy.md")));
		assert.ok(result.agents.find((agent) => agent.name === "canonical" && agent.filePath === path.join(dir, ".pi", "agents", "canonical.md")));
		assert.ok(result.agents.find((agent) => agent.name === "skill-named-agent" && agent.filePath === path.join(dir, ".pi", "agents", "SKILL.md")));
		assert.equal(result.projectAgentsDir, path.join(dir, ".pi", "agents"));
	});

	it("does not register legacy project skill files as agents", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-skills-not-agents-"));
		tempDirs.push(dir);
		writeAgent(path.join(dir, ".agents", "legacy.md"), `---
name: legacy
description: Legacy
---

Legacy prompt
`);
		writeAgent(path.join(dir, ".agents", "skills", "directory-skill", "SKILL.md"), `---
name: directory-skill
description: Directory skill
---

Skill prompt
`);
		writeAgent(path.join(dir, ".agents", "skills", "file-skill.md"), `---
name: file-skill
description: File skill
---

Skill prompt
`);

		const agents = discoverAgents(dir, "project").agents;
		assert.ok(agents.find((agent) => agent.name === "legacy"));
		assert.equal(agents.some((agent) => agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)), false);
		assert.equal(agents.some((agent) => agent.name === "directory-skill"), false);
		assert.equal(agents.some((agent) => agent.name === "file-skill"), false);
	});

	it("does not register user SKILL.md files as agents", () => withTempHome((home) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-skills-not-agents-"));
		tempDirs.push(dir);
		writeAgent(path.join(home, ".agents", "user-agent.md"), `---
name: user-agent
description: User agent
---

User prompt
`);
		writeAgent(path.join(home, ".agents", "skills", "user-skill", "SKILL.md"), `---
name: user-skill
description: User skill
---

Skill prompt
`);

		const agents = discoverAgents(dir, "user").agents;
		assert.ok(agents.find((agent) => agent.name === "user-agent"));
		assert.equal(agents.some((agent) => agent.filePath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)), false);
		assert.equal(agents.some((agent) => agent.name === "user-skill"), false);
	}));

	it("prefers .pi/agents over .agents on project agent name collisions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-collision-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".agents", "shared.md"), `---
name: shared
description: Legacy shared
---

Legacy prompt
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "agents", "shared.md"), `---
name: shared
description: Canonical shared
---

Canonical prompt
`, "utf-8");

		const shared = discoverAgents(dir, "project").agents.find((agent) => agent.name === "shared");
		assert.ok(shared);
		assert.equal(shared.filePath, path.join(dir, ".pi", "agents", "shared.md"));
		assert.equal(shared.description, "Canonical shared");
		assert.equal(shared.systemPrompt.trim(), "Canonical prompt");
	});

	it("uses the project root for the canonical project agent dir even when only .agents exists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-agent-root-"));
		tempDirs.push(dir);
		const nested = path.join(dir, "packages", "app");
		fs.mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
		fs.mkdirSync(nested, { recursive: true });

		const result = discoverAgentsAll(nested);
		assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
	});

	it("discovers project chains from .pi/chains", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-dirs-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".pi", "chains", "flows"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "agents", "ignored.chain.md"), `---
name: ignored-chain
description: Ignored chain
---

## scout

Ignore
`, "utf-8");
		fs.writeFileSync(path.join(dir, ".pi", "chains", "flows", "canonical.chain.md"), `---
name: canonical-chain
description: Canonical chain
---

## worker

Inspect canonical
`, "utf-8");

		const result = discoverAgentsAll(dir);
		assert.equal(result.chains.some((chain) => chain.name === "ignored-chain"), false);
		assert.ok(result.chains.find((chain) => chain.name === "canonical-chain" && chain.filePath === path.join(dir, ".pi", "chains", "flows", "canonical.chain.md")));
		assert.equal(result.projectDir, path.join(dir, ".pi", "agents"));
		assert.equal(result.projectChainDir, path.join(dir, ".pi", "chains"));
	});

	it("prefers project .pi/chains over user chains on name collisions", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-chain-collision-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-user-chain-home-"));
		tempDirs.push(dir, home);
		const oldHome = process.env.HOME;
		const oldUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			const userChainsDir = path.join(home, ".pi", "agent", "chains");
			fs.mkdirSync(userChainsDir, { recursive: true });
			fs.mkdirSync(path.join(dir, ".pi", "chains"), { recursive: true });
			fs.writeFileSync(path.join(userChainsDir, "shared.chain.md"), `---
name: shared-chain
description: User chain
---

## scout

Inspect user
`, "utf-8");
			fs.writeFileSync(path.join(dir, ".pi", "chains", "shared.chain.md"), `---
name: shared-chain
description: Project chain
---

## worker

Inspect project
`, "utf-8");

			const sharedChains = discoverAgentsAll(dir).chains.filter((chain) => chain.name === "shared-chain");
			assert.equal(sharedChains.length, 2);
			assert.deepEqual(sharedChains.map((chain) => chain.source), ["user", "project"]);
			const savedChainLookup = new Map(sharedChains.map((chain) => [chain.name, chain]));
			const shared = savedChainLookup.get("shared-chain");
			assert.ok(shared);
			assert.equal(shared.filePath, path.join(dir, ".pi", "chains", "shared.chain.md"));
			assert.equal(shared.description, "Project chain");
			assert.equal(shared.steps[0]?.agent, "worker");
			assert.equal(shared.steps[0]?.task, "Inspect project");
		} finally {
			if (oldHome === undefined) delete process.env.HOME;
			else process.env.HOME = oldHome;
			if (oldUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = oldUserProfile;
		}
	});
});
