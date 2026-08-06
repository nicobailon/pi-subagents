/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */
import type { BashOperations } from "./tools/bash.ts";
export interface BashExecutorOptions {
    /** Callback for streaming output chunks (already sanitized) */
    onChunk?: (chunk: string) => void;
    /** AbortSignal for cancellation */
    signal?: AbortSignal;
}
export interface BashResult {
    /** Combined stdout + stderr output (sanitized, possibly truncated) */
    output: string;
    /** Process exit code (undefined if killed/cancelled) */
    exitCode: number | undefined;
    /** Whether the command was cancelled via signal */
    cancelled: boolean;
    /** Whether the output was truncated */
    truncated: boolean;
    /** Path to temp file containing full output (if output exceeded truncation threshold) */
    fullOutputPath?: string;
}
/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export declare function executeBashWithOperations(command: string, cwd: string, operations: BashOperations, options?: BashExecutorOptions): Promise<BashResult>;
//# sourceMappingURL=bash-executor.d.ts.map