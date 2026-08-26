import type { Message } from "@earendil-works/pi-ai";
import type { AcceptanceRole, TrackedMutationEvidence } from "../../shared/types.ts";
import { isMutatingTool } from "./long-running-guard.ts";
import { classifyTaskMutationIntent, expectsImplementationMutation, taskMayMutate } from "./task-intent.ts";

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
	"structured_output",
]);

// Cursor native edit/write often land as thinking traces (inactive_trace /
// transcript_trace) rather than toolCall parts when native tool replay is off
// or the tool is inactive in context. Match pi-cursor-sdk display labels.
const CURSOR_FILE_MUTATION_THINKING =
	/(?:^|\n)\s*Cursor (?:edit|write)\s*:/i;

const REVIVED_TASK_PREFIX = /^You are reviving a previous subagent conversation\.\n\nOriginal run: .+\nOriginal agent: .+(?:\nOriginal session file: .+)?\n\nUse the stored session context as background\. Answer the orchestrator's follow-up below\. Do not assume the original child process is still alive\.\n\nFollow-up:\n/;
const IMPLEMENTATION_CHALLENGE_FOLLOW_UP_PATTERN = /^(?:Run )?implementation challenge pass (?:one|two|\d+)(?:\s+and implement any better current[- ]scope change\.?|\s+for the accepted candidate\.\s+Reconsider it and implement any better current[- ]scope change\.?)?$/i;
const NO_BETTER_CHANGE_NEEDED_PATTERN = /^\s*no (?:better|further|additional) (?:current[- ]scope )?(?:code |source |file )?(?:change|changes|edit|edits|patch|patches) (?:is|are) needed\b/i;
const KEPT_CURRENT_IMPLEMENTATION_PATTERN = /\b(?:kept (?:the )?current (?:implementation|candidate|shape)|(?:the )?current (?:implementation|candidate|shape) was kept)\b/i;
const NO_CHANGE_MADE_PATTERN = /\bno (?:new )?(?:(?:code|source|file|test)(?:\s*(?:,\s*or|,|\/|or)\s*(?:code|source|file|test))* changes?|changes?) (?:were|was) made\b/i;
const NO_BETTER_CHANGE_QUALIFIER_PATTERN = /\b(?:do\s+not|don't|dont|not|never|cannot|can't|cant|unable|uncertain|unsure|unclear|disagree|wrong|false|reject|rejected|rejecting|maybe|might|may|\w+n['’]t)\b/i;
const REPORT_SENTENCE_PATTERN = /[^.!?]+(?:[.!?]+(?=(?:["”'’]?\s)|["”'’]?$)|$)/g;
const QUOTED_CLAIM_PATTERN = /["“]([^"”]+)["”]([.!?]?\s*[^.!?]*)/g;
const QUOTED_CLAIM_REFERENCE_PATTERN = /\b(?:that|this|it|claim|report|message|disagree)\b/i;
const CLAIM_CONTRADICTION_PATTERN = /\bbut\b[^.!?]*\b(?:uncertain|unsure|unclear|disagree|wrong|false|reject|rejected|rejecting)\b/i;
const IMPLEMENTATION_RETRACTION_PATTERN = /\b(?:found|identified)\s+(?:(?:a|an|the)\s+)?(?:required|necessary|additional|better)?\s*(?:(?:code|source|file|test)\s+)?(?:changes?|edits?|patches?)\b|\b(?:(?:implementation|code|source|file|test)\s+)?work\s+(?:remains?|is\s+(?:needed|required))\b|\b(?:(?:a|an|the)\s+)?(?:(?:code|source|file|test)\s+)?(?:changes?|edits?|patches?)\s+(?:are|is)\s+(?:needed|required)\b|\b(?:required|necessary|additional|better)\s+(?:(?:code|source|file|test)\s+)?(?:changes?|edits?|patches?)\b|\b(?:I|we)?\s*need\s+(?:(?:code|source|file|test)\s+)?(?:changes?|edits?|patches?)\b|\b(?:need|needs|require|requires)\s+(?:to\s+)?(?:implement|make|apply)\b/i;
const IMPLEMENTATION_RETRACTION_GLOBAL_PATTERN = new RegExp(IMPLEMENTATION_RETRACTION_PATTERN.source, "gi");
const DIRECT_CLAIM_RETRACTION_PATTERN = /^\s*(?:I\s+)?(?:disagree|reject|retract)\b|\b(?:disagree|retract|retracted|retracting|reject|rejected|rejecting)\b[^.!?]*\b(?:that|this|it|claim|report|message)\b|\b(?:that|this|it|claim|report|message)\b[^.!?]*\b(?:is|was)\s+(?:rejected|retracted)\b/i;
const NEGATED_RETRACTION_PREFIX_PATTERN = /\b(?:no|not|\w+n['’]t)\b(?:\s+\w+){0,2}\s*$/i;
const REPORTED_CLAIM_PREFIX_PATTERN = /["“]|\b(?:prior|previous)\s+(?:message|report)\b|\b(?:said|stated|reported)\b/i;
const POST_CLAIM_SEPARATOR_PATTERN = /^[\s,;:.—–'"“‘’-]+/;

interface CompletionMutationGuardInput {
	agent: string;
	task: string;
	messages: Message[];
	tools?: string[];
	mcpDirectTools?: string[];
	mutationTools?: string[];
	toolAvailabilityError?: string;
	mutationEvidence?: TrackedMutationEvidence;
}

interface CompletionMutationGuardResult {
	expectedMutation: boolean;
	attemptedMutation: boolean;
	triggered: boolean;
	blocked: boolean;
	message?: string;
}

interface ReportSentence {
	text: string;
	offset: number;
}

export function hasMutationToolCapability(tools: string[] | undefined, mcpDirectTools: string[] | undefined): boolean {
	if ((mcpDirectTools?.length ?? 0) > 0) return true;
	if (tools === undefined) return true;
	return !tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool));
}

function hasBuiltinMutationTool(tools: string[] | undefined): boolean {
	return tools === undefined || tools.some((tool) => !READ_ONLY_BUILTIN_TOOLS.has(tool));
}

function isWriterRole(agent: string, acceptanceRole: AcceptanceRole | undefined): boolean {
	return acceptanceRole === "writer"
		|| (acceptanceRole === undefined && /\bworker\b/i.test(agent));
}

const WRITER_DELIVERY_PATTERN = /\b(?:address|resolve|work)\s+(?:backlog\s+)?(?:item|issue)\b|\b(?:land|ship)\s+(?:the\s+)?(?:change|changes|fix|feature|implementation)\b/i;

export function validateImplementationToolContract(input: {
	agent: string;
	task: string;
	tools?: string[];
	mcpDirectTools?: string[];
	configuredExtensions?: string[];
	requestedTools?: string[];
	acceptanceRole?: AcceptanceRole;
	completionGuard?: boolean;
}): string | undefined {
	if (input.completionGuard === false) return undefined;
	const requestedMutationTools = input.requestedTools?.filter((tool) => !READ_ONLY_BUILTIN_TOOLS.has(tool)) ?? [];
	const declaredMutationToolsWereRemoved = requestedMutationTools.length > 0 && !hasBuiltinMutationTool(input.tools);
	const configuredExtensionCapability = (input.configuredExtensions?.length ?? 0) > 0 && !declaredMutationToolsWereRemoved;
	if (hasMutationToolCapability(input.tools, input.mcpDirectTools) || configuredExtensionCapability) return undefined;
	const intent = classifyTaskMutationIntent(input.agent, input.task);
	if (intent.kind === "read-only") return undefined;
	const writerTaskMayMutate = isWriterRole(input.agent, input.acceptanceRole)
		&& (taskMayMutate(input.task) || WRITER_DELIVERY_PATTERN.test(input.task));
	if (intent.kind !== "implementation" && !writerTaskMayMutate && !declaredMutationToolsWereRemoved) return undefined;
	return `Agent '${input.agent}' was given an implementation task, but its tool allowlist has no mutation-capable tools. Add bash, edit, write, or another mutation-capable tool to the agent, or use a read-only task/agent.`;
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

export function hasMutationToolCall(messages: Message[], mutationTools?: readonly string[]): boolean {
	for (const message of messages) {
		if (hasCheckpointMutationEvidence(message)) return true;
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "thinking" && CURSOR_FILE_MUTATION_THINKING.test(part.thinking)) return true;
			if (part.type !== "toolCall") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (isMutatingTool(part.name, args, mutationTools)) return true;
		}
	}
	return false;
}

function hasImplementationRetraction(text: string): boolean {
	return Array.from(text.matchAll(IMPLEMENTATION_RETRACTION_GLOBAL_PATTERN)).some((retraction) =>
		!NEGATED_RETRACTION_PREFIX_PATTERN.test(text.slice(0, retraction.index!)));
}

function hasDirectClaimRetraction(text: string): boolean {
	return DIRECT_CLAIM_RETRACTION_PATTERN.test(text.replace(POST_CLAIM_SEPARATOR_PATTERN, ""));
}

function isInsideQuotedText(report: string, index: number): boolean {
	let quote: "double" | "single" | undefined;
	for (const char of report.slice(0, index)) {
		if (quote === "double") {
			if (char === "\"" || char === "”") quote = undefined;
		} else if (quote === "single") {
			if (char === "’") quote = undefined;
		} else if (char === "\"" || char === "“") {
			quote = "double";
		} else if (char === "‘") {
			quote = "single";
		}
	}
	return quote !== undefined;
}

function unqualifiedClaimIndex(report: string, sentences: ReportSentence[], pattern: RegExp): number {
	return sentences.findIndex((sentence) => {
		const claim = sentence.text.match(pattern);
		if (claim === null) return false;
		const before = sentence.text.slice(0, claim.index!);
		const after = sentence.text.slice(claim.index! + claim[0].length);
		const previous = before.trimEnd().at(-1);
		return previous !== "'"
			&& previous !== "‘"
			&& !isInsideQuotedText(report, sentence.offset + claim.index!)
			&& !REPORTED_CLAIM_PREFIX_PATTERN.test(before)
			&& !NO_BETTER_CHANGE_QUALIFIER_PATTERN.test(before)
			&& !CLAIM_CONTRADICTION_PATTERN.test(after)
			&& !hasImplementationRetraction(after)
			&& !hasDirectClaimRetraction(after);
	});
}

function hasLaterClaimRetraction(sentences: ReportSentence[], claimIndex: number): boolean {
	return sentences.slice(claimIndex + 1).some((sentence) => hasImplementationRetraction(sentence.text)
		|| hasDirectClaimRetraction(sentence.text));
}

function explicitlyRejectsQuotedClaim(report: string): boolean {
	for (const [, claim, response] of report.matchAll(QUOTED_CLAIM_PATTERN)) {
		if ((KEPT_CURRENT_IMPLEMENTATION_PATTERN.test(claim!) || NO_CHANGE_MADE_PATTERN.test(claim!))
			&& NO_BETTER_CHANGE_QUALIFIER_PATTERN.test(response!)
			&& QUOTED_CLAIM_REFERENCE_PATTERN.test(response!)) return true;
	}
	return false;
}

function isImplementationChallengeTask(task: string): boolean {
	const followUp = task.replace(REVIVED_TASK_PREFIX, "");
	return followUp !== task && IMPLEMENTATION_CHALLENGE_FOLLOW_UP_PATTERN.test(followUp.trim());
}

function reportsNoBetterChallengeChange(messages: Message[]): boolean {
	const report = messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.content)
		.flatMap((part) => part.type === "text" ? [part.text] : [])
		.join("\n");
	if (explicitlyRejectsQuotedClaim(report)) return false;
	const sentences = Array.from(report.matchAll(REPORT_SENTENCE_PATTERN), (match) => ({
		text: match[0],
		offset: match.index!,
	}));
	const noBetterIndex = unqualifiedClaimIndex(report, sentences, NO_BETTER_CHANGE_NEEDED_PATTERN);
	if (noBetterIndex >= 0) return !hasLaterClaimRetraction(sentences, noBetterIndex);
	const keptIndex = unqualifiedClaimIndex(report, sentences, KEPT_CURRENT_IMPLEMENTATION_PATTERN);
	const noChangeIndex = unqualifiedClaimIndex(report, sentences, NO_CHANGE_MADE_PATTERN);
	return keptIndex >= 0
		&& noChangeIndex >= 0
		&& !hasLaterClaimRetraction(sentences, Math.min(keptIndex, noChangeIndex));
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	if (input.toolAvailabilityError && expectsImplementationMutation(input.agent, input.task)) {
		return {
			expectedMutation: true,
			attemptedMutation: false,
			triggered: false,
			blocked: true,
			message: input.toolAvailabilityError,
		};
	}
	const expectedMutation = hasMutationToolCapability(input.tools, input.mcpDirectTools)
		? expectsImplementationMutation(input.agent, input.task)
		: false;
	const attemptedMutation = hasMutationToolCall(input.messages, input.mutationTools) || input.mutationEvidence?.attemptedMutation === true;
	const noEditChallengeComplete = isImplementationChallengeTask(input.task)
		&& reportsNoBetterChallengeChange(input.messages);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation && !noEditChallengeComplete,
		blocked: false,
	};
}
