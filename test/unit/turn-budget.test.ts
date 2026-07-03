import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedTurnBudget, TurnBudgetState } from "../../src/shared/types.ts";
import {
	DEFAULT_TURN_BUDGET_GRACE_TURNS,
	appendTurnBudgetSystemPrompt,
	formatTurnBudgetOutput,
	initialTurnBudgetState,
	shouldAbortForTurnBudget,
	turnBudgetExceededMessage,
	turnBudgetSoftNote,
	turnBudgetState,
} from "../../src/runs/shared/turn-budget.ts";

function budget(overrides: Partial<ResolvedTurnBudget> = {}): ResolvedTurnBudget {
	return { maxTurns: 3, graceTurns: 1, ...overrides };
}

describe("turn-budget module", () => {
	describe("DEFAULT_TURN_BUDGET_GRACE_TURNS", () => {
		it("defaults to one grace turn", () => {
			assert.equal(DEFAULT_TURN_BUDGET_GRACE_TURNS, 1);
		});
	});

	describe("appendTurnBudgetSystemPrompt", () => {
		it("returns the system prompt unchanged when no budget is configured", () => {
			assert.equal(appendTurnBudgetSystemPrompt("You are a reviewer.", undefined), "You are a reviewer.");
			assert.equal(appendTurnBudgetSystemPrompt("", undefined), "");
		});

		it("appends a turn-budget block after an existing system prompt", () => {
			const result = appendTurnBudgetSystemPrompt("You are a reviewer.", budget({ maxTurns: 5, graceTurns: 2 }));
			assert.ok(result.startsWith("You are a reviewer.\n\n## Turn budget\n"), result);
			assert.match(result, /soft budget of 5 assistant turns/);
			assert.match(result, /2 additional assistant turns/);
		});

		it("emits only the turn-budget block when the system prompt is empty", () => {
			const result = appendTurnBudgetSystemPrompt("   ", budget({ maxTurns: 5, graceTurns: 1 }));
			assert.ok(result.startsWith("## Turn budget\n"), result);
			assert.equal(result.includes("You are"), false);
		});

		it("trims surrounding whitespace from the existing system prompt before joining", () => {
			const result = appendTurnBudgetSystemPrompt("\nYou are a reviewer.\n\n", budget());
			assert.ok(result.startsWith("You are a reviewer.\n\n## Turn budget\n"), result);
			assert.equal(result.startsWith("\n"), false);
		});

		it("pluralizes maxTurns for single and multiple turns", () => {
			assert.match(appendTurnBudgetSystemPrompt("", budget({ maxTurns: 1 })), /soft budget of 1 assistant turn\./);
			assert.match(appendTurnBudgetSystemPrompt("", budget({ maxTurns: 4 })), /soft budget of 4 assistant turns\./);
		});

		it("pluralizes graceTurns for one versus many or zero", () => {
			assert.match(appendTurnBudgetSystemPrompt("", budget({ graceTurns: 1 })), /1 additional assistant turn may be allowed/);
			assert.match(appendTurnBudgetSystemPrompt("", budget({ graceTurns: 0 })), /0 additional assistant turns may be allowed/);
			assert.match(appendTurnBudgetSystemPrompt("", budget({ graceTurns: 3 })), /3 additional assistant turns may be allowed/);
		});
	});

	describe("turnBudgetSoftNote", () => {
		it("describes the wrap-up request with soft limit and grace values", () => {
			assert.equal(
				turnBudgetSoftNote(budget({ maxTurns: 3, graceTurns: 1 }), 3),
				"Turn budget wrap-up was requested after 3 assistant turns (soft limit 3, grace 1). Process-mode live steering is unavailable, so the child was warned at launch to wrap up by this budget. Output may be partial.",
			);
		});

		it("pluralizes the turn count", () => {
			assert.match(turnBudgetSoftNote(budget(), 1), /requested after 1 assistant turn\b/);
			assert.match(turnBudgetSoftNote(budget(), 5), /requested after 5 assistant turns\b/);
		});
	});

	describe("turnBudgetExceededMessage", () => {
		it("describes the hard abort with soft limit plus grace", () => {
			assert.equal(
				turnBudgetExceededMessage(budget({ maxTurns: 3, graceTurns: 1 }), 4),
				"Subagent exceeded turn budget after 4 assistant turns (soft limit 3 + grace 1).",
			);
		});

		it("pluralizes the turn count", () => {
			assert.match(turnBudgetExceededMessage(budget(), 1), /after 1 assistant turn\b/);
			assert.match(turnBudgetExceededMessage(budget(), 3), /after 3 assistant turns\b/);
		});
	});

	describe("formatTurnBudgetOutput", () => {
		it("prefixes the abort message onto captured partial output", () => {
			assert.equal(
				formatTurnBudgetOutput("ABORT", "partial work"),
				"ABORT\n\nPartial output before turn-budget abort:\npartial work",
			);
		});

		it("preserves multi-line partial output verbatim", () => {
			assert.equal(
				formatTurnBudgetOutput("ABORT", "line1\nline2\nline3"),
				"ABORT\n\nPartial output before turn-budget abort:\nline1\nline2\nline3",
			);
		});

		it("returns only the message when there is no partial output", () => {
			assert.equal(formatTurnBudgetOutput("ABORT", ""), "ABORT");
			assert.equal(formatTurnBudgetOutput("ABORT", "  \n  "), "ABORT");
		});
	});

	describe("initialTurnBudgetState", () => {
		it("starts within budget at turn zero and copies the resolved budget", () => {
			const state = initialTurnBudgetState(budget({ maxTurns: 5, graceTurns: 2 }));
			const expected: TurnBudgetState = { maxTurns: 5, graceTurns: 2, outcome: "within-budget", turnCount: 0 };
			assert.deepEqual(state, expected);
			assert.equal("wrapUpRequestedAtTurn" in state, false);
			assert.equal("exceededAtTurn" in state, false);
		});
	});

	describe("turnBudgetState", () => {
		it("marks a wrap-up request without recording an exceeded turn", () => {
			const state = turnBudgetState(budget({ maxTurns: 3, graceTurns: 1 }), 3, false);
			assert.deepEqual(state, {
				maxTurns: 3,
				graceTurns: 1,
				turnCount: 3,
				outcome: "wrap-up-requested",
				wrapUpRequestedAtTurn: 3,
			});
			assert.equal("exceededAtTurn" in state, false);
		});

		it("marks an exceeded budget and records the turn where it happened", () => {
			const state = turnBudgetState(budget({ maxTurns: 3, graceTurns: 1 }), 4, true);
			assert.deepEqual(state, {
				maxTurns: 3,
				graceTurns: 1,
				turnCount: 4,
				outcome: "exceeded",
				wrapUpRequestedAtTurn: 3,
				exceededAtTurn: 4,
			});
		});

		it("records the wrap-up request at the soft-limit turn even when exceeded", () => {
			const state = turnBudgetState(budget({ maxTurns: 2, graceTurns: 0 }), 2, true);
			assert.equal(state.wrapUpRequestedAtTurn, 2);
			assert.equal(state.exceededAtTurn, 2);
			assert.equal(state.outcome, "exceeded");
		});
	});

	describe("shouldAbortForTurnBudget", () => {
		it("allows a terminal assistant response on the final grace turn", () => {
			assert.equal(shouldAbortForTurnBudget(budget({ maxTurns: 3, graceTurns: 1 }), 4, true), false);
		});

		it("aborts a non-terminal assistant response on the final grace turn", () => {
			assert.equal(shouldAbortForTurnBudget(budget({ maxTurns: 3, graceTurns: 1 }), 4, false), true);
		});

		it("aborts turns beyond the grace window even if the message is terminal", () => {
			assert.equal(shouldAbortForTurnBudget(budget({ maxTurns: 3, graceTurns: 1 }), 5, true), true);
		});

		it("allows a terminal response at the soft limit when grace turns are zero", () => {
			assert.equal(shouldAbortForTurnBudget(budget({ maxTurns: 2, graceTurns: 0 }), 2, true), false);
			assert.equal(shouldAbortForTurnBudget(budget({ maxTurns: 2, graceTurns: 0 }), 2, false), true);
		});
	});

	describe("turn budget state transitions", () => {
		it("walks within-budget -> wrap-up-requested -> exceeded as turns accrue", () => {
			const resolved = budget({ maxTurns: 3, graceTurns: 1 });

			const start = initialTurnBudgetState(resolved);
			assert.equal(start.outcome, "within-budget");
			assert.equal(start.turnCount, 0);

			const warning = turnBudgetState(resolved, resolved.maxTurns, false);
			assert.equal(warning.outcome, "wrap-up-requested");
			assert.equal(warning.turnCount, resolved.maxTurns);
			assert.equal(warning.wrapUpRequestedAtTurn, resolved.maxTurns);
			assert.equal("exceededAtTurn" in warning, false);

			const exceeded = turnBudgetState(resolved, resolved.maxTurns + resolved.graceTurns, true);
			assert.equal(exceeded.outcome, "exceeded");
			assert.equal(exceeded.turnCount, resolved.maxTurns + resolved.graceTurns);
			assert.equal(exceeded.exceededAtTurn, resolved.maxTurns + resolved.graceTurns);
			assert.equal(exceeded.wrapUpRequestedAtTurn, resolved.maxTurns);
		});

		it("can represent immediate exceedance when grace turns are zero", () => {
			const resolved = budget({ maxTurns: 2, graceTurns: 0 });
			const exceeded = turnBudgetState(resolved, resolved.maxTurns, true);
			assert.equal(exceeded.outcome, "exceeded");
			assert.equal(exceeded.exceededAtTurn, resolved.maxTurns);
		});
	});
});
