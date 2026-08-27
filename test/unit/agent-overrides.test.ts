import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll, removeBuiltinAgentOverride, saveBuiltinAgentOverride } from "../../src/agents/agents.ts";

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

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

function writeUserAgent(home: string, name: string, body: string): void {
	const filePath = path.join(home, ".pi", "agent", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("builtin agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
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

	it("applies subagents.defaultModel to builtin agents with explicit overrides winning", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultModel: "deepseek-v4-flash",
				agentOverrides: {
					oracle: { model: "deepseek-v4-pro" },
					reviewer: { model: false },
				},
			},
		});

		const builtins = discoverAgentsAll(tempProject).builtin;
		const scout = builtins.find((agent) => agent.name === "scout");
		assert.equal(scout?.model, "deepseek-v4-flash");
		assert.equal(scout?.modelSource?.type, "subagents.defaultModel");
		assert.equal(scout?.modelSource?.scope, "user");
		assert.equal(builtins.find((agent) => agent.name === "worker")?.model, "deepseek-v4-flash");
		const oracle = builtins.find((agent) => agent.name === "oracle");
		assert.equal(oracle?.model, "deepseek-v4-pro");
		assert.equal(oracle?.modelSource, undefined);
		const reviewer = builtins.find((agent) => agent.name === "reviewer");
		assert.equal(reviewer?.model, undefined);
		assert.equal(reviewer?.modelSource, undefined);
	});

	it("lets a builtin agent inherit Pi's normal tools from an override", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					researcher: { tools: "inherit" },
				},
			},
		});

		const researcher = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "researcher");
		assert.equal(researcher?.tools, undefined);
		assert.equal(researcher?.mcpDirectTools, undefined);
	});

	it("keeps strict builtin tools unless a role opts into inheritance", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					researcher: { tools: "inherit" },
				},
			},
		});

		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.equal(builtins.find((agent) => agent.name === "researcher")?.tools, undefined);
		assert.deepEqual(builtins.find((agent) => agent.name === "reviewer")?.tools, ["read", "grep", "find", "ls"]);
	});

	it("keeps explicit empty builtin tool allowlists distinct from inherited tools", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					researcher: { tools: [] },
				},
			},
		});

		const researcher = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "researcher");
		assert.deepEqual(researcher?.tools, []);
		assert.equal(researcher?.mcpDirectTools, undefined);
	});

	it("surfaces invalid string tool override settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					researcher: { tools: "read" },
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("researcher")
				&& error.message.includes("tools"),
		);
	});

	it("clears subagents.defaultModel provenance for same-value agent model overrides", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultModel: "deepseek-v4-flash",
				agentOverrides: {
					worker: { model: "deepseek-v4-flash" },
				},
			},
		});

		const worker = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "worker");
		assert.equal(worker?.model, "deepseek-v4-flash");
		assert.equal(worker?.modelSource, undefined);
	});

	it("prefers project subagents.defaultModel over user defaultModel", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultModel: "deepseek-v4-flash" },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultModel: "deepseek-v4-pro" },
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		assert.equal(worker.model, "deepseek-v4-pro");
	});

	it("applies default providers with per-agent overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultModel: "llama-3",
				defaultProvider: "gpu-a",
				agentOverrides: {
					worker: { defaultProvider: "gpu-b" },
					reviewer: { defaultProvider: false },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultProvider: "gpu-project" },
		});

		const builtins = discoverAgentsAll(tempProject).builtin;
		const scout = builtins.find((agent) => agent.name === "scout");
		assert.equal(scout?.model, "llama-3");
		assert.equal(scout?.modelProvider, "gpu-project");
		assert.equal(scout?.modelSource?.defaultProvider, "gpu-project");
		assert.equal(builtins.find((agent) => agent.name === "worker")?.modelProvider, "gpu-b");
		assert.equal(builtins.find((agent) => agent.name === "reviewer")?.modelProvider, undefined);
	});

	it("applies default providers to custom agent frontmatter models", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultProvider: "gpu-a" },
		});
		writeProjectAgent(tempProject, "worker", `---\nname: worker\ndescription: Project worker\nmodel: llama-3\n---\n\nWork.\n`);

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.model, "llama-3");
		assert.equal(worker?.modelProvider, "gpu-a");
	});

	it("applies subagents.defaultThinking only when thinking is unset", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultThinking: " low ",
				agentOverrides: {
					delegate: { thinking: "xhigh" },
				},
			},
		});
		writeUserAgent(tempHome, "user-default", `---\nname: user-default\ndescription: User agent\n---\n\nUse the default.\n`);
		writeProjectAgent(tempProject, "project-default", `---\nname: project-default\ndescription: Project agent\n---\n\nUse the default.\n`);
		writeProjectAgent(tempProject, "explicit-off", `---\nname: explicit-off\ndescription: Explicitly disabled\nthinking: false\n---\n\nStay off.\n`);

		const discovered = discoverAgentsAll(tempProject);
		assert.equal(discovered.builtin.find((agent) => agent.name === "delegate")?.thinking, "xhigh");
		assert.equal(discovered.builtin.find((agent) => agent.name === "reviewer")?.thinking, "high");
		assert.equal(discovered.user.find((agent) => agent.name === "user-default")?.thinking, "low");
		assert.equal(discovered.project.find((agent) => agent.name === "project-default")?.thinking, "low");
		assert.equal(discovered.project.find((agent) => agent.name === "explicit-off")?.thinking, false);
	});

	it("prefers project subagents.defaultThinking over user defaultThinking", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultThinking: "low" },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { defaultThinking: "high" },
		});

		const delegate = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "delegate");
		assert.ok(delegate);
		assert.equal(delegate.thinking, "high");
	});

	it("preserves custom-agent thinking when disableThinking clears builtin defaults", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { defaultThinking: "low", disableThinking: true },
		});
		writeProjectAgent(tempProject, "custom-default", `---\nname: custom-default\ndescription: Custom default\n---\n\nUse the default.\n`);
		writeProjectAgent(tempProject, "custom-explicit", `---\nname: custom-explicit\ndescription: Custom explicit\nthinking: high\n---\n\nUse the explicit level.\n`);

		const discovered = discoverAgentsAll(tempProject);
		assert.equal(discovered.builtin.find((agent) => agent.name === "reviewer")?.thinking, undefined);
		assert.equal(discovered.project.find((agent) => agent.name === "custom-default")?.thinking, "low");
		assert.equal(discovered.project.find((agent) => agent.name === "custom-explicit")?.thinking, "high");
	});

	it("surfaces malformed defaultThinking settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const defaultThinking of ["", 42]) {
			writeJson(settingsPath, { subagents: { defaultThinking } });
			assert.throws(
				() => discoverAgents(tempProject, "both"),
				(error: unknown) => error instanceof Error
					&& error.message.includes(settingsPath)
					&& error.message.includes("defaultThinking"),
			);
		}
	});

	it("surfaces malformed default provider settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const defaultProvider of ["", 42]) {
			writeJson(settingsPath, { subagents: { defaultProvider } });
			assert.throws(
				() => discoverAgents(tempProject, "both"),
				(error: unknown) => error instanceof Error
					&& error.message.includes(settingsPath)
					&& error.message.includes("defaultProvider"),
			);
		}
		writeJson(settingsPath, { subagents: { agentOverrides: { worker: { defaultProvider: "" } } } });
		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("worker")
				&& error.message.includes("defaultProvider"),
		);
	});

	it("applies subagents.defaultModel to custom agents without a frontmatter model", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				defaultModel: "deepseek-v4-flash",
				agentOverrides: {
					implementer: { model: "deepseek-v4-pro" },
				},
			},
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);
		writeProjectAgent(tempProject, "auditor", `---\nname: auditor\ndescription: Audit code\nmodel: google/gemini-3-pro\n---\n\nAudit the code.\n`);
		writeProjectAgent(tempProject, "scout-copy", `---\nname: scout-copy\ndescription: Scout code\n---\n\nScout the code.\n`);

		const agents = discoverAgents(tempProject, "both").agents;
		assert.equal(agents.find((agent) => agent.name === "implementer")?.model, "deepseek-v4-pro");
		assert.equal(agents.find((agent) => agent.name === "auditor")?.model, "google/gemini-3-pro");
		assert.equal(agents.find((agent) => agent.name === "scout-copy")?.model, "deepseek-v4-flash");
	});

	it("overrides builtin and custom agent descriptions from settings", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { description: " Priced reviewer " },
					implementer: { description: "Priced implementer" },
				},
			},
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: Original implementer\n---\n\nImplement it.\n`);

		const agents = discoverAgents(tempProject, "both").agents;
		assert.equal(agents.find((agent) => agent.name === "reviewer")?.description, "Priced reviewer");
		assert.equal(agents.find((agent) => agent.name === "implementer")?.description, "Priced implementer");
	});

	it("applies user settings overrides to builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
					agentOverrides: {
					reviewer: {
						model: "openai/gpt-5.4",
						fast: true,
						thinking: "xhigh",
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: true,
						allowNestedSubagents: true,
						acceptanceRole: "writer",
						subagentOnlyExtensions: ["./tools/child-review.ts"],
						mutationTools: ["replace", "undo_last_replace"],
						completionGuard: false,
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "builtin");
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.fast, true);
		assert.equal(reviewer.thinking, "xhigh");
		assert.equal(reviewer.systemPromptMode, "replace");
		assert.equal(reviewer.inheritProjectContext, true);
		assert.equal(reviewer.inheritSkills, true);
		assert.equal(reviewer.allowNestedSubagents, true);
		assert.equal(reviewer.acceptanceRole, "writer");
		assert.deepEqual(reviewer.subagentOnlyExtensions, ["./tools/child-review.ts"]);
		assert.deepEqual(reviewer.mutationTools, ["replace", "undo_last_replace"]);
		assert.equal(reviewer.completionGuard, false);
		assert.equal(reviewer.override?.scope, "user");
		assert.equal(reviewer.override?.path, path.join(tempHome, ".pi", "agent", "settings.json"));
	});

	it("globally disables builtin thinking suffix defaults from user settings", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableThinking: true,
			},
		});

		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.ok(builtins.some((agent) => agent.name === "reviewer"));
		assert.deepEqual(
			builtins
				.filter((agent) => agent.thinking !== undefined)
				.map((agent) => agent.name),
			[],
		);
		assert.equal(
			builtins.find((agent) => agent.name === "reviewer")?.override?.path,
			path.join(tempHome, ".pi", "agent", "settings.json"),
		);
	});

	it("lets an explicit same-scope thinking override opt back in when global thinking is disabled", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableThinking: true,
				agentOverrides: {
					reviewer: {
						thinking: "high",
					},
				},
			},
		});

		const agents = discoverAgents(tempProject, "both").agents;
		const reviewer = agents.find((agent) => agent.name === "reviewer");
		const worker = agents.find((agent) => agent.name === "worker");
		assert.ok(reviewer);
		assert.ok(worker);
		assert.equal(reviewer.thinking, "high");
		assert.equal(worker.thinking, undefined);
	});

	it("lets project settings disable builtin thinking even when user overrides request it", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						thinking: "xhigh",
					},
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				disableThinking: true,
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.thinking, undefined);
	});

	it("surfaces malformed subagent default model settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				defaultModel: "",
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("defaultModel"),
		);
	});

	it("surfaces malformed global thinking settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				disableThinking: "yes",
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("disableThinking"),
		);
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

	it("layers a project override on top of a user override for a custom agent instead of discarding it", () => {
		// Regression test: a custom agent (e.g. a reviewer persona shipped as a .md
		// file with no model/thinking/fallbackModels in frontmatter) that gets its
		// model pin exclusively from a *user*-scope agentOverrides entry must keep
		// that pin when a *project*-scope override adds an unrelated field (here:
		// subagentOnlyExtensions). Previously the project override for this agent
		// name replaced the user override wholesale, silently dropping model /
		// thinking / fallbackModels with no error.
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					"persona-reviewer": {
						model: "anthropic/claude-opus-4-8",
						thinking: "high",
						fallbackModels: ["anthropic/claude-sonnet-4-6"],
					},
				},
			},
		});
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					"persona-reviewer": {
						subagentOnlyExtensions: ["./tools/child-only.ts"],
					},
				},
			},
		});
		writeUserAgent(tempHome, "persona-reviewer", `---\nname: persona-reviewer\ndescription: Shared review persona\n---\n\nReview the diff.\n`);

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "persona-reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "anthropic/claude-opus-4-8");
		assert.equal(reviewer.thinking, "high");
		assert.deepEqual(reviewer.fallbackModels, ["anthropic/claude-sonnet-4-6"]);
		assert.deepEqual(reviewer.subagentOnlyExtensions, ["./tools/child-only.ts"]);
		assert.equal(reviewer.override?.scope, "project");
	});

	it("lets a project override flip `disabled` on a custom agent even after a user override already set it", () => {
		// Regression test for a bug caught in review of the layering fix above:
		// applyCustomAgentOverride's `disabled` handling used a stray
		// `agent.disabled === undefined` guard (a no-op before layering existed,
		// since this function only ever ran once against the pristine base
		// agent). Once user-then-project layering was introduced, that guard
		// silently blocked the project override from ever changing `disabled`
		// once the user override had already set it — breaking this PR's own
		// "project wins" precedence for that one field. Cover both directions.
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					"disable-flip-a": { disabled: true },
					"disable-flip-b": { disabled: false },
				},
			},
		});
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					"disable-flip-a": { disabled: false },
					"disable-flip-b": { disabled: true },
				},
			},
		});
		writeUserAgent(tempHome, "disable-flip-a", `---\nname: disable-flip-a\ndescription: User disables, project re-enables\n---\n\nBody.\n`);
		writeUserAgent(tempHome, "disable-flip-b", `---\nname: disable-flip-b\ndescription: User enables, project disables\n---\n\nBody.\n`);

		// discoverAgents filters out agents whose final `.disabled` resolves to
		// true (agents.ts: `.filter((agent) => agent.disabled !== true)`), so
		// presence/absence in the returned list is the observable signal here,
		// not a `.disabled` property on the result.
		const agents = discoverAgents(tempProject, "both").agents;
		const flipA = agents.find((agent) => agent.name === "disable-flip-a");
		const flipB = agents.find((agent) => agent.name === "disable-flip-b");
		assert.ok(flipA, "project override (disabled: false) must win over user override (disabled: true), so the agent stays enabled and listed");
		assert.equal(flipB, undefined, "project override (disabled: true) must win over user override (disabled: false), so the agent ends up disabled and unlisted");
	});

	it("applies acceptance role precedence and false clearing to builtin and custom agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { acceptanceRole: "read-only" },
					scout: { acceptanceRole: "read-only" },
					implementer: { acceptanceRole: "read-only" },
				},
			},
		});
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { acceptanceRole: "writer" },
					scout: { acceptanceRole: false },
					implementer: { acceptanceRole: false },
				},
			},
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const agents = discoverAgents(tempProject, "both").agents;
		assert.equal(agents.find((agent) => agent.name === "reviewer")?.acceptanceRole, "writer");
		assert.equal(agents.find((agent) => agent.name === "scout")?.acceptanceRole, undefined);
		assert.equal(agents.find((agent) => agent.name === "implementer")?.acceptanceRole, undefined);
		assert.equal(agents.find((agent) => agent.name === "implementer")?.override?.scope, "project");
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

	it("frontmatter wins per-field over agentOverrides for a shadowing project agent", () => {
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

	it("fills in unset fields on a custom project agent from project agentOverrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					implementer: {
						output: "artifacts/implementer.md",
						outputMode: "file-only",
						defaultReads: ["CONTEXT.md", "docs/spec.md"],
						model: "anthropic/claude-sonnet-4-6",
						fallbackModels: ["openai/gpt-5-mini"],
						fast: true,
						thinking: "high",
						systemPromptMode: "append",
						inheritProjectContext: true,
						inheritSkills: true,
						defaultContext: "fork",
						acceptanceRole: "writer",
						tools: ["bash", "mcp:xcodebuild_list_sims"],
						skills: ["tdd"],
						subagentOnlyExtensions: ["./tools/child-review.ts"],
						completionGuard: false,
					},
				},
			},
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.ok(implementer);
		assert.equal(implementer.source, "project");
		assert.equal(implementer.output, "artifacts/implementer.md");
		assert.equal(implementer.outputMode, "file-only");
		assert.deepEqual(implementer.defaultReads, ["CONTEXT.md", "docs/spec.md"]);
		assert.equal(implementer.model, "anthropic/claude-sonnet-4-6");
		assert.deepEqual(implementer.fallbackModels, ["openai/gpt-5-mini"]);
		assert.equal(implementer.fast, true);
		assert.equal(implementer.thinking, "high");
		assert.equal(implementer.systemPromptMode, "append");
		assert.equal(implementer.inheritProjectContext, true);
		assert.equal(implementer.inheritSkills, true);
		assert.equal(implementer.defaultContext, "fork");
		assert.equal(implementer.acceptanceRole, "writer");
		assert.deepEqual(implementer.tools, ["bash"]);
		assert.deepEqual(implementer.mcpDirectTools, ["xcodebuild_list_sims"]);
		assert.deepEqual(implementer.skills, ["tdd"]);
		assert.deepEqual(implementer.subagentOnlyExtensions, ["./tools/child-review.ts"]);
		assert.equal(implementer.completionGuard, false);
		assert.equal(implementer.override?.scope, "project");
		assert.equal(implementer.override?.path, path.join(tempProject, ".pi", "settings.json"));
	});

	it("fills in unset fields on a custom user agent from user agentOverrides", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { implementer: { model: "anthropic/claude-sonnet-4-6" } } },
		});
		writeUserAgent(tempHome, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.ok(implementer);
		assert.equal(implementer.source, "user");
		assert.equal(implementer.model, "anthropic/claude-sonnet-4-6");
		assert.equal(implementer.override?.scope, "user");
	});

	it("applies user agentOverrides to a custom project agent when project settings have no entry", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { implementer: { model: "anthropic/claude-sonnet-4-6" } } },
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.ok(implementer);
		assert.equal(implementer.source, "project");
		assert.equal(implementer.model, "anthropic/claude-sonnet-4-6");
		assert.equal(implementer.override?.scope, "user");
	});

	it("prefers project agentOverrides over user agentOverrides on a custom project agent", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { implementer: { model: "anthropic/claude-sonnet-4-6", output: "user.md", defaultReads: ["user.md"] } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { implementer: { model: "openai/gpt-5.4", output: "project.md", defaultReads: ["project.md"] } } },
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.ok(implementer);
		assert.equal(implementer.model, "openai/gpt-5.4");
		assert.equal(implementer.output, "project.md");
		assert.deepEqual(implementer.defaultReads, ["project.md"]);
		assert.equal(implementer.override?.scope, "project");
	});

	it("keeps explicit custom frontmatter fields over matching agentOverrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					implementer: {
						output: "artifacts/override.md",
						outputMode: "file-only",
						defaultReads: ["override.md"],
						model: "anthropic/claude-sonnet-4-6",
						fast: true,
						thinking: "high",
						tools: ["bash"],
						skills: ["override-skill"],
						inheritProjectContext: true,
						defaultContext: "fork",
						acceptanceRole: "writer",
						completionGuard: true,
					},
				},
			},
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\noutput: artifacts/explicit.md\noutputMode: inline\ndefaultReads: explicit.md\nmodel: google/gemini-3-pro\nfast: false\nthinking: medium\ntools: read, mcp:local_tool\nskills: agent-skill\ninheritProjectContext: false\ndefaultContext: fresh\nacceptanceRole: read-only\ncompletionGuard: false\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.ok(implementer);
		assert.equal(implementer.output, "artifacts/explicit.md");
		assert.equal(implementer.outputMode, "inline");
		assert.deepEqual(implementer.defaultReads, ["explicit.md"]);
		assert.equal(implementer.model, "google/gemini-3-pro");
		assert.equal(implementer.fast, false);
		assert.equal(implementer.thinking, "medium");
		assert.deepEqual(implementer.tools, ["read"]);
		assert.deepEqual(implementer.mcpDirectTools, ["local_tool"]);
		assert.deepEqual(implementer.skills, ["agent-skill"]);
		assert.equal(implementer.inheritProjectContext, false);
		assert.equal(implementer.defaultContext, "fresh");
		assert.equal(implementer.acceptanceRole, "read-only");
		assert.equal(implementer.completionGuard, false);
		assert.equal(implementer.override, undefined);
	});

	it("keeps explicit output and defaultReads frontmatter when overrides clear them", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { implementer: { output: false, defaultReads: false } } },
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\noutput: explicit.md\ndefaultReads: explicit.md\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.equal(implementer?.output, "explicit.md");
		assert.deepEqual(implementer?.defaultReads, ["explicit.md"]);
	});

	it("keeps an explicit empty defaultReads override distinct from false", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { implementer: { defaultReads: [] } } },
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.deepEqual(implementer?.defaultReads, []);
	});

	it("leaves a custom agent untouched when no agentOverrides entry matches its name", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.ok(implementer);
		assert.equal(implementer.model, undefined);
		assert.equal(implementer.override, undefined);
	});

	it("disableBuiltins does not disable custom agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		writeProjectAgent(tempProject, "implementer", `---\nname: implementer\ndescription: TDD implementer\n---\n\nDrive the failing test first.\n`);

		const implementer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "implementer");
		assert.ok(implementer);
		assert.notEqual(implementer.disabled, true);
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

	it("surfaces malformed acceptance role override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						acceptanceRole: "observer",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("acceptanceRole"),
		);
	});

	it("surfaces malformed description override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const description of ["", 42]) {
			writeJson(settingsPath, {
				subagents: { agentOverrides: { reviewer: { description } } },
			});
			assert.throws(
				() => discoverAgents(tempProject, "both"),
				(error: unknown) => error instanceof Error
					&& error.message.includes(settingsPath)
					&& error.message.includes("reviewer")
					&& error.message.includes("description"),
			);
		}
	});

	it("surfaces malformed completion guard override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						completionGuard: "false",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("completionGuard"),
		);
	});

	it("rejects unsupported outputMode override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const outputMode of ["artifact-only", false]) {
			writeJson(settingsPath, {
				subagents: {
					agentOverrides: {
						reviewer: { outputMode },
					},
				},
			});

			assert.throws(
				() => discoverAgents(tempProject, "both"),
				(error: unknown) => error instanceof Error
					&& error.message.includes(settingsPath)
					&& error.message.includes("reviewer")
					&& error.message.includes("outputMode"),
			);
		}
	});

	it("applies output and defaultReads overrides to bundled and package agents and supports false clears", () => {
		const packageRoot = path.join(tempProject, "package-agents");
		fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
		writeJson(path.join(packageRoot, "package.json"), { "pi-subagents": { agents: ["agents"] } });
		fs.writeFileSync(path.join(packageRoot, "agents", "package-scout.md"), `---\nname: package-scout\ndescription: Package scout\n---\n\nScout the package.\n`, "utf-8");
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			packages: [packageRoot],
			subagents: { agentOverrides: { "package-scout": { output: "package.md", defaultReads: ["PACKAGE.md"] } } },
		});
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					scout: { output: "research-scout-results.md", defaultReads: ["AGENTS.md"] },
					reviewer: { output: false, defaultReads: false },
				},
			},
		});

		const agents = discoverAgents(tempProject, "both").agents;
		assert.equal(agents.find((agent) => agent.name === "scout")?.output, "research-scout-results.md");
		assert.deepEqual(agents.find((agent) => agent.name === "scout")?.defaultReads, ["AGENTS.md"]);
		assert.equal(agents.find((agent) => agent.name === "reviewer")?.output, undefined);
		assert.equal(agents.find((agent) => agent.name === "reviewer")?.defaultReads, undefined);
		assert.equal(agents.find((agent) => agent.name === "package-scout")?.output, "package.md");
		assert.deepEqual(agents.find((agent) => agent.name === "package-scout")?.defaultReads, ["PACKAGE.md"]);
	});

	it("surfaces malformed output and defaultReads override values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		for (const [field, value] of [["output", 42], ["output", ""], ["output", "  "], ["defaultReads", ["ok", 42]]] as const) {
			writeJson(settingsPath, { subagents: { agentOverrides: { reviewer: { [field]: value } } } });
			assert.throws(
				() => discoverAgents(tempProject, "both"),
				(error: unknown) => error instanceof Error && error.message.includes(settingsPath) && error.message.includes("reviewer") && error.message.includes(field),
			);
		}
	});

	it("builds description changes and false sentinels when an override clears builtin fields", () => {
		const override = buildBuiltinOverrideConfig(
			{
				description: "Base description",
				output: "base-output.md",
				defaultReads: ["base-read.md"],
				model: "openai-codex/gpt-5.4-mini",
				fallbackModels: ["openai/gpt-5-mini"],
				thinking: "high",
				systemPromptMode: "append",
				inheritProjectContext: true,
				inheritGlobalContext: true,
				inheritSkills: false,
				defaultContext: "fork",
				acceptanceRole: "read-only",
				systemPrompt: "Base prompt",
				skills: ["safe-bash"],
				tools: ["bash"],
				mcpDirectTools: ["xcodebuild_list_sims"],
				subagentOnlyExtensions: ["./tools/base-child.ts"],
				completionGuard: false,
			},
			{
				description: "Override description",
				output: undefined,
				defaultReads: undefined,
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritGlobalContext: false,
				inheritSkills: false,
				defaultContext: undefined,
				acceptanceRole: undefined,
				systemPrompt: "Base prompt",
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
				subagentOnlyExtensions: undefined,
				completionGuard: true,
			},
		);

		assert.deepEqual(override, {
			description: "Override description",
			output: false,
			defaultReads: false,
			model: false,
			fallbackModels: false,
			thinking: false,
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritGlobalContext: false,
			defaultContext: false,
			acceptanceRole: false,
			skills: false,
			tools: false,
			subagentOnlyExtensions: false,
			completionGuard: true,
		});
		assert.ok(override);
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		saveBuiltinAgentOverride(tempProject, "reviewer", "project", override);
		const savedOverride = JSON.parse(fs.readFileSync(path.join(tempProject, ".pi", "settings.json"), "utf-8"));
		assert.equal(savedOverride.subagents.agentOverrides.reviewer.output, false);
		assert.equal(savedOverride.subagents.agentOverrides.reviewer.defaultReads, false);
		assert.equal(discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer")?.description, "Override description");

		saveBuiltinAgentOverride(tempProject, "scout", "project", { output: "research.md", defaultReads: ["CONTEXT.md"] });
		const scout = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "scout");
		assert.equal(scout?.output, "research.md");
		assert.deepEqual(scout?.defaultReads, ["CONTEXT.md"]);

		const whitespaceDescription = buildBuiltinOverrideConfig(
			{ description: "Base description" },
			{ description: "   " } as Parameters<typeof buildBuiltinOverrideConfig>[1],
		);
		assert.equal(whitespaceDescription, undefined);
	});
});
