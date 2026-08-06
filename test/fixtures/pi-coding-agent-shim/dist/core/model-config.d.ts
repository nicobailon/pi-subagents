/** Immutable, credential-blind models.json snapshot. */
import { type Static, Type } from "typebox";
declare const ModelDefinitionSchema: Type.TObject<{
    id: Type.TString;
    name: Type.TOptional<Type.TString>;
    api: Type.TOptional<Type.TString>;
    baseUrl: Type.TOptional<Type.TString>;
    reasoning: Type.TOptional<Type.TBoolean>;
    thinkingLevelMap: Type.TOptional<Type.TObject<{
        off: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        minimal: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        low: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        medium: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        high: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        xhigh: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        max: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    }>>;
    input: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"image">]>>>;
    cost: Type.TOptional<Type.TObject<{
        input: Type.TNumber;
        output: Type.TNumber;
        cacheRead: Type.TNumber;
        cacheWrite: Type.TNumber;
        tiers: Type.TOptional<Type.TArray<Type.TObject<{
            input: Type.TNumber;
            output: Type.TNumber;
            cacheRead: Type.TNumber;
            cacheWrite: Type.TNumber;
            inputTokensAbove: Type.TNumber;
        }>>>;
    }>>;
    contextWindow: Type.TOptional<Type.TNumber>;
    maxTokens: Type.TOptional<Type.TNumber>;
    headers: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    compat: Type.TOptional<Type.TUnion<[Type.TObject<{
        supportsStore: Type.TOptional<Type.TBoolean>;
        supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
        supportsReasoningEffort: Type.TOptional<Type.TBoolean>;
        supportsUsageInStreaming: Type.TOptional<Type.TBoolean>;
        maxTokensField: Type.TOptional<Type.TUnion<[Type.TLiteral<"max_completion_tokens">, Type.TLiteral<"max_tokens">]>>;
        requiresToolResultName: Type.TOptional<Type.TBoolean>;
        requiresAssistantAfterToolResult: Type.TOptional<Type.TBoolean>;
        requiresThinkingAsText: Type.TOptional<Type.TBoolean>;
        requiresReasoningContentOnAssistantMessages: Type.TOptional<Type.TBoolean>;
        thinkingFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openrouter">, Type.TLiteral<"together">, Type.TLiteral<"deepseek">, Type.TLiteral<"zai">, Type.TLiteral<"qwen">, Type.TLiteral<"chat-template">, Type.TLiteral<"qwen-chat-template">, Type.TLiteral<"string-thinking">, Type.TLiteral<"ant-ling">]>>;
        chatTemplateKwargs: Type.TOptional<Type.TRecord<"^.*$", Type.TUnion<[Type.TUnion<[Type.TString, Type.TNumber, Type.TBoolean, Type.TNull]>, Type.TObject<{
            $var: Type.TUnion<[Type.TLiteral<"thinking.enabled">, Type.TLiteral<"thinking.effort">]>;
            omitWhenOff: Type.TOptional<Type.TBoolean>;
        }>]>>>;
        cacheControlFormat: Type.TOptional<Type.TLiteral<"anthropic">>;
        openRouterRouting: Type.TOptional<Type.TObject<{
            allow_fallbacks: Type.TOptional<Type.TBoolean>;
            require_parameters: Type.TOptional<Type.TBoolean>;
            data_collection: Type.TOptional<Type.TUnion<[Type.TLiteral<"deny">, Type.TLiteral<"allow">]>>;
            zdr: Type.TOptional<Type.TBoolean>;
            enforce_distillable_text: Type.TOptional<Type.TBoolean>;
            order: Type.TOptional<Type.TArray<Type.TString>>;
            only: Type.TOptional<Type.TArray<Type.TString>>;
            ignore: Type.TOptional<Type.TArray<Type.TString>>;
            quantizations: Type.TOptional<Type.TArray<Type.TString>>;
            sort: Type.TOptional<Type.TUnion<[Type.TString, Type.TObject<{
                by: Type.TOptional<Type.TString>;
                partition: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            }>]>>;
            max_price: Type.TOptional<Type.TObject<{
                prompt: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                completion: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                image: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                audio: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                request: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
            }>>;
            preferred_min_throughput: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                p50: Type.TOptional<Type.TNumber>;
                p75: Type.TOptional<Type.TNumber>;
                p90: Type.TOptional<Type.TNumber>;
                p99: Type.TOptional<Type.TNumber>;
            }>]>>;
            preferred_max_latency: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                p50: Type.TOptional<Type.TNumber>;
                p75: Type.TOptional<Type.TNumber>;
                p90: Type.TOptional<Type.TNumber>;
                p99: Type.TOptional<Type.TNumber>;
            }>]>>;
        }>>;
        vercelGatewayRouting: Type.TOptional<Type.TObject<{
            only: Type.TOptional<Type.TArray<Type.TString>>;
            order: Type.TOptional<Type.TArray<Type.TString>>;
        }>>;
        supportsStrictMode: Type.TOptional<Type.TBoolean>;
        sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
        deferredToolsMode: Type.TOptional<Type.TLiteral<"kimi">>;
        sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
    }>, Type.TObject<{
        supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
        sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        supportsToolSearch: Type.TOptional<Type.TBoolean>;
    }>, Type.TObject<{
        supportsEagerToolInputStreaming: Type.TOptional<Type.TBoolean>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
        supportsCacheControlOnTools: Type.TOptional<Type.TBoolean>;
        forceAdaptiveThinking: Type.TOptional<Type.TBoolean>;
        supportsToolReferences: Type.TOptional<Type.TBoolean>;
    }>]>>;
}>;
declare const ModelOverrideSchema: Type.TObject<{
    name: Type.TOptional<Type.TString>;
    reasoning: Type.TOptional<Type.TBoolean>;
    thinkingLevelMap: Type.TOptional<Type.TObject<{
        off: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        minimal: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        low: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        medium: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        high: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        xhigh: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        max: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    }>>;
    input: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"image">]>>>;
    cost: Type.TOptional<Type.TObject<{
        input: Type.TOptional<Type.TNumber>;
        output: Type.TOptional<Type.TNumber>;
        cacheRead: Type.TOptional<Type.TNumber>;
        cacheWrite: Type.TOptional<Type.TNumber>;
        tiers: Type.TOptional<Type.TArray<Type.TObject<{
            input: Type.TNumber;
            output: Type.TNumber;
            cacheRead: Type.TNumber;
            cacheWrite: Type.TNumber;
            inputTokensAbove: Type.TNumber;
        }>>>;
    }>>;
    contextWindow: Type.TOptional<Type.TNumber>;
    maxTokens: Type.TOptional<Type.TNumber>;
    headers: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    compat: Type.TOptional<Type.TUnion<[Type.TObject<{
        supportsStore: Type.TOptional<Type.TBoolean>;
        supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
        supportsReasoningEffort: Type.TOptional<Type.TBoolean>;
        supportsUsageInStreaming: Type.TOptional<Type.TBoolean>;
        maxTokensField: Type.TOptional<Type.TUnion<[Type.TLiteral<"max_completion_tokens">, Type.TLiteral<"max_tokens">]>>;
        requiresToolResultName: Type.TOptional<Type.TBoolean>;
        requiresAssistantAfterToolResult: Type.TOptional<Type.TBoolean>;
        requiresThinkingAsText: Type.TOptional<Type.TBoolean>;
        requiresReasoningContentOnAssistantMessages: Type.TOptional<Type.TBoolean>;
        thinkingFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openrouter">, Type.TLiteral<"together">, Type.TLiteral<"deepseek">, Type.TLiteral<"zai">, Type.TLiteral<"qwen">, Type.TLiteral<"chat-template">, Type.TLiteral<"qwen-chat-template">, Type.TLiteral<"string-thinking">, Type.TLiteral<"ant-ling">]>>;
        chatTemplateKwargs: Type.TOptional<Type.TRecord<"^.*$", Type.TUnion<[Type.TUnion<[Type.TString, Type.TNumber, Type.TBoolean, Type.TNull]>, Type.TObject<{
            $var: Type.TUnion<[Type.TLiteral<"thinking.enabled">, Type.TLiteral<"thinking.effort">]>;
            omitWhenOff: Type.TOptional<Type.TBoolean>;
        }>]>>>;
        cacheControlFormat: Type.TOptional<Type.TLiteral<"anthropic">>;
        openRouterRouting: Type.TOptional<Type.TObject<{
            allow_fallbacks: Type.TOptional<Type.TBoolean>;
            require_parameters: Type.TOptional<Type.TBoolean>;
            data_collection: Type.TOptional<Type.TUnion<[Type.TLiteral<"deny">, Type.TLiteral<"allow">]>>;
            zdr: Type.TOptional<Type.TBoolean>;
            enforce_distillable_text: Type.TOptional<Type.TBoolean>;
            order: Type.TOptional<Type.TArray<Type.TString>>;
            only: Type.TOptional<Type.TArray<Type.TString>>;
            ignore: Type.TOptional<Type.TArray<Type.TString>>;
            quantizations: Type.TOptional<Type.TArray<Type.TString>>;
            sort: Type.TOptional<Type.TUnion<[Type.TString, Type.TObject<{
                by: Type.TOptional<Type.TString>;
                partition: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            }>]>>;
            max_price: Type.TOptional<Type.TObject<{
                prompt: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                completion: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                image: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                audio: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                request: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
            }>>;
            preferred_min_throughput: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                p50: Type.TOptional<Type.TNumber>;
                p75: Type.TOptional<Type.TNumber>;
                p90: Type.TOptional<Type.TNumber>;
                p99: Type.TOptional<Type.TNumber>;
            }>]>>;
            preferred_max_latency: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                p50: Type.TOptional<Type.TNumber>;
                p75: Type.TOptional<Type.TNumber>;
                p90: Type.TOptional<Type.TNumber>;
                p99: Type.TOptional<Type.TNumber>;
            }>]>>;
        }>>;
        vercelGatewayRouting: Type.TOptional<Type.TObject<{
            only: Type.TOptional<Type.TArray<Type.TString>>;
            order: Type.TOptional<Type.TArray<Type.TString>>;
        }>>;
        supportsStrictMode: Type.TOptional<Type.TBoolean>;
        sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
        deferredToolsMode: Type.TOptional<Type.TLiteral<"kimi">>;
        sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
    }>, Type.TObject<{
        supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
        sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        supportsToolSearch: Type.TOptional<Type.TBoolean>;
    }>, Type.TObject<{
        supportsEagerToolInputStreaming: Type.TOptional<Type.TBoolean>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
        supportsCacheControlOnTools: Type.TOptional<Type.TBoolean>;
        forceAdaptiveThinking: Type.TOptional<Type.TBoolean>;
        supportsToolReferences: Type.TOptional<Type.TBoolean>;
    }>]>>;
}>;
declare const ProviderConfigSchema: Type.TObject<{
    name: Type.TOptional<Type.TString>;
    baseUrl: Type.TOptional<Type.TString>;
    apiKey: Type.TOptional<Type.TString>;
    api: Type.TOptional<Type.TString>;
    oauth: Type.TOptional<Type.TLiteral<"radius">>;
    headers: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    compat: Type.TOptional<Type.TUnion<[Type.TObject<{
        supportsStore: Type.TOptional<Type.TBoolean>;
        supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
        supportsReasoningEffort: Type.TOptional<Type.TBoolean>;
        supportsUsageInStreaming: Type.TOptional<Type.TBoolean>;
        maxTokensField: Type.TOptional<Type.TUnion<[Type.TLiteral<"max_completion_tokens">, Type.TLiteral<"max_tokens">]>>;
        requiresToolResultName: Type.TOptional<Type.TBoolean>;
        requiresAssistantAfterToolResult: Type.TOptional<Type.TBoolean>;
        requiresThinkingAsText: Type.TOptional<Type.TBoolean>;
        requiresReasoningContentOnAssistantMessages: Type.TOptional<Type.TBoolean>;
        thinkingFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openrouter">, Type.TLiteral<"together">, Type.TLiteral<"deepseek">, Type.TLiteral<"zai">, Type.TLiteral<"qwen">, Type.TLiteral<"chat-template">, Type.TLiteral<"qwen-chat-template">, Type.TLiteral<"string-thinking">, Type.TLiteral<"ant-ling">]>>;
        chatTemplateKwargs: Type.TOptional<Type.TRecord<"^.*$", Type.TUnion<[Type.TUnion<[Type.TString, Type.TNumber, Type.TBoolean, Type.TNull]>, Type.TObject<{
            $var: Type.TUnion<[Type.TLiteral<"thinking.enabled">, Type.TLiteral<"thinking.effort">]>;
            omitWhenOff: Type.TOptional<Type.TBoolean>;
        }>]>>>;
        cacheControlFormat: Type.TOptional<Type.TLiteral<"anthropic">>;
        openRouterRouting: Type.TOptional<Type.TObject<{
            allow_fallbacks: Type.TOptional<Type.TBoolean>;
            require_parameters: Type.TOptional<Type.TBoolean>;
            data_collection: Type.TOptional<Type.TUnion<[Type.TLiteral<"deny">, Type.TLiteral<"allow">]>>;
            zdr: Type.TOptional<Type.TBoolean>;
            enforce_distillable_text: Type.TOptional<Type.TBoolean>;
            order: Type.TOptional<Type.TArray<Type.TString>>;
            only: Type.TOptional<Type.TArray<Type.TString>>;
            ignore: Type.TOptional<Type.TArray<Type.TString>>;
            quantizations: Type.TOptional<Type.TArray<Type.TString>>;
            sort: Type.TOptional<Type.TUnion<[Type.TString, Type.TObject<{
                by: Type.TOptional<Type.TString>;
                partition: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            }>]>>;
            max_price: Type.TOptional<Type.TObject<{
                prompt: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                completion: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                image: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                audio: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                request: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
            }>>;
            preferred_min_throughput: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                p50: Type.TOptional<Type.TNumber>;
                p75: Type.TOptional<Type.TNumber>;
                p90: Type.TOptional<Type.TNumber>;
                p99: Type.TOptional<Type.TNumber>;
            }>]>>;
            preferred_max_latency: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                p50: Type.TOptional<Type.TNumber>;
                p75: Type.TOptional<Type.TNumber>;
                p90: Type.TOptional<Type.TNumber>;
                p99: Type.TOptional<Type.TNumber>;
            }>]>>;
        }>>;
        vercelGatewayRouting: Type.TOptional<Type.TObject<{
            only: Type.TOptional<Type.TArray<Type.TString>>;
            order: Type.TOptional<Type.TArray<Type.TString>>;
        }>>;
        supportsStrictMode: Type.TOptional<Type.TBoolean>;
        sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
        deferredToolsMode: Type.TOptional<Type.TLiteral<"kimi">>;
        sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
    }>, Type.TObject<{
        supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
        sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        supportsToolSearch: Type.TOptional<Type.TBoolean>;
    }>, Type.TObject<{
        supportsEagerToolInputStreaming: Type.TOptional<Type.TBoolean>;
        supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
        supportsCacheControlOnTools: Type.TOptional<Type.TBoolean>;
        forceAdaptiveThinking: Type.TOptional<Type.TBoolean>;
        supportsToolReferences: Type.TOptional<Type.TBoolean>;
    }>]>>;
    authHeader: Type.TOptional<Type.TBoolean>;
    models: Type.TOptional<Type.TArray<Type.TObject<{
        id: Type.TString;
        name: Type.TOptional<Type.TString>;
        api: Type.TOptional<Type.TString>;
        baseUrl: Type.TOptional<Type.TString>;
        reasoning: Type.TOptional<Type.TBoolean>;
        thinkingLevelMap: Type.TOptional<Type.TObject<{
            off: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            minimal: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            low: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            medium: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            high: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            xhigh: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            max: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        }>>;
        input: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"image">]>>>;
        cost: Type.TOptional<Type.TObject<{
            input: Type.TNumber;
            output: Type.TNumber;
            cacheRead: Type.TNumber;
            cacheWrite: Type.TNumber;
            tiers: Type.TOptional<Type.TArray<Type.TObject<{
                input: Type.TNumber;
                output: Type.TNumber;
                cacheRead: Type.TNumber;
                cacheWrite: Type.TNumber;
                inputTokensAbove: Type.TNumber;
            }>>>;
        }>>;
        contextWindow: Type.TOptional<Type.TNumber>;
        maxTokens: Type.TOptional<Type.TNumber>;
        headers: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
        compat: Type.TOptional<Type.TUnion<[Type.TObject<{
            supportsStore: Type.TOptional<Type.TBoolean>;
            supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
            supportsReasoningEffort: Type.TOptional<Type.TBoolean>;
            supportsUsageInStreaming: Type.TOptional<Type.TBoolean>;
            maxTokensField: Type.TOptional<Type.TUnion<[Type.TLiteral<"max_completion_tokens">, Type.TLiteral<"max_tokens">]>>;
            requiresToolResultName: Type.TOptional<Type.TBoolean>;
            requiresAssistantAfterToolResult: Type.TOptional<Type.TBoolean>;
            requiresThinkingAsText: Type.TOptional<Type.TBoolean>;
            requiresReasoningContentOnAssistantMessages: Type.TOptional<Type.TBoolean>;
            thinkingFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openrouter">, Type.TLiteral<"together">, Type.TLiteral<"deepseek">, Type.TLiteral<"zai">, Type.TLiteral<"qwen">, Type.TLiteral<"chat-template">, Type.TLiteral<"qwen-chat-template">, Type.TLiteral<"string-thinking">, Type.TLiteral<"ant-ling">]>>;
            chatTemplateKwargs: Type.TOptional<Type.TRecord<"^.*$", Type.TUnion<[Type.TUnion<[Type.TString, Type.TNumber, Type.TBoolean, Type.TNull]>, Type.TObject<{
                $var: Type.TUnion<[Type.TLiteral<"thinking.enabled">, Type.TLiteral<"thinking.effort">]>;
                omitWhenOff: Type.TOptional<Type.TBoolean>;
            }>]>>>;
            cacheControlFormat: Type.TOptional<Type.TLiteral<"anthropic">>;
            openRouterRouting: Type.TOptional<Type.TObject<{
                allow_fallbacks: Type.TOptional<Type.TBoolean>;
                require_parameters: Type.TOptional<Type.TBoolean>;
                data_collection: Type.TOptional<Type.TUnion<[Type.TLiteral<"deny">, Type.TLiteral<"allow">]>>;
                zdr: Type.TOptional<Type.TBoolean>;
                enforce_distillable_text: Type.TOptional<Type.TBoolean>;
                order: Type.TOptional<Type.TArray<Type.TString>>;
                only: Type.TOptional<Type.TArray<Type.TString>>;
                ignore: Type.TOptional<Type.TArray<Type.TString>>;
                quantizations: Type.TOptional<Type.TArray<Type.TString>>;
                sort: Type.TOptional<Type.TUnion<[Type.TString, Type.TObject<{
                    by: Type.TOptional<Type.TString>;
                    partition: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                }>]>>;
                max_price: Type.TOptional<Type.TObject<{
                    prompt: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    completion: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    image: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    audio: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    request: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                }>>;
                preferred_min_throughput: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                    p50: Type.TOptional<Type.TNumber>;
                    p75: Type.TOptional<Type.TNumber>;
                    p90: Type.TOptional<Type.TNumber>;
                    p99: Type.TOptional<Type.TNumber>;
                }>]>>;
                preferred_max_latency: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                    p50: Type.TOptional<Type.TNumber>;
                    p75: Type.TOptional<Type.TNumber>;
                    p90: Type.TOptional<Type.TNumber>;
                    p99: Type.TOptional<Type.TNumber>;
                }>]>>;
            }>>;
            vercelGatewayRouting: Type.TOptional<Type.TObject<{
                only: Type.TOptional<Type.TArray<Type.TString>>;
                order: Type.TOptional<Type.TArray<Type.TString>>;
            }>>;
            supportsStrictMode: Type.TOptional<Type.TBoolean>;
            sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
            deferredToolsMode: Type.TOptional<Type.TLiteral<"kimi">>;
            sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
            supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        }>, Type.TObject<{
            supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
            sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
            supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
            supportsToolSearch: Type.TOptional<Type.TBoolean>;
        }>, Type.TObject<{
            supportsEagerToolInputStreaming: Type.TOptional<Type.TBoolean>;
            supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
            sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
            supportsCacheControlOnTools: Type.TOptional<Type.TBoolean>;
            forceAdaptiveThinking: Type.TOptional<Type.TBoolean>;
            supportsToolReferences: Type.TOptional<Type.TBoolean>;
        }>]>>;
    }>>>;
    modelOverrides: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
        name: Type.TOptional<Type.TString>;
        reasoning: Type.TOptional<Type.TBoolean>;
        thinkingLevelMap: Type.TOptional<Type.TObject<{
            off: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            minimal: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            low: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            medium: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            high: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            xhigh: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
            max: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        }>>;
        input: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"image">]>>>;
        cost: Type.TOptional<Type.TObject<{
            input: Type.TOptional<Type.TNumber>;
            output: Type.TOptional<Type.TNumber>;
            cacheRead: Type.TOptional<Type.TNumber>;
            cacheWrite: Type.TOptional<Type.TNumber>;
            tiers: Type.TOptional<Type.TArray<Type.TObject<{
                input: Type.TNumber;
                output: Type.TNumber;
                cacheRead: Type.TNumber;
                cacheWrite: Type.TNumber;
                inputTokensAbove: Type.TNumber;
            }>>>;
        }>>;
        contextWindow: Type.TOptional<Type.TNumber>;
        maxTokens: Type.TOptional<Type.TNumber>;
        headers: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
        compat: Type.TOptional<Type.TUnion<[Type.TObject<{
            supportsStore: Type.TOptional<Type.TBoolean>;
            supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
            supportsReasoningEffort: Type.TOptional<Type.TBoolean>;
            supportsUsageInStreaming: Type.TOptional<Type.TBoolean>;
            maxTokensField: Type.TOptional<Type.TUnion<[Type.TLiteral<"max_completion_tokens">, Type.TLiteral<"max_tokens">]>>;
            requiresToolResultName: Type.TOptional<Type.TBoolean>;
            requiresAssistantAfterToolResult: Type.TOptional<Type.TBoolean>;
            requiresThinkingAsText: Type.TOptional<Type.TBoolean>;
            requiresReasoningContentOnAssistantMessages: Type.TOptional<Type.TBoolean>;
            thinkingFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openrouter">, Type.TLiteral<"together">, Type.TLiteral<"deepseek">, Type.TLiteral<"zai">, Type.TLiteral<"qwen">, Type.TLiteral<"chat-template">, Type.TLiteral<"qwen-chat-template">, Type.TLiteral<"string-thinking">, Type.TLiteral<"ant-ling">]>>;
            chatTemplateKwargs: Type.TOptional<Type.TRecord<"^.*$", Type.TUnion<[Type.TUnion<[Type.TString, Type.TNumber, Type.TBoolean, Type.TNull]>, Type.TObject<{
                $var: Type.TUnion<[Type.TLiteral<"thinking.enabled">, Type.TLiteral<"thinking.effort">]>;
                omitWhenOff: Type.TOptional<Type.TBoolean>;
            }>]>>>;
            cacheControlFormat: Type.TOptional<Type.TLiteral<"anthropic">>;
            openRouterRouting: Type.TOptional<Type.TObject<{
                allow_fallbacks: Type.TOptional<Type.TBoolean>;
                require_parameters: Type.TOptional<Type.TBoolean>;
                data_collection: Type.TOptional<Type.TUnion<[Type.TLiteral<"deny">, Type.TLiteral<"allow">]>>;
                zdr: Type.TOptional<Type.TBoolean>;
                enforce_distillable_text: Type.TOptional<Type.TBoolean>;
                order: Type.TOptional<Type.TArray<Type.TString>>;
                only: Type.TOptional<Type.TArray<Type.TString>>;
                ignore: Type.TOptional<Type.TArray<Type.TString>>;
                quantizations: Type.TOptional<Type.TArray<Type.TString>>;
                sort: Type.TOptional<Type.TUnion<[Type.TString, Type.TObject<{
                    by: Type.TOptional<Type.TString>;
                    partition: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
                }>]>>;
                max_price: Type.TOptional<Type.TObject<{
                    prompt: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    completion: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    image: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    audio: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                    request: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TString]>>;
                }>>;
                preferred_min_throughput: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                    p50: Type.TOptional<Type.TNumber>;
                    p75: Type.TOptional<Type.TNumber>;
                    p90: Type.TOptional<Type.TNumber>;
                    p99: Type.TOptional<Type.TNumber>;
                }>]>>;
                preferred_max_latency: Type.TOptional<Type.TUnion<[Type.TNumber, Type.TObject<{
                    p50: Type.TOptional<Type.TNumber>;
                    p75: Type.TOptional<Type.TNumber>;
                    p90: Type.TOptional<Type.TNumber>;
                    p99: Type.TOptional<Type.TNumber>;
                }>]>>;
            }>>;
            vercelGatewayRouting: Type.TOptional<Type.TObject<{
                only: Type.TOptional<Type.TArray<Type.TString>>;
                order: Type.TOptional<Type.TArray<Type.TString>>;
            }>>;
            supportsStrictMode: Type.TOptional<Type.TBoolean>;
            sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
            deferredToolsMode: Type.TOptional<Type.TLiteral<"kimi">>;
            sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
            supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
        }>, Type.TObject<{
            supportsDeveloperRole: Type.TOptional<Type.TBoolean>;
            sessionAffinityFormat: Type.TOptional<Type.TUnion<[Type.TLiteral<"openai">, Type.TLiteral<"openai-nosession">, Type.TLiteral<"openrouter">]>>;
            supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
            supportsToolSearch: Type.TOptional<Type.TBoolean>;
        }>, Type.TObject<{
            supportsEagerToolInputStreaming: Type.TOptional<Type.TBoolean>;
            supportsLongCacheRetention: Type.TOptional<Type.TBoolean>;
            sendSessionAffinityHeaders: Type.TOptional<Type.TBoolean>;
            supportsCacheControlOnTools: Type.TOptional<Type.TBoolean>;
            forceAdaptiveThinking: Type.TOptional<Type.TBoolean>;
            supportsToolReferences: Type.TOptional<Type.TBoolean>;
        }>]>>;
    }>>>;
}>;
export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;
/** One immutable load of models.json. */
export declare class ModelConfig {
    private readonly providers;
    private readonly error;
    private constructor();
    static load(modelsJsonPath: string | undefined): Promise<ModelConfig>;
    getProvider(providerId: string): ModelsJsonProvider | undefined;
    getProviderIds(): readonly string[];
    getError(): string | undefined;
}
export {};
//# sourceMappingURL=model-config.d.ts.map