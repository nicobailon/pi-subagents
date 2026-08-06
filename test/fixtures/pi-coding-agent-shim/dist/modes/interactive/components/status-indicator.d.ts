import { type Component, Loader, type TUI } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";
export declare class StatusIndicator extends Loader {
    readonly kind: StatusIndicatorKind;
    constructor(kind: StatusIndicatorKind, ui: TUI, spinnerColorFn: (str: string) => string, messageColorFn: (str: string) => string, message: string, indicator?: WorkingIndicatorOptions);
    dispose(): void;
}
export declare class WorkingStatusIndicator extends StatusIndicator {
    constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions);
}
export declare class RetryStatusIndicator extends StatusIndicator {
    private countdown;
    constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number);
    dispose(): void;
}
export type CompactionStatusReason = "manual" | "threshold" | "overflow";
export declare class CompactionStatusIndicator extends StatusIndicator {
    constructor(ui: TUI, reason: CompactionStatusReason);
}
export declare class BranchSummaryStatusIndicator extends StatusIndicator {
    constructor(ui: TUI);
}
export declare class IdleStatus implements Component {
    invalidate(): void;
    render(width: number): string[];
}
//# sourceMappingURL=status-indicator.d.ts.map