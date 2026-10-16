import { inheritedSessionIds } from "../../shared/session-succession.ts";

/** The sessions whose runs sessionId owns: itself and the sessions this process replaced on the way to it. */
export function ownerSessionIds(sessionId: string): ReadonlySet<string | undefined> {
	return new Set<string | undefined>([sessionId, ...inheritedSessionIds(sessionId)]);
}

export function ownsRun(currentSessionId: string | null | undefined, runSessionId: string | undefined): boolean {
	return currentSessionId ? ownerSessionIds(currentSessionId).has(runSessionId) : false;
}
