/**
 * Parsed git URL information.
 */
export type GitSource = {
    /** Always "git" for git sources */
    type: "git";
    /** Clone URL (always valid for git clone, without ref suffix) */
    repo: string;
    /** Git host domain (e.g., "github.com") */
    host: string;
    /** Repository path (e.g., "user/repo") */
    path: string;
    /** Git ref (branch, tag, commit) if specified */
    ref?: string;
    /** True if ref was specified (package won't be auto-updated) */
    pinned: boolean;
};
/**
 * Parse git source into a GitSource.
 *
 * Rules:
 * - With git: prefix, accept all historical shorthand forms.
 * - Without git: prefix, only accept explicit protocol URLs.
 */
export declare function parseGitUrl(source: string): GitSource | null;
//# sourceMappingURL=git.d.ts.map