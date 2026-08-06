import type { Provider } from "@earendil-works/pi-ai";
import { type LlamaModelInfo } from "./client.ts";
export declare const LLAMA_PROVIDER_ID = "llama.cpp";
export declare const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
export interface LlamaProviderController {
    provider: Provider<"openai-completions">;
    setCatalog(models: readonly LlamaModelInfo[], serverUrl: string): void;
}
export declare function createLlamaProvider(): LlamaProviderController;
//# sourceMappingURL=provider.d.ts.map