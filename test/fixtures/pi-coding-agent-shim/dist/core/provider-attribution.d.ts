import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";
export declare function mergeProviderAttributionHeaders(model: Model<Api>, settingsManager: SettingsManager, sessionId: string | undefined, ...headerSources: Array<ProviderHeaders | undefined>): ProviderHeaders | undefined;
//# sourceMappingURL=provider-attribution.d.ts.map