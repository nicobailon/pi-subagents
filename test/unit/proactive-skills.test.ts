import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig, ChainConfig } from "../../src/agents/agents.ts";
import {
	buildProactiveSkillSubagentRecommendationLines,
	formatProactiveSkillSubagentRecommendations,
	recommendProactiveSkillSubagents,
	resolveProactiveSkillSubagentsConfig,
} from "../../src/agents/proactive-skills.ts";

function agent(name: string, skills?: string[], disabled = false): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/tmp/${name}.md`,
		...(skills ? { skills } : {}),
		...(disabled ? { disabled } : {}),
	};
}

function chain(name: string, skills: string[]): ChainConfig {
	return {
		name,
		description: `${name} chain`,
		source: "project",
		filePath: `/tmp/${name}.chain.md`,
		steps: [{ agent: "worker", skills }],
	};
}

describe("proactive skill subagent recommendations", () => {
	it("recommends available skills referenced by multiple enabled configs", () => {
		const recommendations = recommendProactiveSkillSubagents({
			agents: [
				agent("reviewer"),
				agent("ui-reviewer", ["accessibility"]),
				agent("disabled-reviewer", ["accessibility"], true),
			],
			chains: [chain("ui-check", ["accessibility"]), chain("cleanup", ["deslop"])],
			availableSkills: [
				{ name: "accessibility", description: "Accessibility review." },
				{ name: "deslop", description: "Cleanup review." },
			],
		});

		assert.equal(recommendations.length, 1);
		assert.equal(recommendations[0]?.skill, "accessibility");
		assert.equal(recommendations[0]?.agent, "reviewer");
		assert.equal(recommendations[0]?.references, 2);
		assert.deepEqual(recommendations[0]?.sources, ["agent:ui-reviewer", "chain:ui-check"]);
	});

	it("does not recommend hidden skills (disable-model-invocation: true)", () => {
		const recommendations = recommendProactiveSkillSubagents({
			agents: [
				agent("one", ["hidden-skill", "visible-skill"]),
				agent("two", ["hidden-skill", "visible-skill"]),
			],
			availableSkills: [
				{ name: "hidden-skill", description: "User-only.", disableModelInvocation: true },
				{ name: "visible-skill", description: "Model-invocable." },
			],
		});

		assert.deepEqual(recommendations.map((entry) => entry.skill), ["visible-skill"]);
	});

	it("filters unavailable orchestration skills and honors config bounds", () => {
		const recommendations = recommendProactiveSkillSubagents({
			agents: [
				agent("delegate", ["pi-subagents", "alpha", "beta"]),
				agent("one", ["alpha", "beta"]),
				agent("two", ["gamma"]),
				agent("three", ["gamma"]),
			],
			availableSkills: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
			config: { preferredAgent: "delegate", maxRecommendations: 2 },
		});

		assert.deepEqual(recommendations.map((entry) => entry.skill), ["alpha", "beta"]);
		assert.ok(recommendations.every((entry) => entry.agent === "delegate"));
	});

	it("can be disabled and formats guardrails for visible suggestions", () => {
		assert.equal(resolveProactiveSkillSubagentsConfig(false).enabled, false);
		assert.deepEqual(recommendProactiveSkillSubagents({
			agents: [agent("reviewer", ["deslop"]), agent("cleanup", ["deslop"])],
			availableSkills: [{ name: "deslop" }],
			config: false,
		}), []);

		const lines = formatProactiveSkillSubagentRecommendations([
			{
				skill: "deslop",
				agent: "reviewer",
				references: 2,
				sources: ["agent:a", "chain:b"],
				reason: "referenced by 2 configured agents/chains",
			},
		]);
		assert.match(lines.join("\n"), /Proactive skill subagent suggestions:/);
		assert.match(lines.join("\n"), /fresh context/);
	});

	it("does not discover skills when disabled and treats discovery failures as no suggestions", () => {
		let discoveryCalls = 0;
		const disabledLines = buildProactiveSkillSubagentRecommendationLines({
			agents: [agent("reviewer", ["deslop"]), agent("cleanup", ["deslop"])],
			config: false,
			discoverAvailableSkills: () => {
				discoveryCalls++;
				throw new Error("should not discover when disabled");
			},
		});
		assert.deepEqual(disabledLines, []);
		assert.equal(discoveryCalls, 0);

		const failedDiscoveryLines = buildProactiveSkillSubagentRecommendationLines({
			agents: [agent("reviewer", ["deslop"]), agent("cleanup", ["deslop"])],
			discoverAvailableSkills: () => {
				discoveryCalls++;
				throw new Error("skill scan failed");
			},
		});
		assert.deepEqual(failedDiscoveryLines, []);
		assert.equal(discoveryCalls, 1);
	});
});
