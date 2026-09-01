import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildBuiltinOverrideConfig,
	discoverAgents,
	discoverAgentsAll,
} from "../../src/agents/agents.ts";
import { handleUpdate } from "../../src/agents/agent-management.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(name: string, extensions?: string): void {
	const filePath = path.join(tempProject, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: Test agent${extensions === undefined ? "" : `\nextensions:${extensions ? ` ${extensions}` : ""}`}\n---\n\nTest agent.\n`,
		"utf-8",
	);
}

describe("subagents.defaultExtensions", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagents-project-"),
		);
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined)
			delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("preserves ambient discovery when omitted and disables it when empty", () => {
		let scout = discoverAgentsAll(tempProject).builtin.find(
			(agent) => agent.name === "scout",
		);
		assert.equal(scout?.extensions, undefined);

		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultExtensions: [] },
		});
		scout = discoverAgentsAll(tempProject).builtin.find(
			(agent) => agent.name === "scout",
		);
		assert.deepEqual(scout?.extensions, []);
	});

	it("applies the allowlist only when an agent has no extensions field", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultExtensions: ["./shared.ts"] },
		});
		writeProjectAgent("inherited");
		writeProjectAgent("explicit", "./explicit.ts");
		writeProjectAgent("disabled", "");

		const agents = discoverAgents(tempProject, "both").agents;
		assert.deepEqual(
			agents.find((agent) => agent.name === "inherited")?.extensions,
			["./shared.ts"],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "explicit")?.extensions,
			[path.join(tempProject, ".pi", "agents", "explicit.ts")],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "disabled")?.extensions,
			[],
		);
	});

	it("supports per-agent extensions through agentOverrides", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultExtensions: [],
				agentOverrides: {
					scout: { extensions: ["./scout.ts"] },
					inherited: { extensions: ["./inherited.ts"] },
					explicit: { extensions: ["./ignored.ts"] },
				},
			},
		});
		writeProjectAgent("inherited");
		writeProjectAgent("explicit", "./frontmatter.ts");

		const agents = discoverAgents(tempProject, "both").agents;
		assert.deepEqual(
			agents.find((agent) => agent.name === "scout")?.extensions,
			["./scout.ts"],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "inherited")?.extensions,
			["./inherited.ts"],
		);
		assert.deepEqual(
			agents.find((agent) => agent.name === "explicit")?.extensions,
			["./ignored.ts"],
		);
	});

	it("does not serialize settings-derived extensions during unrelated updates", () => {
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				defaultExtensions: ["./default.ts"],
				agentOverrides: {
					overridden: { extensions: ["./override.ts"] },
				},
			},
		});
		writeProjectAgent("defaulted");
		writeProjectAgent("overridden");

		const ctx = {
			cwd: tempProject,
			modelRegistry: { getAvailable: () => [] },
		} as unknown as Parameters<typeof handleUpdate>[1];
		for (const agent of ["defaulted", "overridden"]) {
			const updated = handleUpdate(
				{ agent, config: { description: `Updated ${agent}` } },
				ctx,
			);
			assert.equal(
				(updated as typeof updated & { isError?: boolean }).isError,
				false,
			);
			const content = fs.readFileSync(
				path.join(tempProject, ".pi", "agents", `${agent}.md`),
				"utf-8",
			);
			assert.doesNotMatch(content, /^extensions:/m);
		}
	});

	it("persists per-agent extension overrides", () => {
		const override = buildBuiltinOverrideConfig(
			{
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				systemPrompt: "Test agent",
				extensions: [],
			},
			{
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				systemPrompt: "Test agent",
				extensions: ["./agent.ts"],
			},
		);

		assert.deepEqual(override, { extensions: ["./agent.ts"] });
	});

	it("uses project settings over user settings while respecting discovery scope", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultExtensions: ["./user.ts"] },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultExtensions: [] },
		});

		assert.deepEqual(
			discoverAgents(tempProject, "both").agents.find(
				(agent) => agent.name === "scout",
			)?.extensions,
			[],
		);
		assert.deepEqual(
			discoverAgents(tempProject, "user").agents.find(
				(agent) => agent.name === "scout",
			)?.extensions,
			["./user.ts"],
		);
		assert.deepEqual(
			discoverAgents(tempProject, "project").agents.find(
				(agent) => agent.name === "scout",
			)?.extensions,
			[],
		);
	});

	it("rejects malformed values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const defaultExtensions of ["nope", 42, [""], [42], ["valid", 42]]) {
			writeJson(settingsPath, { subagents: { defaultExtensions } });
			assert.throws(
				() => discoverAgents(tempProject, "both"),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(settingsPath) &&
					error.message.includes("defaultExtensions"),
			);
		}
	});
});
