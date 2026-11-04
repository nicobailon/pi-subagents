import type { WaitToolConfig } from "../../shared/types.ts";
import { DEFAULT_WAIT_TOOL_NAME } from "../../shared/wait-tool-name.ts";

export const WAIT_TOOL_ENABLED_ENV = "PI_SUBAGENT_WAIT_TOOL_ENABLED";
export const WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV = "PI_SUBAGENT_WAIT_TOOL_DEFAULT_TIMEOUT_MS";

export interface ResolvedWaitToolConfig {
	enabled: boolean;
	defaultTimeoutMs?: number;
	/** Set only when it differs from bg_wait, so default launch configs are unchanged. */
	name?: string;
}

const WAIT_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Tools pi-subagents itself registers; a wait tool under one of these names would collide with it.
const RESERVED_TOOL_NAMES = new Set(["subagent", "subagents_enable", "subagent_supervisor", "contact_supervisor", "intercom", "structured_output", "subagent_launch", "subagent_command", "watchdog_diff", "watchdog_ask", "watchdog_warn", "watchdog_permission_decision"]);

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

function configuredValue(config: unknown): { enabled?: boolean; defaultTimeoutMs?: number; name?: string } {
	if (config === undefined) return {};
	if (typeof config === "boolean") return { enabled: config };
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("config.waitTool must be a boolean or an object with optional enabled, defaultTimeoutMs and name values.");
	}
	const { enabled, defaultTimeoutMs, name } = config as { enabled?: unknown; defaultTimeoutMs?: unknown; name?: unknown };
	if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("config.waitTool.enabled must be a boolean.");
	if (defaultTimeoutMs !== undefined && (!Number.isInteger(defaultTimeoutMs) || (defaultTimeoutMs as number) < 1)) {
		throw new Error("config.waitTool.defaultTimeoutMs must be a positive integer.");
	}
	if (name !== undefined && (typeof name !== "string" || !WAIT_TOOL_NAME_PATTERN.test(name))) {
		throw new Error("config.waitTool.name must start with a letter and contain only letters, digits and underscores (at most 64 characters).");
	}
	if (typeof name === "string" && RESERVED_TOOL_NAMES.has(name)) throw new Error(`config.waitTool.name "${name}" is already a pi-subagents tool.`);
	return {
		enabled,
		...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs: defaultTimeoutMs as number } : {}),
		...(name !== undefined && name !== DEFAULT_WAIT_TOOL_NAME ? { name } : {}),
	};
}

export function resolveWaitToolConfig(config?: WaitToolConfig, env: Record<string, string | undefined> = process.env): ResolvedWaitToolConfig {
	const configured = configuredValue(config);
	const envDefaultTimeoutMs = environmentDefaultTimeoutMs(env[WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV]);
	return {
		enabled: environmentValue(env[WAIT_TOOL_ENABLED_ENV]) ?? configured.enabled ?? true,
		...(envDefaultTimeoutMs ?? configured.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: envDefaultTimeoutMs ?? configured.defaultTimeoutMs } : {}),
		...(configured.name ? { name: configured.name } : {}),
	};
}
