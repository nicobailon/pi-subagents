import { type Api, type AssistantMessage, type AssistantMessageEventStream, type AuthCheck, type AuthInteraction, type AuthResult, type AuthType, type Context, type Credential, type CredentialInfo, type CredentialStore, type Model, type Models, type ModelsApiStreamOptions, type ModelsRefreshOptions, type ModelsRefreshResult, type ModelsSimpleStreamOptions, type ModelsStore, type Provider } from "@earendil-works/pi-ai";
import { type AuthStatus, type CompatibilityRequestConfig, type ProviderConfigInput } from "./provider-composer.ts";
export interface CreateModelRuntimeOptions {
    /** Credential storage. Defaults to the file at authPath. */
    credentials?: CredentialStore;
    authPath?: string;
    modelsPath?: string | null;
    modelsStore?: ModelsStore;
    modelsStorePath?: string;
    /** Allow create() to refresh model catalogs over the network. Defaults to false. */
    allowModelNetwork?: boolean;
    /** Timeout for the create-time network model refresh. */
    modelRefreshTimeoutMs?: number;
    catalogBaseUrl?: string;
}
export interface ModelRuntimeAuthOverrides {
    apiKey?: string;
    env?: Record<string, string>;
}
/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export declare class ModelRuntime implements Models {
    private readonly models;
    private readonly credentials;
    private readonly defaultBuiltins;
    private readonly builtins;
    private readonly nativeExtensionProviders;
    private readonly extensionProviders;
    private readonly compositionErrors;
    private readonly modelsPath;
    private readonly modelNetworkEnabled;
    private config;
    private snapshot;
    private availabilityRefresh;
    private availabilityError;
    private constructor();
    static create(options?: CreateModelRuntimeOptions): Promise<ModelRuntime>;
    private configureRadiusProviders;
    private providerIds;
    private recomposeProvider;
    private rebuildProviders;
    private updateModelSnapshot;
    private runAvailabilityRefresh;
    private queueAvailabilityRefresh;
    /** Coalesce concurrent readers onto the pending refresh. */
    private refreshAvailability;
    /** Mutations must not observe an in-flight refresh started before them. */
    private forceRefreshAvailability;
    getProviders(): readonly Provider[];
    getProvider(providerId: string): Provider | undefined;
    getModels(providerId?: string): readonly Model<Api>[];
    getModel(providerId: string, modelId: string): Model<Api> | undefined;
    checkAuth(providerId: string): Promise<AuthCheck | undefined>;
    getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
    getAvailableSnapshot(): readonly Model<Api>[];
    getError(): string | undefined;
    getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined;
    getRegisteredProviderIds(): readonly string[];
    getRegisteredNativeProvider(providerId: string): Provider | undefined;
    /** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
    getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig;
    isUsingOAuth(providerId: string): boolean;
    hasConfiguredAuth(providerId: string): boolean;
    getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
    getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
    setRuntimeApiKey(providerId: string, apiKey: string, refreshOptions?: ModelsRefreshOptions): Promise<void>;
    removeRuntimeApiKey(providerId: string): Promise<void>;
    listCredentials(): Promise<readonly CredentialInfo[]>;
    getProviderAuthStatus(providerId: string): AuthStatus;
    private prepareRequest;
    stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream;
    complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
    streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
    completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
    login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
    logout(providerId: string): Promise<void>;
    reloadConfig(): Promise<void>;
    refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
    registerNativeProvider(provider: Provider): void;
    registerProvider(providerId: string, config: ProviderConfigInput): void;
    unregisterProvider(providerId: string): void;
}
//# sourceMappingURL=model-runtime.d.ts.map