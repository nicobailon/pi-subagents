import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_TOOL_BUDGET_BLOCK,
	decodeToolBudgetEnv,
	encodeToolBudgetEnv,
	initialToolBudgetState,
	shouldBlockToolForBudget,
	toolBudgetBlockedMessage,
	toolBudgetSoftNudge,
	toolBudgetState,
	validateToolBudgetConfig,
} from "../../src/runs/shared/tool-budget.ts";

describe("tool-budget module", () => {
	it("defaults block tools to read/search tools", () => {
		const resolved = validateToolBudgetConfig({ hard: 5 });
		assert.deepEqual(resolved.budget, { hard: 5, block: [...DEFAULT_TOOL_BUDGET_BLOCK] });
	});

	it("accepts soft and wildcard block", () => {
		const resolved = validateToolBudgetConfig({ soft: 2, hard: 4, block: "*" });
		assert.deepEqual(resolved.budget, { soft: 2, hard: 4, block: "*" });
	});

	it("rejects unsafe configs", () => {
		assert.equal(validateToolBudgetConfig({ hard: 0 }).error, "toolBudget.hard must be an integer >= 1.");
		assert.equal(validateToolBudgetConfig({ soft: 5, hard: 4 }).error, "toolBudget.soft must be <= toolBudget.hard.");
		assert.equal(validateToolBudgetConfig({ hard: 4, block: [] }).error, "toolBudget.block must contain at least one tool name.");
		assert.equal(validateToolBudgetConfig({ hard: 4, block: [""] }).error, "toolBudget.block must contain non-empty tool names.");
	});

	it("serializes and decodes env config", () => {
		const budget = { soft: 2, hard: 4, block: ["read"] };
		assert.deepEqual(decodeToolBudgetEnv(encodeToolBudgetEnv(budget)), budget);
	});

	it("tracks state and block decisions", () => {
		const budget = { soft: 2, hard: 3, block: ["read"] };
		assert.deepEqual(initialToolBudgetState(budget), { soft: 2, hard: 3, block: ["read"], toolCount: 0, outcome: "within-budget" });
		assert.equal(toolBudgetState(budget, 2).outcome, "soft-reached");
		assert.equal(toolBudgetState(budget, 4, "read").outcome, "hard-blocked");
		assert.equal(shouldBlockToolForBudget(budget, "read", 4), true);
		assert.equal(shouldBlockToolForBudget(budget, "write", 4), false);
	});

	it("formats user-facing budget messages", () => {
		const budget = { soft: 2, hard: 3, block: ["read"] };
		assert.match(toolBudgetSoftNudge(budget, 2), /soft limit reached after 2 tool calls/);
		assert.match(toolBudgetBlockedMessage(budget, "read", 4), /'read' tool is blocked/);
	});
});
