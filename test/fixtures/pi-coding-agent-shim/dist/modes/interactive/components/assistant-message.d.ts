import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
/**
 * Component that renders a complete assistant message
 */
export declare class AssistantMessageComponent extends Container {
    private contentContainer;
    private hideThinkingBlock;
    private markdownTheme;
    private hiddenThinkingLabel;
    private outputPad;
    private lastMessage?;
    private hasToolCalls;
    constructor(message?: AssistantMessage, hideThinkingBlock?: boolean, markdownTheme?: MarkdownTheme, hiddenThinkingLabel?: string, outputPad?: number);
    invalidate(): void;
    setHideThinkingBlock(hide: boolean): void;
    setHiddenThinkingLabel(label: string): void;
    setOutputPad(padding: number): void;
    render(width: number): string[];
    updateContent(message: AssistantMessage): void;
}
//# sourceMappingURL=assistant-message.d.ts.map