export function formatProcessSignalError(signal: string): string {
	return `Subagent process terminated by signal ${signal}.`;
}

export function isUnexplainedProcessSignal(input: {
	processSignal?: string | null;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudgetExceeded?: boolean;
	forcedDrainAfterFinalSuccess?: boolean;
}): boolean {
	return Boolean(input.processSignal)
		&& input.interrupted !== true
		&& input.timedOut !== true
		&& input.stopped !== true
		&& input.turnBudgetExceeded !== true
		&& input.forcedDrainAfterFinalSuccess !== true;
}
