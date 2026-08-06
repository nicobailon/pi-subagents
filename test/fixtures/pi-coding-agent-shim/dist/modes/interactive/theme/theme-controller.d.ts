import type { TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { type TerminalTheme, type Theme } from "./theme.ts";
type ThemeResult = {
    success: boolean;
    error?: string;
};
export declare class InteractiveThemeController {
    private readonly ui;
    private readonly settingsManager;
    private readonly showError;
    private readonly onChanged;
    private terminalTheme;
    private activeThemeName;
    private autoSyncEnabled;
    constructor(ui: TUI, settingsManager: SettingsManager, showError: (message: string) => void, onChanged: () => void);
    applyFromSettings(): Promise<void>;
    setThemeName(themeName: string, showError?: boolean): ThemeResult;
    setThemeInstance(themeInstance: Theme): ThemeResult;
    preview(themeSettingOrName: string): void;
    disableAutoSync(): void;
    getTerminalTheme(): TerminalTheme;
    private applyThemeName;
    private notifyChanged;
    private setAutoSync;
    private applyTerminalTheme;
}
export {};
//# sourceMappingURL=theme-controller.d.ts.map