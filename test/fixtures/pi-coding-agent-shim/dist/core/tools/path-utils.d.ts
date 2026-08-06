export declare function pathExists(filePath: string): Promise<boolean>;
export declare function expandPath(filePath: string): string;
/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export declare function resolveToCwd(filePath: string, cwd: string): string;
export declare function resolveReadPath(filePath: string, cwd: string): string;
export declare function resolveReadPathAsync(filePath: string, cwd: string): Promise<string>;
//# sourceMappingURL=path-utils.d.ts.map