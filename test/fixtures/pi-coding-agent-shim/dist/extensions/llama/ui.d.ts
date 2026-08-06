import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { LlamaModelInfo, LlamaProgress } from "./client.ts";
import type { HuggingFaceModel } from "./huggingface.ts";
export type LlamaManagerAction = {
    type: "model";
    model: LlamaModelInfo;
} | {
    type: "download";
} | {
    type: "close";
};
interface ProgressState extends LlamaProgress {
    title: string;
    model: string;
}
export interface LlamaUi {
    showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction>;
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
    searchModels(search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>): Promise<string | undefined>;
    showStatus(title: string, message: string): void;
    progress(state: ProgressState): Promise<void>;
    updateProgress(state: ProgressState): void;
}
export declare function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void>;
export declare function runWithProgress<T>(ui: LlamaUi, options: {
    title: string;
    model: string;
    initialMessage: string;
    cancelTitle: string;
    cancelMessage: string;
    run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
    cancel(): Promise<void>;
}): Promise<{
    cancelled: true;
} | {
    cancelled: false;
    value: T;
}>;
export {};
//# sourceMappingURL=ui.d.ts.map