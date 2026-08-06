import { Box, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 * Only renders the skill block itself - user message is rendered separately.
 */
export declare class SkillInvocationMessageComponent extends Box {
    private expanded;
    private skillBlock;
    private markdownTheme;
    constructor(skillBlock: ParsedSkillBlock, markdownTheme?: MarkdownTheme);
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    private updateDisplay;
}
//# sourceMappingURL=skill-invocation-message.d.ts.map