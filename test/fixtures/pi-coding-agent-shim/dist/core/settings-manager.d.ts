import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
export interface CompactionSettings {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
}
export interface BranchSummarySettings {
    reserveTokens?: number;
    skipPrompt?: boolean;
}
export interface ProviderRetrySettings {
    timeoutMs?: number;
    maxRetries?: number;
    maxRetryDelayMs?: number;
}
export interface RetrySettings {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    provider?: ProviderRetrySettings;
}
export interface TerminalSettings {
    showImages?: boolean;
    imageWidthCells?: number;
    clearOnShrink?: boolean;
    showTerminalProgress?: boolean;
}
export interface ImageSettings {
    autoResize?: boolean;
    blockImages?: boolean;
}
export interface ThinkingBudgetsSettings {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
}
export interface MarkdownSettings {
    codeBlockIndent?: string;
}
export interface WarningSettings {
    anthropicExtraUsage?: boolean;
}
export type DefaultProjectTrust = "ask" | "always" | "never";
export type TransportSetting = Transport;
/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource = string | {
    source: string;
    autoload?: boolean;
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
};
export interface Settings {
    lastChangelogVersion?: string;
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: ThinkingLevel;
    transport?: TransportSetting;
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    theme?: string;
    compaction?: CompactionSettings;
    branchSummary?: BranchSummarySettings;
    retry?: RetrySettings;
    hideThinkingBlock?: boolean;
    showCacheMissNotices?: boolean;
    externalEditor?: string;
    shellPath?: string;
    quietStartup?: boolean;
    defaultProjectTrust?: DefaultProjectTrust;
    shellCommandPrefix?: string;
    npmCommand?: string[];
    collapseChangelog?: boolean;
    enableInstallTelemetry?: boolean;
    enableAnalytics?: boolean;
    trackingId?: string;
    packages?: PackageSource[];
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
    enableSkillCommands?: boolean;
    terminal?: TerminalSettings;
    images?: ImageSettings;
    enabledModels?: string[];
    doubleEscapeAction?: "fork" | "tree" | "none";
    treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
    thinkingBudgets?: ThinkingBudgetsSettings;
    editorPaddingX?: number;
    outputPad?: 0 | 1;
    autocompleteMaxVisible?: number;
    showHardwareCursor?: boolean;
    markdown?: MarkdownSettings;
    warnings?: WarningSettings;
    sessionDir?: string;
    httpProxy?: string;
    httpIdleTimeoutMs?: number;
    websocketConnectTimeoutMs?: number;
}
export type SettingsScope = "global" | "project";
export interface SettingsManagerCreateOptions {
    projectTrusted?: boolean;
}
export interface SettingsStorage {
    withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}
export interface SettingsError {
    scope: SettingsScope;
    error: Error;
}
export declare class FileSettingsStorage implements SettingsStorage {
    private globalSettingsPath;
    private projectSettingsPath;
    constructor(cwd: string, agentDir: string);
    private acquireLockSyncWithRetry;
    withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}
export declare class InMemorySettingsStorage implements SettingsStorage {
    private global;
    private project;
    withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}
export declare class SettingsManager {
    private storage;
    private globalSettings;
    private projectSettings;
    private settings;
    private projectTrusted;
    private modifiedFields;
    private modifiedNestedFields;
    private modifiedProjectFields;
    private modifiedProjectNestedFields;
    private globalSettingsLoadError;
    private projectSettingsLoadError;
    private writeQueue;
    private errors;
    private constructor();
    /** Create a SettingsManager that loads from files */
    static create(cwd: string, agentDir?: string, options?: SettingsManagerCreateOptions): SettingsManager;
    /** Create a SettingsManager from an arbitrary storage backend */
    static fromStorage(storage: SettingsStorage, options?: SettingsManagerCreateOptions): SettingsManager;
    /** Create an in-memory SettingsManager (no file I/O) */
    static inMemory(settings?: Partial<Settings>, options?: SettingsManagerCreateOptions): SettingsManager;
    private static loadFromStorage;
    private static tryLoadFromStorage;
    /** Migrate old settings format to new format */
    private static migrateSettings;
    getGlobalSettings(): Settings;
    getProjectSettings(): Settings;
    isProjectTrusted(): boolean;
    setProjectTrusted(trusted: boolean): void;
    reload(): Promise<void>;
    /** Apply additional overrides on top of current settings */
    applyOverrides(overrides: Partial<Settings>): void;
    /** Mark a global field as modified during this session */
    private markModified;
    /** Mark a project field as modified during this session */
    private markProjectModified;
    private assertProjectTrustedForWrite;
    private recordError;
    private clearModifiedScope;
    private enqueueWrite;
    private cloneModifiedNestedFields;
    private persistScopedSettings;
    private save;
    private saveProjectSettings;
    private updateProjectSettings;
    flush(): Promise<void>;
    drainErrors(): SettingsError[];
    getLastChangelogVersion(): string | undefined;
    setLastChangelogVersion(version: string): void;
    getSessionDir(): string | undefined;
    getDefaultProvider(): string | undefined;
    getDefaultModel(): string | undefined;
    setDefaultProvider(provider: string): void;
    setDefaultModel(modelId: string): void;
    setDefaultModelAndProvider(provider: string, modelId: string): void;
    getSteeringMode(): "all" | "one-at-a-time";
    setSteeringMode(mode: "all" | "one-at-a-time"): void;
    getFollowUpMode(): "all" | "one-at-a-time";
    setFollowUpMode(mode: "all" | "one-at-a-time"): void;
    getThemeSetting(): string | undefined;
    getTheme(): string | undefined;
    setTheme(theme: string): void;
    getDefaultThinkingLevel(): ThinkingLevel | undefined;
    setDefaultThinkingLevel(level: ThinkingLevel): void;
    getTransport(): TransportSetting;
    setTransport(transport: TransportSetting): void;
    getCompactionEnabled(): boolean;
    setCompactionEnabled(enabled: boolean): void;
    getCompactionReserveTokens(): number;
    getCompactionKeepRecentTokens(): number;
    getCompactionSettings(): {
        enabled: boolean;
        reserveTokens: number;
        keepRecentTokens: number;
    };
    getBranchSummarySettings(): {
        reserveTokens: number;
        skipPrompt: boolean;
    };
    getBranchSummarySkipPrompt(): boolean;
    getRetryEnabled(): boolean;
    setRetryEnabled(enabled: boolean): void;
    getRetrySettings(): {
        enabled: boolean;
        maxRetries: number;
        baseDelayMs: number;
    };
    getHttpIdleTimeoutMs(): number;
    setHttpIdleTimeoutMs(timeoutMs: number): void;
    getProviderRetrySettings(): {
        timeoutMs?: number;
        maxRetries?: number;
        maxRetryDelayMs: number;
    };
    getWebSocketConnectTimeoutMs(): number | undefined;
    getHideThinkingBlock(): boolean;
    getShowCacheMissNotices(): boolean;
    getExternalEditorCommand(): string | undefined;
    setHideThinkingBlock(hide: boolean): void;
    setShowCacheMissNotices(show: boolean): void;
    getShellPath(): string | undefined;
    setShellPath(path: string | undefined): void;
    getQuietStartup(): boolean;
    setQuietStartup(quiet: boolean): void;
    getDefaultProjectTrust(): DefaultProjectTrust;
    setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void;
    getShellCommandPrefix(): string | undefined;
    setShellCommandPrefix(prefix: string | undefined): void;
    getNpmCommand(): string[] | undefined;
    setNpmCommand(command: string[] | undefined): void;
    getCollapseChangelog(): boolean;
    setCollapseChangelog(collapse: boolean): void;
    getEnableInstallTelemetry(): boolean;
    setEnableInstallTelemetry(enabled: boolean): void;
    getEnableAnalytics(): boolean;
    getTrackingId(): string | undefined;
    /** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
    setEnableAnalytics(enabled: boolean): void;
    getPackages(): PackageSource[];
    setPackages(packages: PackageSource[]): void;
    setProjectPackages(packages: PackageSource[]): void;
    getExtensionPaths(): string[];
    setExtensionPaths(paths: string[]): void;
    setProjectExtensionPaths(paths: string[]): void;
    getSkillPaths(): string[];
    setSkillPaths(paths: string[]): void;
    setProjectSkillPaths(paths: string[]): void;
    getPromptTemplatePaths(): string[];
    setPromptTemplatePaths(paths: string[]): void;
    setProjectPromptTemplatePaths(paths: string[]): void;
    getThemePaths(): string[];
    setThemePaths(paths: string[]): void;
    setProjectThemePaths(paths: string[]): void;
    getEnableSkillCommands(): boolean;
    setEnableSkillCommands(enabled: boolean): void;
    getThinkingBudgets(): ThinkingBudgetsSettings | undefined;
    getShowImages(): boolean;
    setShowImages(show: boolean): void;
    getImageWidthCells(): number;
    setImageWidthCells(width: number): void;
    getClearOnShrink(): boolean;
    setClearOnShrink(enabled: boolean): void;
    getShowTerminalProgress(): boolean;
    setShowTerminalProgress(enabled: boolean): void;
    getImageAutoResize(): boolean;
    setImageAutoResize(enabled: boolean): void;
    getBlockImages(): boolean;
    setBlockImages(blocked: boolean): void;
    getEnabledModels(): string[] | undefined;
    setEnabledModels(patterns: string[] | undefined): void;
    getDoubleEscapeAction(): "fork" | "tree" | "none";
    setDoubleEscapeAction(action: "fork" | "tree" | "none"): void;
    getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all";
    setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void;
    getShowHardwareCursor(): boolean;
    setShowHardwareCursor(enabled: boolean): void;
    getEditorPaddingX(): number;
    setEditorPaddingX(padding: number): void;
    getOutputPad(): 0 | 1;
    setOutputPad(padding: 0 | 1): void;
    getAutocompleteMaxVisible(): number;
    setAutocompleteMaxVisible(maxVisible: number): void;
    getCodeBlockIndent(): string;
    getWarnings(): WarningSettings;
    setWarnings(warnings: WarningSettings): void;
}
//# sourceMappingURL=settings-manager.d.ts.map