import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";
import { handleWatchdogToolAction } from "../../src/watchdog/tool-actions.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function createCtx(current: { provider: string; id: string }) {
	const models = [
		{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
		{ provider: "anthropic", id: "claude-opus-4-8", reasoning: true },
	];
	return {
		cwd: tempProject,
		model: current,
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: { provider: string; id: string }) => Boolean(model),
		},
		sessionManager: {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	} as never;
}

function text(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((entry) => entry.text ?? "").join("\n");
}

describe("watchdog tool actions", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-tool-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-tool-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".pi", "agent");
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

	it("configures the recommended model for the current session without writing settings", () => {
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });
		const result = handleWatchdogToolAction("watchdog.configure", { model: "recommended" }, createCtx({ provider: "openai-codex", id: "gpt-5.5" }), runtime);

		assert.equal(result.isError, undefined);
		assert.match(text(result), /session model configured: anthropic\/claude-opus-4-8:high/);
		assert.equal(fs.existsSync(path.join(tempHome, ".pi", "agent", "settings.json")), false);
		assert.equal(runtime.getSnapshot(tempProject).config.main.model, "anthropic/claude-opus-4-8");
		assert.equal(runtime.getSnapshot(tempProject).config.main.thinking, "high");
	});

	it("persists the recommended model when user scope is explicit", () => {
		const runtime = new MainWatchdogRuntime({ cwd: tempProject });
		const result = handleWatchdogToolAction("watchdog.configure", { scope: "user", model: "recommended" }, createCtx({ provider: "anthropic", id: "claude-opus-4-8" }), runtime);

		assert.equal(result.isError, undefined);
		const settings = JSON.parse(fs.readFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), "utf-8"));
		assert.equal(settings.subagents.watchdog.main.model, "openai-codex/gpt-5.5");
		assert.equal(settings.subagents.watchdog.main.thinking, "high");
	});
});
