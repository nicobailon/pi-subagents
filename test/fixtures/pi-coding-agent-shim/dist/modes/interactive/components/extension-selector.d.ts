/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */
import { Container, type TUI } from "@earendil-works/pi-tui";
export interface ExtensionSelectorOptions {
    tui?: TUI;
    timeout?: number;
    onToggleToolsExpanded?: () => void;
}
export declare class ExtensionSelectorComponent extends Container {
    private options;
    private selectedIndex;
    private listContainer;
    private onSelectCallback;
    private onCancelCallback;
    private titleText;
    private baseTitle;
    private countdown;
    private onToggleToolsExpanded;
    constructor(title: string, options: string[], onSelect: (option: string) => void, onCancel: () => void, opts?: ExtensionSelectorOptions);
    private updateList;
    handleInput(keyData: string): void;
    dispose(): void;
}
//# sourceMappingURL=extension-selector.d.ts.map