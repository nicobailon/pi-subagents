import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildBuiltinOverrideConfig,
	discoverAgents,
	discoverAgentsAll,
} from "../../agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("agent disabled override", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-project-"));
		process.env.HOME = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("user settings override can disable a builtin agent", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: true },
				},
			},
		});

		const { agents } = discoverAgents(tempProject, "both");
		assert.equal(agents.find((a) => a.name === "reviewer"), undefined);
	});

	it("project settings override can disable a builtin agent", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: true },
				},
			},
		});

		const { agents } = discoverAgents(tempProject, "both");
		assert.equal(agents.find((a) => a.name === "reviewer"), undefined);
	});

	it("disabled builtins are still returned by discoverAgentsAll so management UIs can re-enable them", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: true },
				},
			},
		});

		const { builtin } = discoverAgentsAll(tempProject);
		const reviewer = builtin.find((a) => a.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.disabled, true);
		assert.equal(reviewer.override?.scope, "user");
	});

	it("project override disabling a builtin wins over user override re-enabling it", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { disabled: false } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { disabled: true } } },
		});

		const { agents } = discoverAgents(tempProject, "both");
		assert.equal(agents.find((a) => a.name === "reviewer"), undefined);
	});

	it("non-boolean override disabled value is ignored", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: "true" },
				},
			},
		});

		const { agents } = discoverAgents(tempProject, "both");
		assert.ok(agents.find((a) => a.name === "reviewer"));
	});

	it("omitted disabled in an override leaves the agent active", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { model: "openai/gpt-5.4" },
				},
			},
		});

		const { agents } = discoverAgents(tempProject, "both");
		const reviewer = agents.find((a) => a.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.disabled, undefined);
	});

	it("buildBuiltinOverrideConfig emits disabled:true when a draft disables a builtin", () => {
		const override = buildBuiltinOverrideConfig(
			{
				systemPrompt: "Base prompt",
				disabled: undefined,
			},
			{
				systemPrompt: "Base prompt",
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
				disabled: true,
			},
		);
		assert.deepEqual(override, { disabled: true });
	});
});

describe("disableBuiltins bulk flag", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-bulk-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-bulk-project-"));
		process.env.HOME = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("user scope disableBuiltins:true hides all builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const { agents } = discoverAgents(tempProject, "both");
		// No builtin sources should remain.
		assert.equal(agents.filter((a) => a.source === "builtin").length, 0);
	});

	it("disableBuiltins:true does not affect user-defined agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		writeProjectAgent(
			tempProject,
			"myagent",
			"---\nname: myagent\ndescription: Project agent\n---\n\nBody\n",
		);

		const { agents } = discoverAgents(tempProject, "both");
		assert.ok(agents.find((a) => a.name === "myagent"));
	});

	it("discoverAgentsAll surfaces builtins with disabled:true when disableBuiltins is set", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const { builtin } = discoverAgentsAll(tempProject);
		assert.ok(builtin.length > 0, "expected builtins to still be enumerated");
		assert.ok(
			builtin.every((a) => a.disabled === true),
			"expected every builtin to be marked disabled",
		);
		assert.ok(
			builtin.every((a) => a.override?.scope === "user"),
			"expected every builtin to carry a user-scope override attribution",
		);
	});

	it("project disableBuiltins:false overrides user disableBuiltins:true", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: false },
		});

		const { agents } = discoverAgents(tempProject, "both");
		// Builtins should be back.
		assert.ok(agents.some((a) => a.source === "builtin"));
	});

	it("per-agent override wins over bulk disableBuiltins for that agent", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					reviewer: { model: "openai/gpt-5.4" },
				},
			},
		});

		const { agents } = discoverAgents(tempProject, "both");
		const reviewer = agents.find((a) => a.name === "reviewer");
		// The per-agent override didn't set `disabled`, so reviewer stays active.
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai/gpt-5.4");
	});

	it("non-boolean disableBuiltins value is ignored", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: "true" },
		});

		const { agents } = discoverAgents(tempProject, "both");
		assert.ok(agents.some((a) => a.source === "builtin"));
	});

	it("disableBuiltins in project scope is ignored when scope is 'user'", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const { agents } = discoverAgents(tempProject, "user");
		// Project flag ignored under user scope → builtins still visible.
		assert.ok(agents.some((a) => a.source === "builtin"));
	});
});
