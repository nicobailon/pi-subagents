import type { ResolvedToolBudget, ToolBudgetConfig, ToolBudgetState } from "../../shared/types.ts";

export const DEFAULT_TOOL_BUDGET_BLOCK = ["read", "grep", "find", "ls"] as const;
export const TOOL_BUDGET_ENV = "PI_SUBAGENT_TOOL_BUDGET";

export function normalizeToolBudgetBlock(block: ToolBudgetConfig["block"] | undefined): "*" | string[] {
	if (block === "*") return "*";
	if (block === undefined) return [...DEFAULT_TOOL_BUDGET_BLOCK];
	return [...new Set(block.map((tool) => tool.trim()).filter(Boolean))];
}

export function validateToolBudgetConfig(raw: unknown, label = "toolBudget"): { budget?: ResolvedToolBudget; error?: string } {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${label} must be an object with hard and optional soft/block.` };
	const value = raw as ToolBudgetConfig;
	if (typeof value.hard !== "number" || !Number.isInteger(value.hard) || value.hard < 1) {
		return { error: `${label}.hard must be an integer >= 1.` };
	}
	if (value.soft !== undefined && (typeof value.soft !== "number" || !Number.isInteger(value.soft) || value.soft < 1)) {
		return { error: `${label}.soft must be an integer >= 1 when provided.` };
	}
	if (value.soft !== undefined && value.soft > value.hard) {
		return { error: `${label}.soft must be <= ${label}.hard.` };
	}
	if (value.block !== undefined && value.block !== "*") {
		if (!Array.isArray(value.block)) return { error: `${label}.block must be "*" or an array of tool names.` };
		if (value.block.length === 0) return { error: `${label}.block must contain at least one tool name.` };
		for (const item of value.block) {
			if (typeof item !== "string" || !item.trim()) return { error: `${label}.block must contain non-empty tool names.` };
		}
	}
	return { budget: { hard: value.hard, ...(value.soft !== undefined ? { soft: value.soft } : {}), block: normalizeToolBudgetBlock(value.block) } };
}

export function initialToolBudgetState(budget: ResolvedToolBudget): ToolBudgetState {
	return { ...budget, toolCount: 0, outcome: "within-budget" };
}

export function toolBudgetState(budget: ResolvedToolBudget, toolCount: number, blockedTool?: string): ToolBudgetState {
	const overHard = toolCount > budget.hard;
	const overSoft = budget.soft !== undefined && toolCount >= budget.soft;
	return {
		...budget,
		toolCount,
		outcome: overHard ? "hard-blocked" : overSoft ? "soft-reached" : "within-budget",
		...(overSoft ? { softReachedAt: budget.soft } : {}),
		...(overHard ? { hardReachedAt: budget.hard, blockedTool } : {}),
	};
}

export function shouldBlockToolForBudget(budget: ResolvedToolBudget, toolName: string, nextToolCount: number): boolean {
	if (nextToolCount <= budget.hard) return false;
	return budget.block === "*" || budget.block.includes(toolName);
}

export function toolBudgetSoftNudge(budget: ResolvedToolBudget, toolCount: number): string {
	return `Tool budget soft limit reached after ${toolCount} tool call${toolCount === 1 ? "" : "s"} (soft ${budget.soft}, hard ${budget.hard}). Stop starting new browsing/search work and finalize from the context you already have.`;
}

export function toolBudgetBlockedMessage(budget: ResolvedToolBudget, toolName: string, toolCount: number): string {
	return `Tool budget hard limit reached after ${toolCount} tool call${toolCount === 1 ? "" : "s"} (hard ${budget.hard}). The '${toolName}' tool is blocked so you can finalize from the context you already have.`;
}

export function encodeToolBudgetEnv(budget: ResolvedToolBudget | undefined): string | undefined {
	return budget ? JSON.stringify(budget) : undefined;
}

export function decodeToolBudgetEnv(value: string | undefined): ResolvedToolBudget | undefined {
	if (!value?.trim()) return undefined;
	const parsed = JSON.parse(value) as unknown;
	const normalized = validateToolBudgetConfig(parsed, TOOL_BUDGET_ENV);
	if (normalized.error) throw new Error(normalized.error);
	return normalized.budget;
}
