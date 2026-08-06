/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai/compat";
import { type SessionEntry } from "../session-manager.ts";
import { type FileOperations } from "./utils.ts";
/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
    readFiles: string[];
    modifiedFiles: string[];
}
/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
    /** Usage from the LLM call(s) that generated this summary, if available */
    usage?: Usage;
    /** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
    details?: T;
}
export interface CompactionSettings {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
}
export declare const DEFAULT_COMPACTION_SETTINGS: CompactionSettings;
/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export declare function calculateContextTokens(usage: Usage): number;
/**
 * Find the last valid assistant message usage from session entries.
 */
export declare function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined;
export interface ContextUsageEstimate {
    tokens: number;
    usageTokens: number;
    trailingTokens: number;
    lastUsageIndex: number | null;
}
/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export declare function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate;
/**
 * Check if compaction should trigger based on context usage.
 */
export declare function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean;
/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export declare function estimateTokens(message: AgentMessage): number;
/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export declare function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number;
export interface CutPointResult {
    /** Index of first entry to keep */
    firstKeptEntryIndex: number;
    /** Index of user message that starts the turn being split, or -1 if not splitting */
    turnStartIndex: number;
    /** Whether this cut splits a turn (cut point is not a user message) */
    isSplitTurn: boolean;
}
/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export declare function findCutPoint(entries: SessionEntry[], startIndex: number, endIndex: number, keepRecentTokens: number): CutPointResult;
/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export declare function generateSummary(currentMessages: AgentMessage[], model: Model<any>, reserveTokens: number, apiKey: string | undefined, headers?: Record<string, string>, signal?: AbortSignal, customInstructions?: string, previousSummary?: string, thinkingLevel?: ThinkingLevel, streamFn?: StreamFn, env?: Record<string, string>): Promise<string>;
/** Generate or update a conversation summary and return its provider usage. */
export declare function generateSummaryWithUsage(currentMessages: AgentMessage[], model: Model<any>, reserveTokens: number, apiKey: string | undefined, headers?: Record<string, string>, signal?: AbortSignal, customInstructions?: string, previousSummary?: string, thinkingLevel?: ThinkingLevel, streamFn?: StreamFn, env?: Record<string, string>): Promise<{
    text: string;
    usage: Usage;
}>;
export interface CompactionPreparation {
    /** UUID of first entry to keep */
    firstKeptEntryId: string;
    /** Messages that will be summarized and discarded */
    messagesToSummarize: AgentMessage[];
    /** Messages that will be turned into turn prefix summary (if splitting) */
    turnPrefixMessages: AgentMessage[];
    /** Whether this is a split turn (cut point in middle of turn) */
    isSplitTurn: boolean;
    tokensBefore: number;
    /** Summary from previous compaction, for iterative update */
    previousSummary?: string;
    /** File operations extracted from messagesToSummarize */
    fileOps: FileOperations;
    /** Compaction settions from settings.jsonl	*/
    settings: CompactionSettings;
}
export declare function prepareCompaction(pathEntries: SessionEntry[], settings: CompactionSettings): CompactionPreparation | undefined;
/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export declare function compact(preparation: CompactionPreparation, model: Model<any>, apiKey: string | undefined, headers?: Record<string, string>, customInstructions?: string, signal?: AbortSignal, thinkingLevel?: ThinkingLevel, streamFn?: StreamFn, env?: Record<string, string>): Promise<CompactionResult>;
//# sourceMappingURL=compaction.d.ts.map