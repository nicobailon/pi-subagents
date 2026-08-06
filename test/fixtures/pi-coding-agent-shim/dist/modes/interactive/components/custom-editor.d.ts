import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export declare class CustomEditor extends Editor {
    private keybindings;
    actionHandlers: Map<AppKeybinding, () => void>;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    /** Handler for extension-registered shortcuts. Returns true if handled. */
    onExtensionShortcut?: (data: string) => boolean;
    constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions);
    /**
     * Register a handler for an app action.
     */
    onAction(action: AppKeybinding, handler: () => void): void;
    handleInput(data: string): void;
}
//# sourceMappingURL=custom-editor.d.ts.map