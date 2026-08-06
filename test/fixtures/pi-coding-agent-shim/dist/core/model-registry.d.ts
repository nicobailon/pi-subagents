import type { Api, AuthResult, Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";
export type { ProviderConfigInput } from "./provider-composer.ts";
export type ResolvedRequestAuth = {
    ok: true;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
} | {
    ok: false;
    error: string;
};
export { clearApiKeyCache } from "./provider-composer.ts";
/**
 * Synchronous compatibility facade exposed to extensions.
 * Coding-agent internals use ModelRuntime directly.
 */
export declare class ModelRegistry {
    private readonly runtime;
    constructor(runtime: ModelRuntime);
    /** Reload models.json asynchronously. Await before making synchronous registry reads. */
    refresh(): Promise<void>;
    getError(): string | undefined;
    getAll(): Model<Api>[];
    getAvailable(): Model<Api>[];
    find(provider: string, modelId: string): Model<Api> | undefined;
    hasConfiguredAuth(model: Model<Api>): boolean;
    getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>;
    getProviderAuthStatus(provider: string): AuthStatus;
    getProvider(provider: string): Provider | undefined;
    getProviderDisplayName(provider: string): string;
    getProviderAuth(provider: string): Promise<AuthResult | undefined>;
    getApiKeyForProvider(provider: string): Promise<string | undefined>;
    isUsingOAuth(model: Model<Api>): boolean;
    registerProvider(provider: Provider): void;
    registerProvider(providerName: string, config: ProviderConfigInput): void;
    unregisterProvider(providerName: string): void;
    getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined;
    getRegisteredNativeProvider(providerName: string): Provider | undefined;
    getRegisteredProviderIds(): readonly string[];
}
//# sourceMappingURL=model-registry.d.ts.map