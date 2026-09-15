import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AGENT_MEMORY_APPEND_TOOL,
	MAX_MEMORY_APPEND_BYTES,
	appendAgentMemoryRecord,
	type AgentMemoryAppendTarget,
} from "../../agents/agent-memory.ts";

export function registerAgentMemoryRuntime(pi: Pick<ExtensionAPI, "registerTool">, target: AgentMemoryAppendTarget): void {
	pi.registerTool({
		name: AGENT_MEMORY_APPEND_TOOL,
		label: "Append Agent Memory",
		description: "Append one concise durable record to this agent's configured memory without replacing concurrent entries.",
		parameters: Type.Object({
			content: Type.String({
				description: "One concise dated memory record",
				maxLength: MAX_MEMORY_APPEND_BYTES,
			}),
		}),
		async execute(_toolCallId, params) {
			const bytes = appendAgentMemoryRecord(target, params.content);
			return {
				content: [{ type: "text" as const, text: `Appended ${bytes} bytes to agent memory.` }],
				details: { bytes },
			};
		},
	});
}
