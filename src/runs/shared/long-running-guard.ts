import type { ResolvedControlConfig } from "../../shared/types.ts";

interface LongRunningNoticeMetrics {
	startedAt: number;
	now: number;
	turns: number;
	tokens: number;
}

type LongRunningTriggerReason = "time_threshold" | "turn_threshold" | "token_threshold";

interface FailedMutatingAttempt {
	tool: string;
	path?: string;
	error: string;
	ts: number;
}

interface MutatingFailureState {
	consecutiveFailures: number;
	lastFailureAt?: number;
	recentFailures: FailedMutatingAttempt[];
	lastMutatingPath?: string;
	repeatedPathFailures: number;
}

const MUTATING_BASH_PATTERNS = [
	/(^|[;&|()\s])rm\s+/,
	/(^|[;&|()\s])mv\s+/,
	/(^|[;&|()\s])cp\s+/,
	/(^|[;&|()\s])mkdir\s+/,
	/(^|[;&|()\s])touch\s+/,
	/(^|[;&|()\s])git\s+apply\b/,
	/(^|[;&|()\s])patch\s+/,
	/(^|[;&|()\s])sed\s+[^\n;&|]*\s-i\b/,
	/(^|[;&|()\s])perl\s+[^\n;&|]*\s-pi\b/,
	/(^|[;&|()]|\n)\s*tee\s+[^|&;]+/,
	/\b(writeFile|writeFileSync|appendFile|appendFileSync)\b/,
	/\bwrite_text\s*\(/,
	/\bopen\s*\([^)]*,\s*["'][wa]/,
	// Python heredoc pattern `with open(p) as f: f.write(...)` lacks an explicit
	// mode arg so the open() rule above doesn't match. The `.write(` call on a
	// file-handle named `f` is the unambiguous mutation evidence.
	/\bf\.write\s*\(/,
];

// Tools that cannot mutate the workspace. Used by completion-guard to
// short-circuit the mutation-expectation regex chain for agents whose
// frontmatter declares only these tools. Unknown tool names (extensions,
// MCP, custom) are conservatively treated as possibly mutating; add an entry
// here only when the tool is provably read-only.
//
// Do NOT add capability-escalating tools (e.g. `subagent`, `delegate`,
// `bash` with arbitrary command) here even when their direct effect is
// non-mutating. An agent with `tools: read, grep, subagent` can spawn a
// worker that writes to disk one hop away; classifying it as read-only
// would hide a real category of false-negatives. The set should only contain
// tools whose declared semantics make filesystem mutation impossible at any
// transitive depth.
export const READ_ONLY_TOOL_NAMES = new Set<string>([
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

export function isReadOnlyToolName(name: string): boolean {
	return READ_ONLY_TOOL_NAMES.has(name);
}

const MUTATING_FAILURE_HINTS = [
	"failed",
	"error",
	"no exact match",
	"did not match",
	"malformed",
	"rejected",
	"unable",
	"cannot",
	"could not",
];

export function resolveCurrentPath(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined {
	if (!toolName || !args) return undefined;
	const direct = ["path", "file", "filename", "target", "cwd"];
	for (const key of direct) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : undefined;
		if (!command) return undefined;
		const redirect = command.match(/(?:>|>>|tee\s+)(\S+)/);
		if (redirect?.[1]) return redirect[1];
	}
	return undefined;
}

function hasUnquotedFileRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;
		if (char !== ">") continue;
		if (command[i - 1] === "-") continue;
		const isDouble = command[i + 1] === ">";
		let cursor = i + (isDouble ? 2 : 1);
		while (cursor < command.length && /\s/.test(command[cursor]!)) cursor++;
		if (cursor >= command.length) continue;
		const targetStart = command[cursor]!;
		if (targetStart === "&" || targetStart === "|" || targetStart === ";") continue;
		if (targetStart === "(" || targetStart === ")") continue;
		return true;
	}
	return false;
}

export function isMutatingBashCommand(command: string): boolean {
	return hasUnquotedFileRedirection(command) || MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

export function isMutatingTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
	if (!toolName) return false;
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName !== "bash") return false;
	const command = typeof args?.command === "string" ? args.command : "";
	if (!command.trim()) return false;
	return isMutatingBashCommand(command);
}

export function didMutatingToolFail(text: string): boolean {
	const lowered = text.toLowerCase();
	return MUTATING_FAILURE_HINTS.some((hint) => lowered.includes(hint));
}

export function nextLongRunningTrigger(
	config: ResolvedControlConfig,
	metrics: LongRunningNoticeMetrics,
): LongRunningTriggerReason | undefined {
	if (metrics.now - metrics.startedAt >= config.activeNoticeAfterMs) return "time_threshold";
	if (config.activeNoticeAfterTurns !== undefined && metrics.turns >= config.activeNoticeAfterTurns) return "turn_threshold";
	if (config.activeNoticeAfterTokens !== undefined && metrics.tokens >= config.activeNoticeAfterTokens) return "token_threshold";
	return undefined;
}

export function resetMutatingFailureState(state: MutatingFailureState): void {
	state.consecutiveFailures = 0;
	state.lastFailureAt = undefined;
	state.recentFailures = [];
	state.lastMutatingPath = undefined;
	state.repeatedPathFailures = 0;
}

export function createMutatingFailureState(): MutatingFailureState {
	return {
		consecutiveFailures: 0,
		recentFailures: [],
		repeatedPathFailures: 0,
	};
}

export function recordMutatingFailure(
	state: MutatingFailureState,
	input: FailedMutatingAttempt,
	windowMs: number,
): void {
	if (state.lastFailureAt === undefined || input.ts - state.lastFailureAt > windowMs) {
		state.consecutiveFailures = 0;
		state.recentFailures = [];
		state.repeatedPathFailures = 0;
		state.lastMutatingPath = undefined;
	}
	state.lastFailureAt = input.ts;
	state.consecutiveFailures += 1;
	if (input.path && state.lastMutatingPath === input.path) {
		state.repeatedPathFailures += 1;
	} else if (input.path) {
		state.lastMutatingPath = input.path;
		state.repeatedPathFailures = 1;
	}
	state.recentFailures.push(input);
	if (state.recentFailures.length > 3) state.recentFailures.shift();
}

export function shouldEscalateMutatingFailures(state: MutatingFailureState, threshold: number): boolean {
	return state.consecutiveFailures >= threshold || state.repeatedPathFailures >= threshold;
}

export function summarizeRecentMutatingFailures(state: MutatingFailureState): string | undefined {
	if (state.recentFailures.length === 0) return undefined;
	return state.recentFailures
		.map((entry) => `${entry.tool}${entry.path ? `(${entry.path})` : ""}: ${entry.error}`)
		.join(" | ");
}
