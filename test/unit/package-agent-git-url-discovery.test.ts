import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";

const MANAGED_ENV = ["PI_CODING_AGENT_DIR", "HOME", "USERPROFILE"];

function writeAgent(dir: string, name: string): void {
	const filePath = path.join(dir, `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: ${name} agent\n---\n\nDo ${name} work.\n`,
		"utf-8",
	);
}

describe("package agent discovery from user settings", () => {
	let tempDir = "";
	let agentDir = "";
	let homeDir = "";
	let cwd = "";
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of MANAGED_ENV) saved[key] = process.env[key];
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-git-url-"));
		agentDir = path.join(tempDir, "agent");
		homeDir = path.join(tempDir, "home");
		cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(homeDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
	});

	afterEach(() => {
		for (const key of MANAGED_ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("discovers agents from git packages installed via bare HTTPS URL", () => {
		// Simulate Pi installing a package from a git URL.
		const packageRoot = path.join(agentDir, "git", "github.com", "test-org", "test-repo");
		const agentsDir = path.join(packageRoot, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: "test-git-package", "pi-subagents": { agents: ["./agents"] } }),
		);
		writeAgent(agentsDir, "https-git-agent");

		// Pi stores the source in user settings as a bare HTTPS URL.
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["https://github.com/test-org/test-repo.git"] }),
		);

		const all = discoverAgentsAll(cwd);
		const agent = all.package.find((a) => a.name === "https-git-agent");
		assert.ok(agent, "expected agent from HTTPS git package to be discovered");
		assert.equal(agent?.packageSourceName, "test-git-package");
	});
});
