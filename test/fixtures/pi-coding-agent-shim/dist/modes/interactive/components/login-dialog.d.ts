import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai";
import { Container, type Focusable, type TUI } from "@earendil-works/pi-tui";
/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export declare class LoginDialogComponent extends Container implements Focusable {
    private contentContainer;
    private input;
    private tui;
    private abortController;
    private inputResolver?;
    private inputRejecter?;
    private onComplete;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(tui: TUI, providerId: string, onComplete: (success: boolean, message?: string) => void, providerNameOverride?: string, titleOverride?: string);
    get signal(): AbortSignal;
    private replaceInputWithSubmittedText;
    private cancel;
    /**
     * Called by onAuth callback - show URL and optional instructions
     */
    showAuth(url: string, instructions?: string): void;
    /**
     * Called by onDeviceCode callback - show URL and user code.
     */
    showDeviceCode(info: OAuthDeviceCodeInfo): void;
    /**
     * Show input for manual code/URL entry (for callback server providers)
     */
    showManualInput(prompt: string): Promise<string>;
    /**
     * Called by onPrompt callback - show prompt and wait for input
     * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
     */
    showPrompt(message: string, placeholder?: string): Promise<string>;
    /** Show informational text before another login step. */
    showDetails(lines: string[]): void;
    /** Show provider-owned information and links without starting an auth callback flow. */
    showInfo(message: string, links?: readonly AuthInfoLink[], showCloseHint?: boolean): void;
    /**
     * Show waiting message (for polling flows like GitHub Copilot)
     */
    showWaiting(message: string): void;
    /**
     * Called by onProgress callback
     */
    showProgress(message: string): void;
    handleInput(data: string): void;
}
//# sourceMappingURL=login-dialog.d.ts.map