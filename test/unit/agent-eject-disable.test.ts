import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import { clearSkillCache } from "../../src/agents/skills.ts";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";

let tempDir = "";
let oldAgentDir: string | undefined;

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(filePath: string): unknown {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function userSettingsPath(): string {
	return path.join(tempDir, "agent-home", "settings.json");
}

function projectSettingsPath(): string {
	return path.join(tempDir, ".pi", "settings.json");
}

function userAgentPath(name: string): string {
	return path.join(tempDir, "agent-home", "agents", `${name}.md`);
}

function projectAgentPath(name: string): string {
	return path.join(tempDir, ".pi", "agents", `${name}.md`);
}

describe("agent eject/disable/enable/reset management actions", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-eject-"));
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent-home");
		clearSkillCache();
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		clearSkillCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("eject", () => {
		it("copies a bundled builtin to user scope verbatim and shadows the builtin", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const builtin = discoverAgentsAll(tempDir).builtin.find((a) => a.name === "reviewer");
			assert.ok(builtin);

			const ejected = handleManagementAction("eject", { agent: "reviewer" }, ctx);
			assert.equal(ejected.isError, false);
			assert.match(readText(ejected), /Ejected agent 'reviewer' from builtin to user scope/);

			const target = userAgentPath("reviewer");
			assert.equal(fs.existsSync(target), true);
			assert.equal(fs.readFileSync(target, "utf-8"), fs.readFileSync(builtin.filePath, "utf-8"));

			const effective = discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer");
			assert.ok(effective);
			assert.equal(effective.source, "user");
			assert.equal(effective.filePath, target);
		});

		it("ejects to project scope when agentScope is project", () => {
			fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const ejected = handleManagementAction("eject", { agent: "scout", agentScope: "project" }, ctx);
			assert.equal(ejected.isError, false);
			assert.match(readText(ejected), /to project scope/);
			assert.equal(fs.existsSync(projectAgentPath("scout")), true);
			assert.equal(discoverAgentsAll(tempDir).project.find((a) => a.name === "scout")?.source, "project");
		});

		it("refuses to eject when a custom agent already exists", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			fs.mkdirSync(path.dirname(userAgentPath("reviewer")), { recursive: true });
			fs.writeFileSync(userAgentPath("reviewer"), "---\nname: reviewer\ndescription: Mine\n---\n\nMine.\n", "utf-8");

			const ejected = handleManagementAction("eject", { agent: "reviewer" }, ctx);
			assert.equal(ejected.isError, true);
			assert.match(readText(ejected), /already a custom user agent/);
		});

		it("refuses to eject an unknown agent", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const ejected = handleManagementAction("eject", { agent: "no-such-agent" }, ctx);
			assert.equal(ejected.isError, true);
			assert.match(readText(ejected), /not found or is not a bundled\/package agent/);
		});
	});

	describe("disable", () => {
		it("hides a builtin from runtime discovery via a user settings override", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const disabled = handleManagementAction("disable", { agent: "reviewer" }, ctx);
			assert.equal(disabled.isError, false);
			assert.match(readText(disabled), /Disabled agent 'reviewer' via user settings override/);

			assert.equal(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer"), undefined);
			const all = discoverAgentsAll(tempDir).builtin.find((a) => a.name === "reviewer");
			assert.ok(all);
			assert.equal(all.disabled, true);
			assert.equal(all.override?.scope, "user");

			const settings = readJson(userSettingsPath()) as { subagents: { agentOverrides: { reviewer: { disabled: boolean } } } };
			assert.equal(settings.subagents.agentOverrides.reviewer.disabled, true);
		});

		it("merges disabled into an existing override without dropping other fields", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			writeJson(userSettingsPath(), {
				subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
			});

			handleManagementAction("disable", { agent: "reviewer" }, ctx);

			const settings = readJson(userSettingsPath()) as { subagents: { agentOverrides: { reviewer: { model: string; disabled: boolean } } } };
			assert.deepEqual(settings.subagents.agentOverrides.reviewer, { model: "openai/gpt-5.4", disabled: true });
		});

		it("hides a disabled agent from agent-facing list output", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			handleManagementAction("disable", { agent: "reviewer" }, ctx);

			const text = readText(handleManagementAction("list", {}, ctx));
			assert.doesNotMatch(text, /^- reviewer /m);
		});

		it("writes a project-scoped override when agentScope is project", () => {
			fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const disabled = handleManagementAction("disable", { agent: "reviewer", agentScope: "project" }, ctx);
			assert.equal(disabled.isError, false);
			assert.match(readText(disabled), /via project settings override/);

			const all = discoverAgentsAll(tempDir).builtin.find((a) => a.name === "reviewer");
			assert.equal(all?.override?.scope, "project");
			assert.equal(fs.existsSync(projectSettingsPath()), true);
		});

		it("refuses to disable an unknown agent", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const disabled = handleManagementAction("disable", { agent: "no-such-agent" }, ctx);
			assert.equal(disabled.isError, true);
			assert.match(readText(disabled), /not found/);
		});

		it("also disables a custom agent via a settings override", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			fs.mkdirSync(path.dirname(userAgentPath("helper")), { recursive: true });
			fs.writeFileSync(userAgentPath("helper"), "---\nname: helper\ndescription: Helper\n---\n\nHelp.\n", "utf-8");

			const disabled = handleManagementAction("disable", { agent: "helper" }, ctx);
			assert.equal(disabled.isError, false);
			assert.equal(discoverAgents(tempDir, "both").agents.find((a) => a.name === "helper"), undefined);
		});
	});

	describe("enable", () => {
		it("restores a previously disabled builtin to runtime discovery", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			handleManagementAction("disable", { agent: "reviewer" }, ctx);
			assert.equal(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer"), undefined);

			const enabled = handleManagementAction("enable", { agent: "reviewer" }, ctx);
			assert.equal(enabled.isError, false);
			assert.match(readText(enabled), /Enabled agent 'reviewer'/);
			assert.ok(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer"));

			const settings = readJson(userSettingsPath()) as { subagents?: { agentOverrides?: Record<string, unknown> } };
			assert.equal(settings.subagents?.agentOverrides?.reviewer, undefined);
		});

		it("preserves other override fields when removing the disabled flag", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			writeJson(userSettingsPath(), {
				subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4", disabled: true } } },
			});

			handleManagementAction("enable", { agent: "reviewer" }, ctx);

			const settings = readJson(userSettingsPath()) as { subagents: { agentOverrides: { reviewer: { model: string; disabled?: boolean } } } };
			assert.deepEqual(settings.subagents.agentOverrides.reviewer, { model: "openai/gpt-5.4" });
			assert.ok(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer"));
		});

		it("reports already enabled and makes no changes when nothing is disabled", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const enabled = handleManagementAction("enable", { agent: "reviewer" }, ctx);
			assert.equal(enabled.isError, false);
			assert.match(readText(enabled), /already enabled/);
			assert.equal(fs.existsSync(userSettingsPath()), false);
		});

		it("points to the disabling scope when enabling the wrong scope", () => {
			fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			handleManagementAction("disable", { agent: "reviewer", agentScope: "project" }, ctx);

			const enabled = handleManagementAction("enable", { agent: "reviewer" }, ctx);
			assert.equal(enabled.isError, true);
			assert.match(readText(enabled), /still disabled via a project scope override/);
			assert.match(readText(enabled), /agentScope: 'project'/);
		});

		it("refuses to enable an unknown agent", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const enabled = handleManagementAction("enable", { agent: "no-such-agent" }, ctx);
			assert.equal(enabled.isError, true);
			assert.match(readText(enabled), /not found/);
		});
	});

	describe("reset", () => {
		it("deletes a custom shadow file and restores the bundled builtin", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			handleManagementAction("eject", { agent: "reviewer" }, ctx);
			assert.equal(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer")?.source, "user");

			const reset = handleManagementAction("reset", { agent: "reviewer" }, ctx);
			assert.equal(reset.isError, false);
			assert.match(readText(reset), /Deleted custom user agent file/);
			assert.match(readText(reset), /Reset agent 'reviewer' to its bundled builtin default/);
			assert.equal(fs.existsSync(userAgentPath("reviewer")), false);
			assert.equal(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer")?.source, "builtin");
		});

		it("removes a settings override and restores the pristine builtin", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			handleManagementAction("disable", { agent: "reviewer" }, ctx);
			assert.equal(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer"), undefined);

			const reset = handleManagementAction("reset", { agent: "reviewer" }, ctx);
			assert.equal(reset.isError, false);
			assert.match(readText(reset), /Removed user settings override/);
			assert.ok(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer"));
			assert.equal((readJson(userSettingsPath()) as { subagents?: unknown }).subagents, undefined);
		});

		it("removes both a custom file and a settings override in one reset", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			handleManagementAction("eject", { agent: "reviewer" }, ctx);
			handleManagementAction("disable", { agent: "reviewer" }, ctx);

			const reset = handleManagementAction("reset", { agent: "reviewer" }, ctx);
			assert.equal(reset.isError, false);
			assert.match(readText(reset), /Deleted custom user agent file/);
			assert.match(readText(reset), /Removed user settings override/);
			assert.equal(fs.existsSync(userAgentPath("reviewer")), false);
			assert.ok(discoverAgents(tempDir, "both").agents.find((a) => a.name === "reviewer"));
		});

		it("reports a no-op when there is nothing to reset in the target scope", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const reset = handleManagementAction("reset", { agent: "reviewer" }, ctx);
			assert.equal(reset.isError, false);
			assert.match(readText(reset), /no user customization to reset/);
			assert.match(readText(reset), /at its bundled builtin default/);
		});

		it("points to delete for a custom agent with no bundled default", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			fs.mkdirSync(path.dirname(userAgentPath("solo-helper")), { recursive: true });
			fs.writeFileSync(userAgentPath("solo-helper"), "---\nname: solo-helper\ndescription: Solo\n---\n\nSolo.\n", "utf-8");

			const reset = handleManagementAction("reset", { agent: "solo-helper" }, ctx);
			assert.equal(reset.isError, true);
			assert.match(readText(reset), /no bundled default to reset to/);
			assert.match(readText(reset), /action: "delete"/);
			assert.equal(fs.existsSync(userAgentPath("solo-helper")), true);
		});

		it("refuses to reset an unknown agent", () => {
			const ctx = { cwd: tempDir, modelRegistry: { getAvailable: () => [] } };
			const reset = handleManagementAction("reset", { agent: "no-such-agent" }, ctx);
			assert.equal(reset.isError, true);
			assert.match(readText(reset), /not found/);
		});
	});
});
