import { type Api, type AssistantMessageEventStream, type Context, type Model, type OAuthCredentials, type OAuthLoginCallbacks, type Provider, type ProviderHeaders, type RefreshModelsContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelConfig, ModelsJsonProvider } from "./model-config.ts";
import { clearConfigValueCache } from "./resolve-config-value.ts";
export interface ExtensionOAuthConfig {
    name: string;
    /** @deprecated Retained for extension source compatibility; ignored by canonical auth flows. */
    usesCallbackServer?: boolean;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}
/** Input type for the extension registerProvider API. */
export interface ProviderConfigInput {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    api?: Api;
    streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
    headers?: Record<string, string>;
    authHeader?: boolean;
    oauth?: ExtensionOAuthConfig;
    models?: Array<{
        id: string;
        name: string;
        api?: Api;
        baseUrl?: string;
        reasoning: boolean;
        thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
        input: ("text" | "image")[];
        cost: Model<Api>["cost"];
        contextWindow: number;
        maxTokens: number;
        headers?: Record<string, string>;
        compat?: Model<Api>["compat"];
    }>;
    refreshModels?(context: RefreshModelsContext): Promise<NonNullable<ProviderConfigInput["models"]>>;
}
export type AuthStatus = {
    configured: boolean;
    source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
    label?: string;
};
export declare const clearApiKeyCache: typeof clearConfigValueCache;
export declare function validateExtensionProvider(providerId: string, base: Provider | undefined, modelsConfig: ModelsJsonProvider | undefined, extension: ProviderConfigInput): void;
/** Compose built-in, models.json, and extension layers without reading credentials. */
export declare function composeModelProvider(providerId: string, base: Provider | undefined, modelConfig: ModelConfig, extension: ProviderConfigInput | undefined): Provider;
export declare function resolveConfiguredModelHeaders(model: Model<Api>, config: ModelsJsonProvider | undefined, extension: ProviderConfigInput | undefined, env?: Record<string, string>): Record<string, string> | undefined;
export interface CompatibilityRequestConfig {
    headers?: ProviderHeaders;
    authHeader: boolean;
}
export declare function resolveCompatibilityRequestConfig(model: Model<Api>, config: ModelsJsonProvider | undefined, extension: ProviderConfigInput | undefined): CompatibilityRequestConfig;
export declare function configuredRequestAuthStatus(config: ModelsJsonProvider | undefined, extension: ProviderConfigInput | undefined): AuthStatus | undefined;
//# sourceMappingURL=provider-composer.d.ts.map