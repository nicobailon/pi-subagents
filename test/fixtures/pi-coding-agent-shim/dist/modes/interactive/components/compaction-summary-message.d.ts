import { Box, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export declare class CompactionSummaryMessageComponent extends Box {
    private expanded;
    private message;
    private markdownTheme;
    constructor(message: CompactionSummaryMessage, markdownTheme?: MarkdownTheme);
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    private updateDisplay;
}
//# sourceMappingURL=compaction-summary-message.d.ts.map