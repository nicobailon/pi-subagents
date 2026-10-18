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
		return firstWrittenFile(command);
	}
	return undefined;
}

// Reads one shell word starting at `start`, removing quotes and escapes.
function readShellWord(command: string, start: number): { word: string; end: number } {
	let word = "";
	let quote: string | undefined;
	let i = start;
	for (; i < command.length; i++) {
		const char = command[i]!;
		if (quote) {
			if (char === quote) quote = undefined;
			// Inside double quotes a backslash escapes only $ ` " \ and newline; elsewhere it stays.
			else if (char === "\\" && quote === '"' && /[$`"\\\n]/.test(command[i + 1] ?? "")) word += command[++i];
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "\\" && i + 1 < command.length) word += command[++i];
		else if (/[\s;&|()<>]/.test(char)) break;
		else word += char;
	}
	return { word, end: i };
}

// First file an unquoted `>`, `>>`, or `tee` writes, skipping fd duplications (`>&1`) and /dev/null.
function firstWrittenFile(command: string): string | undefined {
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') i++;
			continue;
		}
		if (char === "'" || char === '"') { quote = char; continue; }
		if (char === "\\") { i++; continue; }
		const isTee = command.startsWith("tee", i) && (i === 0 || /[\s|;&(]/.test(command[i - 1]!)) && /\s/.test(command[i + 3] ?? "");
		if (char !== ">" && !isTee) continue;
		let cursor = isTee ? i + 3 : command[i + 1] === ">" ? i + 2 : i + 1;
		for (;;) {
			// A newline ends the command, so arguments never continue onto the next line.
			while (cursor < command.length && /[ \t]/.test(command[cursor]!)) cursor++;
			if (command[cursor] === "&") break;
			const { word, end } = readShellWord(command, cursor);
			cursor = end;
			if (word && word !== "/dev/null" && !(isTee && word.startsWith("-"))) return word;
			// tee takes several files and flags; a redirect takes one target.
			if (!isTee || !word) break;
		}
		i = cursor - 1;
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
		if (/^\/dev\/null(?=$|[\s;&|()])/.test(command.slice(cursor))) continue;
		return true;
	}
	return false;
}

function unquotedShellText(command: string): string {
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	let result = "";
	for (const char of command) {
		if (escaped) {
			result += inSingle || inDouble ? "_" : char;
			escaped = false;
			continue;
		}
		if (char === "\\" && !inSingle) {
			escaped = true;
			result += inDouble ? "_" : char;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		result += inSingle || inDouble ? "_" : char;
	}
	return result;
}

function hasMutatingGitCommand(command: string): boolean {
	const unquoted = unquotedShellText(command);
	for (const segment of unquoted.split(/(?:&&|\|\||[;|()\n])/)) {
		const trimmed = segment.trim();
		if (!trimmed || /^(?:echo|printf)\b/.test(trimmed)) continue;
		if (/^git\s+(?:(?:(?:-C|--git-dir|--work-tree)\s+\S+|(?:--git-dir|--work-tree)=\S+|--paginate)\s+)*(?:add|commit|push)\b/.test(trimmed)) return true;
	}
	return false;
}

export function isMutatingBashCommand(command: string): boolean {
	return hasUnquotedFileRedirection(command)
		|| hasMutatingGitCommand(command)
		|| MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

export function isMutatingTool(toolName: string | undefined, args: Record<string, unknown> | undefined, mutationTools?: readonly string[]): boolean {
	if (!toolName) return false;
	if (mutationTools?.includes(toolName)) return true;
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName === "cursor") {
		const activityTitle = typeof args?.activityTitle === "string" ? args.activityTitle : "";
		return /^Cursor (?:edit|write)\b/i.test(activityTitle);
	}
	if (toolName !== "bash") return false;
	const command = typeof args?.command === "string" ? args.command : "";
	if (!command.trim()) return false;
	return isMutatingBashCommand(command);
}

export function didMutatingToolFail(result: { isError?: unknown }): boolean {
	return result.isError === true;
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
