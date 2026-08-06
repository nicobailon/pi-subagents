export interface PathInputOptions {
    /** Trim leading/trailing whitespace before normalization. */
    trim?: boolean;
    /** Expand leading `~` to a home directory. Defaults to true. */
    expandTilde?: boolean;
    /** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
    homeDir?: string;
    /** Strip a leading `@`, used for CLI @file paths. */
    stripAtPrefix?: boolean;
    /** Normalize unicode space variants to regular spaces. */
    normalizeUnicodeSpaces?: boolean;
}
/**
 * Resolve a path to its canonical (real) form, following symlinks.
 * Falls back to the raw path if resolution fails (e.g. the target does
 * not exist yet), so that callers never crash on missing filesystem
 * entries.
 */
export declare function canonicalizePath(path: string): string;
/**
 * Returns true if the value is NOT a package source (npm:, git:, etc.)
 * or a remote URL protocol. Bare names, relative paths, and file: URLs
 * are considered local.
 */
export declare function isLocalPath(value: string): boolean;
export declare function normalizePath(input: string, options?: PathInputOptions): string;
export declare function resolvePath(input: string, baseDir?: string, options?: PathInputOptions): string;
export declare function getCwdRelativePath(filePath: string, cwd: string): string | undefined;
export declare function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string;
export declare function markPathIgnoredByCloudSync(path: string): void;
//# sourceMappingURL=paths.d.ts.map