/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
/**
 * Options for print mode.
 */
export interface PrintModeOptions {
    /** Output mode: "text" for final response only, "json" for all events */
    mode: "text" | "json";
    /** Array of additional prompts to send after initialMessage */
    messages?: string[];
    /** First message to send (may contain @file content) */
    initialMessage?: string;
    /** Images to attach to the initial message */
    initialImages?: ImageContent[];
}
/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export declare function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number>;
//# sourceMappingURL=print-mode.d.ts.map