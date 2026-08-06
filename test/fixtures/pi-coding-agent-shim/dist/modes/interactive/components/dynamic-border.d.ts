import type { Component } from "@earendil-works/pi-tui";
/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export declare class DynamicBorder implements Component {
    private color;
    constructor(color?: (str: string) => string);
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=dynamic-border.d.ts.map