import { splitKnownThinkingSuffix, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";
import { filterFallbackCandidates, findModelExclusion, parseModelKey, recordModelFailure } from "./model-exclusions.ts";
import { checkModelScope, type ModelScopeCheckRule, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";
import { redactSecretValues } from "./permissions.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	return splitKnownThinkingSuffix(model);
}

/** Aliases apply only to the resolved launch candidate (without its thinking suffix) and the exact raw response ID. */
export function formatSubagentModelVerificationError(
	expectedModel: string,
	observedModel: string,
	availableModels: AvailableModelInfo[] | undefined,
	modelResponseAliases?: Record<string, string[]>,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const expectedBase = splitThinkingSuffix(expectedModel).baseModel;
	if (modelResponseAliases && Object.hasOwn(modelResponseAliases, expectedBase)
		&& modelResponseAliases[expectedBase]?.includes(observedModel)) return undefined;
	const observedBase = splitThinkingSuffix(observedModel).baseModel;
	if (expectedBase === observedBase) return undefined;
	const expectedEntry = availableModels.find((entry) => entry.fullId === expectedBase);
	if (expectedEntry) {
		if (expectedEntry.id === observedBase) return undefined;
		const expectedIdLeaf = expectedEntry.id.slice(expectedEntry.id.lastIndexOf("/") + 1);
		const expectedFullIdLeaf = expectedEntry.fullId.slice(expectedEntry.fullId.lastIndexOf("/") + 1);
		if (expectedIdLeaf === observedBase || expectedFullIdLeaf === observedBase) return undefined;
	}
	return `model_verification_failed: native Pi child reported a different model than the launch candidate. Expected '${expectedModel}' but observed '${observedModel}'. If you have independently verified this response ID identifies the requested model, declare the exact mapping in modelResponseAliases in ~/.pi/agent/extensions/subagent/config.json (see docs/configuration.md#modelresponsealiases). Use the resolved provider/model ID without its thinking suffix as the key. This leaves the outgoing request unchanged. Configuration changes affect new independent native runs; resumed native runs retain their launch-time declaration. External CLI adapters do not use this setting.`;
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = "inherit";

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
	if (!candidate.provider || !candidate.id) return undefined;
	return { provider: candidate.provider, id: candidate.id };
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators.
 */
export function normalizeModelSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/[._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. */
function stripTrailingDateStamp(segment: string): string {
	const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
	if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
	const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
	if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
	return segment;
}

function isRegisteredProvider(provider: string, availableModels: AvailableModelInfo[]): boolean {
	const normalized = normalizeModelSegment(provider);
	return availableModels.some((entry) => normalizeModelSegment(entry.provider) === normalized);
}

/**
 * Split `provider/id` only when the first path segment is a registered provider.
 * Hugging Face-style `owner/name` ids therefore stay intact unless `owner` is
 * itself a provider in the active registry. `:` and `.` keep the same rule.
 */
function splitQualifiedModelQuery(
	baseModel: string,
	availableModels: AvailableModelInfo[],
): { queryProvider?: string; queryIdRaw: string } {
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		const providerPart = baseModel.slice(0, slashIdx);
		if (isRegisteredProvider(providerPart, availableModels)) {
			return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(slashIdx + 1) };
		}
		return { queryIdRaw: baseModel };
	}
	const providerSeparators = [":", "."];
	for (const separator of providerSeparators) {
		const separatorIdx = baseModel.indexOf(separator);
		if (separatorIdx <= 0) continue;
		const providerPart = baseModel.slice(0, separatorIdx);
		if (!isRegisteredProvider(providerPart, availableModels)) continue;
		return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(separatorIdx + 1) };
	}
	return { queryIdRaw: baseModel };
}

function resolveExactIdMatches(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return preferredMatch.fullId;
	}
	if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	return undefined;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact.fullId;

	const { queryProvider } = splitQualifiedModelQuery(baseModel, availableModels);
	if (queryProvider === undefined) {
		const exactId = resolveExactIdMatches(baseModel, availableModels, preferredProvider);
		if (exactId) return exactId;
	}

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A slash is a provider
 * prefix only when that prefix is a registered provider; otherwise the whole
 * string is the model id (Hugging Face `owner/name`). A qualified provider
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates).
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred) return preferred.fullId;
	}
	if (candidates.length === 1) return candidates[0]!.fullId;
	return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query.
 */
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	if (!thinkingSuffix) return model;
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	return model;
}

function resolveSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return model;
	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const resolvedBase = thinkingSuffix ? resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) : undefined;
	return resolvedBase ? `${resolvedBase}${thinkingSuffix}` : undefined;
}

function suggestAlternateProviderModel(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
): string | undefined {
	if (!availableModels || availableModels.length === 0) return undefined;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
	if (queryProvider === undefined) return undefined;
	const suggestion = resolveBaseModelCandidate(queryIdRaw, availableModels);
	if (!suggestion) return undefined;
	const matched = availableModels.find((entry) => entry.fullId === suggestion);
	if (!matched || normalizeModelSegment(matched.provider) === queryProvider) return undefined;
	return `${suggestion}${thinkingSuffix}`;
}

function resolveRequiredSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string {
	const resolved = resolveSubagentModelCandidate(model, availableModels, preferredProvider);
	if (resolved) return resolved;
	const suggestion = suggestAlternateProviderModel(model, availableModels);
	throw new Error(
		`Unknown subagent model '${model}' in the active Pi model registry.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
	);
}

export interface ResolveSubagentModelOverrideOptions {
	/** When set with `enforce: true`, out-of-scope models are rejected. */
	scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
	/** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
	source?: ModelSource;
	/** Called for warn-severity violations instead of `console.warn`. */
	onWarn?: (violation: ModelScopeViolation) => void;
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	console.warn(`[pi-subagents] ${violation.message}`);
}

function configuredScopes(scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined): ModelScopeCheckRule[] {
	return scope ? (Array.isArray(scope) ? scope : [scope]) : [];
}

function throwForUnresolvedEnforcedInheritScope(scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined, includeMixed = false): void {
	const unresolvedInheritScope = configuredScopes(scope)
		.find((entry) => entry.enforce === true && (includeMixed ? entry.allow?.includes(INHERIT_MODEL) : entry.allow?.length === 1 && entry.allow[0] === INHERIT_MODEL));
	if (!unresolvedInheritScope) return;
	const origin = unresolvedInheritScope.origin ?? "modelScope";
	throw new Error(`Cannot enforce subagent model scope (${origin}): 'inherit' requires a current parent session model.`);
}

function enforceModelScopes(
	model: string,
	scope: ModelScopeCheckRule | ModelScopeCheckRule[] | undefined,
	source: ModelSource,
	onWarn: ((violation: ModelScopeViolation) => void) | undefined,
): void {
	const violations = configuredScopes(scope)
		.map((entry) => checkModelScope(model, entry, source))
		.filter((violation): violation is ModelScopeViolation => violation !== undefined);
	const error = violations.find((violation) => violation.severity === "error");
	if (error) throw new Error(error.message);
	for (const violation of violations) (onWarn ?? defaultScopeWarn)(violation);
}

const MODEL_EXCLUSION_DIAGNOSTIC_MAX_LENGTH = 240;
const MODEL_EXCLUSION_DIAGNOSTIC_MAX_ENTRIES = 20;

function sanitizeModelExclusionDiagnostic(value: string | undefined, fallback: string): string {
	const normalized = typeof value === "string"
		? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim()
		: "";
	return redactSecretValues(normalized || fallback).slice(0, MODEL_EXCLUSION_DIAGNOSTIC_MAX_LENGTH);
}

function formatModelExclusionExpiry(expiresAt: number): string {
	if (!Number.isFinite(expiresAt)) return "unknown";
	const date = new Date(expiresAt);
	return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function formatExcludedCandidateEvidence(candidate: string, exclusion: NonNullable<ReturnType<typeof findModelExclusion>>): string {
	const { provider, modelId } = parseModelKey(candidate);
	const displayCandidate = sanitizeModelExclusionDiagnostic(candidate, "unknown");
	const displayModel = sanitizeModelExclusionDiagnostic(modelId, "unknown");
	const displayProvider = sanitizeModelExclusionDiagnostic(provider ?? exclusion.provider, "unspecified");
	const reason = sanitizeModelExclusionDiagnostic(exclusion.reason, "runtime-failure");
	return `${displayCandidate} — model: ${displayModel}; provider: ${displayProvider}; reason: ${reason}; expires: ${formatModelExclusionExpiry(exclusion.expiresAt)}`;
}

const MODEL_UNAVAILABLE_EXCLUSION_PATTERNS = [
	/model.*not found/i,
	/unknown model/i,
	/model.*unavailable/i,
	/model.*disabled/i,
];

function isCurrentRegistryModel(candidate: string, availableModels: AvailableModelInfo[] | undefined): boolean {
	if (!availableModels || availableModels.length === 0) return false;
	const { baseModel } = splitThinkingSuffix(candidate);
	return availableModels.some((entry) => entry.fullId === baseModel);
}

function ignoreStaleModelUnavailableExclusion(candidate: string, exclusion: NonNullable<ReturnType<typeof findModelExclusion>>, availableModels: AvailableModelInfo[] | undefined): boolean {
	const reason = exclusion.reason ?? "";
	return MODEL_UNAVAILABLE_EXCLUSION_PATTERNS.some((pattern) => pattern.test(reason)) && isCurrentRegistryModel(candidate, availableModels);
}

function throwForExplicitModelExclusion(model: string): void {
	const exclusion = findModelExclusion(model);
	if (!exclusion) return;
	const reason = redactSecretValues((exclusion.reason ?? "runtime-failure").replace(/[\u0000-\u001f\u007f]+/g, " ")).slice(0, 240);
	const expiry = Number.isFinite(exclusion.expiresAt) ? `; expires: ${new Date(exclusion.expiresAt).toISOString()}` : "";
	throw new Error(`Requested subagent model '${model}' is excluded and cannot be replaced by a fallback (reason: ${reason}${expiry}).`);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one,
 * unless strict scope enforcement makes inherited violations hard errors.
 */
export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	if (!parentModel) throwForUnresolvedEnforcedInheritScope(options?.scope, explicit === undefined || options?.source === "inherited");
	let resolved: string | undefined;
	let resolvedFromRegistry = explicit === undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		const candidate = resolveSubagentModelCandidate(explicit, availableModels, preferredProvider);
		if (options?.source === "explicit") {
			resolved = candidate ?? resolveRequiredSubagentModelCandidate(explicit, availableModels, preferredProvider);
			throwForExplicitModelExclusion(resolved);
			resolvedFromRegistry = true;
		} else if (candidate) {
			resolved = candidate;
			resolvedFromRegistry = true;
		} else {
			resolved = explicit;
		}
	}
	if (resolved && options?.scope && resolvedFromRegistry) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		enforceModelScopes(resolved, options.scope, source, options.onWarn);
	}
	return resolved;
}

export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const source = options?.source ?? (explicitModel !== undefined ? "explicit" : "inherited");
	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source },
	);
	if (resolved || explicitModel === undefined) return resolved;
	return resolveSubagentModelOverride(
		agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: options?.source ?? "inherited" },
	);
}

export type ModelOrigin = ModelSource | "configured";

export interface BuildModelCandidatesOptions {
	/** Fallback models warn by default and throw when strict scope enforcement is enabled. */
	scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
	onWarn?: (violation: ModelScopeViolation) => void;
	/** The primary model came from the running parent session, not configuration. */
	primaryModelFromParent?: boolean;
	/** How the primary model was selected. Explicit stays strict and does not rotate to fallbacks. */
	origin?: ModelOrigin;
}

const ZERO_USABLE_MODEL_CANDIDATES_ERROR =
	"No usable subagent models remain after registry, scope, and cached-exclusion filtering.";

export function resolveModelOrigin(input: {
	explicitModel?: string | boolean;
	agentModel?: string | boolean;
	parentModel?: ParentModel;
	fromParent?: boolean;
	storedOrigin?: ModelOrigin;
}): ModelOrigin {
	if (input.storedOrigin) return input.storedOrigin;
	if (input.fromParent) return "inherited";
	if (inheritsParentModel(input.explicitModel, input.agentModel, input.parentModel)) return "inherited";
	const trimmed = typeof input.explicitModel === "string" ? input.explicitModel.trim() : "";
	return trimmed && trimmed !== INHERIT_MODEL ? "explicit" : "configured";
}

export function inheritsParentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
): boolean {
	const requestedModel = explicitModel ?? agentModel;
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	return Boolean(parentModel && (!trimmed || trimmed === INHERIT_MODEL));
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): string[] {
	if (!primaryModel) throwForUnresolvedEnforcedInheritScope(options?.scope, true);
	const origin = options?.origin ?? (options?.primaryModelFromParent ? "inherited" : "configured");
	const scopes = configuredScopes(options?.scope);
	type ExcludedCandidate = { candidate: string; exclusion: NonNullable<ReturnType<typeof findModelExclusion>> };
	const excludedCandidates: ExcludedCandidate[] = [];
	let excludedCandidateCount = 0;
	const warnCachedExclusion = (candidate: string, exclusion: NonNullable<ReturnType<typeof findModelExclusion>>) => {
		excludedCandidateCount++;
		if (excludedCandidates.length < MODEL_EXCLUSION_DIAGNOSTIC_MAX_ENTRIES) excludedCandidates.push({ candidate, exclusion });
		const displayCandidate = sanitizeModelExclusionDiagnostic(candidate, "unknown");
		const reason = sanitizeModelExclusionDiagnostic(exclusion.reason, "runtime-failure");
		console.warn(`[pi-subagents] Skipping model '${displayCandidate}' due to a cached exclusion (reason: ${reason}; expires: ${formatModelExclusionExpiry(exclusion.expiresAt)}).`);
	};
	if (origin === "explicit" && primaryModel) {
		const normalized = resolveRequiredSubagentModelCandidate(primaryModel.trim(), availableModels, preferredProvider);
		throwForExplicitModelExclusion(normalized);
		enforceModelScopes(normalized, scopes, "explicit", options?.onWarn);
		primaryModel = normalized;
	}
	const seen = new Set<string>();
	const candidates: string[] = [];
	const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
	let skippedPrimary: string | undefined;
	let skippedFallback: string | undefined;
	for (let index = 0; index < rawCandidates.length; index++) {
		const raw = rawCandidates[index];
		if (!raw) continue;
		const model = raw.trim();
		const normalized = index === 0 && (origin === "inherited" || origin === "explicit" || options?.primaryModelFromParent)
			? model
			: resolveSubagentModelCandidate(model, availableModels, preferredProvider);
		if (!normalized) {
			if (index === 0) skippedPrimary = model;
			else {
				skippedFallback ??= model;
				console.warn(`[pi-subagents] Skipping fallback model '${model}' because it is unavailable in this environment.`);
			}
			continue;
		}
		if (seen.has(normalized)) continue;
		if (index > 0 || scopes.some((scope) => scope.enforce === true && scope.strict === true)) {
			enforceModelScopes(normalized, scopes, "inherited", options?.onWarn);
		}
		seen.add(normalized);
		candidates.push(normalized);
	}
	const resolved = filterFallbackCandidates(candidates, {
		onExcluded: warnCachedExclusion,
		ignoreExclusion: (candidate, exclusion) => ignoreStaleModelUnavailableExclusion(candidate, exclusion, availableModels),
	});
	if (resolved.length === 0) {
		if (skippedPrimary) resolveRequiredSubagentModelCandidate(skippedPrimary, availableModels, preferredProvider);
		if (candidates.length === 0 && skippedFallback) resolveRequiredSubagentModelCandidate(skippedFallback, availableModels, preferredProvider);
		if (candidates.length > 0) {
			const shownExclusions = excludedCandidates;
			const omittedExclusions = excludedCandidateCount - shownExclusions.length;
			const evidence = shownExclusions.length > 0
				? ` (excluded: ${shownExclusions.map(({ candidate, exclusion }) => formatExcludedCandidateEvidence(candidate, exclusion)).join("; ")}${omittedExclusions > 0 ? `; ... and ${omittedExclusions} more` : ""})`
				: "";
			throw new Error(`${ZERO_USABLE_MODEL_CANDIDATES_ERROR}${evidence}`);
		}
		return resolved;
	}
	if (skippedPrimary) {
		console.warn(`[pi-subagents] Skipping primary model '${skippedPrimary}' because it is unavailable in this environment.`);
	}
	return resolved;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/^REQUEST_LIMIT_EXCEEDED$/,
	/rate\s*limit/i,
	/usage\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection\s+(?:error|reset|closed|aborted)/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/stream ended without finish_reason/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b500\b/,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	/internal server error/i,
	/cold.?start/i,
	/empty response/i,
	/no output/i,
	/model.*(?:load|fail|error)/i,
];

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Retrying a
 * different model cannot fix them and would rerun the whole task. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

function messageError(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = (message as { errorMessage?: unknown }).errorMessage;
	return typeof value === "string" ? value : undefined;
}

export function isRetryableModelFailureAttempt(input: { error: string | undefined; messages?: readonly unknown[]; toolCount?: number }): boolean {
	if (!isRetryableModelFailure(input.error)) return false;
	if ((input.toolCount ?? 0) > 0) return false;
	if (input.error === "Subagent produced no output (possible model cold-start or empty response)." || /^Subagent produced no output after terminal assistant stopReason "[^"]+"\.$/.test(input.error ?? "")) return true;
	if ((input.toolCount ?? 0) === 0 && (input.messages?.length ?? 0) === 0) return true;
	const error = input.error?.trim();
	return Boolean(error && input.messages?.some((message) => messageError(message)?.trim() === error));
}

// Request-shape failures can match broad fallback signals such as "upstream",
// but do not establish that the model is unhealthy for subsequent requests.
const REQUEST_SHAPE_FAILURE_PATTERN = /\b(?:bad[ _]request|invalid[ _]argument|invalid_request_error)\b/i;

export function recordRetryableModelFailure(model: string | undefined, error: string | undefined): void {
	if (!model || !error || !isRetryableModelFailure(error) || isContextOverflow(error)) return;
	if (REQUEST_SHAPE_FAILURE_PATTERN.test(error)) return;
	const { provider, modelId } = parseModelKey(model);
	recordModelFailure({ modelId, reason: error, ...(provider ? { provider } : {}) });
}

/**
 * Context-overflow signals. These are deliberately NOT part of
 * {@link RETRYABLE_MODEL_FAILURE_PATTERNS}: an overflow means the input was too
 * large for the model's context window, so retrying the same input on another
 * model (or the same model again) cannot succeed. Callers should treat overflow
 * as a terminal, non-retryable failure and surface a clear "input too large"
 * error instead of burning fallback attempts on a guaranteed failure.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
	/context(?: length| window| limit)? (?:exceed|overflow|too long)/i,
	/maximum context length/i,
	/too many tokens/i,
	/token limit/i,
	/context_length_exceeded/i,
	/length_required/i,
	/maximum.*tokens/i,
	/prompt.*too long/i,
	/input.*too long/i,
	/exceeded.*context/i,
	/context.*overflow/i,
];

export function isContextOverflow(error: string | undefined): boolean {
	if (!error) return false;
	if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
