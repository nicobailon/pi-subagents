/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export declare class FooterDataProvider {
    private cwd;
    private static readonly WATCH_DEBOUNCE_MS;
    private extensionStatuses;
    private cachedBranch;
    private gitPaths;
    private headWatcher;
    private headWatchFilePath;
    private headWatchFileListener;
    private reftableWatcher;
    private reftableTablesListWatcher;
    private reftableTablesListPath;
    private branchChangeCallbacks;
    private availableProviderCount;
    private refreshTimer;
    private gitWatcherRetryTimer;
    private refreshInFlight;
    private refreshPending;
    private disposed;
    constructor(cwd: string);
    /** Current git branch, null if not in repo, "detached" if detached HEAD */
    getGitBranch(): string | null;
    /** Extension status texts set via ctx.ui.setStatus() */
    getExtensionStatuses(): ReadonlyMap<string, string>;
    /** Subscribe to git branch changes. Returns unsubscribe function. */
    onBranchChange(callback: () => void): () => void;
    /** Internal: set extension status */
    setExtensionStatus(key: string, text: string | undefined): void;
    /** Internal: clear extension statuses */
    clearExtensionStatuses(): void;
    /** Number of unique providers with available models (for footer display) */
    getAvailableProviderCount(): number;
    /** Internal: update available provider count */
    setAvailableProviderCount(count: number): void;
    setCwd(cwd: string): void;
    /** Internal: cleanup */
    dispose(): void;
    private notifyBranchChange;
    private scheduleRefresh;
    private refreshGitBranchAsync;
    private resolveGitBranchSync;
    private resolveGitBranchAsync;
    private clearGitWatchers;
    private scheduleGitWatcherRetry;
    private handleGitWatcherError;
    private setupGitWatcher;
}
/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<FooterDataProvider, "getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange">;
//# sourceMappingURL=footer-data-provider.d.ts.map