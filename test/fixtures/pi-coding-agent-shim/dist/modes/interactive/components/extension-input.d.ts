/**
 * Simple text input component for extensions.
 */
import { Container, type Focusable, type TUI } from "@earendil-works/pi-tui";
export interface ExtensionInputOptions {
    tui?: TUI;
    timeout?: number;
}
export declare class ExtensionInputComponent extends Container implements Focusable {
    private input;
    private onSubmitCallback;
    private onCancelCallback;
    private titleText;
    private baseTitle;
    private countdown;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(title: string, _placeholder: string | undefined, onSubmit: (value: string) => void, onCancel: () => void, opts?: ExtensionInputOptions);
    handleInput(keyData: string): void;
    dispose(): void;
}
//# sourceMappingURL=extension-input.d.ts.map