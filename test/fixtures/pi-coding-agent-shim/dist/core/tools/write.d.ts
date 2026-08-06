import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
declare const writeSchema: Type.TObject<{
    path: Type.TString;
    content: Type.TString;
}>;
export type WriteToolInput = Static<typeof writeSchema>;
/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
    /** Write content to a file */
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    /** Create directory recursively */
    mkdir: (dir: string) => Promise<void>;
}
export interface WriteToolOptions {
    /** Custom operations for file writing. Default: local filesystem */
    operations?: WriteOperations;
}
export declare function createWriteToolDefinition(cwd: string, options?: WriteToolOptions): ToolDefinition<typeof writeSchema, undefined>;
export declare function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema>;
export {};
//# sourceMappingURL=write.d.ts.map