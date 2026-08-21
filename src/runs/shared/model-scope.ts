/**
 * Optional model-scope enforcement for subagent model resolution.
 *
 * When `subagents.modelScope.enforce` is enabled in settings, a resolved model
 * that does not match any `allow` pattern is rejected. The severity depends on
 * where the model came from: an explicit caller-supplied model (`--model`,
 * tool-call `model`, or a TUI clarify pick) is a hard error, while a model
 * inherited from agent frontmatter / `defaultModel` / the parent session only
 * emits a warning so existing configurations keep working. Optional strict
 * enforcement makes inherited models hard errors too.
 *
 * The decision logic ({@link checkModelScope}) is a pure function of its
 * inputs so it can be unit-tested without touching the filesystem or config.
 */

import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";

export interface ModelScopeRule {
	enforce?: boolean;
	/** Reject inherited and fallback models outside the allowlist instead of warning. */
	strict?: boolean;
	/** Glob-style allow patterns (only `*` is special), matched against `provider/id`. */
	allow?: string[];
}

export interface ModelScopeConfig extends ModelScopeRule {
	/** Additional restrictions keyed by canonical agent name. */
	agents?: Record<string, ModelScopeRule>;
}

export interface ModelScopeCheckRule extends ModelScopeRule {
	origin?: string;
}

export interface ResolvedModelScope extends ModelScopeCheckRule {
	origin: string;
}

/** Where a resolved model originated, deciding enforcement severity. */
export type ModelSource = "explicit" | "inherited";

export interface ModelScopeViolation {
	/** Resolved model id (without thinking suffix) that fell outside the scope. */
	model: string;
	severity: "warn" | "error";
	message: string;
	allowedPatterns: string[];
	origin: string;
}

function stripThinkingSuffix(model: string): string {
	return splitKnownThinkingSuffix(model).baseModel;
}

/** Escape RegExp specials except `*`, then turn `*` into `.*`. */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Test whether a resolved model matches a single allow pattern. Both sides are
 * compared case-insensitively against the full `provider/id` (thinking suffix
 * stripped from the model).
 */
export function matchesScopePattern(model: string, pattern: string): boolean {
	return globToRegExp(pattern).test(stripThinkingSuffix(model));
}

/**
 * Pure scope decision. Returns a {@link ModelScopeViolation} when the model is
 * out of scope and enforcement is on, otherwise `undefined`. Enforcement with
 * no `allow` list is a no-op (the settings parser rejects that combination, but
 * this stays defensive for callers that build configs programmatically).
 */
export function checkModelScope(
	model: string | undefined,
	scope: ModelScopeCheckRule | undefined,
	source: ModelSource,
): ModelScopeViolation | undefined {
	if (!model || !scope?.enforce) return undefined;
	const allow = scope.allow;
	if (!allow || allow.length === 0) return undefined;
	if (allow.some((pattern) => matchesScopePattern(model, pattern))) return undefined;

	const baseModel = stripThinkingSuffix(model);
	const severity: ModelScopeViolation["severity"] = source === "explicit" || scope.strict === true ? "error" : "warn";
	const origin = scope.origin ?? "modelScope";
	return {
		model: baseModel,
		severity,
		allowedPatterns: allow,
		origin,
		message:
			`Model '${baseModel}' is outside the configured subagent model scope (${origin}). ` +
			`Allowed patterns: ${allow.join(", ")}.`,
	};
}

function expandInheritPattern(pattern: string, parentModel: { provider: string; id: string } | undefined): string {
	return pattern === "inherit" && parentModel ? `${parentModel.provider}/${parentModel.id}` : pattern;
}

function assertRecord(value: unknown, field: string, meta: { filePath: string }, expected = "an object"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${field}'; expected ${expected}.`);
	}
	return value as Record<string, unknown>;
}

function parseAllowList(value: unknown, field: string, meta: { filePath: string }): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${field}'; expected an array of strings.`);
	}
	const allow: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${field}'; expected an array of strings.`);
		}
		const trimmed = entry.trim();
		if (trimmed) allow.push(trimmed);
	}
	if (allow.length === 0) {
		throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${field}'; expected a non-empty array of patterns.`);
	}
	return allow;
}

function parseScopeRule(input: Record<string, unknown>, field: string, meta: { filePath: string }): ModelScopeRule {
	const rule: ModelScopeRule = {};
	if ("enforce" in input) {
		if (typeof input.enforce !== "boolean") throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${field}.enforce'; expected a boolean.`);
		rule.enforce = input.enforce;
	}
	if ("strict" in input) {
		if (typeof input.strict !== "boolean") throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${field}.strict'; expected a boolean.`);
		rule.strict = input.strict;
	}
	if ("allow" in input) rule.allow = parseAllowList(input.allow, `${field}.allow`, meta);
	return rule;
}

/** Resolve the global and matching agent policies into independent launch-time checks. */
export function resolveModelScopesForAgent(
	config: ModelScopeConfig | undefined,
	agentName: string,
	parentModel: { provider: string; id: string } | undefined,
): ResolvedModelScope[] {
	if (!config) return [];
	const scopes: ResolvedModelScope[] = [];
	if (config.allow) {
		scopes.push({
			...(config.enforce !== undefined ? { enforce: config.enforce } : {}),
			...(config.strict !== undefined ? { strict: config.strict } : {}),
			allow: config.allow.map((pattern) => expandInheritPattern(pattern, parentModel)),
			origin: "modelScope",
		});
	}
	const agentScope = config.agents?.[agentName];
	if (agentScope?.allow) {
		scopes.push({
			enforce: agentScope.enforce ?? config.enforce,
			strict: agentScope.strict ?? config.strict,
			allow: agentScope.allow.map((pattern) => expandInheritPattern(pattern, parentModel)),
			origin: `modelScope.agents.${agentName}`,
		});
	}
	return scopes;
}

/**
 * Validate and normalize a raw `subagents.modelScope` value from settings.
 * Throws a descriptive error for malformed configs (matching the surrounding
 * settings-parsing style). Returns `undefined` when the field is absent.
 */
export function parseModelScopeConfig(
	value: unknown,
	meta: { filePath: string },
): ModelScopeConfig | undefined {
	if (value === undefined) return undefined;
	const input = assertRecord(value, "modelScope", meta);
	const config: ModelScopeConfig = parseScopeRule(input, "modelScope", meta);

	if ("agents" in input) {
		const agents: Record<string, ModelScopeRule> = {};
		for (const [rawName, rawScope] of Object.entries(assertRecord(input.agents, "modelScope.agents", meta, "an object keyed by agent name"))) {
			const name = rawName.trim();
			const field = `modelScope.agents.${name}`;
			if (!name) throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.agents' key; expected a non-empty agent name.`);
			const agentInput = assertRecord(rawScope, field, meta);
			if ("agents" in agentInput) {
				throw new Error(`Subagent settings in '${meta.filePath}' have invalid '${field}.agents'; nested agent scopes are not supported.`);
			}
			agents[name] = parseScopeRule(agentInput, field, meta);
		}
		config.agents = agents;
	}

	const hasAnyAllow = Boolean(config.allow?.length) || Object.values(config.agents ?? {}).some((scope) => Boolean(scope.allow?.length));
	if (config.enforce === true && !hasAnyAllow) {
		throw new Error(`Subagent settings in '${meta.filePath}' set modelScope.enforce without a non-empty 'allow' list; supply allowed model patterns or disable enforcement.`);
	}

	return Object.keys(config).length > 0 ? config : undefined;
}
