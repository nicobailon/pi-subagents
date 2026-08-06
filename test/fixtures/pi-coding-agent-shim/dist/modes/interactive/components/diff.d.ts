export interface RenderDiffOptions {
    /** File path (unused, kept for API compatibility) */
    filePath?: string;
}
/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export declare function renderDiff(diffText: string, _options?: RenderDiffOptions): string;
//# sourceMappingURL=diff.d.ts.map