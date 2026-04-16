import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll } from "../../agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("builtin agent disabling", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-project-"));
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

	it("filters a per-agent disabled builtin from runtime discovery while keeping it in discoverAgentsAll", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: true },
				},
			},
		});

		const runtimeReviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(runtimeReviewer, undefined);

		const allReviewer = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "reviewer");
		assert.ok(allReviewer);
		assert.equal(allReviewer.disabled, true);
		assert.equal(allReviewer.override?.scope, "user");
	});

	it("surfaces malformed disabled overrides instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: "true" },
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("disabled"),
		);
	});

	it("bulk disableBuiltins hides builtins at runtime and marks them disabled in discoverAgentsAll", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const runtimeBuiltinCount = discoverAgents(tempProject, "both").agents.filter((agent) => agent.source === "builtin").length;
		assert.equal(runtimeBuiltinCount, 0);

		const allBuiltins = discoverAgentsAll(tempProject).builtin;
		assert.ok(allBuiltins.length > 0);
		assert.ok(allBuiltins.every((agent) => agent.disabled === true));
		assert.ok(allBuiltins.every((agent) => agent.override?.scope === "user"));
	});

	it("an explicit user override opts a builtin out of user-scope bulk disable", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					reviewer: { model: "openai/gpt-5.4" },
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.disabled, undefined);
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override?.scope, "user");
	});

	it("project disableBuiltins false re-enables builtins hidden by user bulk disable", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: false },
		});

		assert.ok(discoverAgents(tempProject, "both").agents.some((agent) => agent.source === "builtin"));
	});

	it("project bulk disable beats user per-agent re-enable overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					reviewer: { disabled: false, model: "openai/gpt-5.4" },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(reviewer, undefined);

		const allReviewer = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "reviewer");
		assert.ok(allReviewer);
		assert.equal(allReviewer.disabled, true);
		assert.equal(allReviewer.override?.scope, "project");
	});

	it("surfaces malformed disableBuiltins values instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: { disableBuiltins: "true" },
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("disableBuiltins"),
		);
	});

	it("buildBuiltinOverrideConfig emits disabled false when re-enabling a builtin", () => {
		const override = buildBuiltinOverrideConfig(
			{
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				disabled: undefined,
				systemPrompt: "Base prompt",
			},
			{
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				disabled: false,
				systemPrompt: "Base prompt",
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
			},
		);

		assert.deepEqual(override, { disabled: false });
	});
});
