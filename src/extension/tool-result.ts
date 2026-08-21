import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * Convert pi-subagents' internal logical-error result into the rejection Pi's
 * public tool boundary uses to emit a canonical errored ToolResult.
 *
 * Keep this at registered tool boundaries. Internal workflows intentionally
 * retain their return-based error handling.
 */
export function finalizeToolResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
	if (result.isError !== true) return result;

	const message = result.content
		.filter(
			(item): item is { type: "text"; text: string } =>
				item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n")
		.trim();

	throw new Error(message || "pi-subagents reported a logical tool failure.");
}
