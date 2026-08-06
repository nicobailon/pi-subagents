import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type TruncationResult } from "./truncate.ts";
declare const bashSchema: Type.TObject<{
    command: Type.TString;
    timeout: Type.TOptional<Type.TNumber>;
}>;
export type BashToolInput = Static<typeof bashSchema>;
export interface BashToolDetails {
    truncation?: TruncationResult;
    fullOutputPath?: string;
}
/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
    /**
     * Execute a command and stream output.
     * @param command The command to execute
     * @param cwd Working directory
     * @param options Execution options
     * @returns Promise resolving to exit code (null if killed)
     */
    exec: (command: string, cwd: string, options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
    }) => Promise<{
        exitCode: number | null;
    }>;
}
/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export declare function createLocalBashOperations(options?: {
    shellPath?: string;
}): BashOperations;
export interface BashSpawnContext {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
}
export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;
export interface BashToolOptions {
    /** Custom operations for command execution. Default: local shell */
    operations?: BashOperations;
    /** Command prefix prepended to every command (for example shell setup commands) */
    commandPrefix?: string;
    /** Optional explicit shell path from settings */
    shellPath?: string;
    /** Hook to adjust command, cwd, or env before execution */
    spawnHook?: BashSpawnHook;
}
type BashRenderState = {
    startedAt: number | undefined;
    endedAt: number | undefined;
    interval: NodeJS.Timeout | undefined;
};
export declare function createBashToolDefinition(cwd: string, options?: BashToolOptions): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState>;
export declare function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema>;
export {};
//# sourceMappingURL=bash.d.ts.map