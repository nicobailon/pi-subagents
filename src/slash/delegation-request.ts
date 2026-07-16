import {
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	type SubagentDelegationRequest,
} from "../api/delegation.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";

export type SubagentDelegationParseResult =
	| { ok: true; request: SubagentDelegationRequest }
	| { ok: false; requestId?: string; error: string };

const supportedFields = new Set([
	"version",
	"requestId",
	"agent",
	"task",
	"context",
	"cwd",
	"model",
	"timeoutMs",
	"turnBudget",
	"toolBudget",
	"skill",
	"output",
	"outputMode",
	"acceptance",
	"artifacts",
]);

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateRequestId(value: unknown): string | undefined {
	if (!nonEmptyString(value) || value.length > 256 || /[\r\n]/.test(value)) return undefined;
	return value;
}

export function parseSubagentDelegationRequest(data: unknown): SubagentDelegationParseResult {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { ok: false, error: "Delegation request must be an object." };
	}
	const value = data as Record<string, unknown>;
	const requestId = validateRequestId(value.requestId);
	if (value.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION) {
		return {
			...(requestId ? { requestId } : {}),
			ok: false,
			error: `Unsupported delegation protocol version: ${String(value.version)}.`,
		};
	}
	if (!requestId) {
		return { ok: false, error: "Delegation requestId must be a non-empty string of at most 256 characters without newlines." };
	}
	const unsupportedField = Object.keys(value).find((key) => !supportedFields.has(key));
	if (unsupportedField) return { ok: false, requestId, error: `Unsupported delegation field: ${unsupportedField}.` };
	if (!nonEmptyString(value.agent)) return { ok: false, requestId, error: "Delegation agent must be a non-empty string." };
	if (!nonEmptyString(value.task)) return { ok: false, requestId, error: "Delegation task must be a non-empty string." };
	if (value.context !== "fresh" && value.context !== "fork") {
		return { ok: false, requestId, error: "Delegation context must be fresh or fork." };
	}
	if (!nonEmptyString(value.cwd)) return { ok: false, requestId, error: "Delegation cwd must be a non-empty string." };
	if (value.model !== undefined && !nonEmptyString(value.model)) {
		return { ok: false, requestId, error: "model must be a non-empty string when provided." };
	}
	if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1)) {
		return { ok: false, requestId, error: "timeoutMs must be an integer >= 1." };
	}
	const turnBudget = resolveTurnBudgetConfig(value.turnBudget);
	if (turnBudget.error) return { ok: false, requestId, error: turnBudget.error };
	if (value.toolBudget && typeof value.toolBudget === "object" && !Array.isArray(value.toolBudget)) {
		const unsupportedToolBudgetField = Object.keys(value.toolBudget).find((key) => key !== "soft" && key !== "hard" && key !== "block");
		if (unsupportedToolBudgetField) {
			return { ok: false, requestId, error: `toolBudget.${unsupportedToolBudgetField} is not supported.` };
		}
	}
	const toolBudget = validateToolBudgetConfig(value.toolBudget);
	if (toolBudget.error) return { ok: false, requestId, error: toolBudget.error };
	if (value.skill !== undefined) {
		const validSkill = typeof value.skill === "boolean"
			|| nonEmptyString(value.skill)
			|| (Array.isArray(value.skill) && value.skill.length > 0 && value.skill.every(nonEmptyString));
		if (!validSkill) {
			return { ok: false, requestId, error: "skill must be a boolean, non-empty string, or non-empty string array." };
		}
	}
	if (value.output !== undefined && typeof value.output !== "boolean" && !nonEmptyString(value.output)) {
		return { ok: false, requestId, error: "output must be a boolean or non-empty string." };
	}
	if (value.outputMode !== undefined && value.outputMode !== "inline" && value.outputMode !== "file-only") {
		return { ok: false, requestId, error: "outputMode must be inline or file-only." };
	}
	if (value.outputMode === "file-only" && !nonEmptyString(value.output)) {
		return { ok: false, requestId, error: 'outputMode "file-only" requires output to be a non-empty path.' };
	}
	const acceptanceErrors = validateAcceptanceInput(value.acceptance);
	if (acceptanceErrors.length > 0) return { ok: false, requestId, error: acceptanceErrors.join(" ") };
	if (value.artifacts !== undefined && typeof value.artifacts !== "boolean") {
		return { ok: false, requestId, error: "artifacts must be a boolean." };
	}
	return { ok: true, request: value as unknown as SubagentDelegationRequest };
}
