/**
 * Shared task mutation-intent classifier.
 *
 * Single authority for reading a task's wording, answering two different
 * questions from one prohibition analysis:
 *
 * - `classifyTaskMutationIntent` / `expectsImplementationMutation`: does the
 *   task REQUIRE file changes? Consumed by the completion mutation guard,
 *   which blocks completion, so its vocabulary is deliberately narrow.
 * - `taskMayMutate`: COULD the task plausibly change files? Consumed by
 *   acceptance level inference, which only raises evidence gates, so its
 *   vocabulary is deliberately broad (any bare write verb).
 *
 * Explicit read-only wording ("do not modify", "review only") is a task-level
 * intent only when no write imperative survives outside those phrases. A task
 * like "Do not modify tests; implement the fix" is an implementation task with
 * a scoped constraint, not a read-only task.
 */

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

// The prohibition's object ends at punctuation or at a coordinating word
// (but/and/then), so a follow-on clause like "but implement the fix" stays in
// the text for write-intent testing instead of being swallowed as the object.
const NO_EDIT_PROHIBITION_PATTERN = /\b(?:do not|don't|must not)\s+(?:edit|modify|write(?:\s+to)?|touch|change)\b((?:(?!\b(?:but|and|then)\b)[^.;,:!?\n–—-])*)/gi;

/** Objects of a no-edit prohibition that mean "the codebase in general" rather than a named scope. */
const GENERIC_PROHIBITION_OBJECT = /^\s*(?:(?:any|all|the|these|those|your|our|existing|project|source|sources|repo|repository)[\s/,-]*)*(?:files?|code|codebase|sources?|anything|repo(?:sitory)?)?\s*$/i;

const SCOPED_NO_EDIT_CONSTRAINT_PATTERNS = [
	/\bdo not edit files?\s+outside\b/i,
	/\bdo not edit\s+outside\b/i,
	/\bdo not edit\s+unrelated files?\b/i,
	/\bdo not change\s+unrelated files?\b/i,
	/\bdo not modify\s+unrelated files?\b/i,
];

const NO_TOOL_INTENT_PATTERNS = [
	/\bno tools? needed\b/i,
	/\bno tools? required\b/i,
	/\bwithout using tools\b/i,
	/\bdo not use tools\b/i,
	/\bdon't use tools\b/i,
];

const READ_ONLY_DELIVERABLE_PATTERNS = [
	/\b(?:draft|write|compose|prepare|produce)\s+(?:(?:a|an|the)\s+)?(?:github\s+)?(?:issue|bug report|issue draft|issue body|proposal|plan|report|summary|findings?|analysis|recommendations?)\b/i,
	/\b(?:issue|bug report)\s+(?:draft|body|template)\b/i,
	/\b(?:return|provide|produce)\s+(?:text|markdown|answer|findings?|recommendations?)\s+only\b/i,
];

const RESEARCH_AGENT_PATTERNS = [
	/\binvestigate\b/i,
	/\bscout\b/i,
	/\bresearch(?:er)?\b/i,
];

const FIX_OR_PATCH_IMPLEMENTATION_PATTERN = /\b(?:fix|patch)\s+(?:(?:it|this|that|them|each|any|all|these|those)\b|(?:(?:a|an|the|any|all)\s+)?(?:(?:failing|failed|broken|flaky|red|cold|start|current|existing|reported|approved|known|regression|unit|integration|e2e|source|typescript|type-?script|ts|type-?check|compiler)\s+)*(?:bug|defect|issues?|problems?|failures?|regressions?|tests?|errors?|items?|typos?|code|source|implementation|component|function|module|class|method|logic|file|files|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command|lint(?:ing)?|build|ci|type-?check|type\s+checking)\b)/i;

const WORKER_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|edit|modify|refactor|delete)\b/i,
	FIX_OR_PATCH_IMPLEMENTATION_PATTERN,
	/\b(?:update|add|remove|replace|create)\b(?!\s+(?:(?:a|an|the)\s+)?(?:report|summary|findings?)(?:\b|$))/i,
	/\bapply\s+(?:the\s+)?(?:(?:suggested|proposed|recommended)\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
];

const GENERAL_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|edit|modify|refactor)\b/i,
	FIX_OR_PATCH_IMPLEMENTATION_PATTERN,
	/\bapply\s+(?:the\s+)?(?:(?:suggested|proposed|recommended)\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
	/\b(?:update|add|remove|replace|delete|create)\s+(?:the\s+)?(?:file|files|code|source|implementation|test|tests|component|function|module|class|method|logic|import|imports|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command)\b/i,
];

export type TaskMutationIntent = { kind: "implementation" } | { kind: "read-only" } | { kind: "unknown" };

function stripFrameworkInstructions(task: string): string {
	return task
		.split("\n")
		.filter((line) => !/^\s*\[(?:Write to|Read from):/i.test(line))
		.filter((line) => !/^\s*(?:Create and maintain progress at:|Update progress at:|\*\*Output:\*\*|Write your findings to(?: exactly this path)?:|Return the complete artifact in your final response\.|The runtime will persist it to exactly this path:|Do not call contact_supervisor merely because no write-capable tool is available\.|This path is authoritative for this run\.|Ignore any other output filename or output path mentioned elsewhere)/i.test(line))
		.join("\n");
}

function stripPatterns(task: string, patterns: RegExp[]): string {
	let stripped = task;
	for (const pattern of patterns) {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		stripped = stripped.replace(new RegExp(pattern.source, flags), " ");
	}
	return stripped;
}

interface NoEditProhibitionAnalysis {
	/** True when any prohibition (or review-only/no-tool wording) is present. */
	present: boolean;
	/** True when a prohibition covers files/code in general; such wording wins over write verbs. */
	blanket: boolean;
	/** Task text with prohibition phrases and their objects removed, for write-intent testing. */
	strippedText: string;
}

function analyzeNoEditProhibitions(taskText: string): NoEditProhibitionAnalysis {
	let present = REVIEW_ONLY_PATTERNS.some((pattern) => pattern.test(taskText))
		|| NO_TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(taskText));
	let blanket = present;
	let strippedText = stripPatterns(taskText, [...REVIEW_ONLY_PATTERNS, ...NO_TOOL_INTENT_PATTERNS]);
	strippedText = strippedText.replace(new RegExp(NO_EDIT_PROHIBITION_PATTERN.source, NO_EDIT_PROHIBITION_PATTERN.flags), (_match, object: string) => {
		present = true;
		if (GENERIC_PROHIBITION_OBJECT.test(object)) blanket = true;
		return " ";
	});
	return { present, blanket, strippedText };
}

function taskHasReadOnlyDeliverable(taskText: string): boolean {
	return READ_ONLY_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(taskText));
}

function hasImplementationIntent(agent: string, taskText: string): boolean {
	if (/\breviewer\b/i.test(agent)) return REVIEWER_REQUIRED_EDIT_PATTERNS.some((pattern) => pattern.test(taskText));
	if (agent === "worker") return WORKER_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
	return GENERAL_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
}

export function classifyTaskMutationIntent(agent: string, task: string): TaskMutationIntent {
	const taskText = stripFrameworkInstructions(task);
	const taskTextWithoutScopedConstraints = stripPatterns(taskText, SCOPED_NO_EDIT_CONSTRAINT_PATTERNS);
	const prohibitions = analyzeNoEditProhibitions(taskTextWithoutScopedConstraints);
	if (prohibitions.present) {
		if (prohibitions.blanket) return { kind: "read-only" };
		return hasImplementationIntent(agent, prohibitions.strippedText) ? { kind: "implementation" } : { kind: "read-only" };
	}

	if (RESEARCH_AGENT_PATTERNS.some((pattern) => pattern.test(agent))) return { kind: "read-only" };
	if (hasImplementationIntent(agent, taskText)) return { kind: "implementation" };
	if (/\breviewer\b/i.test(agent)) return { kind: "read-only" };
	return taskHasReadOnlyDeliverable(taskTextWithoutScopedConstraints) ? { kind: "read-only" } : { kind: "unknown" };
}

export function expectsImplementationMutation(agent: string, task: string): boolean {
	return classifyTaskMutationIntent(agent, task).kind === "implementation";
}

/** Bare write verbs that make a task write-capable for acceptance inference. */
const MAY_MUTATE_VERB_PATTERN = /\b(?:fix|implement|update|write|edit|modify|migrate|delete|remove|refactor|commit)\b/i;

/**
 * Whether the task could plausibly change files. Blanket prohibitions win;
 * write verbs inside a scoped prohibition's object or a read-only deliverable
 * phrase ("write a summary report") do not count; any other bare write verb
 * does.
 */
export function taskMayMutate(task: string): boolean {
	const taskText = stripPatterns(stripFrameworkInstructions(task), SCOPED_NO_EDIT_CONSTRAINT_PATTERNS);
	const prohibitions = analyzeNoEditProhibitions(taskText);
	if (prohibitions.blanket) return false;
	return MAY_MUTATE_VERB_PATTERN.test(stripPatterns(prohibitions.strippedText, READ_ONLY_DELIVERABLE_PATTERNS));
}
