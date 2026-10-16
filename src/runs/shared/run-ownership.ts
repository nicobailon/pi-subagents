import { inheritedSessionIds } from "../../shared/session-succession.ts";
import type { SubagentState } from "../../shared/types.ts";

/** The sessions whose runs sessionId owns: itself and the sessions this process replaced on the way to it. */
export function ownerSessionIds(sessionId: string): ReadonlySet<string | undefined> {
	return new Set<string | undefined>([sessionId, ...inheritedSessionIds(sessionId)]);
}

export function ownsRun(state: Pick<SubagentState, "currentSessionId">, sessionId: string | undefined): boolean {
	return state.currentSessionId ? ownerSessionIds(state.currentSessionId).has(sessionId) : false;
}
