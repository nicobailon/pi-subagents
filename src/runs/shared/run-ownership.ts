import { inheritedSessionIds } from "../../shared/session-succession.ts";
import type { SubagentState } from "../../shared/types.ts";

/** This session launched the run, or inherited it from a session this process replaced. */
export function ownsRun(state: Pick<SubagentState, "currentSessionId">, sessionId: string | undefined): boolean {
	if (sessionId === undefined || !state.currentSessionId) return false;
	return sessionId === state.currentSessionId || inheritedSessionIds(state.currentSessionId).includes(sessionId);
}
