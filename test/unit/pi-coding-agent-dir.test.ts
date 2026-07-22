import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { handleCreate } from "../../src/agents/agent-management.ts";
import { clearSkillCache, discoverAvailableSkills, resolveSkillPath } from "../../src/agents/skills.ts";
import { loadConfig, updateConfig } from "../../src/extension/config.ts";
import { diagnoseIntercomBridge, resolveIntercomBridge } from "../../src/intercom/intercom-bridge.ts";
import { loadRunsForAgent, recordRun } from "../../src/runs/shared/run-history.ts";
import { cleanupAllArtifactDirs, getArtifactsDir, getProjectArtifactsDir } from "../../src/shared/artifacts.ts";
import { TEMP_ARTIFACTS_DIR } from "../../src/shared/types.ts";
import { getAgentDir, getConfigDirName, getProjectConfigDir, resolveConfigDirName } from "../../src/shared/utils.ts";

let tempDir = "";
let agentDir = "";
let tempHome = "";
let cwd = "";
let oldAgentDir: string | undefined;
let oldHome: string | undefined;
let oldUserProfile: string | undefined;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text;
}

function taskHash(task: string): string {
	return createHash("sha256").update(task).digest("hex");
}

function assertPrivateHistoryModes(historyPath: string): void {
	if (process.platform === "win32") return;
	assert.equal(fs.statSync(path.dirname(historyPath)).mode & 0o777, 0o700);
	assert.equal(fs.statSync(historyPath).mode & 0o777, 0o600);
}

describe("PI_CODING_AGENT_DIR runtime paths", () => {
	beforeEach(() => {
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		oldHome = process.env.HOME;
		oldUserProfile = process.env.USERPROFILE;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-coding-agent-dir-"));
		tempHome = path.join(tempDir, "home");
		agentDir = path.join(tempDir, "agent");
		cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(tempHome, { recursive: true });
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		clearSkillCache();
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("resolves the agent dir dynamically and loads extension config from it", () => {
		assert.equal(resolveConfigDirName({ CONFIG_DIR_NAME: ".custom-pi" }), ".custom-pi");
		assert.equal(resolveConfigDirName({ CONFIG_DIR_NAME: "" }), ".pi");
		assert.equal(getConfigDirName(), ".pi");
		assert.equal(getProjectConfigDir(cwd), path.join(cwd, ".pi"));
		assert.equal(getAgentDir(), agentDir);

		process.env.PI_CODING_AGENT_DIR = "~";
		assert.equal(getAgentDir(), tempHome);

		process.env.PI_CODING_AGENT_DIR = "~/custom-agent-dir";
		assert.equal(getAgentDir(), path.join(tempHome, "custom-agent-dir"));

		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(getAgentDir(), path.join(tempHome, ".pi", "agent"));

		process.env.PI_CODING_AGENT_DIR = agentDir;
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ asyncByDefault: true, maxSubagentDepth: 3, artifactDir: "session" }));

		const config = loadConfig();
		assert.equal(config.asyncByDefault, true);
		assert.equal(config.maxSubagentDepth, 3);
		assert.equal(config.artifactDir, "session");
	});

	it("discovers user agents, chains, and settings under the configured agent dir", () => {
		const settingsPath = path.join(agentDir, "settings.json");
		writeFile(path.join(agentDir, "agents", "env-agent.md"), `---
name: env-agent
description: Env agent
---

Use env agent.
`);
		writeFile(path.join(agentDir, "chains", "env-chain.chain.md"), `---
name: env-chain
description: Env chain
---

## env-agent

Inspect env.
`);
		writeFile(settingsPath, JSON.stringify({
			subagents: {
				agentOverrides: {
					worker: { systemPrompt: "Use env-rooted settings." },
				},
			},
		}, null, 2));

		const discovered = discoverAgentsAll(cwd);
		assert.equal(discovered.userDir, path.join(agentDir, "agents"));
		assert.equal(discovered.userChainDir, path.join(agentDir, "chains"));
		assert.equal(discovered.userSettingsPath, settingsPath);
		assert.ok(discovered.user.find((agent) => agent.name === "env-agent" && agent.filePath === path.join(agentDir, "agents", "env-agent.md")));
		assert.ok(discovered.chains.find((chain) => chain.name === "env-chain" && chain.filePath === path.join(agentDir, "chains", "env-chain.chain.md")));

		const worker = discovered.builtin.find((agent) => agent.name === "worker");
		assert.equal(worker?.systemPrompt, "Use env-rooted settings.");
		assert.equal(worker?.override?.path, settingsPath);
		assert.equal(worker?.override?.scope, "user");

		const createdName = "created-env-agent";
		const created = handleCreate(
			{ config: { name: createdName, description: "Created in env dir", scope: "user" } },
			{ cwd, modelRegistry: { getAvailable: () => [] } },
		);
		assert.equal(created.isError, false, readText(created));
		assert.equal(fs.existsSync(path.join(agentDir, "agents", `${createdName}.md`)), true);
	});

	it("resolves user skills, settings skills, and package skills from the configured agent dir", () => {
		writeFile(path.join(agentDir, "skills", "env-skill", "SKILL.md"), `---
description: Env skill
---
Env skill content.
`);
		writeFile(path.join(agentDir, "settings-skill.md"), `---
description: Settings skill
---
Settings skill content.
`);
		const packageRoot = path.join(agentDir, "packages", "env-package");
		writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "env-package", pi: { skills: ["./skills/package-skill.md"] } }, null, 2));
		writeFile(path.join(packageRoot, "skills", "package-skill.md"), `---
description: Package skill
---
Package skill content.
`);
		writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			skills: ["./settings-skill.md"],
			packages: ["file:./packages/env-package"],
		}, null, 2));

		clearSkillCache();
		assert.deepEqual(resolveSkillPath("env-skill", cwd), { path: path.join(agentDir, "skills", "env-skill", "SKILL.md"), source: "user" });
		assert.deepEqual(resolveSkillPath("settings-skill", cwd), { path: path.join(agentDir, "settings-skill.md"), source: "user-settings" });
		assert.deepEqual(resolveSkillPath("package-skill", cwd), { path: path.join(packageRoot, "skills", "package-skill.md"), source: "user-package" });

		const available = discoverAvailableSkills(cwd);
		assert.ok(available.find((skill) => skill.name === "env-skill" && skill.source === "user"));
		assert.ok(available.find((skill) => skill.name === "settings-skill" && skill.source === "user-settings"));
		assert.ok(available.find((skill) => skill.name === "package-skill" && skill.source === "user-package"));
	});

	it("records private redacted run history and cleans session artifacts under the configured agent dir", () => {
		const task = "Inspect customer ACME token=SECRET";
		recordRun("env-agent", task, 0, 42);
		const historyPath = path.join(agentDir, "run-history.jsonl");
		assert.equal(fs.existsSync(historyPath), true);
		assertPrivateHistoryModes(historyPath);

		const rawHistory = fs.readFileSync(historyPath, "utf-8");
		assert.doesNotMatch(rawHistory, /Inspect customer|ACME|SECRET/);
		assert.match(rawHistory, /"task":"\[redacted\]"/);
		assert.match(rawHistory, /"taskHash":"[a-f0-9]{64}"/);

		const history = loadRunsForAgent("env-agent");
		assert.equal(history.length, 1);
		assert.equal(history[0]?.task, "[redacted]");
		assert.equal(history[0]?.taskHash, taskHash(task));
		assert.equal(history[0]?.status, "ok");

		const artifactPath = path.join(agentDir, "sessions", "session-1", "subagent-artifacts", "old_output.md");
		writeFile(artifactPath, "old output");
		const oldTime = new Date(Date.now() - 60_000);
		fs.utimesSync(artifactPath, oldTime, oldTime);

		cleanupAllArtifactDirs(0);
		assert.equal(fs.existsSync(artifactPath), false);
	});

	it("resolves configured artifact directory preferences", () => {
		const sessionFile = path.join(agentDir, "sessions", "session-1", "session.jsonl");

		assert.equal(getArtifactsDir(sessionFile, cwd), getProjectArtifactsDir(cwd));
		assert.equal(getArtifactsDir(sessionFile, cwd, "project"), getProjectArtifactsDir(cwd));
		assert.equal(getArtifactsDir(sessionFile, cwd, "session"), path.join(path.dirname(sessionFile), "subagent-artifacts"));
		assert.equal(getArtifactsDir(sessionFile, cwd, "temp"), TEMP_ARTIFACTS_DIR);
		assert.equal(getArtifactsDir(null, cwd, "session"), TEMP_ARTIFACTS_DIR);
		assert.throws(() => getArtifactsDir(sessionFile, cwd, "workspace" as never), /Unsupported artifactDir/);
	});

	it("rejects invalid artifactDir config values", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ artifactDir: "workspace" }));

		assert.throws(() => updateConfig((config) => config), /config\.artifactDir must be "project", "session", or "temp"/);
	});

	it("hardens and redacts existing run history while recording", () => {
		const historyPath = path.join(agentDir, "run-history.jsonl");
		fs.mkdirSync(agentDir, { recursive: true, mode: 0o755 });
		fs.writeFileSync(historyPath, `${JSON.stringify({
			agent: "env-agent",
			task: "legacy customer secret",
			ts: 1,
			status: "ok",
			duration: 2,
		})}\nnot json with pasted secret\n`, { encoding: "utf-8", mode: 0o644 });

		recordRun("env-agent", "new customer secret", 1, 9);

		assertPrivateHistoryModes(historyPath);
		const rawHistory = fs.readFileSync(historyPath, "utf-8");
		assert.doesNotMatch(rawHistory, /legacy customer secret|new customer secret|not json with pasted secret/);

		const history = loadRunsForAgent("env-agent");
		assert.equal(history.length, 2);
		assert.equal(history[0]?.task, "[redacted]");
		assert.equal(history[0]?.taskHash, taskHash("new customer secret"));
		assert.equal(history[0]?.status, "error");
		assert.equal(history[0]?.exit, 1);
		assert.equal(history[1]?.task, "[redacted]");
		assert.equal(history[1]?.taskHash, taskHash("legacy customer secret"));
	});

	it("uses the configured agent dir for subagent bridge instruction files", () => {
		const instructionPath = path.join(agentDir, "extensions", "subagent", "bridge.md");
		writeFile(instructionPath, "Native bridge for {orchestratorTarget}");

		const diagnostic = diagnoseIntercomBridge({
			config: { mode: "always" },
			context: "fresh",
			orchestratorTarget: "main",
		});
		assert.equal(diagnostic.active, true);
		assert.equal(diagnostic.extensionDir, "native:pi-subagents-supervisor-channel");

		const bridge = resolveIntercomBridge({
			config: { mode: "always", instructionFile: "bridge.md" },
			context: "fresh",
			orchestratorTarget: "main",
		});
		assert.equal(bridge.active, true);
		assert.equal(bridge.extensionDir, "native:pi-subagents-supervisor-channel");
		assert.match(bridge.instruction, /Native bridge for main/);
	});
});
