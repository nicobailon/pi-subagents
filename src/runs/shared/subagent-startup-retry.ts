import type { Usage } from "../../shared/types.ts";

/**
 * Retry delays for child processes that exit before any model or tool activity.
 * The schedule is intentionally short and bounded to avoid amplifying persistent
 * launch failures while allowing concurrent Pi startup locks to clear.
 */
export const SUBAGENT_STARTUP_RETRY_DELAYS_MS = [250, 750, 1500] as const;

/** A genuine startup race should fail well before a model request can complete. */
export const MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS = 2000;

export interface SubagentStartupFailureEvidence {
	exitCode: number | null | undefined;
	error?: string;
	finalOutput?: string;
	messageCount: number;
	toolCount: number;
	usage: Usage;
	durationMs: number;
	protocolError?: unknown;
	processSignal?: string | null;
	observedMutationAttempt?: boolean;
	detached?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudgetExceeded?: boolean;
}

function hasUsage(usage: Usage): boolean {
	return usage.input !== 0
		|| usage.output !== 0
		|| usage.cacheRead !== 0
		|| usage.cacheWrite !== 0
		|| usage.cost !== 0
		|| usage.turns !== 0;
}

/**
 * Classify only unexplained, zero-activity child exits as startup failures.
 * This intentionally fails closed: any model output, tool activity, usage,
 * mutation evidence, diagnostic, or lifecycle interruption prevents a retry.
 */
export function isRetryableSubagentStartupFailure(evidence: SubagentStartupFailureEvidence): boolean {
	return evidence.exitCode !== undefined
		&& evidence.exitCode !== null
		&& evidence.exitCode !== 0
		&& !evidence.error?.trim()
		&& !evidence.finalOutput?.trim()
		&& evidence.messageCount === 0
		&& evidence.toolCount === 0
		&& !hasUsage(evidence.usage)
		&& evidence.durationMs >= 0
		&& evidence.durationMs <= MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS
		&& evidence.protocolError === undefined
		&& (evidence.processSignal === undefined || evidence.processSignal === null)
		&& evidence.observedMutationAttempt !== true
		&& evidence.detached !== true
		&& evidence.interrupted !== true
		&& evidence.timedOut !== true
		&& evidence.stopped !== true
		&& evidence.turnBudgetExceeded !== true;
}

export function formatSubagentStartupRetryNote(input: {
	model: string;
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}): string {
	return `[startup-retry] ${input.model} exited before model or tool activity (attempt ${input.attempt}/${input.maxAttempts}). Retrying the same model in ${input.delayMs}ms.`;
}

export function formatSubagentStartupRetryExhaustedError(input: {
	model: string;
	attempts: number;
}): string {
	return `Subagent failed to start after ${input.attempts} attempts on ${input.model}; no model, tool, output, usage, or diagnostic activity was observed. This may be a concurrent Pi startup race. Retry the run or temporarily lower subagent concurrency.`;
}

/** Wait for a retry delay, returning false when any lifecycle signal aborts it. */
export async function waitForSubagentStartupRetry(delayMs: number, signals: Array<AbortSignal | undefined>): Promise<boolean> {
	const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (activeSignals.some((signal) => signal.aborted)) return false;
	if (delayMs <= 0) return true;

	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (shouldRetry: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const signal of activeSignals) signal.removeEventListener("abort", abort);
			resolve(shouldRetry);
		};
		const abort = (): void => finish(false);
		const timer = setTimeout(() => finish(true), delayMs);
		for (const signal of activeSignals) signal.addEventListener("abort", abort, { once: true });
	});
}
