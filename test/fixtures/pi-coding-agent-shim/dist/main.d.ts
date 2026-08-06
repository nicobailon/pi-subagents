/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */
import type { InlineExtension } from "./core/extensions/types.ts";
export interface MainOptions {
    extensionFactories?: InlineExtension[];
}
export declare function main(args: string[], options?: MainOptions): Promise<void>;
//# sourceMappingURL=main.d.ts.map