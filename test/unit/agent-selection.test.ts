import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeAgentsForScope } from "../../agent-selection.ts";
import type { AgentConfig } from "../../agents.ts";

function makeAgent(name: string, source: "builtin" | "user" | "project", systemPrompt: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt,
		source,
		filePath: `/${source}/${name}.md`,
	};
}

describe("mergeAgentsForScope", () => {
	it("returns project agents when scope is project", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("project", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});

	it("returns user agents when scope is user", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("user", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
	});

	it("prefers project agents on name collisions when scope is both", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
		assert.equal(result[0]?.systemPrompt, "project prompt");
	});

	it("keeps agents from both scopes when names are distinct", () => {
		const userAgents = [makeAgent("user-only", "user", "user prompt")];
		const projectAgents = [makeAgent("project-only", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 2);
		assert.ok(result.find((a) => a.name === "user-only" && a.source === "user"));
		assert.ok(result.find((a) => a.name === "project-only" && a.source === "project"));
	});

	it("includes builtin agents when no user or project override exists", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const result = mergeAgentsForScope("both", [], [], builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "builtin");
	});

	it("user agents override builtins with the same name", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const userAgents = [makeAgent("scout", "user", "custom prompt")];
		const result = mergeAgentsForScope("both", userAgents, [], builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
		assert.equal(result[0]?.systemPrompt, "custom prompt");
	});

	it("project agents override builtins with the same name", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const projectAgents = [makeAgent("scout", "project", "project prompt")];
		const result = mergeAgentsForScope("both", [], projectAgents, builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});
});
