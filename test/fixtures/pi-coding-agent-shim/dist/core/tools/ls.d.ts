import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type TruncationResult } from "./truncate.ts";
declare const lsSchema: Type.TObject<{
    path: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TNumber>;
}>;
export type LsToolInput = Static<typeof lsSchema>;
export interface LsToolDetails {
    truncation?: TruncationResult;
    entryLimitReached?: number;
}
/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
    /** Check if path exists */
    exists: (absolutePath: string) => Promise<boolean> | boolean;
    /** Get file or directory stats. Throws if not found. */
    stat: (absolutePath: string) => Promise<{
        isDirectory: () => boolean;
    }> | {
        isDirectory: () => boolean;
    };
    /** Read directory entries */
    readdir: (absolutePath: string) => Promise<string[]> | string[];
}
export interface LsToolOptions {
    /** Custom operations for directory listing. Default: local filesystem */
    operations?: LsOperations;
}
export declare function createLsToolDefinition(cwd: string, options?: LsToolOptions): ToolDefinition<typeof lsSchema, LsToolDetails | undefined>;
export declare function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema>;
export {};
//# sourceMappingURL=ls.d.ts.map