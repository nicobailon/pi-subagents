/**
 * TUI component for managing package resources (enable/disable)
 */
import { type Component, Container, type Focusable } from "@earendil-works/pi-tui";
import type { PathMetadata, ResolvedPaths } from "../../../core/package-manager.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
type ResourceType = "extensions" | "skills" | "prompts" | "themes";
type ConfigWriteScope = "global" | "project";
export type ScopedResolvedPaths = Record<ConfigWriteScope, ResolvedPaths>;
interface ResourceItem {
    path: string;
    enabled: boolean;
    metadata: PathMetadata;
    resourceType: ResourceType;
    displayName: string;
    groupKey: string;
    subgroupKey: string;
}
interface ResourceSubgroup {
    type: ResourceType;
    label: string;
    items: ResourceItem[];
}
interface ResourceGroup {
    key: string;
    label: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    source: string;
    subgroups: ResourceSubgroup[];
}
declare class ResourceList implements Component, Focusable {
    private groupsByScope;
    private flatItems;
    private filteredItems;
    private selectedIndex;
    private searchInput;
    private maxVisible;
    private settingsManager;
    private cwd;
    private agentDir;
    private writeScope;
    private inheritedEnabledByKey;
    onCancel?: () => void;
    onExit?: () => void;
    onToggle?: (item: ResourceItem, newEnabled: boolean) => void;
    onSwitchMode?: () => void;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(groupsByScope: Record<ConfigWriteScope, ResourceGroup[]>, settingsManager: SettingsManager, cwd: string, agentDir: string, terminalHeight?: number, writeScope?: ConfigWriteScope);
    setWriteScope(writeScope: ConfigWriteScope): void;
    private get groups();
    private buildInheritedEnabledMap;
    private buildFlatList;
    private findNextItem;
    private filterItems;
    private selectFirstItem;
    updateItem(item: ResourceItem, enabled: boolean): void;
    invalidate(): void;
    render(width: number): string[];
    handleInput(data: string): void;
    private toggleResource;
    private toggleTopLevelResource;
    private togglePackageResource;
    private renderCheckbox;
    private getItemSuffix;
    private isDimmedItem;
    private setProjectResourceOverride;
    private setProjectTopLevelOverride;
    private setProjectTopLevelPaths;
    private setProjectPackageOverride;
    private getNextOverrideState;
    private getProjectOverrideState;
    private getOverrideStateFromEntries;
    private getInheritedEnabled;
    private isInheritedGlobalItem;
    private getTopLevelOverridePatterns;
    private getResourcePatternForScope;
    private createPackageOverrideSource;
    private packageSourceStringMatches;
    private findMatchingPackageSource;
    private getPatternEntryTarget;
    private getResourceItemKey;
    private getItemScope;
    private getTopLevelBaseDir;
    private getResourcePattern;
    private getPackageResourcePattern;
}
export declare class ConfigSelectorComponent extends Container implements Focusable {
    private header;
    private resourceList;
    private writeScope;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(resolvedPaths: ScopedResolvedPaths, settingsManager: SettingsManager, cwd: string, agentDir: string, onClose: () => void, onExit: () => void, requestRender: () => void, terminalHeight?: number, writeScope?: ConfigWriteScope, projectModeAvailable?: boolean);
    private switchWriteScope;
    getResourceList(): ResourceList;
}
export {};
//# sourceMappingURL=config-selector.d.ts.map