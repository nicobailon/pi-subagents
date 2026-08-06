import { Container, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
/** Loader wrapped with borders for extension UI */
export declare class BorderedLoader extends Container {
    private loader;
    private cancellable;
    private signalController?;
    constructor(tui: TUI, theme: Theme, message: string, options?: {
        cancellable?: boolean;
    });
    get signal(): AbortSignal;
    set onAbort(fn: (() => void) | undefined);
    handleInput(data: string): void;
    dispose(): void;
}
//# sourceMappingURL=bordered-loader.d.ts.map