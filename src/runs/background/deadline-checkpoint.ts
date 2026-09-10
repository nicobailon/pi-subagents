import type { SteerRequest } from "./control-channel.ts";

/** `SteerRequest.source` for runner-issued deadline checkpoints. */
export const DEADLINE_CHECKPOINT_SOURCE = "deadline-checkpoint";
/** A checkpoint steer that fires less than this long after launch cannot be useful. */
export const MIN_DEADLINE_CHECKPOINT_LEAD_MS = 1_000;

/**
 * Delay from now at which the checkpoint steer fires, given the remaining run
 * time, or undefined when the option is absent, not a positive integer, or the
 * deadline leaves less than MIN_DEADLINE_CHECKPOINT_LEAD_MS before the checkpoint.
 */
export function deadlineCheckpointDelayMs(
	remainingMs: number,
	checkpointBeforeDeadlineMs: number | undefined,
): number | undefined {
	if (checkpointBeforeDeadlineMs === undefined) return undefined;
	if (
		!Number.isInteger(checkpointBeforeDeadlineMs) ||
		checkpointBeforeDeadlineMs <= 0
	)
		return undefined;
	const delay = remainingMs - checkpointBeforeDeadlineMs;
	return delay >= MIN_DEADLINE_CHECKPOINT_LEAD_MS ? delay : undefined;
}

export function buildDeadlineCheckpointMessage(remainingMs: number): string {
	const seconds = Math.round(Math.max(0, remainingMs) / 1000);
	return `Deadline checkpoint from the runner: this run is killed in about ${seconds} seconds. Finish the current tool call only, then stop and reply with a handoff: changed files, build/test state, remaining work, and commit/PR state. Do not start new work.`;
}

/** Untargeted on purpose: the runner routes it to whichever steps are running when it fires. */
export function buildDeadlineCheckpointRequest(input: { deadlineAt: number; now?: number }): SteerRequest {
	const now = input.now ?? Date.now();
	return {
		type: "steer",
		id: `deadline-checkpoint-${now}`,
		ts: now,
		mode: "steer",
		source: DEADLINE_CHECKPOINT_SOURCE,
		message: buildDeadlineCheckpointMessage(input.deadlineAt - now),
	};
}
