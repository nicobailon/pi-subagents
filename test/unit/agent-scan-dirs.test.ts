import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../../src/agents/agents.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-scan-" + prefix + "-"));
}

describe("settings subagents.agentScanDirs", () => {
	let agentDir: string;
	let projectDir: string;
	let scanRoot: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = tempDir("agent");
		projectDir = tempDir("proj");
		scanRoot = tempDir("scan");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	function writeAgent(dir: string, name: string): void {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, name + ".md"), "---\nname: " + name + "\ndescription: scan dirs test\n---\nbody", "utf8");
	}

	function writeSettings(value: unknown): void {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(value), "utf8");
	}

	function writeProjectSettings(value: unknown): void {
		fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify(value), "utf8");
	}

	it("discovers agents from subagents.agentScanDirs with last-segment glob", () => {
		writeAgent(path.join(scanRoot, "tplA", "agents"), "writer");
		writeSettings({ subagents: { agentScanDirs: [scanRoot.replaceAll("\\", "/") + "/*/agents"] } });
		const result = discoverAgents(projectDir, "both");
		assert.ok(
			result.agents.some((agent) => agent.localName === "writer" || agent.name === "writer"),
			"expected writer discovered, got: " + result.agents.map((a) => a.name).join(","),
		);
	});

	it("keeps user and project scan directories scoped while both includes both", () => {
		const userScanDir = path.join(scanRoot, "user-agents");
		const projectScanDir = path.join(scanRoot, "project-agents");
		writeAgent(userScanDir, "user-scan");
		writeAgent(projectScanDir, "project-scan");
		writeSettings({ subagents: { agentScanDirs: [userScanDir] } });
		writeProjectSettings({ subagents: { agentScanDirs: [projectScanDir] } });

		const userOnly = discoverAgents(projectDir, "user").agents;
		assert.ok(userOnly.some((agent) => agent.name === "user-scan"));
		assert.ok(!userOnly.some((agent) => agent.name === "project-scan"));

		const projectOnly = discoverAgents(projectDir, "project").agents;
		assert.ok(!projectOnly.some((agent) => agent.name === "user-scan"));
		assert.ok(projectOnly.some((agent) => agent.name === "project-scan"));
		assert.equal(projectOnly.find((agent) => agent.name === "project-scan")?.source, "project");

		const both = discoverAgents(projectDir, "both").agents;
		assert.ok(both.some((agent) => agent.name === "user-scan"));
		assert.ok(both.some((agent) => agent.name === "project-scan"));
	});

	it("preserves the suffix after a backslash wildcard", () => {
		writeAgent(path.join(scanRoot, "tplA", "agents"), "backslash");
		writeSettings({ subagents: { agentScanDirs: [scanRoot + "\\*\\agents"] } });
		const result = discoverAgents(projectDir, "user");
		assert.ok(result.agents.some((agent) => agent.name === "backslash"));
	});

	it("does not discover agents when the setting is absent", () => {
		writeAgent(path.join(scanRoot, "tplA", "agents"), "lonely");
		const result = discoverAgents(projectDir, "both");
		assert.ok(!result.agents.some((agent) => agent.localName === "lonely" || agent.name === "lonely"));
	});

	it("prefers user-dir copy over scan-dir same-name agent (eject semantics)", () => {
		writeAgent(path.join(scanRoot, "tplA", "agents"), "writer");
		writeAgent(path.join(agentDir, "agents"), "writer");
		writeSettings({ subagents: { agentScanDirs: [scanRoot.replaceAll("\\", "/") + "/*/agents"] } });
		const result = discoverAgents(projectDir, "both");
		const agent = result.agents.find((a) => a.localName === "writer" || a.name === "writer");
		assert.ok(agent, "writer should exist");
		const filePath = String((agent as { filePath?: string }).filePath ?? "");
		assert.ok(filePath.startsWith(path.join(agentDir, "agents")), "user-dir copy should win, got " + filePath);
	});

	it("supports plain directory entries without glob", () => {
		writeAgent(scanRoot, "flat");
		writeSettings({ subagents: { agentScanDirs: [scanRoot.replaceAll("\\", "/")] } });
		const result = discoverAgents(projectDir, "both");
		assert.ok(result.agents.some((agent) => agent.localName === "flat" || agent.name === "flat"));
	});

	it("ignores missing directories and malformed settings", () => {
		writeSettings({ subagents: { agentScanDirs: [scanRoot.replaceAll("\\", "/") + "/missing/agents", 42] } });
		const result = discoverAgents(projectDir, "both");
		assert.ok(Array.isArray(result.agents));
	});
});
