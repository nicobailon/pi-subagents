import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerSubagentCapabilityCeiling, resolveSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { resolveSubagentLaunchContract, SUBAGENT_LAUNCH_CONTRACT_VERSION } from "../../src/api/preflight.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

let tempDir = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAgentDir: string | undefined;

function writeAgent(filePath: string, body: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function writeSkill(cwd: string, name: string): void {
	const skillDir = path.join(cwd, ".pi", "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\ndescription: ${name}\n---\n\nUse ${name}.\n`, "utf-8");
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeMcpFixture(): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.equal(typeof agentDir, "string");
	const definition = { command: "github-mcp" };
	writeJson(path.join(agentDir, "mcp.json"), { mcpServers: { github: definition } });
	writeJson(path.join(agentDir, "mcp-cache.json"), {
		version: 1,
		servers: {
			github: {
				configHash: computeMcpServerHash(definition),
				cachedAt: Date.now(),
				tools: [{ name: "search_repositories" }, { name: "create_issue" }],
				resources: [],
			},
		},
	});
}

describe("public launch contract preflight", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-"));
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const home = path.join(tempDir, "home");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
		clearSkillCache();
	});

	afterEach(() => {
		clearSkillCache();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves an ordinary single-agent contract without creating launch directories", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeSkill(cwd, "project-skill");
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
tools:
  - read
  - write
  - /tmp/private-tool.ts
model: test/primary
fallbackModels:
  - test/fallback
thinking: high
skills:
  - project-skill
output: report.md
---
Project prompt.
`);
		const sessionRoot = path.join(tempDir, "sessions");
		const handle = registerSubagentCapabilityCeiling({ sessionId: "preflight-session", ceiling: { allowedTools: ["read"], denyExtensions: true }, source: "test" });
		try {
			const ceiling = resolveSubagentCapabilityCeiling("preflight-session");
			const result = await resolveSubagentLaunchContract({
				agent: "worker",
				cwd,
				task: "Inspect the repo",
				runId: "run-123",
				sessionRoot,
				availableModels: [
					{ provider: "test", id: "primary", fullId: "test/primary" },
					{ provider: "test", id: "fallback", fullId: "test/fallback" },
				],
				capabilityCeiling: ceiling,
			});

			assert.equal(result.ok, true);
			assert.equal(result.contract.version, SUBAGENT_LAUNCH_CONTRACT_VERSION);
			assert.equal(result.contract.agent.source, "project");
			assert.equal(result.contract.agent.definitionProjectionVersion, 1);
			assert.match(result.contract.agent.definitionDigest, /^[a-f0-9]{64}$/);
			assert.match(result.contract.launchContractDigest, /^[a-f0-9]{64}$/);
			assert.ok(result.contract.agent.shadowedCandidates.some((candidate) => candidate.name === "worker" && candidate.source === "builtin"));
			assert.equal(result.contract.model, "test/primary:high");
			assert.deepEqual(result.contract.modelCandidates, ["test/primary:high", "test/fallback:high"]);
			assert.equal(result.contract.thinking, "high");
			assert.deepEqual(result.contract.skills.requested, ["project-skill"]);
			assert.equal(result.contract.skills.resolved[0]?.name, "project-skill");
			assert.deepEqual(result.contract.tools.effectiveAllowlist, ["read"]);
			assert.deepEqual(result.contract.tools.capabilityAudit?.removedTools, ["write"]);
			assert.equal(result.contract.tools.capabilityAudit?.removedExtensionCount, 1);
			assert.equal(result.contract.tools.disableAmbientExtensions, true);
			assert.equal(result.contract.roots.sessionFile, path.join(sessionRoot, "run-123", "run-0", "session.jsonl"));
			assert.equal(result.contract.roots.outputPath, path.join(cwd, ".pi-subagents", "artifacts", "outputs", "run-123", "report.md"));
			assert.equal(result.contract.roots.lifecycle?.statusPath.endsWith(path.join("run-123", "status.json")), true);
			assert.equal(result.contract.roots.lifecycle?.eventsPath.endsWith(path.join("run-123", "events.jsonl")), true);
			assert.equal(result.contract.roots.lifecycle?.processTerminalPath.endsWith(path.join("run-123", "process-terminal.json")), true);
			assert.notEqual(result.contract.roots.lifecycle?.asyncDir, result.contract.roots.artifactsDir);
			assert.match(result.contract.digest, /^[a-f0-9]{64}$/);
			const repeated = await resolveSubagentLaunchContract({
				agent: "worker",
				cwd,
				task: "Inspect the repo",
				runId: "run-123",
				sessionRoot,
				availableModels: [
					{ provider: "test", id: "primary", fullId: "test/primary" },
					{ provider: "test", id: "fallback", fullId: "test/fallback" },
				],
				capabilityCeiling: ceiling,
			});
			assert.equal(repeated.ok, true);
			assert.equal(repeated.contract.digest, result.contract.digest);
			assert.equal(fs.existsSync(sessionRoot), false);
			assert.equal(fs.existsSync(path.join(cwd, ".pi-subagents")), false);
		} finally {
			handle.dispose();
		}
	});

	it("changes definition and launch digests when selected agent content changes", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const agentPath = path.join(cwd, ".pi", "agents", "worker.md");
		writeAgent(agentPath, `---
name: digest-worker
description: Digest worker
tools:
  - read
---
First prompt.
`);
		const before = await resolveSubagentLaunchContract({ agent: "digest-worker", cwd, runId: "digest-test" });
		assert.equal(before.ok, true);
		writeAgent(agentPath, `---
name: digest-worker
description: Digest worker
tools:
  - read
---
Changed prompt.
`);
		const after = await resolveSubagentLaunchContract({ agent: "digest-worker", cwd, runId: "digest-test" });
		assert.equal(after.ok, true);
		assert.notEqual(after.contract.agent.definitionDigest, before.contract.agent.definitionDigest);
		assert.notEqual(after.contract.launchContractDigest, before.contract.launchContractDigest);
		assert.notEqual(after.contract.digest, before.contract.digest);
	});

	it("binds resolved skill content into the launch digest", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeSkill(cwd, "digest-skill");
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
tools:
  - read
skills:
  - digest-skill
---
Project prompt.
`);
		const before = await resolveSubagentLaunchContract({ agent: "worker", cwd, runId: "skill-digest-test" });
		assert.equal(before.ok, true);
		fs.writeFileSync(path.join(cwd, ".pi", "skills", "digest-skill", "SKILL.md"), "---\ndescription: updated digest-skill\n---\n\nUse digest-skill.\n", "utf-8");
		clearSkillCache();

		const after = await resolveSubagentLaunchContract({ agent: "worker", cwd, runId: "skill-digest-test" });
		assert.equal(after.ok, true);
		assert.equal(after.contract.agent.definitionDigest, before.contract.agent.definitionDigest);
		assert.notEqual(after.contract.launchContractDigest, before.contract.launchContractDigest);
		assert.notEqual(after.contract.digest, before.contract.digest);
	});

	it("returns closed failures for missing agents and missing skills", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
skills:
  - missing-skill
---
Project prompt.
`);

		const missingAgent = await resolveSubagentLaunchContract({ agent: "missing", cwd });
		assert.deepEqual(missingAgent, { ok: false, code: "missing_agent", message: "Unknown agent: missing", diagnostics: [] });

		const missingSkill = await resolveSubagentLaunchContract({ agent: "worker", cwd });
		assert.equal(missingSkill.ok, false);
		assert.equal(missingSkill.code, "missing_skill");
		assert.match(missingSkill.message, /missing-skill/);
	});

	it("fails closed for invalid runtime inputs", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
---
Project prompt.
`);

		const invalidCwd = await resolveSubagentLaunchContract({ agent: "worker", cwd: path.join(tempDir, "missing") });
		assert.equal(invalidCwd.ok, false);
		assert.equal(invalidCwd.code, "invalid_cwd");

		const unsupportedMode = await resolveSubagentLaunchContract({ agent: "worker", cwd, context: "bogus" as never });
		assert.equal(unsupportedMode.ok, false);
		assert.equal(unsupportedMode.code, "unsupported_mode");

		const invalidArtifactDir = await resolveSubagentLaunchContract({ agent: "worker", cwd, artifactDir: "bogus" as never });
		assert.equal(invalidArtifactDir.ok, false);
		assert.equal(invalidArtifactDir.code, "invalid_artifact_dir");
	});

	it("projects MCP, extension, fanout, structured-output, and fork diagnostics", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeMcpFixture();
		writeAgent(path.join(cwd, ".pi", "agents", "fanout.md"), `---
name: fanout
description: Project fanout
tools:
  - read
  - subagent
  - /tmp/tool-ext.ts
  - mcp:github/search_repositories
extensions:
  - /tmp/config-ext.ts
subagentOnlyExtensions:
  - /tmp/subagent-only.ts
defaultContext: fork
---
Project prompt.
`);

		const result = await resolveSubagentLaunchContract({
			agent: "fanout",
			cwd,
			outputSchema: { type: "object", additionalProperties: false },
		});
		assert.equal(result.ok, true);
		assert.equal(result.contract.context, "fork");
		assert.ok(result.contract.diagnostics.some((diagnostic) => diagnostic.code === "host_required"));
		assert.deepEqual(result.contract.tools.declaredBuiltin, ["read", "subagent"]);
		assert.equal(result.contract.tools.explicitAllowlist, true);
		assert.equal(result.contract.tools.fanoutAuthorized, true);
		assert.deepEqual(result.contract.tools.internalTools, ["structured_output"]);
		assert.deepEqual(result.contract.tools.effectiveMcpTools, ["github_search_repositories"]);
		assert.deepEqual(result.contract.tools.requiredChildTools, ["read", "subagent", "github_search_repositories", "structured_output"]);
		assert.deepEqual(result.contract.tools.toolExtensionPaths, ["/tmp/tool-ext.ts"]);
		assert.equal(result.contract.tools.disableAmbientExtensions, true);
		assert.ok(result.contract.tools.runtimeExtensions.some((extensionPath) => extensionPath.endsWith("subagent-prompt-runtime.ts")));
		assert.ok(result.contract.tools.runtimeExtensions.some((extensionPath) => extensionPath.endsWith("fanout-child.ts")));
		assert.ok(result.contract.tools.extensionArgs.includes("/tmp/config-ext.ts"));
		assert.ok(result.contract.tools.extensionArgs.includes("/tmp/subagent-only.ts"));
	});

	it("fails closed when a capability ceiling denies read required for child skills", async () => {
		const cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeSkill(cwd, "project-skill");
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
tools:
  - read
skills:
  - project-skill
---
Project prompt.
`);

		const result = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			capabilityCeiling: { version: 1, allowedTools: [], denyExtensions: false, sources: ["test"] },
		});
		assert.equal(result.ok, false);
		assert.equal(result.code, "denied_required_tool");
		assert.match(result.message, /excludes required tool 'read'/);
	});
});
