export declare const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300000;
export declare const HTTP_IDLE_TIMEOUT_CHOICES: readonly [{
    readonly label: "30 sec";
    readonly timeoutMs: 30000;
}, {
    readonly label: "1 min";
    readonly timeoutMs: 60000;
}, {
    readonly label: "2 min";
    readonly timeoutMs: 120000;
}, {
    readonly label: "5 min";
    readonly timeoutMs: 300000;
}, {
    readonly label: "disabled";
    readonly timeoutMs: 0;
}];
export declare function parseHttpIdleTimeoutMs(value: unknown): number | undefined;
export declare function formatHttpIdleTimeoutMs(timeoutMs: number): string;
export declare function applyHttpProxySettings(httpProxy: string | undefined): void;
export declare function configureHttpDispatcher(timeoutMs?: number): void;
//# sourceMappingURL=http-dispatcher.d.ts.map