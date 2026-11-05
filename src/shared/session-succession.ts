// Each Pi session replacement runs in a new extension instance, so the chain lives on globalThis.
const SUCCESSION_KEY = Symbol.for("pi-subagents.session-succession");
const MAX_INHERITED_SESSIONS = 8;
// A long-lived host (pi-web) can replace sessions for days; keep only the most recent ones.
const MAX_RECORDED_SESSIONS = 64;

const KEPT_WORK_KEY = Symbol.for("pi-subagents.sessions-keeping-work");

type SuccessionGlobal = typeof globalThis & { [SUCCESSION_KEY]?: Map<string, readonly string[]>; [KEPT_WORK_KEY]?: Set<string> };

function successions(): Map<string, readonly string[]> {
	const runtime = globalThis as SuccessionGlobal;
	runtime[SUCCESSION_KEY] ??= new Map();
	return runtime[SUCCESSION_KEY];
}

function keptWork(): Set<string> {
	const runtime = globalThis as SuccessionGlobal;
	runtime[KEPT_WORK_KEY] ??= new Set();
	return runtime[KEPT_WORK_KEY];
}

/**
 * The operator switched away from sessionId and chose to leave its work there: its successor inherits nothing, and
 * sessionId keeps its own chain when it is reopened. The mark lasts until sessionId shuts down again without it,
 * so a repeated start of the same replacement (RPC rebind) sees it too.
 */
export function keepSessionWork(sessionId: string): void {
	keptWork().delete(sessionId);
	keptWork().add(sessionId);
	while (keptWork().size > MAX_RECORDED_SESSIONS) keptWork().delete(keptWork().values().next().value!);
}

/** sessionId shut down without leaving its work there, so whoever replaces it next inherits as usual. */
export function releaseSessionWork(sessionId: string): void {
	keptWork().delete(sessionId);
}

/** Records that sessionId replaced previousSessionId in this process, inheriting its chain unless its work was kept there. */
export function recordSessionReplacement(sessionId: string, previousSessionId: string): void {
	const inherited = keptWork().has(previousSessionId) ? [] : [previousSessionId, ...(successions().get(previousSessionId) ?? [])];
	const own = keptWork().has(sessionId) ? successions().get(sessionId) ?? [] : [];
	// Resuming back and forth can revisit a session: keep the chain distinct and free of sessionId
	// itself, so the bound holds real predecessors and discovery never scans one session twice.
	const chain = [...new Set([...inherited, ...own])].filter((id) => id !== sessionId);
	successions().delete(sessionId);
	successions().set(sessionId, chain.slice(0, MAX_INHERITED_SESSIONS));
	while (successions().size > MAX_RECORDED_SESSIONS) successions().delete(successions().keys().next().value!);
}

/**
 * A session starting in this process is live again, so no other session inherits its runs any more.
 * pi-web keeps a forked-from session listed and can reopen it while its fork is still live.
 * A startup replaces no session, so the session also drops what it inherited before: whoever
 * replaced it took those runs over and keeps them.
 */
export function recordSessionStart(sessionId: string, startup: boolean): void {
	if (startup) {
		successions().delete(sessionId);
		keptWork().delete(sessionId);
	}
	for (const [id, chain] of successions()) {
		if (chain.includes(sessionId)) successions().set(id, chain.filter((inherited) => inherited !== sessionId));
	}
}

/** Sessions this process replaced on the way to sessionId, newest first; their runs belong to sessionId. */
export function inheritedSessionIds(sessionId: string): readonly string[] {
	return successions().get(sessionId) ?? [];
}
