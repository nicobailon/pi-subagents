import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAdvertisedAgentCatalog, buildAdvertisedAgentPrompt } from "../../src/agents/advertised-agent-prompt.ts";
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

	it("returns no catalog when no agent opts in", () => {
		assert.equal(buildAdvertisedAgentPrompt([agent("hidden")]), undefined);
	});

	it("admits an exact-budget canonical name and omits it one byte over", () => {
		const emptyName = buildAdvertisedAgentPrompt([agent("", { advertise: true, description: "small" })])!;
		const name = "x".repeat(12_288 - Buffer.byteLength(emptyName));
		const exact = buildAdvertisedAgentPrompt([agent(name, { advertise: true, description: "small" })])!;
		assert.equal(Buffer.byteLength(exact), 12_288);
		assert.ok(exact.includes(`<name>${name}</name>`));
		const over = buildAdvertisedAgentPrompt([agent(`${name}x`, { advertise: true, description: "small" })])!;
		assert.doesNotMatch(over, /<name>/);
		assert.match(over, /<omitted count="1"/);
	});

	it("builds a section body without the outer tag that Pi adds from the section key", () => {
		const agents = [agent("alpha", { advertise: true }), agent("hidden")];
		const body = buildAdvertisedAgentCatalog(agents)!;
		assert.doesNotMatch(body, /advertised_subagents/);
		assert.match(body, /<name>alpha<\/name>/);
		assert.doesNotMatch(body, /hidden/);
		assert.equal(buildAdvertisedAgentPrompt(agents), `<advertised_subagents>\n${body}\n</advertised_subagents>`);
		assert.equal(buildAdvertisedAgentCatalog([agent("hidden")]), undefined);
	});

	it("bounds the section body by the same wrapped byte budget", () => {
		const agents = Array.from({ length: 40 }, (_, index) => agent(`agent-${String(index).padStart(2, "0")}`, {
			advertise: true,
			description: "🦜界".repeat(200),
		}));
		const body = buildAdvertisedAgentCatalog(agents)!;
		const wrapped = buildAdvertisedAgentPrompt(agents)!;
		assert.equal(wrapped, `<advertised_subagents>\n${body}\n</advertised_subagents>`);
		assert.ok(Buffer.byteLength(wrapped) <= 12_288);
		assert.match(body, /<omitted count="\d+" \/>/);
	});
});
