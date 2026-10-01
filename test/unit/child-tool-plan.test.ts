import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { MCP_RUNTIME_SNAPSHOT_EVENT, MCP_RUNTIME_SNAPSHOT_VERSION, type McpHostToolInfo, type McpRuntimeSnapshotHost } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

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

/** A parent whose /mcp is owned by `mcpOwner` and whose tool registry holds `tools`. */
function mcpHost(mcpOwner: string, tools: McpHostToolInfo[]): McpRuntimeSnapshotHost {
	return {
		events: { emit() {} },
		getCommands: () => [{ name: "mcp", sourceInfo: { path: mcpOwner } }],
		getAllTools: () => tools,
	};
}

const BUILTIN_MCP_TOOLS: McpHostToolInfo[] = [
	{ name: "mcp__docs__search_pages", exposure: "codemode", namespace: { name: "mcp__docs" } },
	{ name: "mcp__docs__fetch", exposure: "direct", namespace: { name: "mcp__docs" } },
	{ name: "mcp__docs__admin", exposure: "hidden", namespace: { name: "mcp__docs" } },
	{ name: "mcp__other__fetch", exposure: "codemode", namespace: { name: "mcp__other" } },
];

describe("child tool plan with Pi built-in MCP", () => {
	const host = mcpHost("builtin:mcp", BUILTIN_MCP_TOOLS);

	it("grants every non-hidden tool of a selected server as a required child tool", () => {
		const plan = resolvePiLaunchToolPlan({ tools: ["read"], mcpDirectTools: ["docs"], runtimeSnapshotHost: host });
		const granted = ["mcp__docs__search_pages", "mcp__docs__fetch"];
		assert.deepEqual(plan.builtinMcpTools, granted.map((name) => ({ name, selector: "docs" })));
		assert.deepEqual(plan.effectiveToolAllowlist, ["read", ...granted]);
		assert.deepEqual(plan.requiredChildTools, ["read", ...granted]);
	});

	it("grants one tool for a tool selector and applies exclusions", () => {
		const plan = resolvePiLaunchToolPlan({ mcpDirectTools: ["docs/search.pages", "docs/fetch"], excludeTools: ["mcp__docs__fetch"], runtimeSnapshotHost: host });
		assert.deepEqual(plan.builtinMcpTools, [{ name: "mcp__docs__search_pages", selector: "docs/search.pages" }]);
	});

	it("grants the hash-suffixed name Pi gives a tool whose sanitized name another tool took", () => {
		const plan = resolvePiLaunchToolPlan({ mcpDirectTools: ["srv/a.b"], runtimeSnapshotHost: mcpHost("builtin:mcp", [
			{ name: "mcp__srv__a_b", exposure: "codemode", namespace: { name: "mcp__srv" } },
			{ name: "mcp__srv__a_b_df0974cd", exposure: "codemode", namespace: { name: "mcp__srv" } },
		]) });
		assert.deepEqual(plan.effectiveMcpTools, ["mcp__srv__a_b_df0974cd"]);
	});

	it("resolves a raw hyphenated selector to the name and namespace Pi gives the tool", () => {
		const plan = resolvePiLaunchToolPlan({
			mcpDirectTools: ["my-docs/get-item"],
			capabilityCeiling: { version: 1, allowedTools: ["mcp__my_docs__get_item"], sources: ["test"] },
			runtimeSnapshotHost: mcpHost("builtin:mcp", [{ name: "mcp__my_docs__get_item", exposure: "codemode", namespace: { name: "mcp__my_docs" } }]),
		});
		assert.deepEqual(plan.builtinMcpTools, [{ name: "mcp__my_docs__get_item", selector: "my-docs/get-item" }]);
	});

	it("fails a launch whose selector matches no offered tool", () => {
		assert.throws(
			() => resolvePiLaunchToolPlan({ mcpDirectTools: ["docs/admin", "gone"], agentName: "browser", runtimeSnapshotHost: host }),
			/Agent 'browser' selects MCP tools that Pi's built-in MCP does not offer: mcp:docs\/admin, mcp:gone\. The server may be missing, disconnected, still connecting, or its tools hidden; check \/mcp\./,
		);
	});

	for (const [description, adapterHost] of [
		["when the adapter owns /mcp", mcpHost("/ext/pi-mcp-adapter/index.ts", BUILTIN_MCP_TOOLS)],
		["when adapter 3.x loads next to Pi's built-in /mcp", {
			...mcpHost("builtin:mcp", BUILTIN_MCP_TOOLS),
			getCommands: () => [
				{ name: "mcp", sourceInfo: { path: "builtin:mcp" } },
				{ name: "mcp-adapter", sourceInfo: { path: "/ext/pi-mcp-adapter/index.ts" } },
			],
		}],
	] satisfies Array<[string, McpRuntimeSnapshotHost]>) {
		it(`keeps the pi-mcp-adapter path ${description}`, () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-adapter-mcp-"));
			try {
				assert.throws(
					() => resolvePiLaunchToolPlan({ mcpDirectTools: ["docs"], cwd, runtimeSnapshotHost: adapterHost }),
					/Unresolved MCP direct-tool selectors: docs\. Direct MCP tools require a matching configured server/,
				);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		});
	}
});

describe("child tool plan", () => {
	it("does not grant watchdog_diff unless an agent explicitly requests it", () => {
		for (const agentName of ["worker", "scout", "project-reviewer"]) {
			const plan = resolvePiLaunchToolPlan({ tools: ["read", "contact_supervisor"], agentName });
			assert.equal(plan.effectiveToolAllowlist.includes("watchdog_diff"), false);
		}
		const bundledReviewer = resolvePiLaunchToolPlan({ tools: ["read", "watchdog_diff", "contact_supervisor"], agentName: "reviewer" });
		assert.deepEqual(bundledReviewer.effectiveToolAllowlist, ["read", "watchdog_diff", "contact_supervisor"]);
	});

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

describe("child tool plan declared tools", () => {
	it("keeps every declared core tool, so the child registry decides what exists", () => {
		const plan = resolvePiLaunchToolPlan({ tools: ["read", "grep", "find", "ls", "bash"], agentName: "verifier" });
		assert.deepEqual(plan.declaredBuiltinTools, ["read", "grep", "find", "ls", "bash"]);
		assert.deepEqual(plan.effectiveToolAllowlist, ["read", "grep", "find", "ls", "bash"]);
		assert.deepEqual(plan.requiredChildTools, ["read", "grep", "find", "ls", "bash"]);
		assert.deepEqual(plan.warnings, []);
	});

	it("adds read for lazy skill loading without an explicit declaration", () => {
		const plan = resolvePiLaunchToolPlan({ tools: ["bash"], requireReadTool: true });
		assert.deepEqual(plan.requiredChildTools, ["read", "bash"]);
	});

	it("preserves arbitrary non-core requirements without inferring their child providers", () => {
		const tools = ["read", "fixture_search", "__proto__", "ipython"];
		for (const configuration of [
			{},
			{ capabilityCeiling: { version: 1 as const, denyExtensions: true, sources: ["test"] } },
		]) {
			const plan = resolvePiLaunchToolPlan({ tools, ...configuration });
			assert.deepEqual(plan.effectiveToolAllowlist, tools);
			assert.deepEqual(plan.requiredChildTools, tools);
		}
		const restricted = resolvePiLaunchToolPlan({
			tools, excludeTools: ["__proto__"],
			capabilityCeiling: { version: 1, allowedTools: ["fixture_search", "__proto__"], sources: ["test"] },
		});
		assert.deepEqual(restricted.effectiveToolAllowlist, ["fixture_search"]);
		assert.deepEqual(restricted.requiredChildTools, ["fixture_search"]);
		for (const restriction of [{ tools: [] }, { capabilityCeiling: { version: 1 as const, allowedTools: [], sources: ["test"] } }]) {
			const empty = resolvePiLaunchToolPlan({ tools, ...restriction });
			assert.deepEqual(empty.effectiveToolAllowlist, []);
			assert.deepEqual(empty.requiredChildTools, []);
		}
	});

	it("retains the supervisor pairing exception but requires a lone intercom", () => {
		for (const tools of [["intercom"], ["intercom", "contact_supervisor"]]) {
			const plan = resolvePiLaunchToolPlan({ tools });
			assert.deepEqual(plan.effectiveToolAllowlist, tools);
			assert.deepEqual(plan.requiredChildTools, tools.length === 1 ? tools : []);
		}
	});

	it("keeps requested native coordination tools, but honors ceilings and exclusions", () => {
		const tools = ["read", "subagent", "contact_supervisor", "subagent_supervisor"];
		const plan = resolvePiLaunchToolPlan({ tools });
		assert.deepEqual(plan.effectiveToolAllowlist, tools);
		assert.deepEqual(plan.requiredChildTools, ["read", "subagent", "subagent_supervisor"]);
		assert.equal(plan.fanoutAuthorized, true);
		for (const restriction of [
			{ excludeTools: ["subagent_supervisor"] },
			{ capabilityCeiling: { version: 1 as const, allowedTools: ["read", "subagent", "contact_supervisor"], denyExtensions: true, sources: ["test"] } },
		]) {
			const restricted = resolvePiLaunchToolPlan({ tools, ...restriction });
			assert.equal(restricted.fanoutAuthorized, true);
			assert.equal(restricted.effectiveToolAllowlist.includes("subagent_supervisor"), false);
		}
		const leaf = resolvePiLaunchToolPlan({ tools: ["read", "contact_supervisor"] });
		assert.equal(leaf.fanoutAuthorized, false);
		assert.equal(leaf.effectiveToolAllowlist.includes("subagent_supervisor"), false);
	});

	it("rejects an explicitly requested reply tool when fanout authorization is absent or removed", () => {
		for (const input of [
			{ tools: ["read", "subagent_supervisor"] },
			{ tools: ["read", "subagent", "subagent_supervisor"], excludeTools: ["subagent"] },
			{ tools: ["read", "subagent", "subagent_supervisor"], capabilityCeiling: { version: 1 as const, allowedTools: ["read", "subagent_supervisor"], sources: ["test"] } },
		]) {
			assert.throws(() => resolvePiLaunchToolPlan(input), /subagent_supervisor.*requires fanout authorization/);
		}
	});

	it("respects a capability ceiling", () => {
		const plan = resolvePiLaunchToolPlan({
			tools: ["read", "grep", "bash", "write"],
			capabilityCeiling: { version: 1, allowedTools: ["read", "bash"], denyExtensions: false, sources: ["test"] },
		});
		assert.deepEqual(plan.declaredBuiltinTools, ["read", "bash"]);
		assert.deepEqual(plan.capabilityAudit?.ceiling.sources, ["test"]);
	});
});

describe("production launch path keeps declared child tools", () => {
	it("buildInProcessChildLaunch requires every declared tool from the child registry", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-launch-builtins-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = cwd;
		try {
			for (const childAgentName of ["test-agent", "scout"]) {
				const launch = buildInProcessChildLaunch({
					host: "runner",
					cwd,
					childAgentName,
					childIndex: 0,
					sessionEnabled: false,
					inheritProjectContext: false,
					inheritGlobalContext: false,
					inheritSkills: false,
					tools: ["read", "grep", "bash"],
				});
				assert.deepEqual(launch.toolPlan.declaredBuiltinTools, ["read", "grep", "bash"]);
				assert.deepEqual(launch.toolPlan.effectiveToolAllowlist, ["read", "grep", "bash"]);
				assert.deepEqual(launch.toolPlan.requiredChildTools, ["read", "grep", "bash"]);
				assert.deepEqual(launch.config.requiredTools, ["read", "grep", "bash"]);
				assert.deepEqual(launch.warnings, []);
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
