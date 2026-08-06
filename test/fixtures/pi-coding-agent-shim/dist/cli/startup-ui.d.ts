import { TUI } from "@earendil-works/pi-tui";
import { SettingsManager } from "../core/settings-manager.ts";
export declare function createStartupTui(settingsManager: SettingsManager): Promise<TUI>;
export declare function startStartupTui(ui: TUI, settingsManager: SettingsManager): void;
/**
 * First-time setup runs when all of these hold:
 * - this is the official Pi distribution (not a fork/rebrand)
 * - experimental features are enabled (PI_EXPERIMENTAL=1)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 */
export declare function shouldRunFirstTimeSetup(settingsPath?: string): boolean;
export declare function showStartupSelector<T>(settingsManager: SettingsManager, title: string, options: Array<{
    label: string;
    value: T;
}>): Promise<T | undefined>;
/** Show the first-time setup dialog and persist the result */
export declare function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void>;
export declare function showStartupInput(settingsManager: SettingsManager, title: string, placeholder?: string): Promise<string | undefined>;
//# sourceMappingURL=startup-ui.d.ts.map