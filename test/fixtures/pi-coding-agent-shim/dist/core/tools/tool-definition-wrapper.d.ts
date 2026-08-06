import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export declare function wrapToolDefinition<TDetails = unknown>(definition: ToolDefinition<any, TDetails>, ctxFactory?: () => ExtensionContext): AgentTool<any, TDetails>;
/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export declare function wrapToolDefinitions(definitions: ToolDefinition<any, any>[], ctxFactory?: () => ExtensionContext): AgentTool<any>[];
/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export declare function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown>;
//# sourceMappingURL=tool-definition-wrapper.d.ts.map