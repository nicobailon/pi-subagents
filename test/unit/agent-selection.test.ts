import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeAgentsForScope } from "../../agent-selection.ts";
import type { AgentConfig } from "../../agents.ts";

function makeAgent(name: string, source: "builtin" | "package" | "user" | "project", systemPrompt: string): AgentConfig {
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

	it("package agents override builtins with the same name", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const packageAgents = [makeAgent("scout", "package", "package prompt")];
		const result = mergeAgentsForScope("both", [], [], builtinAgents, packageAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "package");
		assert.equal(result[0]?.systemPrompt, "package prompt");
	});

	it("user agents override package agents with the same name", () => {
		const packageAgents = [makeAgent("scout", "package", "package prompt")];
		const userAgents = [makeAgent("scout", "user", "user prompt")];
		const result = mergeAgentsForScope("both", userAgents, [], [], packageAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
		assert.equal(result[0]?.systemPrompt, "user prompt");
	});

	it("priority order is builtin < package < user < project", () => {
		const builtin = [makeAgent("scout", "builtin", "builtin")];
		const pkg = [makeAgent("scout", "package", "package")];
		const user = [makeAgent("scout", "user", "user")];
		const project = [makeAgent("scout", "project", "project")];
		// All four compete — project wins
		const result = mergeAgentsForScope("both", user, project, builtin, pkg);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});

	it("package agents are visible in both scope when user/project have no override", () => {
		const packageAgents = [makeAgent("workflow-agent", "package", "workflow prompt")];
		const userAgents = [makeAgent("other", "user", "user prompt")];
		const result = mergeAgentsForScope("both", userAgents, [], [], packageAgents);
		assert.equal(result.length, 2);
		assert.ok(result.find((a) => a.name === "workflow-agent" && a.source === "package"));
		assert.ok(result.find((a) => a.name === "other" && a.source === "user"));
	});
});
