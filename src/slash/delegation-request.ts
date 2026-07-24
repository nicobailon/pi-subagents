import {
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
	type SubagentDelegationRequest,
	type SubagentDelegationV2Request,
} from "../api/delegation.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";
import { cloneJsonWithinByteLimit } from "./delegation-json.ts";

export type SubagentDelegationParseResult =
	| { ok: true; request: SubagentDelegationRequest | SubagentDelegationV2Request }
	| { ok: false; version?: 1 | 2; requestId?: string; ownerRunId?: string; nodeId?: string; error: string };

const v1SupportedFields = new Set([
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
	"outputSchema",
	"agentContract",
	"acceptance",
	"artifacts",
]);

const v2SupportedFields = new Set([
	"version",
	"requestId",
	"ownerRunId",
	"nodeId",
	"agent",
	"task",
	"context",
	"cwd",
	"model",
	"thinking",
	"timeoutMs",
	"turnBudget",
	"toolBudget",
	"skill",
	"artifacts",
	"result",
]);

const v2ThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_V2_TASK_BYTES = 1024 * 1024;
const MAX_V2_CWD_BYTES = 32 * 1024;
const MAX_V2_SHORT_TEXT_BYTES = 1024;
const MAX_V2_SKILL_ENTRIES = 256;
const MAX_V2_SKILL_AGGREGATE_BYTES = 64 * 1024;

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateId(value: unknown): string | undefined {
	if (!nonEmptyString(value) || value.length > 256 || /[\r\n]/.test(value)) return undefined;
	return value;
}

function validateSharedFields(
	value: Record<string, unknown>,
	identity: { requestId: string; version?: 1 | 2; ownerRunId?: string; nodeId?: string },
): SubagentDelegationParseResult | undefined {
	if (!nonEmptyString(value.agent)) return { ok: false, ...identity, error: "Delegation agent must be a non-empty string." };
	if (!nonEmptyString(value.task)) return { ok: false, ...identity, error: "Delegation task must be a non-empty string." };
	if (value.context !== "fresh" && value.context !== "fork") {
		return { ok: false, ...identity, error: "Delegation context must be fresh or fork." };
	}
	if (!nonEmptyString(value.cwd)) return { ok: false, ...identity, error: "Delegation cwd must be a non-empty string." };
	if (value.model !== undefined && !nonEmptyString(value.model)) {
		return { ok: false, ...identity, error: "model must be a non-empty string when provided." };
	}
	if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1)) {
		return { ok: false, ...identity, error: "timeoutMs must be an integer >= 1." };
	}
	if (identity.version === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION && value.timeoutMs !== undefined && value.timeoutMs > 2_147_483_647) {
		return { ok: false, ...identity, error: "timeoutMs must be <= 2147483647 for delegation v2." };
	}
	const turnBudget = resolveTurnBudgetConfig(value.turnBudget);
	if (turnBudget.error) return { ok: false, ...identity, error: turnBudget.error };
	if (value.toolBudget && typeof value.toolBudget === "object" && !Array.isArray(value.toolBudget)) {
		const unsupportedToolBudgetField = Object.keys(value.toolBudget).find((key) => key !== "soft" && key !== "hard" && key !== "block");
		if (unsupportedToolBudgetField) {
			return { ok: false, ...identity, error: `toolBudget.${unsupportedToolBudgetField} is not supported.` };
		}
	}
	const toolBudget = validateToolBudgetConfig(
		value.toolBudget,
		"toolBudget",
		identity.version === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION ? { minimumHard: 0 } : undefined,
	);
	if (toolBudget.error) return { ok: false, ...identity, error: toolBudget.error };
	if (value.skill !== undefined) {
		const validSkill = typeof value.skill === "boolean"
			|| nonEmptyString(value.skill)
			|| (Array.isArray(value.skill) && value.skill.length > 0 && value.skill.every(nonEmptyString));
		if (!validSkill) {
			return { ok: false, ...identity, error: "skill must be a boolean, non-empty string, or non-empty string array." };
		}
	}
	if (value.artifacts !== undefined && typeof value.artifacts !== "boolean") {
		return { ok: false, ...identity, error: "artifacts must be a boolean." };
	}
	return undefined;
}

function parseV2(value: Record<string, unknown>, requestId: string): SubagentDelegationParseResult {
	const ownerRunId = validateId(value.ownerRunId);
	if (!ownerRunId) {
		return { ok: false, version: 2, requestId, error: "Delegation ownerRunId must be a non-empty string of at most 256 characters without newlines." };
	}
	const nodeId = validateId(value.nodeId);
	if (!nodeId) {
		return { ok: false, version: 2, requestId, ownerRunId, error: "Delegation nodeId must be a non-empty string of at most 256 characters without newlines." };
	}
	const identity = { version: 2 as const, requestId, ownerRunId, nodeId };
	const unsupportedField = Object.keys(value).find((key) => !v2SupportedFields.has(key));
	if (unsupportedField) return { ok: false, ...identity, error: `Unsupported delegation field: ${unsupportedField}.` };
	const sharedError = validateSharedFields(value, identity);
	if (sharedError) return sharedError;
	if (Buffer.byteLength(value.task as string, "utf8") > MAX_V2_TASK_BYTES) {
		return { ok: false, ...identity, error: "Delegation task exceeds 1 MiB when UTF-8 encoded." };
	}
	if (Buffer.byteLength(value.cwd as string, "utf8") > MAX_V2_CWD_BYTES) {
		return { ok: false, ...identity, error: "Delegation cwd exceeds 32 KiB when UTF-8 encoded." };
	}
	if (Buffer.byteLength(value.agent as string, "utf8") > MAX_V2_SHORT_TEXT_BYTES) {
		return { ok: false, ...identity, error: "Delegation agent exceeds 1 KiB when UTF-8 encoded." };
	}
	if (typeof value.model === "string" && Buffer.byteLength(value.model, "utf8") > MAX_V2_SHORT_TEXT_BYTES) {
		return { ok: false, ...identity, error: "Delegation model exceeds 1 KiB when UTF-8 encoded." };
	}
	const skillEntries = typeof value.skill === "string" ? [value.skill] : Array.isArray(value.skill) ? value.skill as string[] : [];
	if (skillEntries.length > MAX_V2_SKILL_ENTRIES) {
		return { ok: false, ...identity, error: "Delegation skill supports at most 256 entries." };
	}
	if (skillEntries.some((entry) => Buffer.byteLength(entry, "utf8") > MAX_V2_SHORT_TEXT_BYTES)) {
		return { ok: false, ...identity, error: "Delegation skill entry exceeds 1 KiB when UTF-8 encoded." };
	}
	if (skillEntries.reduce((total, entry) => total + Buffer.byteLength(entry, "utf8"), 0) > MAX_V2_SKILL_AGGREGATE_BYTES) {
		return { ok: false, ...identity, error: "Delegation skill entries exceed 64 KiB in aggregate when UTF-8 encoded." };
	}
	if (value.thinking !== undefined && (typeof value.thinking !== "string" || !v2ThinkingLevels.has(value.thinking))) {
		return { ok: false, ...identity, error: "thinking must be one of off, minimal, low, medium, high, xhigh, or max." };
	}
	if (!value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
		return { ok: false, ...identity, error: "result must be { kind: \"text\" } or { kind: \"structured\", schema: object }." };
	}
	const result = value.result as Record<string, unknown>;
	let structuredSchema: Record<string, unknown> | undefined;
	if (result.kind === "text") {
		const unsupportedResultField = Object.keys(result).find((key) => key !== "kind");
		if (unsupportedResultField) return { ok: false, ...identity, error: `result.${unsupportedResultField} is not supported for text results.` };
	} else if (result.kind === "structured") {
		const unsupportedResultField = Object.keys(result).find((key) => key !== "kind" && key !== "schema");
		if (unsupportedResultField) return { ok: false, ...identity, error: `result.${unsupportedResultField} is not supported for structured results.` };
		if (!result.schema || typeof result.schema !== "object" || Array.isArray(result.schema)) {
			return { ok: false, ...identity, error: "result.schema must be a JSON Schema object." };
		}
		const inspectedSchema = cloneJsonWithinByteLimit(result.schema, MAX_SCHEMA_BYTES);
		if (!inspectedSchema.ok) {
			return {
				ok: false,
				...identity,
				error: inspectedSchema.reason === "too_large"
					? "result.schema exceeds 64 KiB when encoded."
					: "result.schema must be plain JSON data.",
			};
		}
		structuredSchema = inspectedSchema.value as Record<string, unknown>;
	} else {
		return { ok: false, ...identity, error: "result.kind must be text or structured." };
	}
	return {
		ok: true,
		request: {
			...value,
			result: structuredSchema
				? { kind: "structured", schema: structuredSchema }
				: { kind: "text" },
		} as unknown as SubagentDelegationV2Request,
	};
}

function parseV1(value: Record<string, unknown>, requestId: string): SubagentDelegationParseResult {
	const unsupportedField = Object.keys(value).find((key) => !v1SupportedFields.has(key));
	if (unsupportedField) return { ok: false, requestId, error: `Unsupported delegation field: ${unsupportedField}.` };
	const sharedError = validateSharedFields(value, { requestId });
	if (sharedError) return sharedError;
	if (value.output !== undefined && typeof value.output !== "boolean" && !nonEmptyString(value.output)) {
		return { ok: false, requestId, error: "output must be a boolean or non-empty string." };
	}
	if (value.outputMode !== undefined && value.outputMode !== "inline" && value.outputMode !== "file-only") {
		return { ok: false, requestId, error: "outputMode must be inline or file-only." };
	}
	if (value.outputMode === "file-only" && !nonEmptyString(value.output)) {
		return { ok: false, requestId, error: 'outputMode "file-only" requires output to be a non-empty path.' };
	}
	if (value.outputSchema !== undefined && (!value.outputSchema || typeof value.outputSchema !== "object" || Array.isArray(value.outputSchema))) {
		return { ok: false, requestId, error: "outputSchema must be a JSON Schema object." };
	}
	if (value.agentContract !== undefined) {
		if (!value.agentContract || typeof value.agentContract !== "object" || Array.isArray(value.agentContract)) return { ok: false, requestId, error: "agentContract must be an object." };
		const contract = value.agentContract as Record<string, unknown>;
		if (contract.version !== 1 || Object.keys(contract).some((key) => key !== "version")) return { ok: false, requestId, error: "agentContract must be { version: 1 }." };
	}
	const acceptanceErrors = validateAcceptanceInput(value.acceptance);
	if (acceptanceErrors.length > 0) return { ok: false, requestId, error: acceptanceErrors.join(" ") };
	return { ok: true, request: value as unknown as SubagentDelegationRequest };
}

export function parseSubagentDelegationRequest(data: unknown): SubagentDelegationParseResult {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { ok: false, error: "Delegation request must be an object." };
	}
	const value = data as Record<string, unknown>;
	const requestId = validateId(value.requestId);
	if (value.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION && value.version !== SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION) {
		return {
			...(requestId ? { requestId } : {}),
			ok: false,
			error: `Unsupported delegation protocol version: ${String(value.version)}.`,
		};
	}
	if (!requestId) {
		return { ok: false, error: "Delegation requestId must be a non-empty string of at most 256 characters without newlines." };
	}
	if (value.version === SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION) {
		// Preserve the v1 parser's historical diagnostic for a v1-shaped payload
		// whose version alone was changed to 2.
		if (!Object.hasOwn(value, "ownerRunId") && !Object.hasOwn(value, "nodeId") && !Object.hasOwn(value, "result")) {
			return { ok: false, version: 2, requestId, error: "Unsupported delegation protocol version: 2." };
		}
		return parseV2(value, requestId);
	}
	return parseV1(value, requestId);
}
