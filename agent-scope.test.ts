import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveExecutionAgentScope } from "./agent-scope.ts";

describe("resolveExecutionAgentScope", () => {
	it("defaults to both when scope is omitted", () => {
		assert.equal(resolveExecutionAgentScope(undefined), "both");
	});

	it("passes through explicit scopes", () => {
		assert.equal(resolveExecutionAgentScope("user"), "user");
		assert.equal(resolveExecutionAgentScope("project"), "project");
		assert.equal(resolveExecutionAgentScope("both"), "both");
	});

	it("falls back to both for invalid scopes", () => {
		assert.equal(resolveExecutionAgentScope("invalid"), "both");
		assert.equal(resolveExecutionAgentScope(""), "both");
	});
});
