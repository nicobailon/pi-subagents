export type LlamaModelStatus = "unloaded" | "loading" | "loaded" | "downloading" | "sleeping";
export interface LlamaModelInfo {
    id: string;
    aliases?: string[];
    status: {
        value: LlamaModelStatus;
        args?: string[];
        failed?: boolean;
        exit_code?: number;
        progress?: Record<string, {
            done: number;
            total: number;
        }>;
    };
    architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
    };
    source?: string;
    meta?: {
        n_ctx?: number;
        n_ctx_train?: number;
        size?: number;
        ftype?: string;
    };
}
export interface LlamaModelsResponse {
    data: LlamaModelInfo[];
    object?: string;
}
export interface LlamaModelEvent {
    model: string;
    event: string;
    data?: unknown;
}
export interface LlamaProgress {
    message: string;
    ratio?: number;
    detail?: string;
}
export declare function formatBytes(bytes: number): string;
export declare function normalizeLlamaServerUrl(value: string): string;
export declare function llamaInferenceUrl(serverUrl: string): string;
export declare class LlamaClient {
    readonly serverUrl: string;
    private readonly apiKey;
    constructor(serverUrl: string, apiKey?: string);
    private request;
    list(options?: {
        reload?: boolean;
        signal?: AbortSignal;
    }): Promise<LlamaModelInfo[]>;
    load(model: string, signal?: AbortSignal): Promise<void>;
    unload(model: string, signal?: AbortSignal): Promise<void>;
    unloadAndWait(model: string, signal?: AbortSignal): Promise<void>;
    download(model: string, signal?: AbortSignal): Promise<void>;
    watch(onEvent: (event: LlamaModelEvent) => void, signal?: AbortSignal): Promise<void>;
    loadAndWait(model: string, onProgress: (progress: LlamaProgress) => void, signal?: AbortSignal): Promise<LlamaModelInfo>;
    downloadAndWait(model: string, onProgress: (progress: LlamaProgress) => void, signal?: AbortSignal): Promise<LlamaModelInfo[]>;
}
//# sourceMappingURL=client.d.ts.map