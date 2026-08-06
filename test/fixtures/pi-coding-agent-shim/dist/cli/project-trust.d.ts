import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
export declare function createProjectTrustContext(options: {
    cwd: string;
    mode: AppMode;
    settingsManager: SettingsManager;
    hasUI: boolean;
}): ProjectTrustContext;
//# sourceMappingURL=project-trust.d.ts.map