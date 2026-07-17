import {
	resolveMaxSubagentSpawnsPerSession,
	type ExtensionConfig,
	type SpawnBudgetSnapshot,
	type SubagentState,
} from "../../shared/types.ts";

const MAX_GRANT_HISTORY = 20;

function sessionState(state: SubagentState, config: ExtensionConfig, sessionId: string | null) {
	let counters = state.subagentSpawns;
	if (!counters || counters.sessionId !== sessionId) {
		counters = {
			sessionId,
			count: 0,
			configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
			granted: 0,
			grantHistory: [],
		};
		state.subagentSpawns = counters;
	}
	if (counters.configuredLimit === undefined) {
		counters.configuredLimit = resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null;
	}
	counters.granted ??= 0;
	counters.grantHistory ??= [];
	return counters;
}

export function getSpawnBudgetSnapshot(
	state: SubagentState,
	config: ExtensionConfig,
	sessionId: string | null = state.currentSessionId,
): SpawnBudgetSnapshot {
	const counters = sessionState(state, config, sessionId);
	const configuredLimit = counters.configuredLimit ?? null;
	const granted = configuredLimit === null ? 0 : counters.granted ?? 0;
	const limit = configuredLimit === null ? null : configuredLimit + granted;
	return {
		used: counters.count,
		configuredLimit,
		granted,
		limit,
		remaining: limit === null ? null : Math.max(0, limit - counters.count),
		grantRemaining: configuredLimit === null ? null : Math.max(0, configuredLimit - granted),
		grantHistory: [...(counters.grantHistory ?? [])],
	};
}

export function formatSpawnBudgetSummary(snapshot: SpawnBudgetSnapshot): string {
	if (snapshot.limit === null) return "unlimited";
	return `${snapshot.used}/${snapshot.limit} used, ${snapshot.remaining} remaining (configured ${snapshot.configuredLimit}; granted ${snapshot.granted}; grant allowance ${snapshot.grantRemaining})`;
}

export function formatSpawnBudget(snapshot: SpawnBudgetSnapshot): string {
	return `Spawn budget: ${formatSpawnBudgetSummary(snapshot)}`;
}

export function preflightSpawnBudget(
	state: SubagentState,
	config: ExtensionConfig,
	sessionId: string | null,
	requested: number,
): { snapshot: SpawnBudgetSnapshot; error?: string } {
	const snapshot = getSpawnBudgetSnapshot(state, config, sessionId);
	if (requested <= 0 || snapshot.limit === null || requested <= (snapshot.remaining ?? 0)) return { snapshot };
	return {
		snapshot,
		error: `Subagent spawn limit reached for this session (${snapshot.used}/${snapshot.limit} used, ${requested} requested). ${snapshot.remaining} remaining; the declared run cannot fit, so no children were started. Grant budget explicitly from the root interactive session or start a new session.`,
	};
}

export function reserveSpawnBudget(
	state: SubagentState,
	config: ExtensionConfig,
	sessionId: string | null,
	requested: number,
): { snapshot: SpawnBudgetSnapshot; error?: string } {
	const checked = preflightSpawnBudget(state, config, sessionId, requested);
	if (checked.error || requested <= 0 || checked.snapshot.limit === null) return checked;
	state.subagentSpawns!.count += requested;
	return { snapshot: getSpawnBudgetSnapshot(state, config, sessionId) };
}

export function preflightSpawnBudgetGrant(
	state: SubagentState,
	config: ExtensionConfig,
	sessionId: string,
	additional: number,
): { snapshot: SpawnBudgetSnapshot; error?: string } {
	const snapshot = getSpawnBudgetSnapshot(state, config, sessionId);
	if (!Number.isInteger(additional) || additional <= 0) {
		return { snapshot, error: "action='grant-spawn-budget' requires additional to be a positive integer." };
	}
	if (snapshot.configuredLimit === null || snapshot.limit === null) {
		return { snapshot, error: "The current session has no configured spawn cap, so it does not need a budget grant." };
	}
	if (additional > (snapshot.grantRemaining ?? 0)) {
		return {
			snapshot,
			error: `Spawn budget grant rejected: ${additional} requested but only ${snapshot.grantRemaining} of the original configured limit remains grantable.`,
		};
	}
	return { snapshot };
}

export function grantSpawnBudget(
	state: SubagentState,
	config: ExtensionConfig,
	sessionId: string,
	additional: number,
	now = Date.now(),
): { snapshot: SpawnBudgetSnapshot; error?: string } {
	const checked = preflightSpawnBudgetGrant(state, config, sessionId, additional);
	if (checked.error) return checked;
	const before = checked.snapshot;
	if (before.limit === null) {
		return { snapshot: before, error: "The current session has no configured spawn cap, so it does not need a budget grant." };
	}
	const counters = state.subagentSpawns!;
	counters.granted = (counters.granted ?? 0) + additional;
	const limit = before.limit + additional;
	counters.grantHistory = [
		...(counters.grantHistory ?? []),
		{ sessionId, amount: additional, grantedAt: now, previousLimit: before.limit, limit },
	].slice(-MAX_GRANT_HISTORY);
	return { snapshot: getSpawnBudgetSnapshot(state, config, sessionId) };
}
