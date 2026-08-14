import type { Usage } from "../../shared/types.ts";
import { formatProcessSignalError } from "./process-signal.ts";

/**
 * Retry delays for child processes that exit before any model or tool activity.
 * The schedule is intentionally short and bounded to avoid amplifying persistent
 * launch failures while allowing concurrent Pi startup locks to clear.
 */
export const SUBAGENT_STARTUP_RETRY_DELAYS_MS = [250, 750, 1500] as const;

/** A genuine startup race should fail well before a model request can complete. */
export const MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS = 2000;

const SIGKILL_PROCESS_SIGNAL_ERROR = formatProcessSignalError("SIGKILL");
const EXTENSION_REGISTRATION_CONFLICT_PATTERN = /Failed to load extension\b[^\n]*:\s*(?:Tool|Flag)\s+"[^"]+"\s+conflicts with\b/i;

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

export function formatSubagentExtensionConflictError(
	error: string | undefined,
	input: { agent: string; ambientExtensionsEnabled: boolean },
): string | undefined {
	if (!error || !input.ambientExtensionsEnabled || !EXTENSION_REGISTRATION_CONFLICT_PATTERN.test(error)) return error;
	const settings = JSON.stringify({
		subagents: { agentOverrides: { [input.agent]: { extensions: [] } } },
	});
	return `${error}\n\nSubagent startup loaded conflicting ambient Pi extensions. Retry this run after disabling ambient extension discovery for agent ${JSON.stringify(input.agent)} in project .pi/settings.json: ${settings}. Replace the empty array with only the required extension entry paths when this agent needs extension tools.`;
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
		&& (!evidence.error?.trim() || evidence.error === SIGKILL_PROCESS_SIGNAL_ERROR)
		&& !evidence.finalOutput?.trim()
		&& evidence.messageCount === 0
		&& evidence.toolCount === 0
		&& !hasUsage(evidence.usage)
		&& evidence.durationMs >= 0
		&& evidence.durationMs <= MAX_SUBAGENT_STARTUP_FAILURE_DURATION_MS
		&& evidence.protocolError === undefined
		&& (evidence.processSignal === undefined || evidence.processSignal === null || evidence.processSignal === "SIGKILL")
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
