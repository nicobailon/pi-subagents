/**
 * Model resolution, scoping, and initial selection
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type KnownProvider, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
/** Default model IDs for each known provider */
export declare const defaultModelPerProvider: Record<KnownProvider, string>;
export interface ScopedModel {
    model: Model<Api>;
    /** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
    thinkingLevel?: ThinkingLevel;
}
/**
 * Find an exact model reference match.
 * Supports either a bare model id or a canonical provider/modelId reference.
 * When matching by bare id, ambiguous matches across providers are rejected.
 */
export declare function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined;
export interface ParsedModelResult {
    model: Model<Api> | undefined;
    /** Thinking level if explicitly specified in pattern, undefined otherwise */
    thinkingLevel?: ThinkingLevel;
    warning: string | undefined;
}
/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, return it with "off" thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix with "off"
 *
 * @internal Exported for testing
 */
export declare function parseModelPattern(pattern: string, availableModels: Model<Api>[], options?: {
    allowInvalidThinkingLevelFallback?: boolean;
}): ParsedModelResult;
/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export interface ModelScopeDiagnostic {
    type: "warning";
    message: string;
    pattern: string;
}
export interface ResolveModelScopeResult {
    scopedModels: ScopedModel[];
    diagnostics: ModelScopeDiagnostic[];
}
export declare function resolveModelScopeWithDiagnostics(patterns: string[], modelRuntime: ModelRuntime): Promise<ResolveModelScopeResult>;
export declare function resolveModelScope(patterns: string[], modelRuntime: ModelRuntime): Promise<ScopedModel[]>;
export interface ResolveCliModelResult {
    model: Model<Api> | undefined;
    thinkingLevel?: ThinkingLevel;
    warning: string | undefined;
    /**
     * Error message suitable for CLI display.
     * When set, model will be undefined.
     */
    error: string | undefined;
}
/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export declare function resolveCliModel(options: {
    cliProvider?: string;
    cliModel?: string;
    cliThinking?: ThinkingLevel;
    modelRuntime: ModelRuntime;
}): ResolveCliModelResult;
export interface InitialModelResult {
    model: Model<Api> | undefined;
    thinkingLevel: ThinkingLevel;
    fallbackMessage: string | undefined;
}
/**
 * Find the initial model to use based on priority:
 * 1. CLI args (provider + model)
 * 2. First model from scoped models (if not continuing/resuming)
 * 3. Restored from session (if continuing/resuming)
 * 4. Saved default from settings
 * 5. First available model with valid API key
 */
export declare function findInitialModel(options: {
    cliProvider?: string;
    cliModel?: string;
    scopedModels: ScopedModel[];
    isContinuing: boolean;
    defaultProvider?: string;
    defaultModelId?: string;
    defaultThinkingLevel?: ThinkingLevel;
    modelRuntime: ModelRuntime;
}): Promise<InitialModelResult>;
/**
 * Restore model from session, with fallback to available models
 */
export declare function restoreModelFromSession(savedProvider: string, savedModelId: string, currentModel: Model<Api> | undefined, shouldPrintMessages: boolean, modelRuntime: ModelRuntime): Promise<{
    model: Model<Api> | undefined;
    fallbackMessage: string | undefined;
}>;
//# sourceMappingURL=model-resolver.d.ts.map