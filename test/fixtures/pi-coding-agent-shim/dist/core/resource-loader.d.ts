import { type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";
import { type EventBus } from "./event-bus.ts";
import type { InlineExtension, LoadExtensionsResult } from "./extensions/types.ts";
import { type PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
export interface ResourceExtensionPaths {
    skillPaths?: Array<{
        path: string;
        metadata: PathMetadata;
    }>;
    promptPaths?: Array<{
        path: string;
        metadata: PathMetadata;
    }>;
    themePaths?: Array<{
        path: string;
        metadata: PathMetadata;
    }>;
}
export interface ResourceLoaderReloadOptions {
    resolveProjectTrust?: (input: {
        extensionsResult: LoadExtensionsResult;
    }) => Promise<boolean>;
}
export interface ResourceLoader {
    getExtensions(): LoadExtensionsResult;
    getSkills(): {
        skills: Skill[];
        diagnostics: ResourceDiagnostic[];
    };
    getPrompts(): {
        prompts: PromptTemplate[];
        diagnostics: ResourceDiagnostic[];
    };
    getThemes(): {
        themes: Theme[];
        diagnostics: ResourceDiagnostic[];
    };
    getAgentsFiles(): {
        agentsFiles: Array<{
            path: string;
            content: string;
        }>;
    };
    getSystemPrompt(): string | undefined;
    getAppendSystemPrompt(): string[];
    extendResources(paths: ResourceExtensionPaths): void;
    reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}
export declare function loadProjectContextFiles(options: {
    cwd: string;
    agentDir: string;
}): Array<{
    path: string;
    content: string;
}>;
export interface DefaultResourceLoaderOptions {
    cwd: string;
    agentDir: string;
    settingsManager?: SettingsManager;
    eventBus?: EventBus;
    additionalExtensionPaths?: string[];
    additionalSkillPaths?: string[];
    additionalPromptTemplatePaths?: string[];
    additionalThemePaths?: string[];
    extensionFactories?: InlineExtension[];
    noExtensions?: boolean;
    noSkills?: boolean;
    noPromptTemplates?: boolean;
    noThemes?: boolean;
    noContextFiles?: boolean;
    systemPrompt?: string;
    appendSystemPrompt?: string[];
    extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
    skillsOverride?: (base: {
        skills: Skill[];
        diagnostics: ResourceDiagnostic[];
    }) => {
        skills: Skill[];
        diagnostics: ResourceDiagnostic[];
    };
    promptsOverride?: (base: {
        prompts: PromptTemplate[];
        diagnostics: ResourceDiagnostic[];
    }) => {
        prompts: PromptTemplate[];
        diagnostics: ResourceDiagnostic[];
    };
    themesOverride?: (base: {
        themes: Theme[];
        diagnostics: ResourceDiagnostic[];
    }) => {
        themes: Theme[];
        diagnostics: ResourceDiagnostic[];
    };
    agentsFilesOverride?: (base: {
        agentsFiles: Array<{
            path: string;
            content: string;
        }>;
    }) => {
        agentsFiles: Array<{
            path: string;
            content: string;
        }>;
    };
    systemPromptOverride?: (base: string | undefined) => string | undefined;
    appendSystemPromptOverride?: (base: string[]) => string[];
}
export declare class DefaultResourceLoader implements ResourceLoader {
    private cwd;
    private agentDir;
    private settingsManager;
    private eventBus;
    private packageManager;
    private additionalExtensionPaths;
    private additionalSkillPaths;
    private additionalPromptTemplatePaths;
    private additionalThemePaths;
    private extensionFactories;
    private noExtensions;
    private noSkills;
    private noPromptTemplates;
    private noThemes;
    private noContextFiles;
    private systemPromptSource?;
    private appendSystemPromptSource?;
    private extensionsOverride?;
    private skillsOverride?;
    private promptsOverride?;
    private themesOverride?;
    private agentsFilesOverride?;
    private systemPromptOverride?;
    private appendSystemPromptOverride?;
    private extensionsResult;
    private skills;
    private skillDiagnostics;
    private prompts;
    private promptDiagnostics;
    private themes;
    private themeDiagnostics;
    private agentsFiles;
    private systemPrompt?;
    private appendSystemPrompt;
    private lastSkillPaths;
    private extensionSkillSourceInfos;
    private extensionPromptSourceInfos;
    private extensionThemeSourceInfos;
    private lastPromptPaths;
    private lastThemePaths;
    private loaded;
    constructor(options: DefaultResourceLoaderOptions);
    getExtensions(): LoadExtensionsResult;
    getSkills(): {
        skills: Skill[];
        diagnostics: ResourceDiagnostic[];
    };
    getPrompts(): {
        prompts: PromptTemplate[];
        diagnostics: ResourceDiagnostic[];
    };
    getThemes(): {
        themes: Theme[];
        diagnostics: ResourceDiagnostic[];
    };
    getAgentsFiles(): {
        agentsFiles: Array<{
            path: string;
            content: string;
        }>;
    };
    getSystemPrompt(): string | undefined;
    getAppendSystemPrompt(): string[];
    extendResources(paths: ResourceExtensionPaths): void;
    loadProjectTrustExtensions(): Promise<LoadExtensionsResult>;
    reload(options?: ResourceLoaderReloadOptions): Promise<void>;
    private loadCurrentExtensionSet;
    private resolveExtensionLoadPath;
    private loadFinalExtensionSet;
    private addExtensionConflictDiagnostics;
    private mapSkillPath;
    private normalizeExtensionPaths;
    private updateSkillsFromPaths;
    private updatePromptsFromPaths;
    private updateThemesFromPaths;
    private applyExtensionSourceInfo;
    private findSourceInfoForPath;
    private getDefaultSourceInfoForPath;
    private mergePaths;
    private resolveResourcePath;
    private loadThemes;
    private loadThemesFromDir;
    private loadThemeFromFile;
    private loadExtensionFactories;
    private dedupePrompts;
    private dedupeThemes;
    private discoverSystemPromptFile;
    private discoverAppendSystemPromptFile;
    private isUnderPath;
    private detectExtensionConflicts;
}
//# sourceMappingURL=resource-loader.d.ts.map