import type { Message } from "@earendil-works/pi-ai";

export const ABORT_RECOVERY_PROMPT = "The prior run ended from a provider/transport abort after useful progress. Continue from the current files and transcript. Do not restart. Fix any validation failure or write the required report. Finish with final output.";

export type AbortRecoveryPlan =
	| { action: "resume"; prompt: typeof ABORT_RECOVERY_PROMPT }
	| { action: "settle"; reason: string };

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
}): AbortRecoveryPlan {
	if (input.alreadyResumed) return { action: "settle", reason: "resume already attempted" };
	if (!input.sessionAvailable) return { action: "settle", reason: "retained session unavailable" };
	if (input.stopped || input.interrupted) return { action: "settle", reason: "explicit stop or interrupt" };
	if (input.processSignal) return { action: "settle", reason: "process terminated by signal" };
	if (input.timedOut) return { action: "settle", reason: "elapsed timeout" };
	if (input.toolBudgetExhausted || input.usageBudgetExhausted) return { action: "settle", reason: "budget exhausted" };
	if (input.structuredOutputFailed) return { action: "settle", reason: "structured output failure" };
	if (input.acceptanceFailed) return { action: "settle", reason: "acceptance failure" };
	if (input.currentTool || hasUnresolvedToolCall(input.messages)) return { action: "settle", reason: "tool call still in flight" };

	const terminal = terminalAssistant(input.messages);
	const message = terminal.message;
	const error = [input.error, typeof message?.errorMessage === "string" ? message.errorMessage : undefined]
		.filter((value): value is string => Boolean(value))
		.join("\n");
	const emptyZeroUsageTerminal = message !== undefined
		&& contentParts(message).length === 0
		&& zeroOutputUsage(message);
	const abortMarker = message?.stopReason === "aborted"
		|| isProviderAbortError(error);
	const equivalentProviderAbort = isProviderAbortError(error);
	if ((!emptyZeroUsageTerminal || !abortMarker) && !equivalentProviderAbort) {
		return { action: "settle", reason: "terminal response is not a provider abort" };
	}
	const progressLimit = emptyZeroUsageTerminal ? terminal.index : input.messages.length;
	if (!hasUsefulProgress(input.messages, progressLimit)) return { action: "settle", reason: "no useful prior progress" };
	return { action: "resume", prompt: ABORT_RECOVERY_PROMPT };
}
