import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	detectUnknownAgentNames,
	loadSubagentsOverlay,
	type SubagentsOverlay,
} from "../../subagents-config.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function mkTempDir(prefix = "pi-subagents-config-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, data: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

describe("subagents-config", () => {
	it("returns empty overlay when no files exist", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
		});
		assert.equal(overlay.agents.size, 0);
		assert.equal(overlay.disabled.size, 0);
		assert.deepEqual(overlay.warnings, []);
	});

	it("loads project-only overlay with agent override and disabled", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			agents: {
				scout: { description: "Scout override", model: "sonnet" },
			},
			disabled: ["old-agent"],
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
		});
		assert.deepEqual(overlay.warnings, []);
		assert.equal(overlay.agents.size, 1);
		assert.deepEqual(overlay.agents.get("scout"), {
			description: "Scout override",
			model: "sonnet",
		});
		assert.ok(overlay.disabled.has("old-agent"));
	});

	it("loads user-only overlay via opts.userFilePath", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		const userFile = path.join(userDir, "subagents.json");
		writeJson(userFile, {
			agents: {
				helper: { tools: ["read", "write"] },
			},
			disabled: ["noisy"],
		});

		const overlay = loadSubagentsOverlay(cwd, { userFilePath: userFile });
		assert.deepEqual(overlay.warnings, []);
		assert.deepEqual(overlay.agents.get("helper"), { tools: ["read", "write"] });
		assert.ok(overlay.disabled.has("noisy"));
	});

	it("project field wins on overlap, user-only fields preserved", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		const userFile = path.join(userDir, "subagents.json");
		writeJson(userFile, {
			agents: {
				scout: { description: "user desc", model: "haiku", tools: ["read"] },
			},
		});
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			agents: {
				scout: { description: "project desc", output: "result.md" },
			},
		});

		const overlay = loadSubagentsOverlay(cwd, { userFilePath: userFile });
		assert.deepEqual(overlay.warnings, []);
		const scout = overlay.agents.get("scout");
		assert.equal(scout?.description, "project desc");
		assert.equal(scout?.model, "haiku");
		assert.deepEqual(scout?.tools, ["read"]);
		assert.equal(scout?.output, "result.md");
	});

	it("unions disabled lists from both scopes", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		const userFile = path.join(userDir, "subagents.json");
		writeJson(userFile, { disabled: ["a", "b"] });
		writeJson(path.join(cwd, ".pi", "subagents.json"), { disabled: ["b", "c"] });

		const overlay = loadSubagentsOverlay(cwd, { userFilePath: userFile });
		assert.deepEqual(overlay.warnings, []);
		assert.deepEqual([...overlay.disabled].sort(), ["a", "b", "c"]);
	});

	it("emits warning on invalid JSON without crashing", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		const projectFile = path.join(cwd, ".pi", "subagents.json");
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, "{ not json", "utf-8");

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
		});
		assert.equal(overlay.agents.size, 0);
		assert.equal(overlay.warnings.length, 1);
		assert.match(overlay.warnings[0] ?? "", /invalid JSON/);
		assert.ok((overlay.warnings[0] ?? "").includes(projectFile));
	});

	it("warns on unknown field but keeps other fields", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			agents: {
				scout: { description: "ok", bogus: 42 },
			},
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
		});
		assert.equal(overlay.warnings.length, 1);
		assert.match(overlay.warnings[0] ?? "", /unknown field 'bogus'/);
		assert.deepEqual(overlay.agents.get("scout"), { description: "ok" });
	});

	it("drops array field with wrong type and warns", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			agents: {
				scout: { description: "ok", skills: "code-review" },
			},
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
		});
		assert.equal(overlay.warnings.length, 1);
		assert.match(overlay.warnings[0] ?? "", /skills/);
		assert.deepEqual(overlay.agents.get("scout"), { description: "ok" });
	});

	it("warns and treats disabled as empty when not an array", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			disabled: "nope",
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
		});
		assert.equal(overlay.disabled.size, 0);
		assert.equal(overlay.warnings.length, 1);
		assert.match(overlay.warnings[0] ?? "", /disabled/);
	});

	it("exposes warnings field on overlay", () => {
		const overlay: SubagentsOverlay = {
			agents: new Map(),
			disabled: new Set(),
			warnings: [],
		};
		assert.deepEqual(overlay.warnings, []);
	});

	it("preserves defaultProgress: false override", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			agents: {
				scout: { defaultProgress: false },
			},
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
		});
		assert.deepEqual(overlay.warnings, []);
		const scout = overlay.agents.get("scout");
		assert.ok(scout);
		assert.equal(scout?.defaultProgress, false);
		assert.ok(Object.hasOwn(scout as object, "defaultProgress"));
	});

	it("loads overrides from project settings.json subagents key", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			skills: ["./somewhere"],
			subagents: {
				agents: { scout: { model: "from-settings" } },
				disabled: ["delegate"],
			},
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
			userSettingsPath: path.join(userDir, "settings.json"),
		});
		assert.deepEqual(overlay.warnings, []);
		assert.equal(overlay.agents.get("scout")?.model, "from-settings");
		assert.ok(overlay.disabled.has("delegate"));
	});

	it("subagents.json overrides settings.json subagents key per field", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			subagents: {
				agents: { scout: { model: "from-settings", thinking: "low" } },
			},
		});
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			agents: { scout: { model: "from-subagents-json" } },
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
			userSettingsPath: path.join(userDir, "settings.json"),
		});
		assert.deepEqual(overlay.warnings, []);
		const scout = overlay.agents.get("scout");
		assert.equal(scout?.model, "from-subagents-json");
		// settings.json field not touched by subagents.json is preserved
		assert.equal(scout?.thinking, "low");
	});

	it("layered precedence: project subagents.json > user subagents.json > project settings.json > user settings.json", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(userDir, "settings.json"), {
			subagents: {
				agents: {
					scout: {
						description: "user-settings",
						model: "user-settings-model",
						thinking: "user-settings-thinking",
						output: "user-settings-output",
					},
				},
			},
		});
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			subagents: {
				agents: {
					scout: {
						model: "project-settings-model",
						thinking: "project-settings-thinking",
						output: "project-settings-output",
					},
				},
			},
		});
		writeJson(path.join(userDir, "subagents.json"), {
			agents: {
				scout: {
					thinking: "user-overlay-thinking",
					output: "user-overlay-output",
				},
			},
		});
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			agents: { scout: { output: "project-overlay-output" } },
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
			userSettingsPath: path.join(userDir, "settings.json"),
		});
		assert.deepEqual(overlay.warnings, []);
		const scout = overlay.agents.get("scout");
		assert.equal(scout?.description, "user-settings");
		assert.equal(scout?.model, "project-settings-model");
		assert.equal(scout?.thinking, "user-overlay-thinking");
		assert.equal(scout?.output, "project-overlay-output");
	});

	it("unions disabled across settings.json and subagents.json", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(userDir, "settings.json"), {
			subagents: { disabled: ["from-user-settings"] },
		});
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			subagents: { disabled: ["from-project-settings"] },
		});
		writeJson(path.join(cwd, ".pi", "subagents.json"), {
			disabled: ["from-project-overlay"],
		});

		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
			userSettingsPath: path.join(userDir, "settings.json"),
		});
		assert.ok(overlay.disabled.has("from-user-settings"));
		assert.ok(overlay.disabled.has("from-project-settings"));
		assert.ok(overlay.disabled.has("from-project-overlay"));
	});

	it("settings.json without a subagents key is silently ignored", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			skills: ["./skills"],
		});
		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
			userSettingsPath: path.join(userDir, "settings.json"),
		});
		assert.deepEqual(overlay.warnings, []);
		assert.equal(overlay.agents.size, 0);
		assert.equal(overlay.disabled.size, 0);
	});

	it("invalid types under settings.json subagents are reported with prefixed warnings", () => {
		const cwd = mkTempDir();
		const userDir = mkTempDir();
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			subagents: {
				agents: { scout: { skills: "not-an-array" } },
			},
		});
		const overlay = loadSubagentsOverlay(cwd, {
			userFilePath: path.join(userDir, "subagents.json"),
			userSettingsPath: path.join(userDir, "settings.json"),
		});
		assert.ok(
			overlay.warnings.some((w) => w.includes("settings.json: subagents") && w.includes("scout") && w.includes("skills")),
			`expected a settings.json prefixed warning, got: ${JSON.stringify(overlay.warnings)}`,
		);
	});
});

describe("detectUnknownAgentNames", () => {
	function mkOverlay(
		agents: Record<string, object> = {},
		disabled: string[] = [],
	): SubagentsOverlay {
		return {
			agents: new Map(Object.entries(agents)),
			disabled: new Set(disabled),
			warnings: [],
		};
	}

	it("returns empty array when all names are known", () => {
		const overlay = mkOverlay({ scout: {} }, ["ranger"]);
		const warnings = detectUnknownAgentNames(overlay, ["scout", "ranger", "extra"]);
		assert.deepEqual(warnings, []);
	});

	it("warns on unknown name in agents map", () => {
		const overlay = mkOverlay({ foo: {} });
		const warnings = detectUnknownAgentNames(overlay, ["scout"]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /agents\.foo/);
		assert.match(warnings[0] ?? "", /foo/);
	});

	it("warns on unknown name in disabled", () => {
		const overlay = mkOverlay({}, ["nonexistent"]);
		const warnings = detectUnknownAgentNames(overlay, ["scout"]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /disabled/);
		assert.match(warnings[0] ?? "", /nonexistent/);
	});

	it("warns on both unknown agents and unknown disabled", () => {
		const overlay = mkOverlay({ foo: {} }, ["bar"]);
		const warnings = detectUnknownAgentNames(overlay, ["scout"]);
		assert.equal(warnings.length, 2);
	});

	it("accepts Iterable for knownNames", () => {
		const overlay = mkOverlay({ scout: {} });
		const known = new Set(["scout", "ranger"]);
		const warnings = detectUnknownAgentNames(overlay, known);
		assert.deepEqual(warnings, []);
	});

	it("does not mutate the overlay", () => {
		const overlay = mkOverlay({ foo: {} }, ["bar"]);
		const snapAgents = [...overlay.agents.keys()];
		const snapDisabled = [...overlay.disabled];
		const snapWarnings = [...overlay.warnings];
		detectUnknownAgentNames(overlay, []);
		assert.deepEqual([...overlay.agents.keys()], snapAgents);
		assert.deepEqual([...overlay.disabled], snapDisabled);
		assert.deepEqual(overlay.warnings, snapWarnings);
	});
});
