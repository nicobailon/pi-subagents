import type { Message } from "@earendil-works/pi-ai";
import { isMutatingTool } from "./long-running-guard.ts";
import { expectsImplementationMutation } from "./task-intent.ts";

export { expectsImplementationMutation };

const READ_ONLY_BUILTIN_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"get_search_content",
	"intercom",
	"contact_supervisor",
]);

// Cursor native edit/write often land as thinking traces (inactive_trace /
// transcript_trace) rather than toolCall parts when native tool replay is off
// or the tool is inactive in context. Match pi-cursor-sdk display labels.
const CURSOR_FILE_MUTATION_THINKING =
	/(?:^|\n)\s*Cursor (?:edit|write)\s*:/i;

interface CompletionMutationGuardInput {
	agent: string;
	task: string;
	messages: Message[];
	tools?: string[];
	mcpDirectTools?: string[];
}

interface CompletionMutationGuardResult {
	expectedMutation: boolean;
	attemptedMutation: boolean;
	triggered: boolean;
}

export function hasMutationToolCapability(tools: string[] | undefined, mcpDirectTools: string[] | undefined): boolean {
	if (tools === undefined || tools.length === 0 || (mcpDirectTools?.length ?? 0) > 0) return true;
	return !tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool));
}

export function hasMutationToolCall(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "thinking" && CURSOR_FILE_MUTATION_THINKING.test(part.thinking)) return true;
			if (part.type !== "toolCall") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (isMutatingTool(part.name, args)) return true;
		}
	}
	return false;
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const expectedMutation = hasMutationToolCapability(input.tools, input.mcpDirectTools)
		? expectsImplementationMutation(input.agent, input.task)
		: false;
	const attemptedMutation = hasMutationToolCall(input.messages);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation,
	};
}
