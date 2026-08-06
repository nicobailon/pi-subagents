import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
export declare function shortenPath(path: unknown): string;
export declare function linkPath(styledText: string, rawPath: string, cwd: string): string;
export declare function str(value: unknown): string | null;
export declare function replaceTabs(text: string): string;
export declare function normalizeDisplayText(text: string): string;
export declare function getTextOutput(result: {
    content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
    }>;
} | undefined, showImages: boolean): string;
export type ToolRenderResultLike<TDetails> = {
    content: (TextContent | ImageContent)[];
    details: TDetails;
};
export declare function invalidArgText(theme: Theme): string;
export declare function renderToolPath(rawPath: string | null, theme: Theme, cwd: string, options?: {
    emptyFallback?: string;
}): string;
//# sourceMappingURL=render-utils.d.ts.map