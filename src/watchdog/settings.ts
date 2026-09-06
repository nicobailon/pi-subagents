import * as fs from "node:fs";
import * as path from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/model-info.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import {
	WATCHDOG_WARNING_SEVERITIES,
	type ResolvedWatchdogConfig,
	type WatchdogChildOverrideConfig,
	type WatchdogChildrenConfig,
	type WatchdogEndpointConfig,
	type WatchdogCadenceConfig,
	type WatchdogGuidanceConfig,
	type WatchdogScopeConfig,
	type WatchdogLspConfig,
	type WatchdogRoleModelRule,
	type WatchdogRulesConfig,
	type WatchdogSettingsError,
	type WatchdogSettingsResult,
	type WatchdogSettingsSource,
	type WatchdogSeverity,
} from "./types.ts";

type WatchdogGuidancePatch = Partial<WatchdogGuidanceConfig>;
type WatchdogScopePatch = Partial<WatchdogScopeConfig>;
type WatchdogCadencePatch = Partial<WatchdogCadenceConfig>;
type WatchdogEndpointPatch = Partial<WatchdogEndpointConfig>;
type WatchdogChildOverridePatch = Partial<WatchdogChildOverrideConfig>;
type WatchdogChildrenPatch = Partial<Omit<WatchdogChildrenConfig, "overrides">> & {
	overrides?: Record<string, WatchdogChildOverridePatch>;
};
type WatchdogLspPatch = Partial<WatchdogLspConfig>;

export type WatchdogSettingsWriteScope = "user" | "project";
export type WatchdogModelSettingsTarget =
	| { kind: "main" }
	| { kind: "children" }
	| { kind: "child"; agent: string };

export interface WatchdogModelSettingsWrite {
	scope: WatchdogSettingsWriteScope;
	cwd?: string;
	target: WatchdogModelSettingsTarget;
	model?: string | null;
	thinking?: ThinkingLevel | false | null;
}

type WatchdogConfigPatch = Partial<Omit<ResolvedWatchdogConfig, "guidance" | "scope" | "cadence" | "main" | "children" | "lsp" | "rules">> & {
	rules?: WatchdogRulesConfig;
	guidance?: WatchdogGuidancePatch;
	scope?: WatchdogScopePatch;
	cadence?: WatchdogCadencePatch;
	main?: WatchdogEndpointPatch;
	children?: WatchdogChildrenPatch;
	lsp?: WatchdogLspPatch;
};

interface ParseMeta {
	scope: "user" | "project" | "session";
	path?: string;
}

export const DEFAULT_WATCHDOG_CONFIG: ResolvedWatchdogConfig = {
	enabled: false,
	clarification: false,
	agentEndTimeoutMs: 30_000,
	severityThreshold: "concern",
	maxWarnings: null,
	guidance: {
		watchdogMd: true,
	},
	stalemateRepeats: 3,
	scope: {
		enabled: true,
	},
	cadence: {
		everyNTools: null,
	},
	main: {
		enabled: false,
	},
	children: {
		enabled: false,
		watchdogTailTimeoutMs: 120_000,
		overrides: {},
	},
	lsp: {
		enabled: true,
		timeoutMs: 3_000,
		maxFiles: 20,
		maxDiagnostics: 50,
	},
};

const WATCHDOG_FIELDS = new Set([
	"enabled",
	"clarification",
	"agentEndTimeoutMs",
	"severityThreshold",
	"maxWarnings",
	"guidance",
	"stalemateRepeats",
	"scope",
	"cadence",
	"main",
	"children",
	"lsp",
	"rules",
]);
const RULES_FIELDS = new Set(["action", "roleModels"]);
const ROLE_MODEL_RULE_FIELDS = new Set(["allow", "deny", "note"]);
const GUIDANCE_FIELDS = new Set(["watchdogMd"]);
const SCOPE_FIELDS = new Set(["enabled"]);
const CADENCE_FIELDS = new Set(["everyNTools"]);
const ENDPOINT_FIELDS = new Set(["enabled", "model", "thinking"]);
const CHILDREN_FIELDS = new Set(["enabled", "model", "thinking", "watchdogTailTimeoutMs", "cadence", "overrides"]);
const CHILD_OVERRIDE_FIELDS = new Set(["enabled", "model", "thinking", "cadence"]);
const LSP_FIELDS = new Set(["enabled", "timeoutMs", "maxFiles", "maxDiagnostics"]);

function cloneDefaultConfig(): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
		scope: { ...DEFAULT_WATCHDOG_CONFIG.scope },
		cadence: { ...DEFAULT_WATCHDOG_CONFIG.cadence },
		main: { ...DEFAULT_WATCHDOG_CONFIG.main },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			overrides: {},
		},
		lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp },
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceName(meta: ParseMeta): string {
	return meta.path ? `'${meta.path}'` : "session override";
}

function invalid(meta: ParseMeta, field: string, expected: string): Error {
	return new Error(`Watchdog settings in ${sourceName(meta)} have invalid '${field}'; expected ${expected}.`);
}

function unknown(meta: ParseMeta, field: string): Error {
	return new Error(`Watchdog settings in ${sourceName(meta)} have unknown field '${field}'.`);
}

function assertKnownFields(input: Record<string, unknown>, allowed: Set<string>, fieldPrefix: string, meta: ParseMeta): void {
	for (const key of Object.keys(input)) {
		if (!allowed.has(key)) throw unknown(meta, `${fieldPrefix}.${key}`);
	}
}

function parseObject(value: unknown, field: string, meta: ParseMeta): Record<string, unknown> {
	if (isPlainObject(value)) return value;
	throw invalid(meta, field, "an object");
}

function parseBoolean(value: unknown, field: string, meta: ParseMeta): boolean {
	if (typeof value === "boolean") return value;
	throw invalid(meta, field, "a boolean");
}

function parseNonEmptyString(value: unknown, field: string, meta: ParseMeta): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw invalid(meta, field, "a non-empty string");
}

function parseThinking(value: unknown, field: string, meta: ParseMeta): ThinkingLevel | false {
	if (value === false) return false;
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
	throw invalid(meta, field, `${THINKING_LEVELS.map((level) => `'${level}'`).join(" or ")} or false`);
}

function parseInteger(value: unknown, field: string, meta: ParseMeta, expected: string, check: (value: number) => boolean): number {
	if (typeof value === "number" && Number.isInteger(value) && check(value)) return value;
	throw invalid(meta, field, expected);
}

function parseNullableInteger(value: unknown, field: string, meta: ParseMeta, expected: string, check: (value: number) => boolean): number | null {
	if (value === null) return null;
	return parseInteger(value, field, meta, expected, check);
}

function parseEnum<T extends string>(value: unknown, field: string, meta: ParseMeta, values: readonly T[]): T {
	if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
	throw invalid(meta, field, values.map((item) => `'${item}'`).join(" or "));
}

function parseGuidancePatch(value: unknown, field: string, meta: ParseMeta): WatchdogGuidancePatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, GUIDANCE_FIELDS, field, meta);
	const patch: WatchdogGuidancePatch = {};
	if ("watchdogMd" in input) patch.watchdogMd = parseBoolean(input.watchdogMd, `${field}.watchdogMd`, meta);
	return patch;
}

function parseScopePatch(value: unknown, field: string, meta: ParseMeta): WatchdogScopePatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, SCOPE_FIELDS, field, meta);
	const patch: WatchdogScopePatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	return patch;
}

function parseCadencePatch(value: unknown, field: string, meta: ParseMeta): WatchdogCadencePatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, CADENCE_FIELDS, field, meta);
	const patch: WatchdogCadencePatch = {};
	if ("everyNTools" in input) {
		patch.everyNTools = input.everyNTools === null
			? null
			: parseInteger(input.everyNTools, `${field}.everyNTools`, meta, "null or an integer >= 5", (candidate) => candidate >= 5);
	}
	return patch;
}

function parseEndpointPatch(value: unknown, field: string, meta: ParseMeta): WatchdogEndpointPatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, ENDPOINT_FIELDS, field, meta);
	const patch: WatchdogEndpointPatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	if ("model" in input) patch.model = parseNonEmptyString(input.model, `${field}.model`, meta);
	if ("thinking" in input) patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta);
	return patch;
}

function parseChildOverridePatch(value: unknown, field: string, meta: ParseMeta): WatchdogChildOverridePatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, CHILD_OVERRIDE_FIELDS, field, meta);
	const patch: WatchdogChildOverridePatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	if ("model" in input) patch.model = parseNonEmptyString(input.model, `${field}.model`, meta);
	if ("thinking" in input) patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta);
	if ("cadence" in input) patch.cadence = parseCadencePatch(input.cadence, `${field}.cadence`, meta);
	return patch;
}

function parseChildrenPatch(value: unknown, field: string, meta: ParseMeta): WatchdogChildrenPatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, CHILDREN_FIELDS, field, meta);
	const patch: WatchdogChildrenPatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	if ("model" in input) patch.model = parseNonEmptyString(input.model, `${field}.model`, meta);
	if ("thinking" in input) patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta);
	if ("watchdogTailTimeoutMs" in input) {
		patch.watchdogTailTimeoutMs = parseInteger(input.watchdogTailTimeoutMs, `${field}.watchdogTailTimeoutMs`, meta, "a positive integer", (candidate) => candidate >= 1);
	}
	if ("cadence" in input) patch.cadence = parseCadencePatch(input.cadence, `${field}.cadence`, meta);
	if ("overrides" in input) {
		const overrides = parseObject(input.overrides, `${field}.overrides`, meta);
		patch.overrides = {};
		for (const [agent, override] of Object.entries(overrides)) {
			if (!agent.trim()) throw invalid(meta, `${field}.overrides`, "agent names to be non-empty");
			patch.overrides[agent] = parseChildOverridePatch(override, `${field}.overrides.${agent}`, meta);
		}
	}
	return patch;
}

function parseLspPatch(value: unknown, field: string, meta: ParseMeta): WatchdogLspPatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, LSP_FIELDS, field, meta);
	const patch: WatchdogLspPatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	if ("timeoutMs" in input) patch.timeoutMs = parseInteger(input.timeoutMs, `${field}.timeoutMs`, meta, "a positive integer", (candidate) => candidate >= 1);
	if ("maxFiles" in input) patch.maxFiles = parseInteger(input.maxFiles, `${field}.maxFiles`, meta, "a positive integer", (candidate) => candidate >= 1);
	if ("maxDiagnostics" in input) patch.maxDiagnostics = parseInteger(input.maxDiagnostics, `${field}.maxDiagnostics`, meta, "a non-negative integer", (candidate) => candidate >= 0);
	return patch;
}

function parseStringList(value: unknown, field: string, meta: ParseMeta): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) throw invalid(meta, field, "an array of non-empty strings");
	return value.map((entry: string) => entry.trim());
}

function parseRoleModelRule(value: unknown, field: string, meta: ParseMeta): WatchdogRoleModelRule {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, ROLE_MODEL_RULE_FIELDS, field, meta);
	const rule: WatchdogRoleModelRule = {};
	if ("allow" in input) rule.allow = parseStringList(input.allow, `${field}.allow`, meta);
	if ("deny" in input) rule.deny = parseStringList(input.deny, `${field}.deny`, meta);
	if ("note" in input) rule.note = parseNonEmptyString(input.note, `${field}.note`, meta);
	return rule;
}

function parseRules(value: unknown, field: string, meta: ParseMeta): WatchdogRulesConfig {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, RULES_FIELDS, field, meta);
	const rules: WatchdogRulesConfig = { action: "warn", roleModels: {} };
	if ("action" in input) rules.action = parseEnum(input.action, `${field}.action`, meta, ["warn", "block"] as const);
	if ("roleModels" in input) {
		for (const [agent, rule] of Object.entries(parseObject(input.roleModels, `${field}.roleModels`, meta))) {
			if (!agent.trim()) throw invalid(meta, `${field}.roleModels`, "agent names to be non-empty");
			rules.roleModels[agent] = parseRoleModelRule(rule, `${field}.roleModels.${agent}`, meta);
		}
	}
	return rules;
}

function parseWatchdogPatch(value: unknown, field: string, meta: ParseMeta): WatchdogConfigPatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, WATCHDOG_FIELDS, field, meta);
	const patch: WatchdogConfigPatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	if ("clarification" in input) patch.clarification = parseBoolean(input.clarification, `${field}.clarification`, meta);
	if ("agentEndTimeoutMs" in input) {
		patch.agentEndTimeoutMs = parseInteger(input.agentEndTimeoutMs, `${field}.agentEndTimeoutMs`, meta, "a positive integer", (candidate) => candidate >= 1);
	}
	if ("severityThreshold" in input) {
		patch.severityThreshold = parseEnum<WatchdogSeverity>(input.severityThreshold, `${field}.severityThreshold`, meta, WATCHDOG_WARNING_SEVERITIES);
	}
	if ("maxWarnings" in input) {
		patch.maxWarnings = parseNullableInteger(input.maxWarnings, `${field}.maxWarnings`, meta, "null or a non-negative integer", (candidate) => candidate >= 0);
	}
	if ("guidance" in input) patch.guidance = parseGuidancePatch(input.guidance, `${field}.guidance`, meta);
	if ("stalemateRepeats" in input) {
		patch.stalemateRepeats = parseInteger(input.stalemateRepeats, `${field}.stalemateRepeats`, meta, "a positive integer", (candidate) => candidate >= 1);
	}
	if ("scope" in input) patch.scope = parseScopePatch(input.scope, `${field}.scope`, meta);
	if ("cadence" in input) patch.cadence = parseCadencePatch(input.cadence, `${field}.cadence`, meta);
	if ("main" in input) patch.main = parseEndpointPatch(input.main, `${field}.main`, meta);
	if ("children" in input) patch.children = parseChildrenPatch(input.children, `${field}.children`, meta);
	if ("lsp" in input) patch.lsp = parseLspPatch(input.lsp, `${field}.lsp`, meta);
	if ("rules" in input) patch.rules = parseRules(input.rules, `${field}.rules`, meta);
	return patch;
}

function parseSettingsObject(settings: Record<string, unknown>, meta: ParseMeta): WatchdogConfigPatch {
	if (!("subagents" in settings)) return {};
	const subagents = parseObject(settings.subagents, "subagents", meta);
	if (!("watchdog" in subagents)) return {};
	return parseWatchdogPatch(subagents.watchdog, "subagents.watchdog", meta);
}

function readSettingsFileStrict(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
	}
	return parsed;
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function getUserSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

export function getWatchdogUserSettingsPath(): string {
	return getUserSettingsPath();
}

function getProjectSettingsPath(cwd: string): string | undefined {
	let currentDir = cwd;
	while (true) {
		if (isDirectory(getProjectConfigDir(currentDir)) || isDirectory(path.join(currentDir, ".agents"))) {
			return path.join(getProjectConfigDir(currentDir), "settings.json");
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

export function getWatchdogProjectSettingsPath(cwd: string): string {
	return path.join(getProjectConfigDir(cwd), "settings.json");
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
	const next: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const current = next[key];
		next[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
	}
	return next as T;
}

function resolvePatch(patch: WatchdogConfigPatch): ResolvedWatchdogConfig {
	const config = deepMerge(cloneDefaultConfig() as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as ResolvedWatchdogConfig;
	config.enabled = patch.enabled ?? DEFAULT_WATCHDOG_CONFIG.enabled;
	config.main.enabled = patch.main?.enabled ?? config.enabled;
	return config;
}

function parseSourceFile(filePath: string, scope: "user" | "project"): WatchdogConfigPatch {
	return parseSettingsObject(readSettingsFileStrict(filePath), { scope, path: filePath });
}

function parseSessionOverride(value: Record<string, unknown>): WatchdogConfigPatch {
	if ("subagents" in value) return parseSettingsObject(value, { scope: "session" });
	return parseWatchdogPatch(value, "subagents.watchdog", { scope: "session" });
}

export function resolveWatchdogConfigStrict(cwd: string, options: { session?: Record<string, unknown> } = {}): ResolvedWatchdogConfig {
	let patch: WatchdogConfigPatch = {};
	patch = deepMerge(patch as Record<string, unknown>, parseSourceFile(getUserSettingsPath(), "user") as Record<string, unknown>) as WatchdogConfigPatch;
	const projectSettingsPath = getProjectSettingsPath(cwd);
	if (projectSettingsPath) {
		patch = deepMerge(patch as Record<string, unknown>, parseSourceFile(projectSettingsPath, "project") as Record<string, unknown>) as WatchdogConfigPatch;
	}
	if (options.session) {
		patch = deepMerge(patch as Record<string, unknown>, parseSessionOverride(options.session) as Record<string, unknown>) as WatchdogConfigPatch;
	}
	return resolvePatch(patch);
}

function ensureObjectField(parent: Record<string, unknown>, key: string, field: string, meta: ParseMeta): Record<string, unknown> {
	if (!(key in parent)) parent[key] = {};
	if (!isPlainObject(parent[key])) throw invalid(meta, field, "an object");
	return parent[key];
}

function ensureWatchdogSettings(settings: Record<string, unknown>, meta: ParseMeta): Record<string, unknown> {
	const subagents = ensureObjectField(settings, "subagents", "subagents", meta);
	return ensureObjectField(subagents, "watchdog", "subagents.watchdog", meta);
}

function settingsPathForWrite(scope: WatchdogSettingsWriteScope, cwd: string | undefined): string {
	return scope === "user" ? getUserSettingsPath() : getWatchdogProjectSettingsPath(cwd ?? process.cwd());
}

function targetSettingsObject(watchdog: Record<string, unknown>, target: WatchdogModelSettingsTarget, meta: ParseMeta): Record<string, unknown> {
	if (target.kind === "main") return ensureObjectField(watchdog, "main", "subagents.watchdog.main", meta);
	const children = ensureObjectField(watchdog, "children", "subagents.watchdog.children", meta);
	if (target.kind === "children") return children;
	if (!target.agent.trim()) throw invalid(meta, "subagents.watchdog.children.overrides.<agent>", "a non-empty agent name");
	const overrides = ensureObjectField(children, "overrides", "subagents.watchdog.children.overrides", meta);
	return ensureObjectField(overrides, target.agent.trim(), `subagents.watchdog.children.overrides.${target.agent.trim()}`, meta);
}

function writeSettingsFile(settingsPath: string, settings: Record<string, unknown>): string {
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	return settingsPath;
}

export function writeUserWatchdogEnabled(enabled: boolean): string {
	const settingsPath = getUserSettingsPath();
	const meta: ParseMeta = { scope: "user", path: settingsPath };
	const settings = readSettingsFileStrict(settingsPath);
	const watchdog = ensureWatchdogSettings(settings, meta);
	watchdog.enabled = enabled;
	targetSettingsObject(watchdog, { kind: "main" }, meta).enabled = enabled;
	return writeSettingsFile(settingsPath, settings);
}

export function writeWatchdogModelSettings(input: WatchdogModelSettingsWrite): string {
	const settingsPath = settingsPathForWrite(input.scope, input.cwd);
	const meta: ParseMeta = { scope: input.scope, path: settingsPath };
	const settings = readSettingsFileStrict(settingsPath);
	const watchdog = ensureWatchdogSettings(settings, meta);
	const target = targetSettingsObject(watchdog, input.target, meta);
	if (input.model === null) delete target.model;
	else if (input.model !== undefined) target.model = input.model;
	if (input.thinking === null) delete target.thinking;
	else if (input.thinking !== undefined) target.thinking = input.thinking;
	return writeSettingsFile(settingsPath, settings);
}

export function resolveWatchdogConfig(cwd: string, options: { session?: Record<string, unknown> } = {}): WatchdogSettingsResult {
	const sources: WatchdogSettingsSource[] = [];
	const errors: WatchdogSettingsError[] = [];
	let patch: WatchdogConfigPatch = {};
	const sourceSpecs: Array<{ scope: "user" | "project"; path: string | undefined }> = [
		{ scope: "user", path: getUserSettingsPath() },
		{ scope: "project", path: getProjectSettingsPath(cwd) },
	];
	for (const source of sourceSpecs) {
		if (!source.path) continue;
		sources.push({ scope: source.scope, path: source.path, exists: fs.existsSync(source.path) });
		try {
			patch = deepMerge(patch as Record<string, unknown>, parseSourceFile(source.path, source.scope) as Record<string, unknown>) as WatchdogConfigPatch;
		} catch (error) {
			errors.push({ scope: source.scope, path: source.path, message: error instanceof Error ? error.message : String(error) });
		}
	}
	if (options.session) {
		sources.push({ scope: "session", exists: true });
		try {
			patch = deepMerge(patch as Record<string, unknown>, parseSessionOverride(options.session) as Record<string, unknown>) as WatchdogConfigPatch;
		} catch (error) {
			errors.push({ scope: "session", message: error instanceof Error ? error.message : String(error) });
		}
	}
	return {
		ok: errors.length === 0,
		config: errors.length === 0 ? resolvePatch(patch) : cloneDefaultConfig(),
		errors,
		sources,
	};
}
