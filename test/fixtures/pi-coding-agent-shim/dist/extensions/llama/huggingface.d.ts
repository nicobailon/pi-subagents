export interface HuggingFaceModel {
    id: string;
    downloads: number;
}
export interface HuggingFaceQuantization {
    name: string;
    size?: number;
}
export interface HuggingFaceModelDetails {
    id: string;
    gated: false | "auto" | "manual";
    quantizations: HuggingFaceQuantization[];
}
export declare function findHuggingFaceToken(env?: NodeJS.ProcessEnv): Promise<string | undefined>;
export declare class HuggingFaceClient {
    private readonly token;
    private readonly baseUrl;
    constructor(token?: string, baseUrl?: string);
    private request;
    search(query: string, signal?: AbortSignal): Promise<HuggingFaceModel[]>;
    details(id: string, signal?: AbortSignal): Promise<HuggingFaceModelDetails>;
}
//# sourceMappingURL=huggingface.d.ts.map