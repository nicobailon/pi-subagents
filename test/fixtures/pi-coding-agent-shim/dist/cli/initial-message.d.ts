import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";
export interface InitialMessageInput {
    parsed: Args;
    fileText?: string;
    fileImages?: ImageContent[];
    stdinContent?: string;
}
export interface InitialMessageResult {
    initialMessage?: string;
    initialImages?: ImageContent[];
}
/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export declare function buildInitialMessage({ parsed, fileText, fileImages, stdinContent }: InitialMessageInput): InitialMessageResult;
//# sourceMappingURL=initial-message.d.ts.map