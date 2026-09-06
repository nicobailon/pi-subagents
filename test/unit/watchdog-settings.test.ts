import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveWatchdogConfig, resolveWatchdogConfigStrict, writeUserWatchdogEnabled, writeWatchdogModelSettings } from "../../src/watchdog/settings.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function userSettingsPath(): string {
	return path.join(tempHome, ".pi", "agent", "settings.json");
}

function projectSettingsPath(): string {
	return path.join(tempProject, ".pi", "settings.json");
}

describe("watchdog settings", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-watchdog-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-watchdog-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("resolves a default-off config when no watchdog settings exist", () => {
		const result = resolveWatchdogConfig(tempProject);

		assert.equal(result.ok, true);
		assert.equal(result.config.enabled, false);
		assert.equal(result.config.clarification, false);
		assert.equal(result.config.main.enabled, false);
		assert.equal(result.config.children.enabled, false);
		assert.equal(result.config.guidance.watchdogMd, true);
		assert.equal(result.config.agentEndTimeoutMs, 30_000);
		assert.equal(result.config.children.watchdogTailTimeoutMs, 120_000);
		assert.equal(result.config.stalemateRepeats, 3);
		assert.deepEqual(result.config.scope, { enabled: true });
		assert.deepEqual(result.config.cadence, { everyNTools: null });
		assert.deepEqual(result.config.lsp, { enabled: true, timeoutMs: 3000, maxFiles: 20, maxDiagnostics: 50 });
	});

	it("accepts only a boolean clarification opt-in", () => {
		assert.equal(resolveWatchdogConfig(tempProject, { session: { clarification: true } }).config.clarification, true);
		assert.equal(resolveWatchdogConfig(tempProject, { session: { clarification: "true" } }).ok, false);
		assert.equal(resolveWatchdogConfig(tempProject, { session: { children: { clarification: true } } }).ok, false);
	});

	it("lets root enabled opt the main watchdog in while children stay default-off", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					enabled: true,
				},
			},
		});

		const config = resolveWatchdogConfig(tempProject).config;

		assert.equal(config.enabled, true);
		assert.equal(config.main.enabled, true);
		assert.equal(config.children.enabled, false);
	});

	it("merges user, project, and session overrides field by field", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					enabled: true,
					stalemateRepeats: 5,
					children: {
						cadence: { everyNTools: 10 },
						overrides: {
							worker: { enabled: true, model: "anthropic/claude-test", cadence: { everyNTools: 5 } },
						},
					},
					guidance: { watchdogMd: false },
					scope: { enabled: false },
					cadence: { everyNTools: 10 },
				},
			},
		});
		writeJson(projectSettingsPath(), {
			subagents: {
				watchdog: {
					stalemateRepeats: 2,
					lsp: { enabled: false, timeoutMs: 1500, maxFiles: 4, maxDiagnostics: 7 },
					main: { model: "openai/gpt-test" },
					children: {
						overrides: {
							worker: { thinking: "medium" },
							reviewer: { enabled: false },
						},
					},
				},
			},
		});

		const result = resolveWatchdogConfig(tempProject, {
			session: {
				children: {
					overrides: {
						worker: { enabled: false },
					},
				},
			},
		});

		assert.equal(result.ok, true);
		assert.equal(result.config.main.enabled, true);
		assert.equal(result.config.main.model, "openai/gpt-test");
		assert.equal(result.config.stalemateRepeats, 2);
		assert.equal(result.config.guidance.watchdogMd, false);
		assert.deepEqual(result.config.scope, { enabled: false });
		assert.deepEqual(result.config.cadence, { everyNTools: 10 });
		assert.deepEqual(result.config.children.cadence, { everyNTools: 10 });
		assert.deepEqual(result.config.lsp, { enabled: false, timeoutMs: 1500, maxFiles: 4, maxDiagnostics: 7 });
		assert.deepEqual(result.config.children.overrides.worker, {
			enabled: false,
			model: "anthropic/claude-test",
			thinking: "medium",
			cadence: { everyNTools: 5 },
		});
		assert.deepEqual(result.config.children.overrides.reviewer, { enabled: false });
	});

	it("returns exact validation errors at the watchdog boundary", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					enabled: "yes",
				},
			},
		});

		const result = resolveWatchdogConfig(tempProject);

		assert.equal(result.ok, false);
		assert.deepEqual(result.errors, [{
			scope: "user",
			path: userSettingsPath(),
			message: `Watchdog settings in '${userSettingsPath()}' have invalid 'subagents.watchdog.enabled'; expected a boolean.`,
		}]);
		assert.equal(result.config.enabled, false);
		assert.equal(result.config.main.enabled, false);
	});

	it("throws the same exact validation error in strict mode", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					children: { overrides: { worker: { mode: "fast" } } },
				},
			},
		});

		assert.throws(
			() => resolveWatchdogConfigStrict(tempProject),
			(error: unknown) => error instanceof Error
				&& error.message === `Watchdog settings in '${userSettingsPath()}' have unknown field 'subagents.watchdog.children.overrides.worker.mode'.`,
		);
	});

	it("parses launch rules and rejects malformed rule fields", () => {
		const rules = {
			action: "block",
			roleModels: { scout: { allow: ["openai-codex/gpt-5.6-luna:max"] }, oracle: { deny: ["*"], note: "ask first" } },
		} as const;
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: { rules },
			},
		});
		const result = resolveWatchdogConfig(tempProject);
		assert.equal(result.ok, true, result.errors[0]?.message);
		assert.deepEqual(result.config.rules, rules);
		assert.equal(resolveWatchdogConfig(tempProject, { session: { enabled: true } }).config.rules?.action, "block");

		writeJson(userSettingsPath(), { subagents: { watchdog: { rules: { action: "shout" } } } });
		assert.match(resolveWatchdogConfig(tempProject).errors[0]?.message ?? "", /invalid 'subagents\.watchdog\.rules\.action'; expected 'warn' or 'block'/);
		writeJson(userSettingsPath(), { subagents: { watchdog: { rules: { roleModels: { scout: { allowed: ["x"] } } } } } });
		assert.match(resolveWatchdogConfig(tempProject).errors[0]?.message ?? "", /unknown field 'subagents\.watchdog\.rules\.roleModels\.scout\.allowed'/);
		writeJson(userSettingsPath(), { subagents: { watchdog: {} } });
		assert.equal(resolveWatchdogConfig(tempProject).config.rules, undefined);
	});

	it("rejects invalid scope and cadence config at settings load", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					scope: { mode: "hidden" },
				},
			},
		});

		let result = resolveWatchdogConfig(tempProject);
		assert.equal(result.ok, false);
		assert.match(result.errors[0]?.message ?? "", /unknown field 'subagents\.watchdog\.scope\.mode'/);

		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					cadence: { everyNTools: 4 },
				},
			},
		});

		result = resolveWatchdogConfig(tempProject);
		assert.equal(result.ok, false);
		assert.match(result.errors[0]?.message ?? "", /invalid 'subagents\.watchdog\.cadence\.everyNTools'/);

		writeJson(userSettingsPath(), { subagents: { watchdog: { children: { cadence: { everyNTools: 4 } } } } });
		assert.match(resolveWatchdogConfig(tempProject).errors[0]?.message ?? "", /invalid 'subagents\.watchdog\.children\.cadence\.everyNTools'/);
	});

	it("rejects invalid LSP config at settings load", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					lsp: { timeoutMs: 0 },
				},
			},
		});

		const result = resolveWatchdogConfig(tempProject);

		assert.equal(result.ok, false);
		assert.equal(result.config.main.enabled, false);
		assert.match(result.errors[0]?.message ?? "", /invalid 'subagents\.watchdog\.lsp\.timeoutMs'/);
	});

	it("rejects unsupported watchdog thinking values at settings load", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					main: { thinking: "maximum" },
				},
			},
		});

		const result = resolveWatchdogConfig(tempProject);

		assert.equal(result.ok, false);
		assert.equal(result.config.main.enabled, false);
		assert.match(result.errors[0]?.message ?? "", /invalid 'subagents\.watchdog\.main\.thinking'/);
		assert.match(result.errors[0]?.message ?? "", /'high'/);
	});

	it("writes watchdog model settings without toggling enablement", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					enabled: false,
					main: { enabled: false },
				},
			},
		});

		writeWatchdogModelSettings({
			scope: "user",
			target: { kind: "main" },
			model: "anthropic/claude-opus-4-8",
			thinking: "high",
		});

		const settings = JSON.parse(fs.readFileSync(userSettingsPath(), "utf-8"));
		assert.equal(settings.subagents.watchdog.enabled, false);
		assert.equal(settings.subagents.watchdog.main.enabled, false);
		assert.equal(settings.subagents.watchdog.main.model, "anthropic/claude-opus-4-8");
		assert.equal(settings.subagents.watchdog.main.thinking, "high");
	});

	it("clears watchdog model and thinking overrides", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					main: { model: "openai-codex/gpt-5.5", thinking: "high" },
				},
			},
		});

		writeWatchdogModelSettings({
			scope: "user",
			target: { kind: "main" },
			model: null,
			thinking: null,
		});

		const settings = JSON.parse(fs.readFileSync(userSettingsPath(), "utf-8"));
		assert.equal("model" in settings.subagents.watchdog.main, false);
		assert.equal("thinking" in settings.subagents.watchdog.main, false);
	});

	it("preserves JSON.parse errors in boundary results", () => {
		fs.mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
		fs.writeFileSync(userSettingsPath(), "{ bad", "utf-8");

		const result = resolveWatchdogConfig(tempProject);

		assert.equal(result.ok, false);
		assert.equal(result.errors.length, 1);
		assert.equal(result.errors[0]?.scope, "user");
		assert.match(result.errors[0]?.message ?? "", new RegExp(`^Failed to parse settings file '${userSettingsPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}': `));
		assert.equal(result.config.main.enabled, false);
	});

	it("writes persistent on/off toggles to root and main enabled", () => {
		writeJson(userSettingsPath(), {
			subagents: {
				watchdog: {
					enabled: false,
					main: { enabled: false, model: "openai/watchdog" },
				},
			},
		});

		writeUserWatchdogEnabled(true);
		let settings = JSON.parse(fs.readFileSync(userSettingsPath(), "utf-8"));
		assert.equal(settings.subagents.watchdog.enabled, true);
		assert.equal(settings.subagents.watchdog.main.enabled, true);
		assert.equal(settings.subagents.watchdog.main.model, "openai/watchdog");
		assert.equal(resolveWatchdogConfig(tempProject).config.main.enabled, true);

		writeUserWatchdogEnabled(false);
		settings = JSON.parse(fs.readFileSync(userSettingsPath(), "utf-8"));
		assert.equal(settings.subagents.watchdog.enabled, false);
		assert.equal(settings.subagents.watchdog.main.enabled, false);
		assert.equal(settings.subagents.watchdog.main.model, "openai/watchdog");
		assert.equal(resolveWatchdogConfig(tempProject).config.main.enabled, false);
	});
});
