export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;
export interface HighlightOptions {
    language?: string;
    ignoreIllegals?: boolean;
    languageSubset?: string[];
    theme?: HighlightTheme;
}
export declare function renderHighlightedHtml(html: string, theme?: HighlightTheme): string;
export declare function highlight(code: string, options?: HighlightOptions): string;
export declare function supportsLanguage(name: string): boolean;
//# sourceMappingURL=syntax-highlight.d.ts.map