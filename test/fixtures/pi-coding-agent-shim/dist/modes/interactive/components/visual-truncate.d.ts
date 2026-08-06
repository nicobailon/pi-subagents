/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by both tool-execution.ts and bash-execution.ts for consistent behavior.
 */
export interface VisualTruncateResult {
    /** The visual lines to display */
    visualLines: string[];
    /** Number of visual lines that were skipped (hidden) */
    skippedCount: number;
}
/**
 * Truncate text to a maximum number of visual lines (from the end).
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @returns The truncated visual lines and count of skipped lines
 */
export declare function truncateToVisualLines(text: string, maxVisualLines: number, width: number, paddingX?: number): VisualTruncateResult;
//# sourceMappingURL=visual-truncate.d.ts.map