import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { getHostBuiltinToolNames, resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { MCP_RUNTIME_SNAPSHOT_EVENT, MCP_RUNTIME_SNAPSHOT_VERSION, type McpRuntimeSnapshotHost } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

/** A parent whose pi-mcp-adapter answers snapshot requests for one runtime-only server. */
function runtimeSnapshotHost(serverName: string): McpRuntimeSnapshotHost {
	return {
		events: {
			emit(event, request) {
				if (event !== MCP_RUNTIME_SNAPSHOT_EVENT || request.version !== MCP_RUNTIME_SNAPSHOT_VERSION || request.name !== serverName) return;
				request.result = { ok: true, snapshot: { name: serverName, runtime: true, persisted: false, definition: { command: "node", args: ["server.js"] } } };
			},
		},
	};
}

describe("child tool plan", () => {
	it("fails a launch that selects MCP tools from the adapter's runtime snapshot", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runtime-mcp-"));
		try {
			assert.throws(
				() => resolvePiLaunchToolPlan({ tools: ["read"], mcpDirectTools: ["runtime-only/search"], cwd, agentName: "browser", runtimeSnapshotHost: runtimeSnapshotHost("runtime-only") }),
				/cannot be provided to in-process children; MCP tools must come from an ambient adapter extension in a background child/,
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("child tool plan host builtin intersection", () => {
	it("intersects declared tools with host-available builtins", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "grep", "find", "ls", "bash"],
			hostAvailableBuiltins: ["ipython", "bash"],
		});
		assert.deepEqual(plan.declaredBuiltinTools, ["bash"]);
		assert.deepEqual(plan.unavailableHostBuiltins, ["read", "grep", "find", "ls"]);
		assert.deepEqual(plan.effectiveToolAllowlist, ["bash"]);
	});

	it("keeps requested native coordination tools through host builtin filtering, but not ceilings or exclusions", () => {
		const tools = ["read", "subagent", "contact_supervisor", "subagent_supervisor"];
		const input = { tools, hostAvailableBuiltins: ["read"] };
		const plan = resolvePiLaunchToolPlan(input);
		assert.deepEqual(plan.effectiveToolAllowlist, tools);
		assert.deepEqual(plan.requiredChildTools, ["read", "subagent", "subagent_supervisor"]);
		assert.equal(plan.fanoutAuthorized, true);
		assert.deepEqual(plan.unavailableHostBuiltins, []);
		for (const restriction of [
			{ excludeTools: ["subagent_supervisor"] },
			{ capabilityCeiling: { version: 1 as const, allowedTools: ["read", "subagent", "contact_supervisor"], denyExtensions: true, sources: ["test"] } },
		]) {
			const restricted = resolvePiLaunchToolPlan({ ...input, ...restriction });
			assert.equal(restricted.fanoutAuthorized, true);
			assert.equal(restricted.effectiveToolAllowlist.includes("subagent_supervisor"), false);
		}
		const leaf = resolvePiLaunchToolPlan({ ...input, tools: ["read", "contact_supervisor"] });
		assert.equal(leaf.fanoutAuthorized, false);
		assert.equal(leaf.effectiveToolAllowlist.includes("subagent_supervisor"), false);
	});

	it("rejects an explicitly requested reply tool when fanout authorization is absent or removed", () => {
		for (const input of [
			{ tools: ["read", "subagent_supervisor"] },
			{ tools: ["read", "subagent", "subagent_supervisor"], excludeTools: ["subagent"] },
			{ tools: ["read", "subagent", "subagent_supervisor"], capabilityCeiling: { version: 1 as const, allowedTools: ["read", "subagent_supervisor"], sources: ["test"] } },
		]) {
			assert.throws(() => resolvePiLaunchToolPlan({ ...input, hostAvailableBuiltins: ["read"] }), /subagent_supervisor.*requires fanout authorization/);
		}
	});

	it("keeps all tools when host provides them", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "grep", "bash"],
			hostAvailableBuiltins: ["read", "grep", "bash", "write", "find"],
		});
		assert.deepEqual(plan.declaredBuiltinTools, ["read", "grep", "bash"]);
		assert.deepEqual(plan.unavailableHostBuiltins, []);
	});

	it("works without hostAvailableBuiltins (standard Pi hosts)", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "grep", "find", "ls"],
		});
		assert.deepEqual(plan.declaredBuiltinTools, ["read", "grep", "find", "ls"]);
		assert.deepEqual(plan.unavailableHostBuiltins, []);
	});

	it("fails when requireReadTool is true but host does not provide read", () => {
		assert.throws(
			() => resolvePiLaunchToolPlan({
				tools: ["bash"],
				requireReadTool: true,
				hostAvailableBuiltins: ["ipython", "bash"],
				agentName: "oracle",
			}),
			/Host runtime does not provide required tool 'read' for agent 'oracle'/,
		);
		assert.throws(
			() => resolvePiLaunchToolPlan({
				tools: ["bash"],
				requireReadTool: true,
				hostAvailableBuiltins: ["bash"],
			}),
			/Host runtime does not provide required tool 'read'/,
		);
	});

	it("includes unavailableHostBuiltins in capability audit", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "bash"],
			hostAvailableBuiltins: ["bash"],
			capabilityCeiling: {
				version: 1,
				allowedTools: ["read", "bash"],
				denyExtensions: false,
				sources: ["test"],
			},
		});
		assert.deepEqual(plan.capabilityAudit?.unavailableHostBuiltins, ["read"]);
	});

	it("respects both capability ceiling and host availability", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "grep", "bash", "write"],
			hostAvailableBuiltins: ["read", "grep", "bash"],
			capabilityCeiling: {
				version: 1,
				allowedTools: ["read", "bash"],
				denyExtensions: false,
				sources: ["test"],
			},
		});
		assert.deepEqual(plan.declaredBuiltinTools, ["read", "bash"]);
		assert.deepEqual(plan.unavailableHostBuiltins, []);
	});

	it("tracks tools removed by host even when ceiling allows them", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "grep", "bash"],
			hostAvailableBuiltins: ["bash"],
			capabilityCeiling: {
				version: 1,
				allowedTools: ["read", "grep", "bash"],
				denyExtensions: false,
				sources: ["test"],
			},
		});
		assert.deepEqual(plan.declaredBuiltinTools, ["bash"]);
		assert.deepEqual(plan.unavailableHostBuiltins, ["read", "grep"]);
	});
});

describe("production launch path supplies hostAvailableBuiltins", () => {
	it("buildInProcessChildLaunch passes hostAvailableBuiltins to tool plan resolution", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-launch-builtins-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = cwd;
		try {
			const launch = buildInProcessChildLaunch({
				host: "runner",
				cwd,
				childAgentName: "test-agent",
				childIndex: 0,
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritGlobalContext: false,
				inheritSkills: false,
				tools: ["read", "grep", "bash"],
				hostAvailableBuiltins: ["ipython", "bash"],
			});
			assert.deepEqual(launch.toolPlan.declaredBuiltinTools, ["bash"]);
			assert.deepEqual(launch.toolPlan.unavailableHostBuiltins, ["read", "grep"]);
			assert.deepEqual(launch.toolPlan.effectiveToolAllowlist, ["bash"]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("getHostBuiltinToolNames extracts builtin tools from ExtensionAPI", () => {
		const mockPi = {
			getAllTools: () => [
				{ name: "read", sourceInfo: { source: "builtin" } },
				{ name: "bash", sourceInfo: { source: "auto" } },
				{ name: "custom-auto-tool", sourceInfo: { source: "auto" } },
				{ name: "custom-tool", sourceInfo: { source: "extension", path: "/ext/tool.ts" } },
				{ name: "mcp-tool", sourceInfo: { source: "mcp" } },
			],
		};
		const builtins = getHostBuiltinToolNames(mockPi);
		assert.deepEqual(builtins, ["read", "bash"]);
	});

	it("getHostBuiltinToolNames returns undefined on failure or empty results", () => {
		const throwingPi = {
			getAllTools: () => { throw new Error("Not available"); },
		};
		assert.equal(getHostBuiltinToolNames(throwingPi), undefined);

		const emptyPi = {
			getAllTools: () => [],
		};
		assert.equal(getHostBuiltinToolNames(emptyPi), undefined);

		const noBuiltinsPi = {
			getAllTools: () => [
				{ name: "custom-tool", sourceInfo: { source: "extension" } },
			],
		};
		assert.equal(getHostBuiltinToolNames(noBuiltinsPi), undefined);
	});
});
