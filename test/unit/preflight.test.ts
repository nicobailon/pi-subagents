import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerSubagentCapabilityCeiling, resolveSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { resolveSubagentLaunchContract, SUBAGENT_LAUNCH_CONTRACT_VERSION } from "../../src/api/preflight.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import { TEMP_ARTIFACTS_DIR } from "../../src/shared/types.ts";

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
			assert.equal(result.contract.roots.outputPath, path.join(TEMP_ARTIFACTS_DIR, "outputs", "run-123", "report.md"));
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
			assert.equal(fs.existsSync(path.join(cwd, ".pi/subagents")), false);
		} finally {
			handle.dispose();
		}
	});

	it("binds canonical extension metadata into public preflight provenance", async () => {
		const cwd = path.join(tempDir, "bindings-repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "binding-worker.md"), `---\nname: binding-worker\ndescription: Binding worker\n---\nWorker.\n`);
		const omitted = await resolveSubagentLaunchContract({ agent: "binding-worker", cwd, task: "Inspect" });
		const bound = await resolveSubagentLaunchContract({ agent: "binding-worker", cwd, task: "Inspect", extensionBindings: { "shepherd.dispatch/1": { writeScope: ["src/a.ts"], role: "coder" } } });
		assert.equal(omitted.ok, true);
		assert.equal(bound.ok, true);
		if (omitted.ok && bound.ok) {
			assert.notEqual(bound.contract.launchContractDigest, omitted.contract.launchContractDigest);
		}
		const invalid = await resolveSubagentLaunchContract({ agent: "binding-worker", cwd, extensionBindings: { invalid: true } });
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.equal(invalid.code, "invalid_extension_bindings");
	});

	it("binds fast mode runtime extension into public preflight provenance", async () => {
		const cwd = path.join(tempDir, "fast-repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "fast-worker.md"), `---
name: fast-worker
description: Fast worker
model: openai-codex/gpt-5.6-luna
fast: true
---
Worker.
`);
		const availableModels = [{ provider: "openai-codex", id: "gpt-5.6-luna", fullId: "openai-codex/gpt-5.6-luna" }];
		const enabled = await resolveSubagentLaunchContract({ agent: "fast-worker", cwd, task: "Run", availableModels });
		const disabled = await resolveSubagentLaunchContract({ agent: "fast-worker", cwd, task: "Run", availableModels, fast: false });

		assert.equal(enabled.ok, true);
		assert.equal(disabled.ok, true);
		if (enabled.ok && disabled.ok) {
			assert.ok(enabled.contract.tools.runtimeExtensions.some((entry) => entry.endsWith("fast-mode-extension.ts")));
			assert.equal(disabled.contract.tools.runtimeExtensions.some((entry) => entry.endsWith("fast-mode-extension.ts")), false);
			assert.notEqual(enabled.contract.launchContractDigest, disabled.contract.launchContractDigest);
		}
	});

	it("enforces maxThinking before a child launch and accepts levels at the ceiling", async () => {
		const cwd = path.join(tempDir, "thinking-repo");
		fs.mkdirSync(cwd, { recursive: true });
		writeJson(path.join(cwd, ".pi", "settings.json"), { subagents: { maxThinking: "xhigh" } });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---\nname: worker\ndescription: Project worker\nmodel: test/worker\nthinking: xhigh\n---\nWorker.\n`);
		const accepted = await resolveSubagentLaunchContract({ agent: "worker", cwd, task: "Inspect", availableModels: [{ provider: "test", id: "worker", fullId: "test/worker" }] });
		assert.equal(accepted.ok, true);
		if (accepted.ok) assert.equal(accepted.contract.thinkingCeiling, "xhigh");
		const rejected = await resolveSubagentLaunchContract({ agent: "worker", cwd, task: "Inspect", thinking: "max", availableModels: [{ provider: "test", id: "worker", fullId: "test/worker" }] });
		assert.equal(rejected.ok, false);
		if (!rejected.ok) {
			assert.equal(rejected.code, "thinking_ceiling");
			assert.match(rejected.message, /max.*xhigh.*worker/);
		}
	});

	it("binds the resolved agent outputMode into the launch digest", async () => {
		const cwd = path.join(tempDir, "repo-output-mode");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
output: report.md
outputMode: file-only
---
Project prompt.
`);

		const defaultMode = await resolveSubagentLaunchContract({ agent: "worker", cwd });
		const explicitDefault = await resolveSubagentLaunchContract({ agent: "worker", cwd, outputMode: "file-only" });
		const override = await resolveSubagentLaunchContract({ agent: "worker", cwd, outputMode: "inline" });

		assert.equal(defaultMode.ok, true);
		assert.equal(explicitDefault.ok, true);
		assert.equal(override.ok, true);
		assert.equal(defaultMode.contract.launchContractDigest, explicitDefault.contract.launchContractDigest);
		assert.notEqual(defaultMode.contract.launchContractDigest, override.contract.launchContractDigest);
	});

	it("rejects an unresolved configured model when the host registry is available", async () => {
		const cwd = path.join(tempDir, "repo-unresolved-model");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
model: fast
---
Project prompt.
`);

		await assert.rejects(
			resolveSubagentLaunchContract({
				agent: "worker",
				cwd,
				availableModels: [{ provider: "test", id: "primary", fullId: "test/primary" }],
			}),
			/Unknown subagent model 'fast'/,
		);
	});

	it("trusts an inherited parent model outside the host registry", async () => {
		const cwd = path.join(tempDir, "repo-parent-model");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
---
Project prompt.
`);

		const result = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			parentModel: { provider: "gateway", id: "parent-model" },
			availableModels: [{ provider: "test", id: "primary", fullId: "test/primary" }],
		});

		assert.equal(result.ok, true);
		assert.equal(result.contract.model, "gateway/parent-model");
		assert.deepEqual(result.contract.modelCandidates, ["gateway/parent-model"]);
	});

	it("uses subagents.defaultProvider when resolving launch model ids", async () => {
		const cwd = path.join(tempDir, "repo-default-provider");
		fs.mkdirSync(cwd, { recursive: true });
		writeJson(path.join(process.env.HOME!, ".pi", "agent", "settings.json"), {
			subagents: { defaultProvider: "gpu-b" },
		});
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
model: gpt-5-mini
---
Project prompt.
`);

		const result = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			parentModel: { provider: "openai", id: "gpt-5-mini" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "gpu-b", id: "gpt-5-mini", fullId: "gpu-b/gpt-5-mini" },
			],
		});

		assert.equal(result.ok, true);
		assert.equal(result.contract.model, "gpu-b/gpt-5-mini");
		assert.deepEqual(result.contract.modelCandidates, ["gpu-b/gpt-5-mini"]);
	});

	it("bypasses native model validation for external CLI runners", async () => {
		const cwd = path.join(tempDir, "repo-external-model");
		fs.mkdirSync(cwd, { recursive: true });
		writeJson(path.join(process.env.HOME!, ".pi", "agent", "settings.json"), {
			subagents: { defaultModel: "mock/default-model" },
		});
		writeAgent(path.join(cwd, ".pi", "agents", "external.md"), `---
name: external
description: External runner
runner:
  type: external-cli
  command: ${JSON.stringify(process.execPath)}
---
Project prompt.
`);

		const result = await resolveSubagentLaunchContract({
			agent: "external",
			cwd,
			availableModels: [{ provider: "other", id: "known", fullId: "other/known" }],
		});

		assert.equal(result.ok, true);
		assert.equal(result.contract.model, undefined);
		assert.deepEqual(result.contract.modelCandidates, []);
	});

	it("resolves agent aliases to the canonical launch contract agent", async () => {
		const cwd = path.join(tempDir, "repo-alias");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
aliases: developer, coder
---
Project prompt.
`);

		const result = await resolveSubagentLaunchContract({
			agent: "developer",
			cwd,
			task: "Implement the change",
		});

		assert.equal(result.ok, true);
		assert.equal(result.contract.agent.name, "worker");
	});

	it("reports alias collisions as ambiguous agents", async () => {
		const cwd = path.join(tempDir, "repo-alias-collision");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
aliases: coder
---
Project prompt.
`);
		writeAgent(path.join(cwd, ".pi", "agents", "reviewer.md"), `---
name: reviewer
description: Project reviewer
aliases: coder
---
Review prompt.
`);

		const result = await resolveSubagentLaunchContract({ agent: "coder", cwd });

		assert.equal(result.ok, false);
		assert.equal(result.code, "ambiguous_agent");
		assert.match(result.message, /Ambiguous agent alias 'coder': reviewer, worker|Ambiguous agent alias 'coder': worker, reviewer/);
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
		writeAgent(path.join(cwd, ".pi", "agents", "broken.md"), `---
name: broken
description: Broken worker
runner:
  type: unknown
---
Broken prompt.
`);
		const brokenAgent = await resolveSubagentLaunchContract({ agent: "broken", cwd });
		assert.equal(brokenAgent.ok, false);
		assert.equal(brokenAgent.code, "missing_agent");
		assert.match(brokenAgent.message, /Agent 'broken' has invalid configuration: Agent 'broken' has invalid runner\.type/);
		assert.deepEqual(brokenAgent.diagnostics, [{ code: "missing_agent", severity: "error", message: brokenAgent.message }]);
		writeAgent(path.join(cwd, ".pi", "agents", "code-analysis.zeta-worker.md"), `---
name: zeta-worker
package: code-analysis
description: Broken packaged worker
runner:
  type: unknown
---
Broken prompt.
`);
		const brokenPackagedAgent = await resolveSubagentLaunchContract({ agent: "code-analysis.zeta-worker", cwd, agentScope: "project" });
		assert.equal(brokenPackagedAgent.ok, false);
		assert.equal(brokenPackagedAgent.code, "missing_agent");
		assert.match(brokenPackagedAgent.message, /Agent 'code-analysis\.zeta-worker' has invalid configuration: Agent 'zeta-worker' has invalid runner\.type/);
		assert.deepEqual(brokenPackagedAgent.diagnostics, [{ code: "missing_agent", severity: "error", message: brokenPackagedAgent.message }]);
		writeAgent(path.join(cwd, ".pi", "agents", "reviewer.md"), `---
name: reviewer
description: Broken reviewer
runner:
  type: unknown
---
Broken prompt.
`);
		const brokenReviewer = await resolveSubagentLaunchContract({ agent: "reviewer", cwd, agentScope: "both" });
		assert.equal(brokenReviewer.ok, false);
		assert.equal(brokenReviewer.code, "missing_agent");
		assert.match(brokenReviewer.message, /Agent 'reviewer' has invalid configuration: Agent 'reviewer' has invalid runner\.type/);
		const spacedBrokenReviewer = await resolveSubagentLaunchContract({ agent: " reviewer ", cwd, agentScope: "both" });
		assert.equal(spacedBrokenReviewer.ok, false);
		assert.equal(spacedBrokenReviewer.code, "missing_agent");
		assert.match(spacedBrokenReviewer.message, /Agent ' reviewer ' has invalid configuration: Agent 'reviewer' has invalid runner\.type/);
		writeAgent(path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "foo.md"), `---
name: foo
description: User foo
---
User prompt.
`);
		writeAgent(path.join(cwd, ".pi", "agents", "acme.foo.md"), `---
name: foo
package: acme
description: Broken packaged foo
runner:
  type: unknown
---
Broken prompt.
`);
		const localFoo = await resolveSubagentLaunchContract({ agent: "foo", cwd, agentScope: "both" });
		assert.equal(localFoo.ok, true);
		const brokenPackagedFoo = await resolveSubagentLaunchContract({ agent: "acme.foo", cwd, agentScope: "both" });
		assert.equal(brokenPackagedFoo.ok, false);
		assert.match(brokenPackagedFoo.message, /Agent 'acme\.foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
		writeAgent(path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "package-shadow.md"), `---
name: package-shadow
description: User package shadow
---
User prompt.
`);
		writeAgent(path.join(cwd, ".pi", "agents", "package-shadow.md"), `---
name: package-shadow
package: !!!
description: Broken package shadow
---
Broken prompt.
`);
		const brokenPackageShadow = await resolveSubagentLaunchContract({ agent: "package-shadow", cwd, agentScope: "both" });
		assert.equal(brokenPackageShadow.ok, false);
		assert.match(brokenPackageShadow.message, /Agent 'package-shadow' has invalid configuration: Agent 'package-shadow' package is invalid after sanitization/);
		writeAgent(path.join(cwd, ".agents", "shared.md"), `---
name: shared
description: Legacy shared
---
Legacy prompt.
`);
		writeAgent(path.join(cwd, ".pi", "agents", "shared.md"), `---
name: shared
description: Broken canonical shared
runner:
  type: unknown
---
Broken prompt.
`);
		const brokenCanonicalShared = await resolveSubagentLaunchContract({ agent: "shared", cwd, agentScope: "project" });
		assert.equal(brokenCanonicalShared.ok, false);
		assert.match(brokenCanonicalShared.message, /Agent 'shared' has invalid configuration: Agent 'shared' has invalid runner\.type/);
		const packageRoot = path.join(cwd, "package");
		writeAgent(path.join(packageRoot, "agents", "ambiguous.md"), `---
name: ambiguous
package: acme
description: Package ambiguous
---
Package prompt.
`);
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["agents"] } }));
		fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));
		writeAgent(path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "ambiguous.md"), `---
name: ambiguous
description: User ambiguous
---
User prompt.
`);
		writeAgent(path.join(cwd, ".pi", "agents", "ambiguous.md"), `---
name: ambiguous
description: Broken project ambiguous
runner:
  type: unknown
---
Broken prompt.
`);
		const brokenBeforeAmbiguity = await resolveSubagentLaunchContract({ agent: "ambiguous", cwd, agentScope: "both" });
		assert.equal(brokenBeforeAmbiguity.ok, false);
		assert.equal(brokenBeforeAmbiguity.code, "missing_agent");
		assert.match(brokenBeforeAmbiguity.message, /Agent 'ambiguous' has invalid configuration: Agent 'ambiguous' has invalid runner\.type/);

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

		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const result = await resolveSubagentLaunchContract({
			agent: "fanout",
			cwd,
			outputSchema: { type: "object", additionalProperties: false },
			parentSessionFile,
			parentLeafId: "leaf-current",
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

	it("falls back implicit default fork to fresh when the parent session is not forkable", async () => {
		const cwd = path.join(tempDir, "repo-implicit-fork");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
defaultContext: fork
---
Project prompt.
`);

		const missingSession = await resolveSubagentLaunchContract({ agent: "worker", cwd });
		assert.equal(missingSession.ok, true);
		assert.equal(missingSession.contract.context, "fresh");

		const missingFile = path.join(tempDir, "missing-parent.jsonl");
		const unpersisted = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			parentSessionFile: missingFile,
			parentLeafId: "leaf-current",
		});
		assert.equal(unpersisted.ok, true);
		assert.equal(unpersisted.contract.context, "fresh");

		const parentSessionFile = path.join(tempDir, "implicit-parent.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");
		const missingLeaf = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			parentSessionFile,
		});
		assert.equal(missingLeaf.ok, true);
		assert.equal(missingLeaf.contract.context, "fresh");

		const explicitFork = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			context: "fork",
		});
		assert.equal(explicitFork.ok, true);
		assert.equal(explicitFork.contract.context, "fork");
	});

	it("applies defaultSubagentContext fork without overriding explicit fresh", async () => {
		const cwd = path.join(tempDir, "repo-global-fork");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
defaultContext: fresh
---
Project prompt.
`);
		writeJson(path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "subagent", "config.json"), {
			defaultSubagentContext: "fork",
		});
		const parentSessionFile = path.join(tempDir, "global-parent.jsonl");
		fs.writeFileSync(parentSessionFile, '{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n', "utf-8");

		const implicit = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			parentSessionFile,
			parentLeafId: "leaf-current",
		});
		assert.equal(implicit.ok, true);
		assert.equal(implicit.contract.context, "fork");

		const explicitFresh = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			context: "fresh",
			parentSessionFile,
			parentLeafId: "leaf-current",
		});
		assert.equal(explicitFresh.ok, true);
		assert.equal(explicitFresh.contract.context, "fresh");

		const unavailableFork = await resolveSubagentLaunchContract({ agent: "worker", cwd });
		assert.equal(unavailableFork.ok, true);
		assert.equal(unavailableFork.contract.context, "fresh");
	});

	it("applies defaultSubagentContext fresh over an agent fork default", async () => {
		const cwd = path.join(tempDir, "repo-global-fresh");
		fs.mkdirSync(cwd, { recursive: true });
		writeAgent(path.join(cwd, ".pi", "agents", "worker.md"), `---
name: worker
description: Project worker
defaultContext: fork
---
Project prompt.
`);
		writeJson(path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "subagent", "config.json"), {
			defaultSubagentContext: "fresh",
		});

		const implicit = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd,
			parentSessionFile: path.join(tempDir, "global-parent.jsonl"),
			parentLeafId: "leaf-current",
		});
		assert.equal(implicit.ok, true);
		assert.equal(implicit.contract.context, "fresh");
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
