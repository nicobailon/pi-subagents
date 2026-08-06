import type { SettingsManager } from "./settings-manager.ts";
export interface PathMetadata {
    source: string;
    scope: SourceScope;
    origin: "package" | "top-level";
    baseDir?: string;
}
export interface ResolvedResource {
    path: string;
    enabled: boolean;
    metadata: PathMetadata;
}
export interface ResolvedPaths {
    extensions: ResolvedResource[];
    skills: ResolvedResource[];
    prompts: ResolvedResource[];
    themes: ResolvedResource[];
}
export type MissingSourceAction = "install" | "skip" | "error";
export interface ProgressEvent {
    type: "start" | "progress" | "complete" | "error";
    action: "install" | "remove" | "update" | "clone" | "pull";
    source: string;
    message?: string;
}
export type ProgressCallback = (event: ProgressEvent) => void;
export interface PackageUpdate {
    source: string;
    displayName: string;
    type: "npm" | "git";
    scope: Exclude<SourceScope, "temporary">;
}
export interface ConfiguredPackage {
    source: string;
    scope: "user" | "project";
    filtered: boolean;
    installedPath?: string;
}
export interface PackageManager {
    resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
    install(source: string, options?: {
        local?: boolean;
    }): Promise<void>;
    installAndPersist(source: string, options?: {
        local?: boolean;
    }): Promise<void>;
    remove(source: string, options?: {
        local?: boolean;
    }): Promise<void>;
    removeAndPersist(source: string, options?: {
        local?: boolean;
    }): Promise<boolean>;
    update(source?: string): Promise<void>;
    listConfiguredPackages(): ConfiguredPackage[];
    resolveExtensionSources(sources: string[], options?: {
        local?: boolean;
        temporary?: boolean;
    }): Promise<ResolvedPaths>;
    addSourceToSettings(source: string, options?: {
        local?: boolean;
    }): boolean;
    removeSourceFromSettings(source: string, options?: {
        local?: boolean;
    }): boolean;
    setProgressCallback(callback: ProgressCallback | undefined): void;
    getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}
interface PackageManagerOptions {
    cwd: string;
    agentDir: string;
    settingsManager: SettingsManager;
}
type SourceScope = "user" | "project" | "temporary";
export declare function getExtensionTempFolder(agentDir: string): string;
export declare class DefaultPackageManager implements PackageManager {
    private cwd;
    private agentDir;
    private settingsManager;
    private globalNpmRoot;
    private globalNpmRootCommandKey;
    private progressCallback;
    constructor(options: PackageManagerOptions);
    setProgressCallback(callback: ProgressCallback | undefined): void;
    addSourceToSettings(source: string, options?: {
        local?: boolean;
    }): boolean;
    removeSourceFromSettings(source: string, options?: {
        local?: boolean;
    }): boolean;
    getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
    private emitProgress;
    private withProgress;
    resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
    resolveExtensionSources(sources: string[], options?: {
        local?: boolean;
        temporary?: boolean;
    }): Promise<ResolvedPaths>;
    listConfiguredPackages(): ConfiguredPackage[];
    install(source: string, options?: {
        local?: boolean;
    }): Promise<void>;
    installAndPersist(source: string, options?: {
        local?: boolean;
    }): Promise<void>;
    remove(source: string, options?: {
        local?: boolean;
    }): Promise<void>;
    removeAndPersist(source: string, options?: {
        local?: boolean;
    }): Promise<boolean>;
    update(source?: string): Promise<void>;
    private updateConfiguredSources;
    private shouldUpdateNpmSource;
    private updateNpmBatch;
    private installNpmBatch;
    checkForAvailableUpdates(): Promise<PackageUpdate[]>;
    private resolvePackageSources;
    private findAutoloadDeltaBase;
    private resolveLocalExtensionSource;
    private installParsedSource;
    private getPackageSourceString;
    private getSourceMatchKeyForInput;
    private getSourceMatchKeyForSettings;
    private buildNoMatchingPackageMessage;
    private findSuggestedConfiguredSource;
    private packageSourcesMatch;
    private normalizePackageSourceForSettings;
    private parseSource;
    private installedNpmMatchesConfiguredVersion;
    private npmHasAvailableUpdate;
    private getInstalledNpmVersion;
    private getLatestNpmVersion;
    private gitHasAvailableUpdate;
    private getRemoteGitHead;
    private getLocalGitUpdateTarget;
    private getGitUpstreamRef;
    private runGitRemoteCommand;
    private runWithConcurrency;
    /**
     * Get a unique identity for a package, ignoring version/ref.
     * Used to detect when the same package is in both global and project settings.
     * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
     * for the same repository are treated as identical.
     */
    private getPackageIdentity;
    /**
     * Dedupe packages: if same package identity appears in both global and project,
     * keep only the project one (project wins). A project entry with autoload=false
     * is a delta over the global entry, so both are kept (delta first).
     */
    private dedupePackages;
    private parseNpmSpec;
    private assertProjectTrustedForScope;
    private getNpmCommand;
    private getPackageManagerName;
    private runNpmCommand;
    private getGitDependencyInstallArgs;
    private runNpmCommandSync;
    private getNpmInstallArgs;
    private installNpm;
    private uninstallNpm;
    private installGit;
    private updateGit;
    private ensureGitRef;
    private refreshTemporaryGitSource;
    private removeGit;
    private pruneEmptyGitParents;
    private ensureNpmProject;
    private ensureGitIgnore;
    private getNpmInstallRoot;
    private getGlobalNpmRoot;
    private getPnpmGlobalPackagePath;
    private getManagedNpmInstallPath;
    private getLegacyGlobalNpmInstallPath;
    private getNpmInstallPath;
    private getGitInstallPath;
    private getGitInstallRoot;
    private getTemporaryDir;
    private resolveManagedPath;
    private getBaseDirForScope;
    private resolvePath;
    private resolvePathFromBase;
    private collectPackageResources;
    private collectDefaultResources;
    private applyPackageFilter;
    private applyPackageDeltaFilter;
    /**
     * Collect all files from a package for a resource type, applying manifest patterns.
     * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
     * that pass the manifest's own patterns.
     */
    private collectManifestFiles;
    private readPiManifest;
    private addManifestEntries;
    private collectFilesFromManifestEntries;
    private resolveLocalEntries;
    private addAutoDiscoveredResources;
    private collectFilesFromPaths;
    private getTargetMap;
    private addResource;
    private createAccumulator;
    private toResolvedPaths;
    private spawnCommand;
    private spawnCaptureCommand;
    private runCommandCapture;
    private runCommand;
    private runCommandSync;
}
export {};
//# sourceMappingURL=package-manager.d.ts.map