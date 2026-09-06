/**
 * Child lifecycle projection: when the observed child session events mean
 * the run is settling and the observer may start (or must cancel) its final
 * drain window.
 */
export type ChildLifecycleAction = "start-drain" | "cancel-drain" | "none";

export interface ChildLifecycleState {
	compactionRetryActive: boolean;
}

export function projectChildLifecycle(event: { type?: string; willRetry?: unknown }, terminalAssistantStop = false, state?: ChildLifecycleState): ChildLifecycleAction {
	if (event.type === "compaction_end") {
		if (state) state.compactionRetryActive = event.willRetry === true;
		return event.willRetry === true ? "cancel-drain" : "none";
	}
	if (event.type === "agent_start" || event.type === "auto_retry_start" || event.type === "turn_start") {
		if (state) state.compactionRetryActive = false;
		return "cancel-drain";
	}
	if (event.type === "agent_end" && event.willRetry === true) return "cancel-drain";
	if (event.type === "agent_end" && state) state.compactionRetryActive = false;
	if (event.type === "agent_settled") return state?.compactionRetryActive ? "none" : "start-drain";
	if (terminalAssistantStop) return "start-drain";
	return "none";
}
