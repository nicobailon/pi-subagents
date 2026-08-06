/**
 * Shared diff computation utilities for the edit and similar tools.
 */
export declare function detectLineEnding(content: string): "\r\n" | "\n";
export declare function normalizeToLF(text: string): string;
export declare function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string;
/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export declare function normalizeForFuzzyMatch(text: string): string;
interface MatchedEdit {
    editIndex: number;
    matchIndex: number;
    matchLength: number;
    newText: string;
}
type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;
/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export declare function applyReplacementsPreservingUnchangedLines(originalContent: string, baseContent: string, replacements: TextReplacement[]): string;
export interface FuzzyMatchResult {
    /** Whether a match was found */
    found: boolean;
    /** The index where the match starts (in the content that should be used for replacement) */
    index: number;
    /** Length of the matched text */
    matchLength: number;
    /** Whether fuzzy matching was used (false = exact match) */
    usedFuzzyMatch: boolean;
    /**
     * The content to use for replacement operations.
     * When exact match: original content. When fuzzy match: normalized content.
     */
    contentForReplacement: string;
}
export interface Edit {
    oldText: string;
    newText: string;
}
export interface AppliedEditsResult {
    baseContent: string;
    newContent: string;
}
/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export declare function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult;
/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export declare function stripBom(content: string): {
    bom: string;
    text: string;
};
/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export declare function applyEditsToNormalizedContent(normalizedContent: string, edits: Edit[], path: string): AppliedEditsResult;
/** Generate a standard unified patch. */
export declare function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines?: number): string;
/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export declare function generateDiffString(oldContent: string, newContent: string, contextLines?: number): {
    diff: string;
    firstChangedLine: number | undefined;
};
export interface EditDiffResult {
    diff: string;
    firstChangedLine: number | undefined;
}
export interface EditDiffError {
    error: string;
}
/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export declare function computeEditsDiff(path: string, edits: Edit[], cwd: string): Promise<EditDiffResult | EditDiffError>;
/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export declare function computeEditDiff(path: string, oldText: string, newText: string, cwd: string): Promise<EditDiffResult | EditDiffError>;
export {};
//# sourceMappingURL=edit-diff.d.ts.map