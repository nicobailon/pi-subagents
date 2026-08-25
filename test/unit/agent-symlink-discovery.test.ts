import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";

let tempDir = "";
let cwd = "";
const saved: Record<string, string | undefined> = {};
const MANAGED_ENV = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", "PI_SUBAGENT_EXTRA_AGENT_DIRS"];

function writeAgent(dir: string, name: string): string {
	const filePath = path.join(dir, `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} agent\n---\n\nDo ${name} work.\n`, "utf-8");
	return filePath;
}

const SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function symlinkDir(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, SYMLINK_TYPE);
		return true;
	} catch (error) {
		// Windows without Developer Mode/elevation rejects symlink creation (EPERM).
		if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	}
}

describe("agent discovery through symlinked directories (#1505)", () => {
	beforeEach(() => {
		for (const key of MANAGED_ENV) saved[key] = process.env[key];
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-symlink-"));
		// Isolate from the developer's real user agent dirs so defaults are empty.
		const homeDir = path.join(tempDir, "home");
		cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(homeDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	});

	afterEach(() => {
		for (const key of MANAGED_ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers agents inside a symlinked .agents/agents directory", () => {
		const toolkitAgents = path.join(tempDir, "toolkit", ".agents", "agents");
		writeAgent(toolkitAgents, "shared-reviewer");

		const projectAgentsRoot = path.join(cwd, ".agents");
		fs.mkdirSync(projectAgentsRoot, { recursive: true });
		if (!symlinkDir(toolkitAgents, path.join(projectAgentsRoot, "agents"))) return;

		const found = discoverAgents(cwd, "project").agents.find((a) => a.name === "shared-reviewer");
		assert.ok(found, "expected agent inside symlinked directory to be discovered");
	});

	it("still discovers agents inside a nested symlinked subdirectory", () => {
		const toolkitTeam = path.join(tempDir, "toolkit", "team");
		writeAgent(toolkitTeam, "team-agent");

		const projectAgents = path.join(cwd, ".agents", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		if (!symlinkDir(toolkitTeam, path.join(projectAgents, "team"))) return;

		const found = discoverAgents(cwd, "project").agents.find((a) => a.name === "team-agent");
		assert.ok(found, "expected agent inside nested symlinked directory to be discovered");
	});

	it("ignores a dangling directory symlink without throwing", () => {
		const projectAgents = path.join(cwd, ".agents", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		writeAgent(projectAgents, "real-agent");
		if (!symlinkDir(path.join(tempDir, "missing-target"), path.join(projectAgents, "gone"))) return;

		const agents = discoverAgents(cwd, "project").agents;
		assert.ok(agents.find((a) => a.name === "real-agent"), "real agent should still resolve");
	});

	it("terminates when a symlink points back to an ancestor directory", () => {
		const projectAgents = path.join(cwd, ".agents", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		writeAgent(projectAgents, "loop-agent");
		// A symlink back to an ancestor would loop forever without cycle detection.
		if (!symlinkDir(projectAgents, path.join(projectAgents, "self"))) return;

		const agents = discoverAgents(cwd, "project").agents;
		assert.ok(agents.find((a) => a.name === "loop-agent"), "real agent should still resolve despite the cycle");
	});
});
