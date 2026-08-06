/**
 * TUI session selector for --resume flag
 */
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;
/** Show TUI session selector and return selected session path or null if cancelled */
export declare function selectSession(currentSessionsLoader: SessionsLoader, allSessionsLoader: SessionsLoader, settingsManager: SettingsManager): Promise<string | null>;
export {};
//# sourceMappingURL=session-picker.d.ts.map