/**
 * Armin says hi! A fun easter egg with animated XBM art.
 */
import type { Component, TUI } from "@earendil-works/pi-tui";
export declare class ArminComponent implements Component {
    private ui;
    private interval;
    private effect;
    private finalGrid;
    private currentGrid;
    private effectState;
    private cachedLines;
    private cachedWidth;
    private gridVersion;
    private cachedVersion;
    constructor(ui: TUI);
    invalidate(): void;
    render(width: number): string[];
    private createEmptyGrid;
    private initEffect;
    private startAnimation;
    private stopAnimation;
    private tickEffect;
    private tickTypewriter;
    private tickScanline;
    private tickRain;
    private tickFade;
    private tickCrt;
    private tickGlitch;
    private tickDissolve;
    private updateDisplay;
    dispose(): void;
}
//# sourceMappingURL=armin.d.ts.map