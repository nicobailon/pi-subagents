import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearAgentDiscoveryCache, discoverAgents } from "../../src/agents/agents.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `agent-scan-${prefix}-`));
}

function writeAgent(dir: string, name: string, description = "scan dirs test"): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`, "utf-8");
}

describe("settings subagents.agentScanDirs", () => {
	let agentDir: string;
	let projectDir: string;
	let scanRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = tempDir("agent");
		projectDir = tempDir("project");
		scanRoot = tempDir("scan");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
		clearAgentDiscoveryCache();
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const dir of [agentDir, projectDir, scanRoot]) fs.rmSync(dir, { recursive: true, force: true });
		clearAgentDiscoveryCache();
	});

	function writeUserSettings(value: unknown): void {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(value), "utf-8");
	}

	function writeProjectSettings(value: unknown): void {
		fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify(value), "utf-8");
	}

	it("discovers agents from configured user scan directories", () => {
		writeAgent(scanRoot, "scan-writer");
		writeUserSettings({ subagents: { agentScanDirs: [scanRoot] } });

		const result = discoverAgents(projectDir, "user");

		const agent = result.agents.find((candidate) => candidate.name === "scan-writer");
		assert.equal(agent?.source, "user");
		assert.equal(agent?.filePath, path.join(scanRoot, "scan-writer.md"));
	});

	it("expands one wildcard directory segment and invalidates when children are added", () => {
		writeUserSettings({ subagents: { agentScanDirs: [path.join(scanRoot, "*", "agents")] } });
		assert.equal(discoverAgents(projectDir, "user").agents.some((agent) => agent.name === "late-writer"), false);

		writeAgent(path.join(scanRoot, "template-a", "agents"), "late-writer");
		const result = discoverAgents(projectDir, "user");

		assert.equal(result.agents.some((agent) => agent.name === "late-writer"), true);
	});

	it("invalidates when an existing wildcard child receives its agents directory", () => {
		fs.mkdirSync(path.join(scanRoot, "template-a"));
		writeUserSettings({ subagents: { agentScanDirs: [path.join(scanRoot, "*", "agents")] } });
		assert.equal(discoverAgents(projectDir, "user").agents.some((agent) => agent.name === "late-nested-writer"), false);

		writeAgent(path.join(scanRoot, "template-a", "agents"), "late-nested-writer");
		const result = discoverAgents(projectDir, "user");

		assert.equal(result.agents.some((agent) => agent.name === "late-nested-writer"), true);
	});

	it("keeps user and project scan directories scoped", () => {
		const userScanDir = path.join(scanRoot, "user-agents");
		const projectScanDir = path.join(scanRoot, "project-agents");
		writeAgent(userScanDir, "user-scan");
		writeAgent(projectScanDir, "project-scan");
		writeUserSettings({ subagents: { agentScanDirs: [userScanDir] } });
		writeProjectSettings({ subagents: { agentScanDirs: [projectScanDir] } });

		assert.equal(discoverAgents(projectDir, "user").agents.some((agent) => agent.name === "project-scan"), false);
		assert.equal(discoverAgents(projectDir, "project").agents.some((agent) => agent.name === "user-scan"), false);
		assert.equal(discoverAgents(projectDir, "both").agents.some((agent) => agent.name === "user-scan"), true);
		assert.equal(discoverAgents(projectDir, "both").agents.some((agent) => agent.name === "project-scan"), true);
	});

	it("lets fixed user agents override same-name scan-dir agents", () => {
		writeAgent(path.join(scanRoot, "template", "agents"), "writer", "from scan dir");
		writeAgent(path.join(agentDir, "agents"), "writer", "from fixed user dir");
		writeUserSettings({ subagents: { agentScanDirs: [path.join(scanRoot, "*", "agents")] } });

		const agent = discoverAgents(projectDir, "both").agents.find((candidate) => candidate.name === "writer");

		assert.equal(agent?.filePath, path.join(agentDir, "agents", "writer.md"));
	});

	it("accepts backslash-separated wildcard patterns", () => {
		writeAgent(path.join(scanRoot, "template", "agents"), "backslash-scan");
		writeUserSettings({ subagents: { agentScanDirs: [`${scanRoot}\\*\\agents`] } });

		const result = discoverAgents(projectDir, "user");

		assert.equal(result.agents.some((agent) => agent.name === "backslash-scan"), true);
	});

	it("does not treat constrained wildcard segments as broad directory scans", () => {
		writeAgent(path.join(scanRoot, "flow-a", "agents"), "flow-scan");
		writeAgent(path.join(scanRoot, "other", "agents"), "other-scan");
		writeUserSettings({ subagents: { agentScanDirs: [path.join(scanRoot, "flow-*", "agents")] } });

		const result = discoverAgents(projectDir, "user");

		assert.equal(result.agents.some((agent) => agent.name === "flow-scan"), false);
		assert.equal(result.agents.some((agent) => agent.name === "other-scan"), false);
	});

	it("rejects malformed scan directory settings", () => {
		writeUserSettings({ subagents: { agentScanDirs: [path.join(scanRoot, "agents"), 42] } });

		assert.throws(
			() => discoverAgents(projectDir, "user"),
			/Subagent settings .* invalid 'agentScanDirs'/,
		);
	});
});
