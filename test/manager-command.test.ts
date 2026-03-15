import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerSubagentExtension from "../index.ts";

function makeFakePi() {
	const commands = new Map<string, { description?: string }>();
	return {
		commands,
		events: {
			on() {},
			emit() {},
		},
		on() {},
		registerTool() {},
		registerShortcut() {},
		registerCommand(name: string, options: { description?: string }) {
			commands.set(name, options);
		},
	};
}

function writeConfig(homeDir: string, config: Record<string, unknown>) {
	const configDir = path.join(homeDir, ".pi", "agent", "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config, null, 2));
}

describe("managerCommand config", () => {
	const originalHome = process.env.HOME;

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
	});

	it("defaults to /agents", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		process.env.HOME = homeDir;

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(pi.commands.has("agents"));
		assert.ok(!pi.commands.has("subagents"));
	});

	it("registers a custom manager command", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		process.env.HOME = homeDir;
		writeConfig(homeDir, { managerCommand: "subagents" });

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(pi.commands.has("subagents"));
		assert.ok(!pi.commands.has("agents"));
	});

	it("normalizes a leading slash in managerCommand", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		process.env.HOME = homeDir;
		writeConfig(homeDir, { managerCommand: "/subagents" });

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(pi.commands.has("subagents"));
	});

	it("disables manager command registration when set to false", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		process.env.HOME = homeDir;
		writeConfig(homeDir, { managerCommand: false });

		const pi = makeFakePi();
		registerSubagentExtension(pi as never);

		assert.ok(!pi.commands.has("agents"));
		assert.ok(!pi.commands.has("subagents"));
		assert.ok(pi.commands.has("run"));
		assert.ok(pi.commands.has("chain"));
		assert.ok(pi.commands.has("parallel"));
	});
});
