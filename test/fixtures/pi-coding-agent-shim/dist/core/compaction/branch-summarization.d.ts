/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai/compat";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { type FileOperations } from "./utils.ts";
export interface BranchSummaryResult {
    summary?: string;
    usage?: Usage;
    readFiles?: string[];
    modifiedFiles?: string[];
    aborted?: boolean;
    error?: string;
}
/** Details stored in BranchSummaryEntry.details for file tracking */
export interface BranchSummaryDetails {
    readFiles: string[];
    modifiedFiles: string[];
}
export type { FileOperations } from "./utils.ts";
export interface BranchPreparation {
    /** Messages extracted for summarization, in chronological order */
    messages: AgentMessage[];
    /** File operations extracted from tool calls */
    fileOps: FileOperations;
    /** Total estimated tokens in messages */
    totalTokens: number;
}
export interface CollectEntriesResult {
    /** Entries to summarize, in chronological order */
    entries: SessionEntry[];
    /** Common ancestor between old and new position, if any */
    commonAncestorId: string | null;
}
export interface GenerateBranchSummaryOptions {
    /** Model to use for summarization */
    model: Model<any>;
    /** API key for the model */
    apiKey?: string;
    /** Request headers for the model */
    headers?: Record<string, string>;
    /** Provider-scoped environment values for the model */
    env?: Record<string, string>;
    /** Abort signal for cancellation */
    signal: AbortSignal;
    /** Optional custom instructions for summarization */
    customInstructions?: string;
    /** If true, customInstructions replaces the default prompt instead of being appended */
    replaceInstructions?: boolean;
    /** Tokens reserved for prompt + LLM response (default 16384) */
    reserveTokens?: number;
    /** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
    streamFn?: StreamFn;
}
/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export declare function collectEntriesForBranchSummary(session: ReadonlySessionManager, oldLeafId: string | null, targetId: string): CollectEntriesResult;
/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export declare function prepareBranchEntries(entries: SessionEntry[], tokenBudget?: number): BranchPreparation;
/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export declare function generateBranchSummary(entries: SessionEntry[], options: GenerateBranchSummaryOptions): Promise<BranchSummaryResult>;
//# sourceMappingURL=branch-summarization.d.ts.map