/**
 * Tool HTML renderer for custom tools in HTML export.
 *
 * Renders custom tool calls and results to HTML by invoking their TUI renderers
 * and converting the ANSI output to HTML.
 */
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
export interface ToolHtmlRendererDeps {
    /** Function to look up tool definition by name */
    getToolDefinition: (name: string) => ToolDefinition | undefined;
    /** Theme for styling */
    theme: Theme;
    /** Working directory for render context */
    cwd: string;
    /** Terminal width for rendering (default: 100) */
    width?: number;
}
export interface ToolHtmlRenderer {
    /** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
    renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
    /** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
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
export declare function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer;
//# sourceMappingURL=tool-renderer.d.ts.map