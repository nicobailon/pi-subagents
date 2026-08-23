import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { assertThinkingWithinCeiling, compareThinkingLevels, intersectThinkingCeilings, parseThinkingLevel } from "../../src/shared/thinking-ceiling.ts";

let home = "";
let project = "";
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

describe("thinking ceilings", () => {
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-thinking-ceiling-home-"));
		project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-thinking-ceiling-project-"));
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	});

	it("orders every supported level and rejects malformed ceilings", () => {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
		for (let index = 0; index < levels.length; index++) {
			assert.equal(parseThinkingLevel(levels[index]), levels[index]);
			if (index > 0) assert.ok(compareThinkingLevels(levels[index - 1], levels[index]) < 0);
		}
		assert.throws(() => parseThinkingLevel("turbo"), /expected one of/);
	});

	it("intersects inherited ceilings and validates concrete model suffixes", () => {
		assert.equal(intersectThinkingCeilings("xhigh", "high"), "high");
		assert.equal(intersectThinkingCeilings("low", "xhigh"), "low");
		assert.doesNotThrow(() => assertThinkingWithinCeiling({ model: "test/model:xhigh", ceiling: "xhigh", agent: "worker" }));
		assert.throws(
			() => assertThinkingWithinCeiling({ model: "test/model:max", ceiling: "xhigh", agent: "worker", runId: "run-1" }),
			/Thinking level 'max'.*maximum 'xhigh'.*worker.*run-1/,
		);
		assert.doesNotThrow(() => assertThinkingWithinCeiling({ model: "test/model", configThinking: false, ceiling: "off" }));
	});

	it("loads maxThinking with project precedence and attaches it to discovered agents", () => {
		writeJson(path.join(home, ".pi", "agent", "settings.json"), { subagents: { maxThinking: "max" } });
		fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
		writeJson(path.join(project, ".pi", "settings.json"), { subagents: { maxThinking: "xhigh" } });
		const discovered = discoverAgents(project, "both");
		assert.equal(discovered.maxThinking, "xhigh");
		assert.equal(discovered.agents.find((agent) => agent.name === "worker")?.maxThinking, "xhigh");
	});

	it("fails closed for invalid maxThinking settings", () => {
		const settingsPath = path.join(home, ".pi", "agent", "settings.json");
		for (const value of ["", "turbo", 42, false]) {
			writeJson(settingsPath, { subagents: { maxThinking: value } });
			assert.throws(() => discoverAgents(project, "both"), (error: unknown) => error instanceof Error && error.message.includes(settingsPath) && error.message.includes("maxThinking"));
		}
	});
});
