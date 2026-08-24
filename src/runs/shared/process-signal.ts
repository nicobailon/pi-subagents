export function formatProcessSignalError(signal: string): string {
	return `Subagent process terminated by signal ${signal}.`;
}

export function formatMidToolExitError(input: {
	toolName: string;
	exitCode: number | null;
	processSignal?: string | null;
}): string {
	const terminal = [`exit ${input.exitCode ?? "unknown"}`, ...(input.processSignal ? [`signal ${input.processSignal}`] : [])].join(", ");
	return `Subagent process exited during '${input.toolName}' tool execution (${terminal}) before the tool completed. Earlier assistant output is not a terminal result.`;
}

export function isOrdinaryToolForMidToolExit(toolName: string): boolean {
	return toolName !== "intercom" && toolName !== "contact_supervisor";
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
