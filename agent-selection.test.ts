import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeAgentsForScope } from "./agent-selection.ts";

type TestAgent = {
	name: string;
	source: "user" | "project";
	systemPrompt: string;
};

function makeAgent(name: string, source: "user" | "project", systemPrompt: string): TestAgent {
	return { name, source, systemPrompt };
}

describe("mergeAgentsForScope", () => {
	it("returns project agents when scope is project", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("project", userAgents as any, projectAgents as any);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});

	it("returns user agents when scope is user", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("user", userAgents as any, projectAgents as any);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
	});

	it("prefers project agents on name collisions when scope is both", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents as any, projectAgents as any);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
		assert.equal(result[0]?.systemPrompt, "project prompt");
	});

	it("keeps agents from both scopes when names are distinct", () => {
		const userAgents = [makeAgent("user-only", "user", "user prompt")];
		const projectAgents = [makeAgent("project-only", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents as any, projectAgents as any);
		assert.equal(result.length, 2);
		assert.ok(result.find((a) => a.name === "user-only" && a.source === "user"));
		assert.ok(result.find((a) => a.name === "project-only" && a.source === "project"));
	});
});
