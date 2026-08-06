import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
/**
 * Component that renders a user message
 */
export declare class UserMessageComponent extends Container {
    private text;
    private markdownTheme;
    private outputPad;
    constructor(text: string, markdownTheme?: MarkdownTheme, outputPad?: number);
    setOutputPad(padding: number): void;
    private rebuild;
    render(width: number): string[];
}
//# sourceMappingURL=user-message.d.ts.map