/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */
export declare const DEFAULT_MAX_LINES = 2000;
export declare const DEFAULT_MAX_BYTES: number;
export declare const GREP_MAX_LINE_LENGTH = 500;
export interface TruncationResult {
    /** The truncated content */
    content: string;
    /** Whether truncation occurred */
    truncated: boolean;
    /** Which limit was hit: "lines", "bytes", or null if not truncated */
    truncatedBy: "lines" | "bytes" | null;
    /** Total number of lines in the original content */
    totalLines: number;
    /** Total number of bytes in the original content */
    totalBytes: number;
    /** Number of complete lines in the truncated output */
    outputLines: number;
    /** Number of bytes in the truncated output */
    outputBytes: number;
    /** Whether the last line was partially truncated (only for tail truncation edge case) */
    lastLinePartial: boolean;
    /** Whether the first line exceeded the byte limit (for head truncation) */
    firstLineExceedsLimit: boolean;
    /** The max lines limit that was applied */
    maxLines: number;
    /** The max bytes limit that was applied */
    maxBytes: number;
}
export interface TruncationOptions {
    /** Maximum number of lines (default: 2000) */
    maxLines?: number;
    /** Maximum number of bytes (default: 50KB) */
    maxBytes?: number;
}
/**
 * Format bytes as human-readable size.
 */
export declare function formatSize(bytes: number): string;
/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export declare function truncateHead(content: string, options?: TruncationOptions): TruncationResult;
/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export declare function truncateTail(content: string, options?: TruncationOptions): TruncationResult;
/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
export declare function truncateLine(line: string, maxChars?: number): {
    text: string;
    wasTruncated: boolean;
};
//# sourceMappingURL=truncate.d.ts.map