import { type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Model } from "@earendil-works/pi-ai/compat";
import { AgentSession } from "./agent-session.ts";
import type { LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { createBashTool, createCodingTools, createEditTool, createFindTool, createGrepTool, createLsTool, createReadOnlyTools, createReadTool, createWriteTool, withFileMutationQueue } from "./tools/index.ts";
export interface CreateAgentSessionOptions {
    /** Working directory for project-local discovery. Default: process.cwd() */
    cwd?: string;
    /** Global config directory. Default: ~/.pi/agent */
    agentDir?: string;
    /** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
    modelRuntime?: ModelRuntime;
    /** Model to use. Default: from settings, else first available */
    model?: Model<any>;
    /** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
    thinkingLevel?: ThinkingLevel;
    /** Models available for cycling (Ctrl+P in interactive mode) */
    scopedModels?: Array<{
        model: Model<any>;
        thinkingLevel?: ThinkingLevel;
    }>;
    /**
     * Optional default tool suppression mode when no explicit allowlist is provided.
     *
     * - "all": start with no tools enabled
     * - "builtin": disable the default built-in tools (read, bash, edit, write)
     *   but keep extension/custom tools enabled
     */
    noTools?: "all" | "builtin";
    /**
     * Optional allowlist of tool names.
     *
     * When omitted, pi enables the default built-in tools (read, bash, edit, write)
     * and leaves extension/custom tools enabled unless `noTools` changes that default.
     * When provided, only the listed tool names are enabled.
     */
    tools?: string[];
    /** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
    excludeTools?: string[];
    /** Custom tools to register (in addition to built-in tools). */
    customTools?: ToolDefinition[];
    /** Resource loader. When omitted, DefaultResourceLoader is used. */
    resourceLoader?: ResourceLoader;
    /** Session manager. Default: SessionManager.create(cwd) */
    sessionManager?: SessionManager;
    /** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
    settingsManager?: SettingsManager;
    /** Session start event metadata for extension runtime startup. */
    sessionStartEvent?: SessionStartEvent;
}
/** Result from createAgentSession */
export interface CreateAgentSessionResult {
    /** The created session */
    session: AgentSession;
    /** Extensions result (for UI context setup in interactive mode) */
    extensionsResult: LoadExtensionsResult;
    /** Warning if session was restored with a different model than saved */
    modelFallbackMessage?: string;
}
export * from "./agent-session-runtime.ts";
export type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory, InlineExtension, SlashCommandInfo, SlashCommandSource, ToolDefinition, } from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";
export { withFileMutationQueue, createCodingTools, createReadOnlyTools, createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool, };
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export declare function createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
//# sourceMappingURL=sdk.d.ts.map