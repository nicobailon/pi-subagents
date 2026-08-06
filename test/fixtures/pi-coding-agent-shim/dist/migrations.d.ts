/**
 * One-time migrations that run on startup.
 */
/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export declare function migrateAuthToAuthJson(): string[];
/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export declare function migrateSessionsFromAgentRoot(): void;
/**
 * Print deprecation warnings and wait for keypress.
 */
export declare function showDeprecationWarnings(warnings: string[]): Promise<void>;
/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export declare function runMigrations(cwd: string): {
    migratedAuthProviders: string[];
    deprecationWarnings: string[];
};
//# sourceMappingURL=migrations.d.ts.map