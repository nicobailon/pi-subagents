/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable.
 */
type TimingLabel = "main" | "extensions";
export declare function resetTimings(namespace?: TimingLabel): void;
export declare function time(label: string, namespace?: TimingLabel): void;
export declare function printTimings(): void;
export {};
//# sourceMappingURL=timings.d.ts.map