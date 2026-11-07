import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { handleCreate, handleUpdate } from "../../src/agents/agent-management.ts";

let tempHome = "";
let tempProject = "";
const managedEnv = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
const savedEnv = managedEnv.map((name) => process.env[name]);

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeAgent(dir: string, name: string, extraFrontmatter = ""): string {
	const filePath = path.join(dir, `${name}.md`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: Test agent${extraFrontmatter ? `\n${extraFrontmatter}` : ""}\n---\n\nTest agent.\n`, "utf-8");
	return filePath;
}

function inheritsGlobal(name: string): boolean | undefined {
	return discoverAgents(tempProject, "both").agents.find((agent) => agent.name === name)?.inheritGlobalContext;
}

describe("subagents.defaultInheritGlobalContext", () => {
	let userSettingsPath = "";
	let projectAgents = "";

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		userSettingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		projectAgents = path.join(tempProject, ".pi", "agents");
		writeAgent(path.join(tempHome, ".pi", "agent", "agents"), "mine");
		writeAgent(projectAgents, "plain");
		writeAgent(projectAgents, "optout", "inheritGlobalContext: false");
	});

	afterEach(() => {
		managedEnv.forEach((name, index) => {
			if (savedEnv[index] === undefined) delete process.env[name];
			else process.env[name] = savedEnv[index];
		});
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("leaves agents unchanged when unset", () => {
		for (const name of ["scout", "mine", "plain"]) assert.equal(inheritsGlobal(name), false, name);
	});

	it("turns global context on for every agent without its own value", () => {
		writeJson(userSettingsPath, {
			subagents: { defaultInheritGlobalContext: true, agentOverrides: { reviewer: { inheritGlobalContext: false } } },
		});
		for (const name of ["scout", "mine", "plain"]) assert.equal(inheritsGlobal(name), true, name);
		assert.equal(inheritsGlobal("optout"), false);
		assert.equal(inheritsGlobal("reviewer"), false);
	});

	it("uses the project setting over the user setting", () => {
		writeJson(userSettingsPath, { subagents: { defaultInheritGlobalContext: true } });
		writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { defaultInheritGlobalContext: false } });
		assert.equal(inheritsGlobal("scout"), false);
		writeJson(userSettingsPath, { subagents: { defaultInheritGlobalContext: false } });
		writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { defaultInheritGlobalContext: true } });
		assert.equal(inheritsGlobal("scout"), true);
	});

	it("rejects a non-boolean value", () => {
		writeJson(userSettingsPath, { subagents: { defaultInheritGlobalContext: "true" } });
		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error && error.message.includes(userSettingsPath) && error.message.includes("defaultInheritGlobalContext"),
		);
	});

	it("does not write the default into an agent file on update", () => {
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultInheritGlobalContext: true, agentOverrides: { overridden: { thinking: "low" } } },
		});
		writeAgent(projectAgents, "overridden");
		const ctx = { cwd: tempProject, modelRegistry: { getAvailable: () => [] } } as unknown as Parameters<typeof handleUpdate>[1];
		for (const agent of ["plain", "overridden"]) {
			const updated = handleUpdate({ agent, config: { description: `Updated ${agent}` } }, ctx);
			assert.equal(updated.isError, false);
			const content = fs.readFileSync(path.join(projectAgents, `${agent}.md`), "utf-8");
			assert.match(content, new RegExp(`^description: Updated ${agent}$`, "m"));
			assert.doesNotMatch(content, /^inheritGlobalContext:/m);
		}
	});

	it("keeps an explicit false from create", () => {
		writeJson(path.join(tempProject, ".pi", "settings.json"), { subagents: { defaultInheritGlobalContext: true } });
		const ctx = { cwd: tempProject, modelRegistry: { getAvailable: () => [] } } as unknown as Parameters<typeof handleCreate>[1];
		const created = handleCreate({ config: { name: "created-optout", description: "Created", scope: "project", inheritGlobalContext: false } }, ctx);
		assert.equal(created.isError, false);
		assert.equal(inheritsGlobal("created-optout"), false);
	});
});
