import type { AgentState } from "@earendil-works/pi-agent-core";
import { SessionManager } from "../session-manager.ts";
/**
 * Interface for rendering custom tools to HTML.
 * Used by agent-session to pre-render extension tool output.
 */
export interface ToolHtmlRenderer {
    /** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
    renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
    /** Render a tool result to HTML. Returns collapsed/expanded or undefined if tool has no custom renderer. */
    renderResult(toolCallId: string, toolName: string, result: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
    }>, details: unknown, isError: boolean): {
        collapsed?: string;
        expanded?: string;
    } | undefined;
}
export interface ExportOptions {
    outputPath?: string;
    themeName?: string;
    /** Optional tool renderer for custom tools */
    toolRenderer?: ToolHtmlRenderer;
}
/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
export declare function exportSessionToHtml(sm: SessionManager, state?: AgentState, options?: ExportOptions | string): Promise<string>;
/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export declare function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string>;
//# sourceMappingURL=index.d.ts.map