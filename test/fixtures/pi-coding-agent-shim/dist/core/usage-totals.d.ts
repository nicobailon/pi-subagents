import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";
export interface UsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}
export declare function createUsageTotals(): UsageTotals;
export declare function addUsageToTotals(totals: UsageTotals, usage: Usage): void;
export interface UsageCostBreakdownEntry {
    key: string;
    cost: number;
    tokens: number;
}
/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export declare function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[];
//# sourceMappingURL=usage-totals.d.ts.map