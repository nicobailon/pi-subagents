import type { PathMetadata } from "./package-manager.ts";
export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";
export interface SourceInfo {
    path: string;
    source: string;
    scope: SourceScope;
    origin: SourceOrigin;
    baseDir?: string;
}
export declare function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo;
export declare function createSyntheticSourceInfo(path: string, options: {
    source: string;
    scope?: SourceScope;
    origin?: SourceOrigin;
    baseDir?: string;
}): SourceInfo;
//# sourceMappingURL=source-info.d.ts.map