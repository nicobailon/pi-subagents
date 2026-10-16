// Each Pi session replacement runs in a new extension instance, so the chain lives on globalThis.
const STORE_KEY = "__piSubagentSessionSuccession";
const MAX_INHERITED_SESSIONS = 8;

function successions(): Map<string, readonly string[]> {
	const globalStore = globalThis as Record<string, unknown>;
	if (!(globalStore[STORE_KEY] instanceof Map)) globalStore[STORE_KEY] = new Map<string, readonly string[]>();
	return globalStore[STORE_KEY] as Map<string, readonly string[]>;
}

/** Records that sessionId replaced previousSessionId in this process, inheriting its chain. */
export function recordSessionReplacement(sessionId: string, previousSessionId: string): void {
	// Resuming back and forth can revisit a session: keep the chain distinct and free of sessionId
	// itself, so the bound holds real predecessors and discovery never scans one session twice.
	const chain = [...new Set([previousSessionId, ...(successions().get(previousSessionId) ?? [])])].filter((id) => id !== sessionId);
	successions().set(sessionId, chain.slice(0, MAX_INHERITED_SESSIONS));
}

/** Sessions this process replaced on the way to sessionId, newest first; their runs belong to sessionId. */
export function inheritedSessionIds(sessionId: string): readonly string[] {
	return successions().get(sessionId) ?? [];
}
