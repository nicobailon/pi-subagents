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

const REVIVED_TASK_PREFIX = /^You are reviving a previous subagent conversation\.\n\nOriginal run: .+\nOriginal agent: .+(?:\nOriginal session file: .+)?\n\nUse the stored session context as background\. Answer the orchestrator's follow-up below\. Do not assume the original child process is still alive\.\n\nFollow-up:\n/;
const IMPLEMENTATION_CHALLENGE_TASK_PATTERN = new RegExp(`${REVIVED_TASK_PREFIX.source}(?:Run )?implementation challenge pass (?:one|two|\\d+)\\b`, "i");
const NO_BETTER_CHANGE_NEEDED_PATTERN = /^\s*no (?:better|further|additional) (?:current[- ]scope )?(?:code |source |file )?(?:change|changes|edit|edits|patch|patches) (?:is|are) needed\b/i;
const KEPT_CURRENT_IMPLEMENTATION_PATTERN = /\b(?:kept (?:the )?current (?:implementation|candidate|shape)|(?:the )?current (?:implementation|candidate|shape) was kept)\b/i;
const NO_CHANGE_MADE_PATTERN = /\bno (?:new )?(?:(?:code|source|file|test)(?:\s*(?:,\s*or|,|\/|or)\s*(?:code|source|file|test))* changes?|changes?) (?:were|was) made\b/i;
const NO_BETTER_CHANGE_QUALIFIER_PATTERN = /\b(?:do\s+not|don't|dont|not|never|cannot|can't|cant|unable|uncertain|unsure|unclear|disagree|wrong|false|reject|rejected|rejecting|maybe|might|may|\w+n['’]t)\b/i;
const REPORT_SENTENCE_PATTERN = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
const QUOTED_CLAIM_PATTERN = /["“]([^"”]+)["”]([.!?]?\s*[^.!?]*)/g;
const QUOTED_CLAIM_REFERENCE_PATTERN = /\b(?:that|this|it|claim|report|message|disagree)\b/i;
const CLAIM_CONTRADICTION_PATTERN = /\bbut\b[^.!?]*\b(?:uncertain|unsure|unclear|disagree|wrong|false|reject|rejected|rejecting)\b/i;

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
	if ((mcpDirectTools?.length ?? 0) > 0) return true;
	if (tools === undefined) return true;
	return !tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool));
}

function hasCheckpointMutationEvidence(message: Message): boolean {
	const record = message as unknown as {
		role?: string;
		type?: string;
		customType?: unknown;
		data?: unknown;
		details?: unknown;
	};
	if ((record.role !== "custom" && record.type !== "custom") || record.customType !== "pi-checkpoint") return false;
	const details = typeof record.details === "object" && record.details !== null && !Array.isArray(record.details)
		? record.details as Record<string, unknown>
		: undefined;
	const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
		? record.data as Record<string, unknown>
		: typeof details?.beforeCommit === "string" || typeof details?.afterCommit === "string"
			? details
			: details?.data && typeof details.data === "object" && !Array.isArray(details.data)
				? details.data as Record<string, unknown>
				: undefined;
	return typeof data?.beforeCommit === "string"
		&& typeof data.afterCommit === "string"
		&& data.beforeCommit !== data.afterCommit;
}

export function hasMutationToolCall(messages: Message[]): boolean {
	for (const message of messages) {
		if (hasCheckpointMutationEvidence(message)) return true;
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

function hasUnqualifiedClaim(sentences: string[], pattern: RegExp): boolean {
	return sentences.some((sentence) => {
		const claim = sentence.match(pattern);
		if (claim === null) return false;
		const before = sentence.slice(0, claim.index!);
		const after = sentence.slice(claim.index! + claim[0].length);
		return !NO_BETTER_CHANGE_QUALIFIER_PATTERN.test(before)
			&& !CLAIM_CONTRADICTION_PATTERN.test(after);
	});
}

function explicitlyRejectsQuotedClaim(report: string): boolean {
	for (const [, claim, response] of report.matchAll(QUOTED_CLAIM_PATTERN)) {
		if ((KEPT_CURRENT_IMPLEMENTATION_PATTERN.test(claim!) || NO_CHANGE_MADE_PATTERN.test(claim!))
			&& NO_BETTER_CHANGE_QUALIFIER_PATTERN.test(response!)
			&& QUOTED_CLAIM_REFERENCE_PATTERN.test(response!)) return true;
	}
	return false;
}

function reportsNoBetterChallengeChange(messages: Message[]): boolean {
	const report = messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.content)
		.flatMap((part) => part.type === "text" ? [part.text] : [])
		.join("\n");
	if (explicitlyRejectsQuotedClaim(report)) return false;
	const sentences = report.match(REPORT_SENTENCE_PATTERN) ?? [];
	if (hasUnqualifiedClaim(sentences, NO_BETTER_CHANGE_NEEDED_PATTERN)) return true;
	return hasUnqualifiedClaim(sentences, KEPT_CURRENT_IMPLEMENTATION_PATTERN)
		&& hasUnqualifiedClaim(sentences, NO_CHANGE_MADE_PATTERN);
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const expectedMutation = hasMutationToolCapability(input.tools, input.mcpDirectTools)
		? expectsImplementationMutation(input.agent, input.task)
		: false;
	const attemptedMutation = hasMutationToolCall(input.messages);
	const noEditChallengeComplete = IMPLEMENTATION_CHALLENGE_TASK_PATTERN.test(input.task)
		&& reportsNoBetterChallengeChange(input.messages);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation && !noEditChallengeComplete,
	};
}
