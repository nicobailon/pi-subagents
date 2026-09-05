import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendAdvertisedAgentPrompt, buildAdvertisedAgentPrompt } from "../../src/agents/advertised-agent-prompt.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `${name} prompt`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/tmp/${name}.md`,
		...overrides,
	};
}

describe("advertised agent prompt", () => {
	it("includes only opted-in, capability-permitted agents in stable order", () => {
		const prompt = buildAdvertisedAgentPrompt([
			agent("zeta", { advertise: true }),
			agent("hidden"),
			agent("disabled", { advertise: true, disabled: true }),
			agent("alpha", { advertise: true }),
		], {
			version: 1,
			allowedAgents: ["alpha", "hidden", "zeta"],
			denyExtensions: false,
			sources: ["test"],
		});

		assert.ok(prompt);
		assert.match(prompt, /<name>alpha<\/name>/);
		assert.match(prompt, /<name>zeta<\/name>/);
		assert.doesNotMatch(prompt, /hidden|disabled/);
		assert.ok(prompt.indexOf("alpha") < prompt.indexOf("zeta"));
	});

	it("escapes agent-owned metadata and bounds the catalog", () => {
		const agents = Array.from({ length: 18 }, (_, index) => agent(`agent-${String(index).padStart(2, "0")}`, {
			advertise: true,
			description: index === 0 ? `<route>&${"x".repeat(700)}` : `agent ${index}`,
		}));
		const prompt = buildAdvertisedAgentPrompt(agents);

		assert.ok(prompt);
		assert.match(prompt, /&lt;route&gt;&amp;/);
		assert.doesNotMatch(prompt, /<route>/);
		assert.match(prompt, /…<\/description>/);
		assert.match(prompt, /<omitted count="2" \/>/);
	});

	it("replaces an existing catalog instead of duplicating it", () => {
		const first = buildAdvertisedAgentPrompt([agent("alpha", { advertise: true })]);
		const second = buildAdvertisedAgentPrompt([agent("beta", { advertise: true })]);
		assert.ok(first);
		assert.ok(second);

		const systemPrompt = appendAdvertisedAgentPrompt(appendAdvertisedAgentPrompt("base prompt", first), second);
		assert.equal(systemPrompt.match(/<advertised_subagents>/gu)?.length, 1);
		assert.doesNotMatch(systemPrompt, /<name>alpha<\/name>/);
		assert.match(systemPrompt, /<name>beta<\/name>/);
	});

	it("returns no catalog when no agent opts in", () => {
		assert.equal(buildAdvertisedAgentPrompt([agent("hidden")]), undefined);
	});
});
