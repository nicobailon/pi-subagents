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
	/\bmust\s+(?:edit|modify|change|fix|patch|apply|implement)\b/i,
	/\brequired\s+to\s+(?:edit|modify|change|fix|patch|apply|implement)\b/i,
	/(?:^|[.!?\n]\s*)implement\s+(?:the\s+)?(?:approved|requested|specified|file|code|source|fix(?:es)?|changes?)\b/i,
	/\bregardless\s+of\s+findings\b/i,
	/\balways\s+(?:edit|modify|change|fix|patch|apply|implement)\b/i,
	/\bapply\s+(?:the\s+)?fix(?:es)?\s+directly\b/i,
	/\bmake\s+(?:the\s+)?code\s+changes\b/i,
];

// The prohibition's object ends at punctuation, a serialized line separator,
// or a coordinating word (but/and/then), so a follow-on clause like "but
// implement the fix" stays in the text for write-intent testing instead of
// being swallowed as the object.
// Accept serialized line separators too: workflow prompts can carry literal
// `\\n`/`\\r\\n` between clauses instead of decoded newlines.
const NO_EDIT_PROHIBITION_PATTERN = /(?:\b|\\(?:r\\n|n))(?:do not|don't|must not)\s+(?:edit|modify|write(?:\s+to)?|touch|change)\b((?:(?!\b(?:but|and|then)\b|\\(?:r\\n|n))[^.;,:!?\n–—-])*)/gi;
const COORDINATED_NO_EDIT_PROHIBITION_PATTERN = /(?:\b|\\(?:r\\n|n))(?:do not|don't|must not)\s+((?=(?:(?!\\(?:r\\n|n))[^.;:!?\n–—-])*\b(?:and|or)\s+(?:edit|modify|write(?:\s+to)?|touch|change)\b)(?:(?!\\(?:r\\n|n))[^.;:!?\n–—-])*?\b(?:and|or)\s+(?:edit|modify|write(?:\s+to)?|touch|change)\b(?:(?!\b(?:but|and|then)\b|\\(?:r\\n|n))[^.;,:!?\n–—-])*)/gi;

/** Objects of a no-edit prohibition that mean "the codebase in general" rather than a named scope. */
const GENERIC_PROHIBITION_OBJECT = /^\s*(?:(?:any|all|the|these|those|your|our|existing|project|product|source|sources|config|configs|repo|repository)[\s/,-]*)*(?:files?|code|codebase|sources?|anything|repo(?:sitory)?)?\s*$/i;
const SCOPED_PROHIBITION_CONTINUATION = /^(?:\\(?:r\\n|n)|\r?\n)\s*(?:in|inside|under|within|outside|except|other\s+than|besides)\b/i;
const OUTPUT_INSTRUCTION_CONTINUATION = /^(?:\\(?:r\\n|n)|\r?\n)\s*(?:in|inside|within)\s+(?:(?:(?:your|the)\s+)(?:final\s+)?|final\s+)(?:output|response|report|answer|reply|message|summary|findings?|analysis|recommendations?)(?:\s*\/\s*(?:output|response|report|answer|reply|message|summary|findings?|analysis|recommendations?))*\b(?![\\/])/i;

function hasScopedProhibitionContinuation(text: string): boolean {
	return SCOPED_PROHIBITION_CONTINUATION.test(text) && !OUTPUT_INSTRUCTION_CONTINUATION.test(text);
}

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

// Review/severity vocabulary like "must-fix items" or "should-fix tests" is not
// the verb. Rather than dash-guarding every pattern (which would also suppress
// CLI flags like "--fix" and genuine clause-level dashes like "branch—fix it"),
// strip the known severity compounds (must|should|needs + dash + verb) from the
// task text before matching. Dash coverage: ASCII hyphen + U+2010..U+2015.
const SEVERITY_COMPOUND_PATTERN = /\b(?:must|should|needs)[\-\u2010-\u2015](?:fix|edit|update|add|remove|replace|create|apply|make|do|implement|modify|delete|patch)\b/gi;

function stripSeverityCompounds(task: string): string {
	return task.replace(SEVERITY_COMPOUND_PATTERN, " ");
}
export { stripSeverityCompounds };

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
	const stripNoEditProhibition = (match: string, object: string, offset: number, source: string): string => {
		present = true;
		if (GENERIC_PROHIBITION_OBJECT.test(object) && !hasScopedProhibitionContinuation(source.slice(offset + match.length))) blanket = true;
		return " ";
	};
	strippedText = strippedText.replace(new RegExp(COORDINATED_NO_EDIT_PROHIBITION_PATTERN.source, COORDINATED_NO_EDIT_PROHIBITION_PATTERN.flags), stripNoEditProhibition);
	strippedText = strippedText.replace(new RegExp(NO_EDIT_PROHIBITION_PATTERN.source, NO_EDIT_PROHIBITION_PATTERN.flags), stripNoEditProhibition);
	// Restore boundaries after stripping a prohibition from serialized prompts.
	strippedText = strippedText.replace(/\\(?:r\\n|n)/g, "\n");
	return { present, blanket, strippedText };
}

function taskHasReadOnlyDeliverable(taskText: string): boolean {
	return READ_ONLY_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(taskText));
}

function isReviewerStyleAgent(agent: string): boolean {
	return /\b(?:advisor|reviewer|oracle)\b/i.test(agent);
}

function hasImplementationIntent(agent: string, taskText: string): boolean {
	if (isReviewerStyleAgent(agent)) return REVIEWER_REQUIRED_EDIT_PATTERNS.some((pattern) => pattern.test(taskText));
	if (agent === "worker") return WORKER_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
	return GENERAL_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
}

export function classifyTaskMutationIntent(agent: string, task: string): TaskMutationIntent {
	const taskText = stripSeverityCompounds(stripFrameworkInstructions(task));
	const taskTextWithoutScopedConstraints = stripPatterns(taskText, SCOPED_NO_EDIT_CONSTRAINT_PATTERNS);
	const prohibitions = analyzeNoEditProhibitions(taskTextWithoutScopedConstraints);
	if (prohibitions.present) {
		if (prohibitions.blanket) return { kind: "read-only" };
		return hasImplementationIntent(agent, prohibitions.strippedText) ? { kind: "implementation" } : { kind: "read-only" };
	}

	if (RESEARCH_AGENT_PATTERNS.some((pattern) => pattern.test(agent))) return { kind: "read-only" };
	if (hasImplementationIntent(agent, taskText)) return { kind: "implementation" };
	if (isReviewerStyleAgent(agent)) return { kind: "read-only" };
	return taskHasReadOnlyDeliverable(taskTextWithoutScopedConstraints) ? { kind: "read-only" } : { kind: "unknown" };
}

export function expectsImplementationMutation(agent: string, task: string): boolean {
	return classifyTaskMutationIntent(agent, task).kind === "implementation";
}

/** Bare write verbs that make a task write-capable for acceptance inference.
 * Severity compounds ("must-fix items") are stripped before matching, so they
 * are not write imperatives, while CLI flags ("--fix", "-w"), clause-level
 * dashes ("branch—fix it"), and hyphenated imperatives ("hot-fix the bug")
 * all stay write-capable. */
const MAY_MUTATE_VERB_PATTERN = /\b(?:fix|implement|update|write|edit|modify|migrate|delete|remove|refactor|commit)\b/i;

/**
 * Whether the task could plausibly change files. Blanket prohibitions win;
 * write verbs inside a scoped prohibition's object or a read-only deliverable
 * phrase ("write a summary report") do not count; any other bare write verb
 * does.
 */
export function taskMayMutate(task: string): boolean {
	const taskText = stripPatterns(stripSeverityCompounds(stripFrameworkInstructions(task)), SCOPED_NO_EDIT_CONSTRAINT_PATTERNS);
	const prohibitions = analyzeNoEditProhibitions(taskText);
	if (prohibitions.blanket) return false;
	return MAY_MUTATE_VERB_PATTERN.test(stripPatterns(prohibitions.strippedText, READ_ONLY_DELIVERABLE_PATTERNS));
}
