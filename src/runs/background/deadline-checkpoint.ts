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
