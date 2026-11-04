// Each Pi session replacement runs in a new extension instance, so the chain lives on globalThis.
const SUCCESSION_KEY = Symbol.for("pi-subagents.session-succession");
const MAX_INHERITED_SESSIONS = 8;
// A long-lived host (pi-web) can replace sessions for days; keep only the most recent ones.
const MAX_RECORDED_SESSIONS = 64;

const HANDOFF_KEY = Symbol.for("pi-subagents.approved-session-handoffs");
type SuccessionGlobal = typeof globalThis & {
	[SUCCESSION_KEY]?: Map<string, readonly string[]>;
	[HANDOFF_KEY]?: Map<string, string>;
};

// SAFETY: this module owns both Symbol-keyed Maps across extension instances.
const runtime = globalThis as SuccessionGlobal;

function handoffs(): Map<string, string> {
	return runtime[HANDOFF_KEY] ??= new Map();
}

/** Offer an approved handoff when the old runtime shuts down. */
export function approveSessionHandoff(sessionId: string, previousSessionId: string): void {
	handoffs().delete(sessionId);
	handoffs().set(sessionId, previousSessionId);
	while (handoffs().size > MAX_RECORDED_SESSIONS) handoffs().delete(handoffs().keys().next().value!);
}

/** Claim once, only for the approved predecessor and destination. */
export function consumeSessionHandoff(sessionId: string, previousSessionId?: string): boolean {
	const approved = handoffs().get(sessionId);
	handoffs().delete(sessionId);
	return previousSessionId !== undefined && approved === previousSessionId;
}

function successions(): Map<string, readonly string[]> {
	return runtime[SUCCESSION_KEY] ??= new Map();
}

/** Records that sessionId replaced previousSessionId in this process, inheriting its chain. */
export function recordSessionReplacement(sessionId: string, previousSessionId: string): void {
	// Resuming back and forth can revisit a session: keep the chain distinct and free of sessionId
	// itself, so the bound holds real predecessors and discovery never scans one session twice.
	const chain = [...new Set([previousSessionId, ...(successions().get(previousSessionId) ?? [])])].filter((id) => id !== sessionId);
	successions().delete(sessionId);
	successions().set(sessionId, chain.slice(0, MAX_INHERITED_SESSIONS));
	while (successions().size > MAX_RECORDED_SESSIONS) successions().delete(successions().keys().next().value!);
}

/** Reopening reclaims the session's own runs. Only a reload retains its inherited chain. */
export function recordSessionStart(sessionId: string, clearInheritance: boolean): void {
	if (clearInheritance) successions().delete(sessionId);
	handoffs().delete(sessionId);
	for (const [target, previous] of handoffs()) if (previous === sessionId) handoffs().delete(target);
	for (const [id, chain] of successions()) {
		if (chain.includes(sessionId)) successions().set(id, chain.filter((inherited) => inherited !== sessionId));
	}
}

/** Sessions this process replaced on the way to sessionId, newest first; their runs belong to sessionId. */
export function inheritedSessionIds(sessionId: string): readonly string[] {
	return successions().get(sessionId) ?? [];
}
