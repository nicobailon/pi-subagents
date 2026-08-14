import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import {
	NATIVE_INTERCOM_EXTENSION_DIR,
	applyIntercomBridgeToAgent,
	diagnoseIntercomBridge,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
	resolveIntercomBridgeMode,
	type IntercomBridgeState,
} from "../../src/intercom/intercom-bridge.ts";

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
		assert.equal(resolveIntercomSessionTarget("planner", "session-12345678", "session-stableabcdef"), "planner");
	});

	it("uses a runtime-only subagent chat alias when unnamed", () => {
		assert.equal(resolveIntercomSessionTarget(undefined, "session-12345678", ""), "subagent-chat-12345678");
	});

	it("uses the current pi-intercom runtime id for unnamed fallback when present", () => {
		assert.equal(resolveIntercomSessionTarget(undefined, "session-12345678", "session-stableabcdef"), "subagent-chat-stableabcdef");
		assert.equal(resolveIntercomSessionTarget(undefined, "session-12345678", "session-abcdefghijklmnopqrst"), "subagent-chat-abcdefghijklmnopqr");
	});
});

describe("resolveSubagentIntercomTarget", () => {
	it("builds stable child session targets from run metadata", () => {
		assert.equal(resolveSubagentIntercomTarget("78f659a3", "worker"), "subagent-worker-78f659a3");
		assert.equal(resolveSubagentIntercomTarget("78f659a3", "senior executor", 1), "subagent-senior-executor-78f659a3-2");
	});
});

describe("diagnoseIntercomBridge", () => {
	it("reports the native supervisor channel as available without external package discovery", () => {
		const diagnostic = diagnoseIntercomBridge({
			config: { mode: "always" },
			context: "fresh",
			orchestratorTarget: "main",
		});

		assert.equal(diagnostic.active, true);
		assert.equal(diagnostic.wantsIntercom, true);
		assert.equal(diagnostic.supervisorChannelAvailable, true);
		assert.equal(diagnostic.extensionDir, NATIVE_INTERCOM_EXTENSION_DIR);
	});

	it("does not read external intercom config when bridge mode is off", () => {
		const diagnostic = diagnoseIntercomBridge({
			config: { mode: "off" },
			context: "fresh",
			orchestratorTarget: "main",
		});

		assert.equal(diagnostic.active, false);
		assert.equal(diagnostic.reason, "bridge mode is off");
	});
});

describe("resolveIntercomBridge", () => {
	it("activates when mode/context permit and an orchestrator target exists", () => {
		const bridge = resolveIntercomBridge({
			config: { mode: "fork-only" },
			context: "fork",
			orchestratorTarget: "main",
		});

		assert.equal(bridge.active, true);
		assert.equal(bridge.resultDelivery, false);
		assert.equal(bridge.orchestratorTarget, "main");
		assert.equal(bridge.extensionDir, NATIVE_INTERCOM_EXTENSION_DIR);
	});

	it("uses a per-run override instead of the global config", () => {
		const bridge = resolveIntercomBridge({
			config: { mode: "always", resultDelivery: true },
			override: { mode: "off" },
			context: "fresh",
			orchestratorTarget: "main",
		});

		assert.equal(bridge.active, false);
		assert.equal(bridge.mode, "off");
		assert.equal(bridge.resultDelivery, false);
	});

	it("can disable external grouped-result delivery without disabling supervisor coordination", () => {
		const bridge = resolveIntercomBridge({
			config: { mode: "always", resultDelivery: false },
			context: "fresh",
			orchestratorTarget: "main",
		});
		assert.equal(bridge.active, true);
		assert.equal(bridge.resultDelivery, false);
	});

	it("stays inactive for fresh context when mode is fork-only", () => {
		const bridge = resolveIntercomBridge({
			config: { mode: "fork-only" },
			context: "fresh",
			orchestratorTarget: "main",
		});
		assert.equal(bridge.active, false);
	});

	it("loads custom instructions from instructionFile", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-intercom-bridge-test-"));
		const instructionFile = path.join(tempDir, "bridge.md");
		fs.writeFileSync(instructionFile, "Custom bridge for {orchestratorTarget}\nUse ask then send.");
		try {
			const bridge = resolveIntercomBridge({
				config: { mode: "always", instructionFile },
				context: "fresh",
				orchestratorTarget: "main",
			});
			assert.equal(bridge.active, true);
			assert.match(bridge.instruction, /Custom bridge for main/);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses stronger default instructions for fork-aware coordination", () => {
		const bridge = resolveIntercomBridge({
			config: { mode: "always" },
			context: "fork",
			orchestratorTarget: "main",
		});
		assert.equal(bridge.active, true);
		assert.match(bridge.instruction, /reference-only/i);
		assert.match(bridge.instruction, /normal assistant text/i);
		assert.match(bridge.instruction, /contact_supervisor/);
		assert.match(bridge.instruction, /need_decision/);
		assert.match(bridge.instruction, /progress_update/);
		assert.match(bridge.instruction, /focused task result/i);
	});
});

describe("applyIntercomBridgeToAgent", () => {
	const activeBridge: IntercomBridgeState = {
		active: true,
		mode: "always",
		resultDelivery: true,
		orchestratorTarget: "main",
		extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
		instruction: "Intercom orchestration channel:\n- Need a decision or blocked: contact_supervisor({ reason: \"need_decision\", message: \"<question>\" })\n- Blocked/update: contact_supervisor({ reason: \"progress_update\", message: \"UPDATE: <summary>\" })",
	};

	it("injects contact_supervisor and prompt instructions", () => {
		const updated = applyIntercomBridgeToAgent(makeAgent({ tools: ["read", "bash"] }), activeBridge);
		assert.deepEqual(updated.tools, ["read", "bash", "contact_supervisor"]);
		assert.match(updated.systemPrompt, /Intercom orchestration channel:/);
		assert.match(updated.systemPrompt, /contact_supervisor/);
		assert.doesNotMatch(updated.systemPrompt ?? "", /Generic intercom/);
	});

	it("is idempotent", () => {
		const first = applyIntercomBridgeToAgent(makeAgent({ tools: ["read"] }), activeBridge);
		const second = applyIntercomBridgeToAgent(first, activeBridge);
		assert.equal(second.tools?.filter((tool) => tool === "intercom").length, 0);
		assert.equal(second.tools?.filter((tool) => tool === "contact_supervisor").length, 1);
		assert.equal(second.systemPrompt, first.systemPrompt);
	});

	it("does not block native supervisor tools for agents with explicit extension allowlists", () => {
		const agent = makeAgent({ tools: ["read"], extensions: ["/tmp/other-extension/index.ts"] });
		const updated = applyIntercomBridgeToAgent(agent, activeBridge);
		assert.deepEqual(updated.tools, ["read", "contact_supervisor"]);
		assert.match(updated.systemPrompt, /contact_supervisor/);
	});

	it("preserves explicitly requested external intercom tools", () => {
		const updated = applyIntercomBridgeToAgent(makeAgent({ tools: ["read", "intercom"] }), activeBridge);
		assert.deepEqual(updated.tools, ["read", "intercom", "contact_supervisor"]);
	});

	it("does not widen explicit empty or MCP-only builtin allowlists", () => {
		const emptyTools = applyIntercomBridgeToAgent(makeAgent({ tools: [] }), activeBridge);
		assert.deepEqual(emptyTools.tools, []);
		assert.match(emptyTools.systemPrompt, /contact_supervisor/);

		const mcpOnly = applyIntercomBridgeToAgent(makeAgent({ tools: [], mcpDirectTools: ["github/search_repositories"] }), activeBridge);
		assert.deepEqual(mcpOnly.tools, []);
		assert.deepEqual(mcpOnly.mcpDirectTools, ["github/search_repositories"]);
		assert.match(mcpOnly.systemPrompt, /contact_supervisor/);
	});
});
