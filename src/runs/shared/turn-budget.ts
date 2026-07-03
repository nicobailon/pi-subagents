import type { ResolvedTurnBudget, TurnBudgetState } from "../../shared/types.ts";

export const DEFAULT_TURN_BUDGET_GRACE_TURNS = 1;

export function appendTurnBudgetSystemPrompt(systemPrompt: string, budget: ResolvedTurnBudget | undefined): string {
	if (!budget) return systemPrompt;
	const grace = budget.graceTurns === 1 ? "1 additional assistant turn" : `${budget.graceTurns} additional assistant turns`;
	const block = [
		"## Turn budget",
		`This child run has a soft budget of ${budget.maxTurns} assistant turn${budget.maxTurns === 1 ? "" : "s"}.`,
		`After that, ${grace} may be allowed only for a final wrap-up.`,
		"When you approach or reach the soft budget, stop starting new tool work and return the final answer immediately.",
		"This runner uses process-mode execution, so live steering after launch may be unavailable; treat this instruction as the wrap-up request.",
		"If you continue past the soft budget plus grace turns, the supervisor may abort the process and return only partial output.",
	].join("\n");
	return systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${block}` : block;
}

export function turnBudgetSoftNote(budget: ResolvedTurnBudget, turnCount: number): string {
	return `Turn budget wrap-up was requested after ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns}, grace ${budget.graceTurns}). Process-mode live steering is unavailable, so the child was warned at launch to wrap up by this budget. Output may be partial.`;
}

export function turnBudgetExceededMessage(budget: ResolvedTurnBudget, turnCount: number): string {
	return `Subagent exceeded turn budget after ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns} + grace ${budget.graceTurns}).`;
}

export function formatTurnBudgetOutput(message: string, output: string): string {
	return output.trim()
		? `${message}\n\nPartial output before turn-budget abort:\n${output}`
		: message;
}

export function initialTurnBudgetState(budget: ResolvedTurnBudget): TurnBudgetState {
	return { ...budget, outcome: "within-budget", turnCount: 0 };
}

export function turnBudgetState(budget: ResolvedTurnBudget, turnCount: number, exceeded: boolean): TurnBudgetState {
	return {
		...budget,
		turnCount,
		outcome: exceeded ? "exceeded" : "wrap-up-requested",
		wrapUpRequestedAtTurn: budget.maxTurns,
		...(exceeded ? { exceededAtTurn: turnCount } : {}),
	};
}

export function shouldAbortForTurnBudget(budget: ResolvedTurnBudget, turnCount: number, terminalAssistantStop: boolean): boolean {
	const hardLimit = budget.maxTurns + budget.graceTurns;
	if (turnCount < hardLimit) return false;
	if (turnCount > hardLimit) return true;
	return !terminalAssistantStop;
}
