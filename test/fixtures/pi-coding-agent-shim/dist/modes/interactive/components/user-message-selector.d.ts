import { type Component, Container } from "@earendil-works/pi-tui";
interface UserMessageItem {
    id: string;
    text: string;
    timestamp?: string;
}
/**
 * Custom user message list component with selection
 */
declare class UserMessageList implements Component {
    private messages;
    private selectedIndex;
    onSelect?: (entryId: string) => void;
    onCancel?: () => void;
    private maxVisible;
    constructor(messages: UserMessageItem[], initialSelectedId?: string);
    invalidate(): void;
    render(width: number): string[];
    handleInput(keyData: string): void;
}
/**
 * Component that renders a user message selector for branching
 */
export declare class UserMessageSelectorComponent extends Container {
    private messageList;
    constructor(messages: UserMessageItem[], onSelect: (entryId: string) => void, onCancel: () => void, initialSelectedId?: string);
    getMessageList(): UserMessageList;
}
export {};
//# sourceMappingURL=user-message-selector.d.ts.map