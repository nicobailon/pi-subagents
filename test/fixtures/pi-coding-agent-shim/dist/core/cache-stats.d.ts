import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";
/**
 * Prompt-cache TTL: idle gaps longer than this are worth mentioning as the
 * likely cause of a miss. Anthropic's default cache TTL is 5 minutes.
 */
export declare const CACHE_TTL_MS: number;
/** A counted cache miss on a single assistant message. */
export interface CacheMiss {
    /** Prompt tokens that were in the previous turn's prompt but not read from cache. */
    missedTokens: number;
    /** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
    missedCost: number;
    /** Milliseconds since the previous request (which last refreshed the cache). */
    idleMs: number;
    /** True when the model changed relative to the previous request. */
    modelChanged: boolean;
}
export interface CacheWasteTotals {
    missedTokens: number;
    missedCost: number;
    /** Number of counted misses (turns above the noise floor). */
    missCount: number;
}
/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
export interface ModelPriceSource {
    getModel(provider: string, modelId: string): {
        cost: {
            cacheRead: number;
        };
    } | undefined;
}
/**
 * Cumulative cache waste across a session: prompt tokens that should have been
 * cache reads (they were in the previous turn's prompt) but were re-billed.
 */
export declare function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals;
/**
 * All counted cache misses across a session, keyed by the assistant message
 * (by reference) that paid for them. Used to re-derive transcript notices when
 * rebuilding the chat from entries (resume, post-compaction rebuild).
 */
export declare function collectCacheMisses(entries: SessionEntry[], models: ModelPriceSource): Map<AssistantMessage, CacheMiss>;
/**
 * Detect a cache miss on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 */
export declare function detectCacheMiss(entries: SessionEntry[], message: AssistantMessage, models: ModelPriceSource): CacheMiss | undefined;
//# sourceMappingURL=cache-stats.d.ts.map