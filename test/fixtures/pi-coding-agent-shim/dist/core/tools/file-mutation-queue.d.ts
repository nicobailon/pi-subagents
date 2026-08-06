/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export declare function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=file-mutation-queue.d.ts.map