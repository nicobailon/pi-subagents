export interface ChangelogEntry {
    major: number;
    minor: number;
    patch: number;
    content: string;
}
export declare function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string;
/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export declare function parseChangelog(changelogPath: string): ChangelogEntry[];
/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export declare function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number;
/**
 * Get entries newer than lastVersion
 */
export declare function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[];
export { getChangelogPath } from "../config.ts";
//# sourceMappingURL=changelog.d.ts.map