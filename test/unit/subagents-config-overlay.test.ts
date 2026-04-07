import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../agents.ts";

describe("subagents-config-overlay", () => {
	let tempHome: string;
	let prevHomeEnv: string | undefined;
	const tempDirs: string[] = [];

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-overlay-home-"));
		prevHomeEnv = process.env.PI_SUBAGENTS_HOME;
		process.env.PI_SUBAGENTS_HOME = tempHome;
	});

	afterEach(() => {
		if (prevHomeEnv === undefined) delete process.env.PI_SUBAGENTS_HOME;
		else process.env.PI_SUBAGENTS_HOME = prevHomeEnv;
		fs.rmSync(tempHome, { recursive: true, force: true });
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (!dir) continue;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function mkProject(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-overlay-proj-"));
		tempDirs.push(dir);
		return dir;
	}

	function writeAgent(projectDir: string, name: string, frontmatter: string, body = "Do things"): void {
		const agentsDir = path.join(projectDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\n${frontmatter}---\n\n${body}\n`,
			"utf-8",
		);
	}

	function writeProjectOverlay(projectDir: string, data: unknown): void {
		const p = path.join(projectDir, ".pi", "subagents.json");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(data), "utf-8");
	}

	function writeUserOverlay(data: unknown): void {
		const p = path.join(tempHome, ".pi", "agent", "subagents.json");
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(data), "utf-8");
	}

	it("project overlay overrides model defined in .md", () => {
		const projectDir = mkProject();
		writeAgent(projectDir, "scout", "model: foo\n");
		writeProjectOverlay(projectDir, { agents: { scout: { model: "bar" } } });

		const { agents } = discoverAgents(projectDir, "project");
		const scout = agents.find((a) => a.name === "scout");
		assert.equal(scout?.model, "bar");
	});

	it("project overlay sets model when .md has none", () => {
		const projectDir = mkProject();
		writeAgent(projectDir, "scout", "");
		writeProjectOverlay(projectDir, { agents: { scout: { model: "bar" } } });

		const { agents } = discoverAgents(projectDir, "project");
		const scout = agents.find((a) => a.name === "scout");
		assert.equal(scout?.model, "bar");
	});

	it("no override preserves .md model (regression)", () => {
		const projectDir = mkProject();
		writeAgent(projectDir, "scout", "model: foo\n");

		const { agents } = discoverAgents(projectDir, "project");
		const scout = agents.find((a) => a.name === "scout");
		assert.equal(scout?.model, "foo");
	});

	it("override defaultProgress: false is applied (not truthy-filtered)", () => {
		const projectDir = mkProject();
		writeAgent(projectDir, "scout", "defaultProgress: true\n");
		writeProjectOverlay(projectDir, { agents: { scout: { defaultProgress: false } } });

		const { agents } = discoverAgents(projectDir, "project");
		const scout = agents.find((a) => a.name === "scout");
		assert.equal(scout?.defaultProgress, false);
	});

	it("override skills replaces the list exactly", () => {
		const projectDir = mkProject();
		writeAgent(projectDir, "scout", "skills: x, y, z\n");
		writeProjectOverlay(projectDir, { agents: { scout: { skills: ["a", "b"] } } });

		const { agents } = discoverAgents(projectDir, "project");
		const scout = agents.find((a) => a.name === "scout");
		assert.deepEqual(scout?.skills, ["a", "b"]);
	});

	it("user-scope overlay is applied", () => {
		const projectDir = mkProject();
		writeAgent(projectDir, "scout", "model: foo\n");
		writeUserOverlay({ agents: { scout: { model: "user-model" } } });

		const { agents } = discoverAgents(projectDir, "project");
		const scout = agents.find((a) => a.name === "scout");
		assert.equal(scout?.model, "user-model");
	});

	it("project overlay wins per-field; user-only fields preserved", () => {
		const projectDir = mkProject();
		writeAgent(projectDir, "scout", "model: foo\n");
		writeUserOverlay({
			agents: { scout: { model: "user-model", thinking: "user-thinking" } },
		});
		writeProjectOverlay(projectDir, { agents: { scout: { model: "project-model" } } });

		const { agents } = discoverAgents(projectDir, "project");
		const scout = agents.find((a) => a.name === "scout");
		assert.equal(scout?.model, "project-model");
		assert.equal(scout?.thinking, "user-thinking");
	});
});
