import { type SourceInfo } from "./source-info.ts";
/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
    name: string;
    description: string;
    argumentHint?: string;
    content: string;
    sourceInfo: SourceInfo;
    filePath: string;
}
/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export declare function parseCommandArgs(argsString: string): string[];
/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${N:-default} for positional arg N with default when missing/empty
 * - ${@:-default} and ${ARGUMENTS:-default} for all args with a default when empty
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument and default values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export declare function substituteArgs(content: string, args: string[]): string;
export interface LoadPromptTemplatesOptions {
    /** Working directory for project-local templates. */
    cwd: string;
    /** Agent config directory for global templates. */
    agentDir: string;
    /** Explicit prompt template paths (files or directories). */
    promptPaths: string[];
    /** Include default prompt directories. */
    includeDefaults: boolean;
}
/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. Explicit prompt paths
 */
export declare function loadPromptTemplates(options: LoadPromptTemplatesOptions): PromptTemplate[];
/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export declare function expandPromptTemplate(text: string, templates: PromptTemplate[]): string;
//# sourceMappingURL=prompt-templates.d.ts.map