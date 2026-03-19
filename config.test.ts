import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadExtensionConfig } from "./config.ts";

const tempDirs: string[] = [];

function makeTempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-config-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadExtensionConfig", () => {
	it("preserves legacy config.json settings", () => {
		const homeDir = makeTempHome();
		writeJson(path.join(homeDir, ".pi", "agent", "extensions", "subagent", "config.json"), {
			asyncByDefault: true,
			defaultSessionDir: "~/.pi/agent/sessions/subagent/",
		});

		const config = loadExtensionConfig(undefined, homeDir);
		assert.equal(config.asyncByDefault, true);
		assert.equal(config.defaultSessionDir, "~/.pi/agent/sessions/subagent/");
		assert.deepEqual(config.keybindings?.agentManagerNew, ["ctrl+n", "alt+n"]);
	});

	it("reads namespaced user settings", () => {
		const homeDir = makeTempHome();
		writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
			"pi-subagents": {
				asyncByDefault: true,
				keybindings: {
					agentManagerNew: ["ctrl+shift+n"],
				},
			},
		});

		const config = loadExtensionConfig(undefined, homeDir);
		assert.equal(config.asyncByDefault, true);
		assert.deepEqual(config.keybindings?.agentManagerNew, ["ctrl+shift+n"]);
	});

	it("lets project settings override user and legacy settings", () => {
		const homeDir = makeTempHome();
		const cwd = path.join(homeDir, "worktree");
		writeJson(path.join(homeDir, ".pi", "agent", "extensions", "subagent", "config.json"), {
			asyncByDefault: false,
			defaultSessionDir: "legacy-dir",
			keybindings: {
				agentManagerNew: ["alt+n"],
			},
		});
		writeJson(path.join(homeDir, ".pi", "agent", "settings.json"), {
			"pi-subagents": {
				asyncByDefault: true,
				defaultSessionDir: "user-dir",
				keybindings: {
					agentManagerNew: ["ctrl+n"],
				},
			},
		});
		writeJson(path.join(cwd, ".pi", "settings.json"), {
			"pi-subagents": {
				defaultSessionDir: "project-dir",
				keybindings: {
					agentManagerNew: ["ctrl+shift+n"],
				},
			},
		});

		const config = loadExtensionConfig(cwd, homeDir);
		assert.equal(config.asyncByDefault, true);
		assert.equal(config.defaultSessionDir, "project-dir");
		assert.deepEqual(config.keybindings?.agentManagerNew, ["ctrl+shift+n"]);
	});
});
