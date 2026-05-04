import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll, removeBuiltinAgentOverride } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("builtin agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("bundled builtin agents inherit the default model", () => {
		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.ok(builtins.length > 0);
		assert.deepEqual(
			builtins
				.filter((agent) => agent.model !== undefined || agent.fallbackModels !== undefined)
				.map((agent) => agent.name),
			[],
		);
	});

	it("applies user settings overrides to builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						model: "openai/gpt-5.4",
						thinking: "xhigh",
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: true,
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "builtin");
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.thinking, "xhigh");
		assert.equal(reviewer.systemPromptMode, "replace");
		assert.equal(reviewer.inheritProjectContext, true);
		assert.equal(reviewer.inheritSkills, true);
		assert.equal(reviewer.override?.scope, "user");
		assert.equal(reviewer.override?.path, path.join(tempHome, ".pi", "agent", "settings.json"));
	});

	it("prefers project settings overrides over user settings overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini", thinking: "high" } } },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.thinking, "high");
		assert.equal(reviewer.override?.scope, "project");
		assert.equal(reviewer.override?.path, path.join(tempProject, ".pi", "settings.json"));
	});

	it("does not apply project settings overrides when scope is user", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "user").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override?.scope, "user");
	});

	it("does not apply user settings overrides when scope is project", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.notEqual(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override, undefined);
	});

	it("does not read malformed out-of-scope settings files", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), '{"subagents":', "utf-8");
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.override?.scope, "project");
	});

	it("does not apply builtin settings overrides when a full project agent overrides the builtin", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeProjectAgent(tempProject, "reviewer", `---\nname: reviewer\ndescription: Project reviewer\nmodel: google/gemini-3-pro\n---\n\nUse the project reviewer.\n`);

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "project");
		assert.equal(reviewer.model, "google/gemini-3-pro");
		assert.equal(reviewer.override, undefined);
	});

	it("does not create a settings file when removing a non-existent override", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		assert.equal(fs.existsSync(settingsPath), false);
		removeBuiltinAgentOverride(tempProject, "reviewer", "user");
		assert.equal(fs.existsSync(settingsPath), false);
	});

	it("surfaces malformed settings files instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, '{"subagents":', "utf-8");

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to parse settings file"),
		);
	});

	it("surfaces settings read failures without mislabeling them as parse errors", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(settingsPath, { recursive: true });

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to read settings file"),
		);
	});

	it("surfaces malformed builtin override entries instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						inheritProjectContext: "true",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("inheritProjectContext"),
		);
	});

	it("builds false sentinels when an override clears builtin fields", () => {
		const override = buildBuiltinOverrideConfig(
			{
				model: "openai-codex/gpt-5.4-mini",
				fallbackModels: ["openai/gpt-5-mini"],
				thinking: "high",
				systemPromptMode: "append",
				inheritProjectContext: true,
				inheritSkills: false,
				defaultContext: "fork",
				systemPrompt: "Base prompt",
				skills: ["safe-bash"],
				tools: ["bash"],
				mcpDirectTools: ["xcodebuild_list_sims"],
			},
			{
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				defaultContext: undefined,
				systemPrompt: "Base prompt",
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
			},
		);

		assert.deepEqual(override, {
			model: false,
			fallbackModels: false,
			thinking: false,
			systemPromptMode: "replace",
			inheritProjectContext: false,
			defaultContext: false,
			skills: false,
			tools: false,
		});
	});
});

function writeUserAgent(home: string, name: string, body: string): void {
	const filePath = path.join(home, ".pi", "agent", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("user agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("applies project settings overrides to user agents", () => {
		writeUserAgent(tempHome, "worker", `---\nname: worker\ndescription: My worker\nmodel: openai/gpt-5\nthinking: medium\n---\n\nYou are a worker.\n`);
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { worker: { model: "anthropic/claude-sonnet-4", thinking: "high" } } },
		});

		const worker = discoverAgents(tempProject, "both").agents.find((a) => a.name === "worker");
		assert.ok(worker);
		assert.equal(worker.source, "user");
		assert.equal(worker.model, "anthropic/claude-sonnet-4");
		assert.equal(worker.thinking, "high");
		assert.equal(worker.systemPrompt, "You are a worker.");
	});

	it("applies user settings overrides to user agents when no project override exists", () => {
		writeUserAgent(tempHome, "worker", `---\nname: worker\ndescription: My worker\nmodel: openai/gpt-5\n---\n\nYou are a worker.\n`);
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { worker: { model: "fireworks/deepseek-v4" } } },
		});

		const worker = discoverAgents(tempProject, "both").agents.find((a) => a.name === "worker");
		assert.ok(worker);
		assert.equal(worker.model, "fireworks/deepseek-v4");
	});

	it("project settings override beats user settings override for user agents", () => {
		writeUserAgent(tempHome, "worker", `---\nname: worker\ndescription: My worker\nmodel: openai/gpt-5\n---\n\nYou are a worker.\n`);
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { worker: { model: "fireworks/deepseek-v4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { worker: { model: "anthropic/claude-sonnet-4" } } },
		});

		const worker = discoverAgents(tempProject, "both").agents.find((a) => a.name === "worker");
		assert.ok(worker);
		assert.equal(worker.model, "anthropic/claude-sonnet-4");
	});

	it("does not apply settings overrides to project agents (full file wins)", () => {
		writeProjectAgent(tempProject, "worker", `---\nname: worker\ndescription: Project worker\nmodel: google/gemini-3-pro\n---\n\nProject worker.\n`);
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { worker: { model: "anthropic/claude-sonnet-4" } } },
		});

		const worker = discoverAgents(tempProject, "both").agents.find((a) => a.name === "worker");
		assert.ok(worker);
		assert.equal(worker.source, "project");
		assert.equal(worker.model, "google/gemini-3-pro");
	});

	it("user agents overridden in discoverAgentsAll too", () => {
		writeUserAgent(tempHome, "worker", `---\nname: worker\ndescription: My worker\nmodel: openai/gpt-5\n---\n\nYou are a worker.\n`);
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { worker: { model: "anthropic/claude-sonnet-4" } } },
		});

		const d = discoverAgentsAll(tempProject);
		const worker = d.user.find((a) => a.name === "worker");
		assert.ok(worker);
		assert.equal(worker.model, "anthropic/claude-sonnet-4");
	});
});
