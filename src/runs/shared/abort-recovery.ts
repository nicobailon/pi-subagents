import type { Message } from "@earendil-works/pi-ai";

export const ABORT_RECOVERY_PROMPT = "The prior run ended from a provider/transport abort after useful progress. Continue from the current files and transcript. Do not restart. Fix any validation failure or write the required report. Finish with final output.";

export type AbortRecoveryPlan =
	| { action: "resume"; prompt: typeof ABORT_RECOVERY_PROMPT }
	| { action: "settle"; reason: string; diagnostic?: string };

const PROVIDER_ABORT_PATTERN = /(?:provider|transport|connection|stream|socket|request).*(?:abort|closed|reset|ended|terminated|error|fail)|(?:abort|closed|reset|ended|terminated|error|fail).*(?:provider|transport|connection|stream|socket|request)/i;
const ABORT_ERROR_PATTERN = /\b(?:operation|request|response|stream|connection|transport|provider)?\s*(?:was\s+)?aborted\b/i;
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

function isProviderAbortError(error: string): boolean {
	return !TOOL_FAILURE_PREFIX.test(error.trim()) && (PROVIDER_ABORT_PATTERN.test(error) || ABORT_ERROR_PATTERN.test(error));
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function contentParts(message: Record<string, unknown>): unknown[] {
	return Array.isArray(message.content) ? message.content : [];
}

function terminalAssistant(messages: readonly Message[]): { message?: Record<string, unknown>; index: number } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = record(messages[index]);
		if (message?.role === "assistant") return { message, index };
	}
	return { index: messages.length };
}

function zeroOutputUsage(message: Record<string, unknown>): boolean {
	const usage = record(message.usage);
	return usage !== undefined && (usage.output ?? usage.outputTokens ?? 0) === 0;
}

function hasUsefulProgress(messages: readonly Message[], terminalIndex: number): boolean {
	for (let index = 0; index < terminalIndex; index++) {
		const message = record(messages[index]);
		if (!message) continue;
		if (message.role === "assistant" && contentParts(message).length > 0) return true;
		if (message.role === "toolResult" && message.isError !== true) return true;
	}
	return false;
}

function hasUnresolvedToolCall(messages: readonly Message[]): boolean {
	const pending = new Set<string>();
	for (const rawMessage of messages) {
		const message = record(rawMessage);
		if (!message) continue;
		if (message.role === "assistant") {
			for (const rawPart of contentParts(message)) {
				const part = record(rawPart);
				if (part?.type === "toolCall" && typeof part.id === "string" && part.id) pending.add(part.id);
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			pending.delete(message.toolCallId);
		}
	}
	return pending.size > 0;
}

export function planAbortRecovery(input: {
	messages: readonly Message[];
	error?: string;
	processSignal?: string | null;
	sessionAvailable: boolean;
	alreadyResumed: boolean;
	stopped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	toolBudgetExhausted?: boolean;
	usageBudgetExhausted?: boolean;
	structuredOutputFailed?: boolean;
	acceptanceFailed?: boolean;
	currentTool?: string;
	afterCompactionSettlement?: boolean;
}): AbortRecoveryPlan {
	const terminal = terminalAssistant(input.messages);
	const message = terminal.message;
	const terminalError = typeof message?.errorMessage === "string" ? message.errorMessage : undefined;
	const emptyZeroUsageTerminal = message !== undefined
		&& contentParts(message).length === 0
		&& zeroOutputUsage(message);
	const terminalAssistantAbort = message?.stopReason === "aborted"
		|| (message?.stopReason === "error" && terminalError !== undefined && isProviderAbortError(terminalError));
	const abortCandidate = emptyZeroUsageTerminal && terminalAssistantAbort;
	const compactionAbortCandidate = input.afterCompactionSettlement === true && abortCandidate;
	const settle = (reason: string): AbortRecoveryPlan => ({
		action: "settle",
		reason,
		...(compactionAbortCandidate
			? { diagnostic: `Compaction-induced child abort could not be resumed safely: ${reason}.` }
			: {}),
	});

	if (input.alreadyResumed) return settle("resume already attempted");
	if (!input.sessionAvailable) return settle("retained session unavailable");
	if (input.stopped || input.interrupted) return settle("explicit stop or interrupt");
	// A compaction abort can leave the child process open until the runner's
	// terminal drain sends SIGTERM. The compaction + settlement markers make
	// that cleanup signal non-authoritative; explicit stop/interrupt still wins.
	if (input.processSignal && !compactionAbortCandidate) return settle("process terminated by signal");
	if (input.timedOut) return settle("elapsed timeout");
	if (input.toolBudgetExhausted || input.usageBudgetExhausted) return settle("budget exhausted");
	if (input.structuredOutputFailed) return settle("structured output failure");
	if (input.acceptanceFailed) return settle("acceptance failure");
	if (input.currentTool) return settle(`active tool '${input.currentTool.slice(0, 128)}' remains in flight`);
	if (hasUnresolvedToolCall(input.messages)) return settle("unresolved tool call remains in transcript");
	if (!input.afterCompactionSettlement) return settle("compaction settlement not verified");
	if (!abortCandidate) return settle("terminal assistant abort evidence not verified");
	const progressLimit = emptyZeroUsageTerminal ? terminal.index : input.messages.length;
	if (!hasUsefulProgress(input.messages, progressLimit)) return settle("no useful prior progress");
	return { action: "resume", prompt: ABORT_RECOVERY_PROMPT };
}
