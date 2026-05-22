import type { Message } from "@earendil-works/pi-ai";
import { isMutatingBashCommand } from "./long-running-guard.ts";

const REVIEW_ONLY_PATTERNS = [
	/\breview only\b/i,
	/\bsuggest fixes only\b/i,
	/\bonly return findings\b/i,
	/\breturn findings only\b/i,
];

const REVIEWER_REQUIRED_EDIT_PATTERNS = [
	/\bmust\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\brequired\s+to\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\bregardless\s+of\s+findings\b/i,
	/\balways\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\bapply\s+(?:the\s+)?fix(?:es)?\s+directly\b/i,
	/\bmake\s+(?:the\s+)?code\s+changes\b/i,
];

const EXPLICIT_NO_EDIT_PATTERNS = [
	/\bdo not edit\b/i,
	/\bdon't edit\b/i,
	/\bdo not modify\b/i,
	/\bdo not change files\b/i,
];

const SCOPED_NO_EDIT_CONSTRAINT_PATTERNS = [
	/\bdo not edit files?\s+outside\b/i,
	/\bdo not edit\s+outside\b/i,
	/\bdo not edit\s+unrelated files?\b/i,
	/\bdo not change\s+unrelated files?\b/i,
	/\bdo not modify\s+unrelated files?\b/i,
];

const RESEARCH_AGENT_PATTERNS = [
	/\binvestigate\b/i,
	/\bscout\b/i,
	/\bresearch(?:er)?\b/i,
];

const WORKER_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|fix|edit|modify|patch|refactor|delete)\b/i,
	/\b(?:update|add|remove|replace|create)\b(?!\s+(?:(?:a|an|the)\s+)?(?:report|summary|findings?)(?:\b|$))/i,
	/\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
];

const GENERAL_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|fix|edit|modify|patch|refactor)\b/i,
	/\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
	/\b(?:update|add|remove|replace|delete|create)\s+(?:the\s+)?(?:file|files|code|source|implementation|test|tests|component|function|module|class|method|logic|import|imports|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command)\b/i,
];

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

function stripFrameworkInstructions(task: string): string {
	return task
		.split("\n")
		.filter((line) => !/^\s*\[(?:Write to|Read from):/i.test(line))
		.filter((line) => !/^\s*(?:Create and maintain progress at:|Update progress at:|Write your findings to:)/i.test(line))
		.join("\n");
}

function stripScopedNoEditConstraints(task: string): string {
	let stripped = task;
	for (const pattern of SCOPED_NO_EDIT_CONSTRAINT_PATTERNS) {
		stripped = stripped.replace(pattern, " ");
	}
	return stripped;
}

function declaresOnlyReadOnlyTools(tools: string[] | undefined, mcpDirectTools: string[] | undefined): boolean {
	return tools !== undefined
		&& tools.length > 0
		&& (mcpDirectTools?.length ?? 0) === 0
		&& tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool));
}

export function expectsImplementationMutation(agent: string, task: string): boolean {
	const taskText = stripFrameworkInstructions(task);
	const taskTextWithoutScopedConstraints = stripScopedNoEditConstraints(taskText);
	if (REVIEW_ONLY_PATTERNS.some((pattern) => pattern.test(taskTextWithoutScopedConstraints))) return false;
	if (EXPLICIT_NO_EDIT_PATTERNS.some((pattern) => pattern.test(taskTextWithoutScopedConstraints))) return false;

	if (RESEARCH_AGENT_PATTERNS.some((pattern) => pattern.test(agent))) return false;
	if (/\breviewer\b/i.test(agent)) return REVIEWER_REQUIRED_EDIT_PATTERNS.some((pattern) => pattern.test(taskText));

	const workerIntent = agent === "worker" && WORKER_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
	if (workerIntent) return true;

	return GENERAL_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
}

export function hasMutationToolCall(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (part.name === "edit" || part.name === "write") return true;
			if (part.name !== "bash") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (typeof args.command === "string" && isMutatingBashCommand(args.command)) return true;
		}
	}
	return false;
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const expectedMutation = declaresOnlyReadOnlyTools(input.tools, input.mcpDirectTools)
		? false
		: expectsImplementationMutation(input.agent, input.task);
	const attemptedMutation = hasMutationToolCall(input.messages);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation,
	};
}
