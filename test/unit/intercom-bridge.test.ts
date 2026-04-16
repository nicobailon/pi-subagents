import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../agents.ts";
import {
	applyIntercomBridgeToAgent,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveIntercomBridgeMode,
	type IntercomBridgeState,
} from "../../intercom-bridge.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Test worker",
		systemPrompt: "Base prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
		...overrides,
	};
}

describe("resolveIntercomBridgeMode", () => {
	it("defaults unknown values to always", () => {
		assert.equal(resolveIntercomBridgeMode(undefined), "always");
		assert.equal(resolveIntercomBridgeMode("nope"), "always");
	});

	it("accepts explicit modes", () => {
		assert.equal(resolveIntercomBridgeMode("off"), "off");
		assert.equal(resolveIntercomBridgeMode("fork-only"), "fork-only");
		assert.equal(resolveIntercomBridgeMode("always"), "always");
	});
});

describe("resolveIntercomSessionTarget", () => {
	it("prefers an explicit session name", () => {
		assert.equal(resolveIntercomSessionTarget("planner", "session-12345678"), "planner");
	});

	it("uses a runtime-only subagent chat alias when unnamed", () => {
		assert.equal(resolveIntercomSessionTarget(undefined, "session-12345678"), "subagent-chat-12345678");
	});
});

describe("resolveIntercomBridge", () => {
	it("activates when extension exists, config is enabled, and context matches", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const configPath = path.join(tempDir, "config.json");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ enabled: true }));
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "fork-only" },
				context: "fork",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(bridge.active, true);
			assert.equal(bridge.orchestratorTarget, "main");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stays inactive when intercom config is disabled", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const configPath = path.join(tempDir, "config.json");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ enabled: false }));
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(bridge.active, false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stays active when intercom config is malformed", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const configPath = path.join(tempDir, "config.json");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(configPath, "{ enabled: nope }");
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always" },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
				configPath,
			});
			assert.equal(bridge.active, true);
		} finally {
			console.warn = originalWarn;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stays inactive for fresh context when mode is fork-only", () => {
		const bridge = resolveIntercomBridge({
			config: { mode: "fork-only" },
			context: "fresh",
			orchestratorTarget: "main",
			extensionDir: "/path/that/does/not/matter",
		});
		assert.equal(bridge.active, false);
	});

	it("loads custom instructions from instructionFile", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-intercom-bridge-test-"));
		const extensionDir = path.join(tempDir, "pi-intercom");
		const instructionFile = path.join(tempDir, "bridge.md");
		fs.mkdirSync(extensionDir, { recursive: true });
		fs.writeFileSync(instructionFile, "Custom bridge for {orchestratorTarget}\nUse ask then send.");
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always", instructionFile },
				context: "fresh",
				orchestratorTarget: "main",
				extensionDir,
			});
			assert.equal(bridge.active, true);
			assert.match(bridge.instruction, /Custom bridge for main/);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("applyIntercomBridgeToAgent", () => {
	const activeBridge: IntercomBridgeState = {
		active: true,
		mode: "always",
		orchestratorTarget: "main",
		extensionDir: "/Users/test/.pi/agent/extensions/pi-intercom",
		instruction: "Intercom orchestration channel:\n- Need a decision or blocked: intercom({ action: \"ask\", to: \"main\", message: \"<question>\" })\n- Completion/update: intercom({ action: \"send\", to: \"main\", message: \"DONE: <summary>\" })",
	};

	it("injects intercom tool and prompt instructions", () => {
		const updated = applyIntercomBridgeToAgent(makeAgent({ tools: ["read", "bash"] }), activeBridge);
		assert.deepEqual(updated.tools, ["read", "bash", "intercom"]);
		assert.match(updated.systemPrompt, /Intercom orchestration channel:/);
		assert.match(updated.systemPrompt, /action: "ask"/);
	});

	it("is idempotent", () => {
		const first = applyIntercomBridgeToAgent(makeAgent({ tools: ["read"] }), activeBridge);
		const second = applyIntercomBridgeToAgent(first, activeBridge);
		assert.equal(second.tools?.filter((tool) => tool === "intercom").length, 1);
		assert.equal(second.systemPrompt, first.systemPrompt);
	});

	it("does not inject when extension sandbox excludes intercom", () => {
		const agent = makeAgent({ tools: ["read"], extensions: ["/tmp/other-extension/index.ts"] });
		const updated = applyIntercomBridgeToAgent(agent, activeBridge);
		assert.equal(updated, agent);
	});

	it("does not treat not-pi-intercom paths as allowed", () => {
		const agent = makeAgent({ tools: ["read"], extensions: ["/tmp/not-pi-intercom/index.ts"] });
		const updated = applyIntercomBridgeToAgent(agent, activeBridge);
		assert.equal(updated, agent);
	});
});
