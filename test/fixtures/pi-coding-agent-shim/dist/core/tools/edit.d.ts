import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Box } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type EditDiffError, type EditDiffResult } from "./edit-diff.ts";
type EditPreview = EditDiffResult | EditDiffError;
type EditRenderState = {
    callComponent?: EditCallRenderComponent;
};
declare const editSchema: Type.TObject<{
    path: Type.TString;
    edits: Type.TArray<Type.TObject<{
        oldText: Type.TString;
        newText: Type.TString;
    }>>;
}>;
export type EditToolInput = Static<typeof editSchema>;
export interface EditToolDetails {
    /** Display-oriented diff of the changes made */
    diff: string;
    /** Standard unified patch of the changes made */
    patch: string;
    /** Line number of the first change in the new file (for editor navigation) */
    firstChangedLine?: number;
}
/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
    /** Read file contents as a Buffer */
    readFile: (absolutePath: string) => Promise<Buffer>;
    /** Write content to a file */
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    /** Check if file is readable and writable (throw if not) */
    access: (absolutePath: string) => Promise<void>;
}
export interface EditToolOptions {
    /** Custom operations for file editing. Default: local filesystem */
    operations?: EditOperations;
}
type EditCallRenderComponent = Box & {
    preview?: EditPreview;
    previewArgsKey?: string;
    previewPending?: boolean;
    settledError?: boolean;
};
export declare function createEditToolDefinition(cwd: string, options?: EditToolOptions): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState>;
export declare function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema>;
export {};
//# sourceMappingURL=edit.d.ts.map