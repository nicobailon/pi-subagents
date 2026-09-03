import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleList } from "../../src/agents/agent-management.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import {
	decodeSubagentCapabilityCeiling,
	encodeSubagentCapabilityCeiling,
	intersectSubagentCapabilityCeilings,
	parseSubagentCapabilityCeiling,
	registerSubagentCapabilityCeiling,
} from "../../src/api/capability-ceiling.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `${name} prompt`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

describe("capability ceiling agent allowlist", () => {
	it("parses, round-trips, and intersects allowedAgents", () => {
		const parsed = parseSubagentCapabilityCeiling({ version: 1, allowedAgents: ["worker", "reviewer", "worker"], denyExtensions: false, sources: ["plan"] });
		assert.deepEqual(parsed.allowedAgents, ["reviewer", "worker"]);
		assert.deepEqual(decodeSubagentCapabilityCeiling(encodeSubagentCapabilityCeiling(parsed)), parsed);

		assert.deepEqual(intersectSubagentCapabilityCeilings(
			{ version: 1, allowedAgents: ["worker", "reviewer"], denyExtensions: false, sources: ["outer"] },
			{ version: 1, allowedAgents: ["reviewer", "scout"], denyExtensions: true, sources: ["inner"] },
		), {
			version: 1,
			allowedAgents: ["reviewer"],
			denyExtensions: true,
			sources: ["inner", "outer"],
		});

		assert.deepEqual(intersectSubagentCapabilityCeilings(
			{ version: 1, allowedTools: ["read"], denyExtensions: false, sources: ["tools-only"] },
			{ version: 1, allowedAgents: [], denyExtensions: false, sources: ["none"] },
		)?.allowedAgents, []);
	});

	it("marks non-allowlisted agents as restricted in list output", () => {
		const sessionId = `allowlist-list-${Date.now()}-${Math.random()}`;
		const handle = registerSubagentCapabilityCeiling({ sessionId, source: "plan-mode", ceiling: { allowedAgents: ["reviewer"] } });
		try {
			const result = handleList({}, { cwd: process.cwd(), currentSessionId: sessionId, modelRegistry: { getAvailable: () => [] } });
			const text = result.content[0]?.text ?? "";
			assert.match(text, /Executable agents:/);
			assert.match(text, /- reviewer /);
			assert.match(text, /Restricted agents \(not executable in this session; capability ceiling: plan-mode\):/);
			assert.match(text, /- worker /);
		} finally {
			handle.dispose();
		}
	});

	it("rejects a non-allowlisted agent in preflight launch resolution", async () => {
		const result = await resolveSubagentLaunchContract({
			agent: "worker",
			cwd: process.cwd(),
			capabilityCeiling: { version: 1, allowedAgents: ["reviewer"], denyExtensions: false, sources: ["plan-mode"] },
		});
		assert.equal(result.ok, false);
		assert.equal(result.code, "restricted_agent");
		assert.match(result.message, /does not allow agent 'worker'/);
		assert.match(result.message, /Allowed agents: reviewer/);
	});

	it("rejects a non-allowlisted foreground launch before spawning", async () => {
		const result = await runSync(process.cwd(), [agent("worker"), agent("reviewer")], "worker", "Do work", {
			capabilityCeiling: { version: 1, allowedAgents: ["reviewer"], denyExtensions: false, sources: ["plan-mode"] },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /does not allow agent 'worker'/);
		assert.deepEqual(result.capabilityCeiling?.allowedAgents, ["reviewer"]);
	});

	it("includes allowedAgents in the child runtime config and audit metadata", () => {
		const { config, capabilityAudit } = buildInProcessChildLaunch({
			host: "parent",
			cwd: process.cwd(),
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			childAgentName: "reviewer",
			childIndex: 0,
			capabilityCeiling: { version: 1, allowedAgents: ["reviewer"], allowedTools: ["read"], denyExtensions: true, sources: ["plan-mode"] },
		});
		assert.equal(capabilityAudit?.agentAllowed, true);
		assert.deepEqual(capabilityAudit?.agentRestrictionSources, ["plan-mode"]);
		assert.deepEqual(config.capabilityCeiling?.allowedAgents, ["reviewer"]);
	});
});
