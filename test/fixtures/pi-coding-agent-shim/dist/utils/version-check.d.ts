export interface LatestPiRelease {
    version: string;
    packageName?: string;
    note?: string;
}
export declare function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined;
export declare function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean;
export declare function getLatestPiRelease(currentVersion: string, options?: {
    timeoutMs?: number;
}): Promise<LatestPiRelease | undefined>;
export declare function getLatestPiVersion(currentVersion: string, options?: {
    timeoutMs?: number;
}): Promise<string | undefined>;
export declare function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined>;
//# sourceMappingURL=version-check.d.ts.map