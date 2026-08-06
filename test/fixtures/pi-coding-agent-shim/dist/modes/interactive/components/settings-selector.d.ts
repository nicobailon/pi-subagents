import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import { Container, SettingsList } from "@earendil-works/pi-tui";
import type { DefaultProjectTrust, WarningSettings } from "../../../core/settings-manager.ts";
import { type TerminalTheme } from "../theme/theme.ts";
export interface SettingsConfig {
    autoCompact: boolean;
    showImages: boolean;
    imageWidthCells: number;
    autoResizeImages: boolean;
    blockImages: boolean;
    enableSkillCommands: boolean;
    steeringMode: "all" | "one-at-a-time";
    followUpMode: "all" | "one-at-a-time";
    transport: Transport;
    httpIdleTimeoutMs: number;
    thinkingLevel: ThinkingLevel;
    availableThinkingLevels: ThinkingLevel[];
    currentTheme: string;
    terminalTheme: TerminalTheme;
    availableThemes: string[];
    hideThinkingBlock: boolean;
    showCacheMissNotices: boolean;
    collapseChangelog: boolean;
    enableInstallTelemetry: boolean;
    doubleEscapeAction: "fork" | "tree" | "none";
    treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
    showHardwareCursor: boolean;
    editorPaddingX: number;
    outputPad: 0 | 1;
    autocompleteMaxVisible: number;
    quietStartup: boolean;
    defaultProjectTrust: DefaultProjectTrust;
    clearOnShrink: boolean;
    showTerminalProgress: boolean;
    warnings: WarningSettings;
}
export interface SettingsCallbacks {
    onAutoCompactChange: (enabled: boolean) => void;
    onShowImagesChange: (enabled: boolean) => void;
    onImageWidthCellsChange: (width: number) => void;
    onAutoResizeImagesChange: (enabled: boolean) => void;
    onBlockImagesChange: (blocked: boolean) => void;
    onEnableSkillCommandsChange: (enabled: boolean) => void;
    onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
    onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
    onTransportChange: (transport: Transport) => void;
    onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
    onThinkingLevelChange: (level: ThinkingLevel) => void;
    onThemeChange: (theme: string) => void;
    onThemePreview?: (theme: string) => void;
    onHideThinkingBlockChange: (hidden: boolean) => void;
    onShowCacheMissNoticesChange: (shown: boolean) => void;
    onCollapseChangelogChange: (collapsed: boolean) => void;
    onEnableInstallTelemetryChange: (enabled: boolean) => void;
    onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
    onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
    onShowHardwareCursorChange: (enabled: boolean) => void;
    onEditorPaddingXChange: (padding: number) => void;
    onOutputPadChange: (padding: 0 | 1) => void;
    onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
    onQuietStartupChange: (enabled: boolean) => void;
    onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
    onClearOnShrinkChange: (enabled: boolean) => void;
    onShowTerminalProgressChange: (enabled: boolean) => void;
    onWarningsChange: (warnings: WarningSettings) => void;
    onCancel: () => void;
}
/**
 * Main settings selector component.
 */
export declare class SettingsSelectorComponent extends Container {
    private settingsList;
    constructor(config: SettingsConfig, callbacks: SettingsCallbacks);
    getSettingsList(): SettingsList;
}
//# sourceMappingURL=settings-selector.d.ts.map