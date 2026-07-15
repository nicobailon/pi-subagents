export const SUBAGENT_DELEGATION_REQUEST_EVENT = "subagent:delegation:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "subagent:delegation:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT = "subagent:delegation:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "subagent:delegation:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "subagent:delegation:cancel";

const supportedFields = new Set([
	"version",
	"requestId",
	"agent",
	"task",
	"context",
	"cwd",
	"model",
	"timeoutMs",
	"maxRuntimeMs",
	"turnBudget",
	"toolBudget",
	"skill",
	"output",
	"outputMode",
	"acceptance",
	"artifacts",
]);

function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function optionalString(value) {
	return value === undefined || nonEmptyString(value);
}

function validateTurnBudget(value) {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return "turnBudget must be an object.";
	if (!positiveInteger(value.maxTurns)) return "turnBudget.maxTurns must be a positive integer.";
	if (value.graceTurns !== undefined && (!Number.isInteger(value.graceTurns) || value.graceTurns < 0)) {
		return "turnBudget.graceTurns must be a non-negative integer.";
	}
	return undefined;
}

function validateToolBudget(value) {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return "toolBudget must be an object.";
	if (!positiveInteger(value.hard)) return "toolBudget.hard must be a positive integer.";
	if (value.soft !== undefined && (!positiveInteger(value.soft) || value.soft > value.hard)) {
		return "toolBudget.soft must be a positive integer no greater than toolBudget.hard.";
	}
	if (value.block !== undefined && value.block !== "*" && (!Array.isArray(value.block) || !value.block.every(nonEmptyString))) {
		return 'toolBudget.block must be "*" or an array of non-empty tool names.';
	}
	return undefined;
}

function validateOptionalFields(value) {
	if (!optionalString(value.model)) return "model must be a non-empty string when provided.";
	for (const name of ["timeoutMs", "maxRuntimeMs"]) {
		if (value[name] !== undefined && !positiveInteger(value[name])) return `${name} must be a positive integer.`;
	}
	if (value.timeoutMs !== undefined && value.maxRuntimeMs !== undefined && value.timeoutMs !== value.maxRuntimeMs) {
		return "timeoutMs and maxRuntimeMs are aliases; provide one or use the same value for both.";
	}
	const turnBudgetError = validateTurnBudget(value.turnBudget);
	if (turnBudgetError) return turnBudgetError;
	const toolBudgetError = validateToolBudget(value.toolBudget);
	if (toolBudgetError) return toolBudgetError;
	if (value.skill !== undefined) {
		const validSkill = typeof value.skill === "boolean" || nonEmptyString(value.skill) ||
			(Array.isArray(value.skill) && value.skill.length > 0 && value.skill.every(nonEmptyString));
		if (!validSkill) return "skill must be a boolean, non-empty string, or non-empty string array.";
	}
	if (value.output !== undefined && typeof value.output !== "boolean" && !nonEmptyString(value.output)) {
		return "output must be a boolean or non-empty string.";
	}
	if (value.outputMode !== undefined && value.outputMode !== "inline" && value.outputMode !== "file-only") {
		return "outputMode must be inline or file-only.";
	}
	if (value.acceptance !== undefined) {
		const levels = new Set(["auto", "attested", "checked", "verified"]);
		const validAcceptance = value.acceptance === false || levels.has(value.acceptance) ||
			(!!value.acceptance && typeof value.acceptance === "object" && !Array.isArray(value.acceptance));
		if (!validAcceptance) return "acceptance must be a supported level, false, or an object.";
	}
	if (value.artifacts !== undefined && typeof value.artifacts !== "boolean") return "artifacts must be a boolean.";
	return undefined;
}

export function parseSubagentDelegationRequest(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { ok: false, error: "Delegation request must be an object." };
	}
	const requestId = nonEmptyString(data.requestId) ? data.requestId : undefined;
	if (data.version !== 1) {
		return {
			ok: false,
			...(requestId ? { requestId } : {}),
			error: `Unsupported delegation protocol version: ${String(data.version)}.`,
		};
	}
	if (!requestId) return { ok: false, error: "Delegation requestId must be a non-empty string." };
	if (!nonEmptyString(data.agent)) return { ok: false, requestId, error: "Delegation agent must be a non-empty string." };
	if (!nonEmptyString(data.task)) return { ok: false, requestId, error: "Delegation task must be a non-empty string." };
	if (data.context !== "fresh" && data.context !== "fork") {
		return { ok: false, requestId, error: "Delegation context must be fresh or fork." };
	}
	if (!nonEmptyString(data.cwd)) return { ok: false, requestId, error: "Delegation cwd must be a non-empty string." };
	const unsupportedField = Object.keys(data).find((key) => !supportedFields.has(key));
	if (unsupportedField) return { ok: false, requestId, error: `Unsupported delegation field: ${unsupportedField}.` };
	const optionalFieldError = validateOptionalFields(data);
	if (optionalFieldError) return { ok: false, requestId, error: optionalFieldError };
	return { ok: true, request: data };
}
