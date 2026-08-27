import type { WaitToolConfig } from "../../shared/types.ts";

export const WAIT_TOOL_ENABLED_ENV = "PI_SUBAGENT_WAIT_TOOL_ENABLED";
export const WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV = "PI_SUBAGENT_WAIT_TOOL_DEFAULT_TIMEOUT_MS";

export interface ResolvedWaitToolConfig {
	enabled: boolean;
	defaultTimeoutMs?: number;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function environmentValue(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	throw new Error(`${WAIT_TOOL_ENABLED_ENV} must be one of true/false, 1/0, yes/no, on/off, or enabled/disabled.`);
}

function environmentDefaultTimeoutMs(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV} must be a positive integer.`);
	return parsed;
}

function configuredValue(config: unknown): { enabled?: boolean; defaultTimeoutMs?: number } {
	if (config === undefined) return {};
	if (typeof config === "boolean") return { enabled: config };
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("config.waitTool must be a boolean or an object with optional enabled and defaultTimeoutMs values.");
	}
	const { enabled, defaultTimeoutMs } = config as { enabled?: unknown; defaultTimeoutMs?: unknown };
	if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("config.waitTool.enabled must be a boolean.");
	if (defaultTimeoutMs !== undefined && (!Number.isInteger(defaultTimeoutMs) || (defaultTimeoutMs as number) < 1)) {
		throw new Error("config.waitTool.defaultTimeoutMs must be a positive integer.");
	}
	return { enabled, ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs: defaultTimeoutMs as number } : {}) };
}

export function resolveWaitToolConfig(config?: WaitToolConfig, env: Record<string, string | undefined> = process.env): ResolvedWaitToolConfig {
	const configured = configuredValue(config);
	const envDefaultTimeoutMs = environmentDefaultTimeoutMs(env[WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV]);
	return {
		enabled: environmentValue(env[WAIT_TOOL_ENABLED_ENV]) ?? configured.enabled ?? true,
		...(envDefaultTimeoutMs ?? configured.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: envDefaultTimeoutMs ?? configured.defaultTimeoutMs } : {}),
	};
}
