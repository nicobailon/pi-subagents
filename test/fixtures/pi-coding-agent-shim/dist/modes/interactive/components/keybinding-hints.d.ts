/**
 * Utilities for formatting keybinding hints in the UI.
 */
import { type Keybinding } from "@earendil-works/pi-tui";
export interface KeyTextFormatOptions {
    capitalize?: boolean;
}
export declare function formatKeyText(key: string, options?: KeyTextFormatOptions): string;
export declare function keyText(keybinding: Keybinding): string;
export declare function keyDisplayText(keybinding: Keybinding): string;
export declare function keyHint(keybinding: Keybinding, description: string): string;
export declare function rawKeyHint(key: string, description: string): string;
//# sourceMappingURL=keybinding-hints.d.ts.map