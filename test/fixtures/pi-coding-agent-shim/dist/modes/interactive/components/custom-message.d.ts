import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export declare class CustomMessageComponent extends Container {
    private message;
    private customRenderer?;
    private box;
    private customComponent?;
    private markdownTheme;
    private _expanded;
    constructor(message: CustomMessage<unknown>, customRenderer?: MessageRenderer, markdownTheme?: MarkdownTheme);
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    private rebuild;
}
//# sourceMappingURL=custom-message.d.ts.map