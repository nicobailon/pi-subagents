import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAuthorityDecision, validateAuthorityPolicy } from "../../src/policy/authority.ts";

describe("authority policy", () => {
	it("uses conservative cleanup and spawn defaults without obstructing normal control", () => {
		assert.equal(resolveAuthorityDecision({ action: "discardWorktree" }), "confirm");
		assert.equal(resolveAuthorityDecision({ action: "destructiveCleanup" }), "confirm");
		assert.equal(resolveAuthorityDecision({ action: "spawnBudgetGrant" }), "confirm");
		assert.equal(resolveAuthorityDecision({ action: "scheduleCreate" }), "auto");
		assert.equal(resolveAuthorityDecision({ action: "stopRun" }), "auto");
		assert.equal(resolveAuthorityDecision({ action: "steerRun" }), "auto");
	});

	it("confirms project panes that spawn an unchecked host and leaves plugin-gated inspectors automatic", () => {
		assert.equal(resolveAuthorityDecision({ action: "inspectorOpen" }), "auto");
		assert.equal(resolveAuthorityDecision({ action: "projectOpen" }), "confirm");
		const policy = validateAuthorityPolicy({ inspectorOpen: "forbid", projectOpen: "auto" });
		assert.equal(resolveAuthorityDecision({ action: "inspectorOpen", policy }), "forbid");
		assert.equal(resolveAuthorityDecision({ action: "projectOpen", policy }), "auto");
	});

	it("accepts only fixed actions and decisions", () => {
		const policy = validateAuthorityPolicy({ discardWorktree: "forbid", stopRun: "confirm" });
		assert.equal(resolveAuthorityDecision({ action: "discardWorktree", policy }), "forbid");
		assert.equal(resolveAuthorityDecision({ action: "stopRun", policy }), "confirm");
		assert.throws(() => validateAuthorityPolicy({ mergePullRequest: "auto" }), /unknown/);
		assert.throws(() => validateAuthorityPolicy({ discardWorktree: "sometimes" }), /auto.*confirm.*forbid/);
	});
});
