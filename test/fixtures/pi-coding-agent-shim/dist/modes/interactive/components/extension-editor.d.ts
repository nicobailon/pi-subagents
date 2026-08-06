/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */
import { Container, type EditorOptions, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
export declare class ExtensionEditorComponent extends Container implements Focusable {
    private editor;
    private onSubmitCallback;
    private onCancelCallback;
    private tui;
    private keybindings;
    private externalEditorCommand;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(tui: TUI, keybindings: KeybindingsManager, title: string, prefill: string | undefined, onSubmit: (value: string) => void, onCancel: () => void, options?: EditorOptions, externalEditorCommand?: string);
    handleInput(keyData: string): void;
    private getExternalEditorCommand;
    private openExternalEditor;
}
//# sourceMappingURL=extension-editor.d.ts.map