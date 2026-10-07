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
import { loadRunsForAgent, planBackgroundRunHistory, recordRun } from "../../src/runs/shared/run-history.ts";
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
		writeFile(configPath, JSON.stringify({ asyncByDefault: true, defaultSubagentContext: "fresh", maxSubagentDepth: 3, artifactDir: "session", artifactConfig: { cleanupDays: 9007199254740991 } }));

		const config = loadConfig();
		assert.equal(config.asyncByDefault, true);
		assert.equal(config.defaultSubagentContext, "fresh");
		assert.equal(config.maxSubagentDepth, 3);
		assert.equal(config.artifactDir, "session");
		assert.equal(config.artifactConfig?.cleanupDays, Number.MAX_SAFE_INTEGER);
	});

	it("requires a pruning model when pruned fork mode is enabled", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ forkContext: { mode: "pruned" } }));
		assert.throws(() => loadConfig(), /forkContext\.model is required/);

		writeFile(configPath, JSON.stringify({ forkContext: { mode: "pruned", model: "openai-codex/gpt-5.6-luna:max" } }));
		assert.deepEqual(loadConfig().forkContext, { mode: "pruned", model: "openai-codex/gpt-5.6-luna:max" });
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

	it("ignores nested .pi and sync-backups agent definitions", () => {
		const userAgentsDir = path.join(agentDir, "agents");
		const rootAgentPath = path.join(userAgentsDir, "root-agent.md");
		writeFile(rootAgentPath, `---
name: root-agent
description: Root agent
---

Use the configured root agent.
`);
		const nestedBackupAgentPath = path.join(userAgentsDir, ".pi", "agent", "sync-backups", "20260712-163714", "agents", "stale.md");
		writeFile(nestedBackupAgentPath, `---
name: stale
model: nonexistent/model
description: Stale backup agent
---

This definition must not be executable.
`);
		const directBackupAgentPath = path.join(userAgentsDir, "sync-backups", "20260712-163714", "agents", "also-stale.md");
		writeFile(directBackupAgentPath, `---
name: also-stale
description: Another stale backup agent
---

This definition must not be executable either.
`);

		const discovered = discoverAgentsAll(cwd);
		assert.ok(discovered.user.find((agent) => agent.name === "root-agent" && agent.filePath === rootAgentPath));
		assert.equal(discovered.user.some((agent) => agent.name === "stale"), false);
		assert.equal(discovered.user.some((agent) => agent.name === "also-stale"), false);
		assert.equal(discovered.user.some((agent) => agent.filePath === nestedBackupAgentPath || agent.filePath === directBackupAgentPath), false);
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
		const task = "PROMPT_AUDIT_SENTINEL_1021 Inspect customer ACME token=SECRET";
		recordRun("env-agent", task, 0, 42);
		const historyPath = path.join(agentDir, "run-history.jsonl");
		assert.equal(fs.existsSync(historyPath), true);
		assertPrivateHistoryModes(historyPath);

		const rawHistory = fs.readFileSync(historyPath, "utf-8");
		assert.doesNotMatch(rawHistory, /PROMPT_AUDIT_SENTINEL_1021|Inspect customer|ACME|SECRET/);
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
		assert.equal(fs.existsSync(artifactPath), true);

		cleanupAllArtifactDirs(1 / 24 / 60 / 60 / 1000);
		assert.equal(fs.existsSync(artifactPath), false);
	});

	it("records explicit run outcomes without guessing legacy outcomes", () => {
		const historyPath = path.join(agentDir, "run-history.jsonl");
		writeFile(historyPath, `${JSON.stringify({ agent: "outcome-agent", task: "[redacted]", ts: 1, status: "error", duration: 1, exit: 143 })}\n`);
		recordRun("outcome-agent", "failed", 1, 2);
		recordRun("outcome-agent", "timed out", 1, 3, { timedOut: true });
		recordRun("outcome-agent", "interrupted", 1, 4, { interrupted: true });
		recordRun("outcome-agent", "stopped", 1, 5, { stopped: true });
		recordRun("outcome-agent", "completed", 0, 6);
		recordRun("outcome-agent", "signalled", 143, 7, { processSignal: "SIGTERM" });

		const history = loadRunsForAgent("outcome-agent");
		assert.deepEqual(history.map((entry) => entry.outcome), ["stopped", "completed", "stopped", "interrupted", "timed_out", "failed", undefined]);
		assert.equal(history.at(-1)?.exit, 143);
	});

	it("resolves configured artifact directory preferences", () => {
		const sessionFile = path.join(agentDir, "sessions", "session-1", "session.jsonl");

		assert.equal(getArtifactsDir(sessionFile, cwd), path.join(path.dirname(sessionFile), "subagent-artifacts"));
		assert.equal(getArtifactsDir(sessionFile, cwd, "project"), getProjectArtifactsDir(cwd));
		assert.equal(getArtifactsDir(sessionFile, cwd, "session"), path.join(path.dirname(sessionFile), "subagent-artifacts"));
		assert.equal(getArtifactsDir(sessionFile, cwd, "temp"), TEMP_ARTIFACTS_DIR);
		assert.equal(getArtifactsDir(null, cwd, "session"), TEMP_ARTIFACTS_DIR);
		assert.throws(() => getArtifactsDir(sessionFile, cwd, "workspace" as never), /Unsupported artifactDir/);
	});

	it("validates default subagent context values", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ defaultSubagentContext: "fresh" }));
		assert.equal(loadConfig().defaultSubagentContext, "fresh");

		writeFile(configPath, JSON.stringify({ asyncWidgetCollapsed: true }));
		assert.equal(loadConfig().asyncWidgetCollapsed, true);
		writeFile(configPath, JSON.stringify({ asyncWidgetCollapsed: "true" }));
		assert.deepEqual(loadConfig(), {});
		writeFile(configPath, JSON.stringify({ programStatus: false }));
		assert.equal(loadConfig().programStatus, false);
		writeFile(configPath, JSON.stringify({ programStatus: "off" }));
		assert.throws(() => updateConfig((config) => config), /config\.programStatus must be a boolean/);

		writeFile(configPath, JSON.stringify({ defaultSubagentContext: "other" }));
		assert.throws(() => updateConfig((config) => config), /config\.defaultSubagentContext must be "fresh" or "fork"/);
	});

	it("accepts valid global checkpoint offsets and rejects invalid config before execution", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		for (const checkpointBeforeDeadlineMs of [undefined, 1, 300_000, 2_147_483_647]) {
			writeFile(configPath, JSON.stringify({ checkpointBeforeDeadlineMs }));
			assert.equal(loadConfig().checkpointBeforeDeadlineMs, checkpointBeforeDeadlineMs);
		}
		for (const checkpointBeforeDeadlineMs of [0, -1, 1.5, 2_147_483_648, null, false, "300000", [], {}]) {
			writeFile(configPath, JSON.stringify({ checkpointBeforeDeadlineMs }));
			assert.throws(() => loadConfig(), /config\.checkpointBeforeDeadlineMs must be a positive integer no larger than 2147483647/);
		}
		writeFile(configPath, "{}");
		assert.throws(() => updateConfig(() => ({ checkpointBeforeDeadlineMs: Infinity })), /config\.checkpointBeforeDeadlineMs must be a positive integer no larger than 2147483647/);
		assert.deepEqual(loadConfig(), {});
	});

	it("fails config load for invalid disabled features instead of falling back to defaults", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ disabledFeatures: ["watchdogs"] }));
		assert.throws(() => loadConfig(), /config\.disabledFeatures entry "watchdogs" is not one of:/);
	});

	it("loads runnerLaunchers and fails closed on malformed launchers or other invalid values", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		const runnerLaunchers = { net: ["nono", "run", "--profile", " net ", "--"], "subagent-net": ["subagent-net"], "net.v2_x-1": ["wrap"] };
		writeFile(configPath, JSON.stringify({ runnerLaunchers }));
		assert.deepEqual(loadConfig().runnerLaunchers, runnerLaunchers);
		for (const invalid of [[], "nono", { net: [] }, { net: "nono run" }, { net: [""] }, { net: [" "] }, { net: ["nono", 1] }, { net: ["no\u0000no"] }, { "": ["nono"] }, { "'net'": ["nono"] }, { "a b": ["nono"] }, { "-x": ["nono"] }, { ["n".repeat(129)]: ["nono"] }]) {
			writeFile(configPath, JSON.stringify({ runnerLaunchers: invalid }));
			assert.throws(() => loadConfig(), /config\.runnerLaunchers.*(?:letters, digits|argv array|JSON object)/);
		}
		writeFile(configPath, JSON.stringify({ resultScanLogging: "bogus", runnerLaunchers }));
		assert.throws(() => loadConfig(), /config\.resultScanLogging must be/);
	});

	it("fails config load for invalid scheduledRuns because it controls the tool schema", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ scheduledRuns: { enabled: "false" } }));
		assert.throws(() => loadConfig(), /config\.scheduledRuns\.enabled must be a boolean/);
	});

	it("loads exact model response aliases and preserves them during config updates", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		const modelResponseAliases = {
			"databricks-bedrock/ias-claude-opus-5": ["claude-opus-5", "exact/Response:high"],
			"gateway/owner/model": [],
		};
		writeFile(configPath, JSON.stringify({ modelResponseAliases }));
		assert.deepEqual(loadConfig().modelResponseAliases, modelResponseAliases);
		updateConfig((config) => ({ ...config, asyncByDefault: false }));
		assert.deepEqual(loadConfig(), { modelResponseAliases, asyncByDefault: false });
		writeFile(configPath, JSON.stringify({ modelResponseAliases: {} }));
		assert.deepEqual(loadConfig().modelResponseAliases, {});
	});

	it("fails config load for malformed model response aliases with useful diagnostics", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		for (const modelResponseAliases of [null, [], "alias", { "": [] }, { model: [] }, { "/model": [] }, { "provider/ ": [] }, { " /model": [] }]) {
			writeFile(configPath, JSON.stringify({ modelResponseAliases }));
			assert.throws(() => loadConfig(), /config\.modelResponseAliases.*(?:JSON object|provider\/model ID)/);
		}
		for (const aliases of [null, "response", [""], [" "], [1], ["valid", false]]) {
			writeFile(configPath, JSON.stringify({ modelResponseAliases: { "provider/model": aliases } }));
			assert.throws(() => loadConfig(), /config\.modelResponseAliases\["provider\/model"\].*array of non-empty response ID strings/);
		}
	});

	it("rejects removed model exclusion config without creating a store", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		const exclusionPath = path.join(tempDir, "model-exclusions.json");
		writeFile(configPath, JSON.stringify({ modelExclusions: { defaultTtlMs: 300_000 } }));
		assert.throws(() => updateConfig((current) => current), /modelExclusions was removed/);
		assert.equal(fs.existsSync(exclusionPath), false);
	});

	it("fails closed when loadConfig reads removed model exclusion config", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ modelExclusions: { defaultTtlMs: 300_000 }, asyncByDefault: false }));
		assert.throws(() => loadConfig(), /config\.modelExclusions was removed/);
	});

	it("fails closed instead of dropping restrictions when another config value is invalid", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		for (const restriction of [{ authorityPolicy: { stopRun: "forbid" } }, { permissions: { rules: { write: "deny" } } }, { toolBudget: { hard: 5 } }]) {
			writeFile(configPath, JSON.stringify({ resultScanLogging: "bogus", ...restriction }));
			assert.throws(() => loadConfig(), /config\.resultScanLogging must be/);
		}
	});

	it("rejects invalid artifactDir config values", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ artifactDir: "workspace" }));

		assert.throws(() => updateConfig((config) => config), /config\.artifactDir must be "project", "session", or "temp"/);
	});

	it("loads and validates abandoned async capacity cleanup policy", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ capacity: { abandonedSlotReleaseAfterMs: 600_000 } }));
		assert.equal(loadConfig().capacity?.abandonedSlotReleaseAfterMs, 600_000);

		writeFile(configPath, JSON.stringify({ capacity: { abandonedSlotReleaseAfterMs: false } }));
		assert.equal(loadConfig().capacity?.abandonedSlotReleaseAfterMs, false);

		for (const invalid of [299_999, 86_400_001, 0, "600000", null]) {
			writeFile(configPath, JSON.stringify({ capacity: { abandonedSlotReleaseAfterMs: invalid } }));
			assert.throws(() => updateConfig((config) => config), /config\.capacity\.abandonedSlotReleaseAfterMs must be false or an integer/);
		}
	});

	it("loads and validates Fleet keybinding config", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ fleetKeybindings: { pageUp: ["u"], pageDown: ["d"] } }));
		assert.deepEqual(loadConfig().fleetKeybindings, { pageUp: ["u"], pageDown: ["d"] });

		writeFile(configPath, JSON.stringify({ fleetKeybindings: { missing: ["m"] } }));
		assert.throws(() => updateConfig((config) => config), /config\.fleetKeybindings\.missing is not a supported Fleet action/);

		writeFile(configPath, JSON.stringify({ fleetKeybindings: { pageUp: [""] } }));
		assert.throws(() => updateConfig((config) => config), /config\.fleetKeybindings\.pageUp entries must be non-empty strings/);
	});

	it("loads and validates the foreground detach shortcut", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ foregroundDetachShortcut: "ctrl+b" }));
		assert.equal(loadConfig().foregroundDetachShortcut, "ctrl+b");

		writeFile(configPath, JSON.stringify({ foregroundDetachShortcut: "banana" }));
		assert.throws(() => updateConfig((config) => config), /config\.foregroundDetachShortcut must be a valid keybinding string/);
	});

	it("loads and validates main-window renderer density config", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ mainWindowRenderer: { horizontalSpacing: 0, compactResultMaxLines: 4 } }));
		assert.deepEqual(loadConfig().mainWindowRenderer, { horizontalSpacing: 0, compactResultMaxLines: 4 });

		writeFile(configPath, JSON.stringify({ mainWindowRenderer: { horizontalSpacing: -1 } }));
		assert.throws(() => updateConfig((config) => config), /config\.mainWindowRenderer\.horizontalSpacing must be an integer from 0 to 4/);

		writeFile(configPath, JSON.stringify({ mainWindowRenderer: { compactResultMaxLines: 0 } }));
		assert.throws(() => updateConfig((config) => config), /config\.mainWindowRenderer\.compactResultMaxLines must be a positive integer/);
	});

	it("loads and validates experimental Orca progress-tab config", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		writeFile(configPath, JSON.stringify({ orcaProgressTabs: { enabled: true } }));
		assert.deepEqual(loadConfig().orcaProgressTabs, { enabled: true });

		writeFile(configPath, JSON.stringify({ orcaProgressTabs: { enabled: "yes" } }));
		assert.throws(() => updateConfig((config) => config), /config\.orcaProgressTabs\.enabled must be a boolean/);

		writeFile(configPath, JSON.stringify({ orcaProgressTabs: { enabled: true, focus: true } }));
		assert.throws(() => updateConfig((config) => config), /config\.orcaProgressTabs\.focus is not supported/);
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

	it("re-sanitizes run history after an external write", () => {
		recordRun("env-agent", "first secret", 0, 1);
		const historyPath = path.join(agentDir, "run-history.jsonl");
		fs.appendFileSync(historyPath, `${JSON.stringify({
			agent: "env-agent",
			task: "externally written secret",
			ts: 2,
			status: "ok",
			duration: 2,
		})}\n`);

		recordRun("env-agent", "second secret", 0, 3);

		const rawHistory = fs.readFileSync(historyPath, "utf-8");
		assert.doesNotMatch(rawHistory, /first secret|externally written secret|second secret/);
		assert.equal(loadRunsForAgent("env-agent").length, 3);
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

	it("planBackgroundRunHistory maps single and multi-step runs to a hashable task string (via rows)", () => {
		// Single step: the task text feeds the taskHash (redacted on disk), same as foreground.
		const single = planBackgroundRunHistory({
			steps: [{ task: "fix the flaky test" }], resultMode: "single",
			statusSteps: [{ agent: "worker", status: "complete", durationMs: 10 }], runDurationMs: 10,
		});
		assert.equal(single[0]?.task, "fix the flaky test");
		// launchBindingTask (worktree-bound copy) wins when present.
		assert.equal(planBackgroundRunHistory({
			steps: [{ task: "original", launchBindingTask: "bound COPY path" }], resultMode: "single",
			statusSteps: [{ agent: "worker", status: "complete", durationMs: 10 }], runDurationMs: 10,
		})[0]?.task, "bound COPY path");
		// Multi-step runs never leak per-step prompts: the census key is the mode label.
		assert.equal(planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }], resultMode: "parallel",
			statusSteps: [{ agent: "w", status: "complete", durationMs: 10 }, { agent: "r", status: "complete", durationMs: 10 }], runDurationMs: 20,
		})[0]?.task, "parallel");
		assert.equal(planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }], resultMode: "chain",
			statusSteps: [{ agent: "w", status: "complete", durationMs: 10 }, { agent: "r", status: "complete", durationMs: 10 }], runDurationMs: 20,
		})[0]?.task, "chain");
		// Missing/empty task falls back rather than producing an empty hash input.
		assert.equal(planBackgroundRunHistory({
			steps: [{ task: "" }], resultMode: "single",
			statusSteps: [{ agent: "worker", status: "complete", durationMs: 10 }], runDurationMs: 10,
		})[0]?.task, "single");
	});

	it("planBackgroundRunHistory records no row for steps the runner never launched, whatever their relabeled status", () => {
		// stopRunner relabels pending steps to `stopped`; timeoutRunner to `failed`+timedOut;
		// fail-fast and usage-budget skips to `failed`. Only the runner's `launched` fact
		// distinguishes them from steps that really dispatched a child session.
		const rows = planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }, { task: "c" }],
			resultMode: "parallel",
			statusSteps: [
				{ agent: "stopped-ghost", status: "stopped", durationMs: 0, launched: false },
				{ agent: "timeout-ghost", status: "failed", timedOut: true, durationMs: 0, launched: false },
				{ agent: "launched-stopped", status: "stopped", durationMs: 50, launched: true },
			],
			runDurationMs: 50,
			stopped: true,
		});
		assert.equal(rows.length, 1); // only the step that actually dispatched a child
		assert.equal(rows[0]?.agent, "launched-stopped");
		assert.equal(rows[0]?.terminal.stopped, true);
	});

	it("planBackgroundRunHistory maps a single-step run to one foreground-shaped row", () => {
		const rows = planBackgroundRunHistory({
			steps: [{ task: "fix the flaky test" }],
			resultMode: "single",
			statusSteps: [{ agent: "worker", status: "complete", durationMs: 4321 }],
			runDurationMs: 5000,
		});
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.agent, "worker");
		assert.equal(rows[0]?.task, "fix the flaky test");
		assert.equal(rows[0]?.exitCode, 0);
		assert.equal(rows[0]?.durationMs, 4321);
		assert.deepEqual(rows[0]?.terminal, {});
	});

	it("planBackgroundRunHistory records one row per child step so loadRunsForAgent sees every child", () => {
		const rows = planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }, { task: "c" }],
			resultMode: "parallel",
			statusSteps: [
				{ agent: "worker", status: "complete", durationMs: 100 },
				{ agent: "worker", status: "failed" },            // duplicate agent stays two rows
				{ agent: "reviewer", status: "complete", durationMs: 300 },
			],
			stepResults: [{}, { processSignal: "SIGTERM" }, {}],
			runDurationMs: 999,
		});
		assert.deepEqual(rows.map((row) => row.agent), ["worker", "worker", "reviewer"]);
		// Multi-step rows hash the mode label, never per-step prompts.
		assert.ok(rows.every((row) => row.task === "parallel"));
		assert.deepEqual(rows.map((row) => row.exitCode), [0, 1, 0]);
		assert.equal(rows[1]?.durationMs, 999); // missing step duration falls back to the run duration
		assert.equal(rows[1]?.terminal.processSignal, "SIGTERM");
	});

	it("planBackgroundRunHistory skips steps that never ran (pending after an early chain failure)", () => {
		const rows = planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }, { task: "c" }],
			resultMode: "chain",
			statusSteps: [
				{ agent: "worker", status: "failed", durationMs: 50 },
				{ agent: "worker", status: "pending" },   // chain stopped here — never attempted
				{ agent: "reviewer", status: "pending" },  // never attempted
			],
			runDurationMs: 60,
		});
		// Only the one child that actually ran gets a row; unrun agents accumulate no attempts.
		assert.deepEqual(rows.map((row) => row.agent), ["worker"]);
		assert.equal(rows[0]?.exitCode, 1);
	});

	it("planBackgroundRunHistory keeps a completed child's outcome when the run is interrupted later", () => {
		const rows = planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }],
			resultMode: "chain",
			statusSteps: [
				{ agent: "worker", status: "complete", durationMs: 100 }, // finished before the interrupt
				{ agent: "worker", status: "paused" },                     // interrupted mid-run
			],
			runDurationMs: 200,
			interrupted: true,
		});
		assert.equal(rows[0]?.exitCode, 0);
		assert.deepEqual(rows[0]?.terminal, {});
		assert.equal(rows[1]?.terminal.interrupted, true);
	});

	it("planBackgroundRunHistory keeps an earlier failure's outcome when a sibling is later interrupted", () => {
		const rows = planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }],
			resultMode: "parallel",
			statusSteps: [
				{ agent: "worker", status: "failed", durationMs: 40 }, // failed on its own, earlier
				{ agent: "reviewer", status: "paused" },               // sibling interrupted later
			],
			runDurationMs: 100,
			interrupted: true,
		});
		assert.deepEqual(rows[0]?.terminal, {});
		assert.equal(rows[0]?.exitCode, 1);
		assert.equal(rows[1]?.terminal.interrupted, true);
	});

	it("planBackgroundRunHistory honors a self-terminal step's own timeout flag", () => {
		const rows = planBackgroundRunHistory({
			steps: [{ task: "a" }],
			resultMode: "single",
			statusSteps: [{ agent: "worker", status: "failed", durationMs: 30, timedOut: true }],
			runDurationMs: 30,
		});
		assert.deepEqual(rows[0]?.terminal, { timedOut: true }); // outcome "timed_out", not "failed"
	});

	it("planBackgroundRunHistory propagates run-level terminal flags to non-terminal rows", () => {
		const rows = planBackgroundRunHistory({
			steps: [{ task: "a" }, { task: "b" }],
			resultMode: "chain",
			statusSteps: [{ agent: "worker", status: "paused" }, { agent: "worker", status: "stopped" }],
			runDurationMs: 10,
			interrupted: true,
			timedOut: false,
		});
		assert.ok(rows.length === 2);
		assert.ok(rows.every((row) => row.terminal.interrupted === true && row.terminal.timedOut === undefined));
		assert.ok(rows.every((row) => row.exitCode === 1)); // paused is not a terminal success
	});

	it("planBackgroundRunHistory skips steps without a usable agent name", () => {
		const rows = planBackgroundRunHistory({
			steps: [],
			resultMode: "single",
			statusSteps: [{ agent: "", status: "complete" }, { status: "complete" }, { agent: "worker", status: "complete", durationMs: 5 }],
			runDurationMs: 7,
		});
		assert.deepEqual(rows.map((row) => row.agent), ["worker"]);
	});
});
