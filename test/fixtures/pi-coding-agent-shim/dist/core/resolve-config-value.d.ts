/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */
export declare function getConfigValueEnvVarName(config: string): string | undefined;
export declare function getConfigValueEnvVarNames(config: string): string[];
export declare function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[];
export declare function isCommandConfigValue(config: string): boolean;
export declare function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean;
/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export declare function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined;
/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export declare function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined;
export declare function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string;
/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export declare function resolveHeaders(headers: Record<string, string> | undefined, env?: Record<string, string>): Record<string, string> | undefined;
export declare function resolveHeadersOrThrow(headers: Record<string, string> | undefined, description: string, env?: Record<string, string>): Record<string, string> | undefined;
/** Clear the config value command cache. Exported for testing. */
export declare function clearConfigValueCache(): void;
//# sourceMappingURL=resolve-config-value.d.ts.map