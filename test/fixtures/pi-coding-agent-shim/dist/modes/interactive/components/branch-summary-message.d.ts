import { Box, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export declare class BranchSummaryMessageComponent extends Box {
    private expanded;
    private message;
    private markdownTheme;
    constructor(message: BranchSummaryMessage, markdownTheme?: MarkdownTheme);
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    private updateDisplay;
}
//# sourceMappingURL=branch-summary-message.d.ts.map