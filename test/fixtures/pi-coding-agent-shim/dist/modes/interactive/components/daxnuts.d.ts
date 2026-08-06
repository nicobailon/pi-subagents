/**
 * POWERED BY DAXNUTS - Easter egg for OpenCode + Kimi K2.5
 *
 * A heartfelt tribute to dax (@thdxr) for providing free Kimi K2.5 access via OpenCode.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
export declare class DaxnutsComponent implements Component {
    private ui;
    private image;
    private interval;
    private tick;
    private maxTicks;
    private cachedLines;
    private cachedWidth;
    private cachedTick;
    constructor(ui: TUI);
    invalidate(): void;
    private startAnimation;
    private stopAnimation;
    render(width: number): string[];
    dispose(): void;
}
//# sourceMappingURL=daxnuts.d.ts.map