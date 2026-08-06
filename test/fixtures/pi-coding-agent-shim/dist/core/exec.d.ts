/**
 * Shared command execution utilities for extensions and custom tools.
 */
/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
    /** AbortSignal to cancel the command */
    signal?: AbortSignal;
    /** Timeout in milliseconds */
    timeout?: number;
    /** Working directory */
    cwd?: string;
}
/**
 * Result of executing a shell command.
 */
export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
}
/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export declare function execCommand(command: string, args: string[], cwd: string, options?: ExecOptions): Promise<ExecResult>;
//# sourceMappingURL=exec.d.ts.map