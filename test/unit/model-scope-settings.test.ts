import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("subagents.modelScope discovery", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-scope-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-scope-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		if (originalExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = originalExtraAgentDirs;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("exposes a user modelScope from discoverAgents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { modelScope: { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] } },
		});
		const result = discoverAgents(tempProject, "both");
		assert.deepEqual(result.modelScope, { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] });
	});

	it("returns undefined when no modelScope is configured", () => {
		assert.equal(discoverAgents(tempProject, "both").modelScope, undefined);
	});

	it("prefers project modelScope over user modelScope", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { modelScope: { enforce: true, allow: ["anthropic/*"] } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { modelScope: { enforce: false, allow: ["deepseek/*"] } },
		});
		const result = discoverAgents(tempProject, "both");
		assert.deepEqual(result.modelScope, { enforce: false, allow: ["deepseek/*"] });
	});

	it("falls back to user modelScope when project does not set one", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { modelScope: { enforce: true, allow: ["anthropic/*"] } },
		});
		const result = discoverAgents(tempProject, "both");
		assert.deepEqual(result.modelScope, { enforce: true, allow: ["anthropic/*"] });
	});

	it("rejects an invalid modelScope config at discovery time", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { modelScope: { enforce: true } },
		});
		assert.throws(() => discoverAgents(tempProject, "both"), /without a non-empty 'allow'/);
	});

	it("rejects a malformed modelScope value at discovery time", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { modelScope: "anthropic/*" },
		});
		assert.throws(() => discoverAgents(tempProject, "both"), /invalid 'modelScope'/);
	});
});
