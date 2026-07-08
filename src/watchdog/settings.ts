import * as fs from "node:fs";
import * as path from "node:path";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/model-info.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import {
	WATCHDOG_DELIVERY_MODES,
	WATCHDOG_LATE_WARNING_POLICIES,
	WATCHDOG_WARNING_SEVERITIES,
	type ResolvedWatchdogConfig,
	type WatchdogAsyncCompletionConfig,
	type WatchdogAutoFollowConfig,
	type WatchdogChildOverrideConfig,
	type WatchdogChildrenConfig,
	type WatchdogDeliveryMode,
	type WatchdogEndpointConfig,
	type WatchdogGuidanceConfig,
	type WatchdogLateWarningPolicy,
	type WatchdogLspConfig,
	type WatchdogSettingsError,
	type WatchdogSettingsResult,
	type WatchdogSettingsSource,
	type WatchdogSeverity,
	type WatchdogSyncBacklog,
} from "./types.ts";

type WatchdogAutoFollowPatch = Partial<WatchdogAutoFollowConfig>;
type WatchdogGuidancePatch = Partial<WatchdogGuidanceConfig>;
type WatchdogEndpointPatch = Partial<WatchdogEndpointConfig>;
type WatchdogChildOverridePatch = Partial<WatchdogChildOverrideConfig>;
type WatchdogChildrenPatch = Partial<Omit<WatchdogChildrenConfig, "autoFollow" | "overrides">> & {
	autoFollow?: WatchdogAutoFollowPatch;
	overrides?: Record<string, WatchdogChildOverridePatch>;
};
type WatchdogAsyncCompletionPatch = Partial<WatchdogAsyncCompletionConfig>;
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

type WatchdogConfigPatch = Partial<Omit<ResolvedWatchdogConfig, "guidance" | "autoFollow" | "main" | "children" | "asyncCompletion" | "lsp">> & {
	guidance?: WatchdogGuidancePatch;
	autoFollow?: WatchdogAutoFollowPatch;
	main?: WatchdogEndpointPatch;
	children?: WatchdogChildrenPatch;
	asyncCompletion?: WatchdogAsyncCompletionPatch;
	lsp?: WatchdogLspPatch;
};

interface ParseMeta {
	scope: "user" | "project" | "session";
	path?: string;
}

export const DEFAULT_WATCHDOG_CONFIG: ResolvedWatchdogConfig = {
	enabled: false,
	delivery: "held",
	showDuringRun: false,
	syncBacklog: "off",
	agentEndTimeoutMs: 30_000,
	lateWarningPolicy: "show-stale-no-autofollow",
	severityThreshold: "concern",
	maxWarnings: null,
	guidance: {
		watchdogMd: true,
		systemPromptPath: null,
	},
	autoFollow: {
		blockers: true,
		maxAttempts: 3,
		stalemateRepeats: 3,
	},
	main: {
		enabled: false,
	},
	children: {
		enabled: false,
		watchdogTailTimeoutMs: 120_000,
		autoFollow: {
			blockers: true,
			maxAttempts: 3,
			stalemateRepeats: 3,
		},
		overrides: {},
	},
	asyncCompletion: {
		enabled: false,
		autoFollowBlockers: false,
	},
	lsp: {
		enabled: true,
		timeoutMs: 3_000,
		maxFiles: 20,
		maxDiagnostics: 50,
	},
	compactAtPercent: 80,
	reviewRetryDelayMs: 1_000,
	maxReviewFailures: 3,
};

const WATCHDOG_FIELDS = new Set([
	"enabled",
	"delivery",
	"showDuringRun",
	"syncBacklog",
	"agentEndTimeoutMs",
	"lateWarningPolicy",
	"severityThreshold",
	"maxWarnings",
	"guidance",
	"autoFollow",
	"main",
	"children",
	"asyncCompletion",
	"lsp",
	"compactAtPercent",
	"reviewRetryDelayMs",
	"maxReviewFailures",
]);
const GUIDANCE_FIELDS = new Set(["watchdogMd", "systemPromptPath"]);
const AUTO_FOLLOW_FIELDS = new Set(["blockers", "maxAttempts", "stalemateRepeats"]);
const ENDPOINT_FIELDS = new Set(["enabled", "model", "thinking"]);
const CHILDREN_FIELDS = new Set(["enabled", "model", "thinking", "watchdogTailTimeoutMs", "autoFollow", "overrides"]);
const CHILD_OVERRIDE_FIELDS = new Set(["enabled", "model", "thinking"]);
const ASYNC_COMPLETION_FIELDS = new Set(["enabled", "autoFollowBlockers"]);
const LSP_FIELDS = new Set(["enabled", "timeoutMs", "maxFiles", "maxDiagnostics"]);

function cloneDefaultConfig(): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
		autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.autoFollow },
		main: { ...DEFAULT_WATCHDOG_CONFIG.main },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.children.autoFollow },
			overrides: {},
		},
		asyncCompletion: { ...DEFAULT_WATCHDOG_CONFIG.asyncCompletion },
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

function parseSyncBacklog(value: unknown, field: string, meta: ParseMeta): WatchdogSyncBacklog {
	if (value === "off") return "off";
	return parseInteger(value, field, meta, "'off' or a positive integer", (candidate) => candidate >= 1);
}

function parseGuidancePatch(value: unknown, field: string, meta: ParseMeta): WatchdogGuidancePatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, GUIDANCE_FIELDS, field, meta);
	const patch: WatchdogGuidancePatch = {};
	if ("watchdogMd" in input) patch.watchdogMd = parseBoolean(input.watchdogMd, `${field}.watchdogMd`, meta);
	if ("systemPromptPath" in input) {
		patch.systemPromptPath = input.systemPromptPath === null
			? null
			: parseNonEmptyString(input.systemPromptPath, `${field}.systemPromptPath`, meta);
	}
	return patch;
}

function parseAutoFollowPatch(value: unknown, field: string, meta: ParseMeta): WatchdogAutoFollowPatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, AUTO_FOLLOW_FIELDS, field, meta);
	const patch: WatchdogAutoFollowPatch = {};
	if ("blockers" in input) patch.blockers = parseBoolean(input.blockers, `${field}.blockers`, meta);
	if ("maxAttempts" in input) {
		patch.maxAttempts = parseNullableInteger(input.maxAttempts, `${field}.maxAttempts`, meta, "null or a positive integer", (candidate) => candidate >= 1);
	}
	if ("stalemateRepeats" in input) {
		patch.stalemateRepeats = parseInteger(input.stalemateRepeats, `${field}.stalemateRepeats`, meta, "a positive integer", (candidate) => candidate >= 1);
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
	if ("autoFollow" in input) patch.autoFollow = parseAutoFollowPatch(input.autoFollow, `${field}.autoFollow`, meta);
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

function parseAsyncCompletionPatch(value: unknown, field: string, meta: ParseMeta): WatchdogAsyncCompletionPatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, ASYNC_COMPLETION_FIELDS, field, meta);
	const patch: WatchdogAsyncCompletionPatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	if ("autoFollowBlockers" in input) patch.autoFollowBlockers = parseBoolean(input.autoFollowBlockers, `${field}.autoFollowBlockers`, meta);
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

function parseWatchdogPatch(value: unknown, field: string, meta: ParseMeta): WatchdogConfigPatch {
	const input = parseObject(value, field, meta);
	assertKnownFields(input, WATCHDOG_FIELDS, field, meta);
	const patch: WatchdogConfigPatch = {};
	if ("enabled" in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta);
	if ("delivery" in input) patch.delivery = parseEnum<WatchdogDeliveryMode>(input.delivery, `${field}.delivery`, meta, WATCHDOG_DELIVERY_MODES);
	if ("showDuringRun" in input) patch.showDuringRun = parseBoolean(input.showDuringRun, `${field}.showDuringRun`, meta);
	if ("syncBacklog" in input) patch.syncBacklog = parseSyncBacklog(input.syncBacklog, `${field}.syncBacklog`, meta);
	if ("agentEndTimeoutMs" in input) {
		patch.agentEndTimeoutMs = parseInteger(input.agentEndTimeoutMs, `${field}.agentEndTimeoutMs`, meta, "a positive integer", (candidate) => candidate >= 1);
	}
	if ("lateWarningPolicy" in input) {
		patch.lateWarningPolicy = parseEnum<WatchdogLateWarningPolicy>(input.lateWarningPolicy, `${field}.lateWarningPolicy`, meta, WATCHDOG_LATE_WARNING_POLICIES);
	}
	if ("severityThreshold" in input) {
		patch.severityThreshold = parseEnum<WatchdogSeverity>(input.severityThreshold, `${field}.severityThreshold`, meta, WATCHDOG_WARNING_SEVERITIES);
	}
	if ("maxWarnings" in input) {
		patch.maxWarnings = parseNullableInteger(input.maxWarnings, `${field}.maxWarnings`, meta, "null or a non-negative integer", (candidate) => candidate >= 0);
	}
	if ("guidance" in input) patch.guidance = parseGuidancePatch(input.guidance, `${field}.guidance`, meta);
	if ("autoFollow" in input) patch.autoFollow = parseAutoFollowPatch(input.autoFollow, `${field}.autoFollow`, meta);
	if ("main" in input) patch.main = parseEndpointPatch(input.main, `${field}.main`, meta);
	if ("children" in input) patch.children = parseChildrenPatch(input.children, `${field}.children`, meta);
	if ("asyncCompletion" in input) patch.asyncCompletion = parseAsyncCompletionPatch(input.asyncCompletion, `${field}.asyncCompletion`, meta);
	if ("lsp" in input) patch.lsp = parseLspPatch(input.lsp, `${field}.lsp`, meta);
	if ("compactAtPercent" in input) {
		patch.compactAtPercent = parseInteger(input.compactAtPercent, `${field}.compactAtPercent`, meta, "an integer from 50 through 95", (candidate) => candidate >= 50 && candidate <= 95);
	}
	if ("reviewRetryDelayMs" in input) {
		patch.reviewRetryDelayMs = parseInteger(input.reviewRetryDelayMs, `${field}.reviewRetryDelayMs`, meta, "a positive integer", (candidate) => candidate >= 1);
	}
	if ("maxReviewFailures" in input) {
		patch.maxReviewFailures = parseInteger(input.maxReviewFailures, `${field}.maxReviewFailures`, meta, "a positive integer", (candidate) => candidate >= 1);
	}
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
