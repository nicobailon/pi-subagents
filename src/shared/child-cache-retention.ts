import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * Anthropic prices a cache write by the TTL it is asked for: 1.25x base input
 * for the 5m window, 2x for the 1h one. Child sessions are short-lived and
 * rarely idle, so a 1h window they never claim is a flat surcharge on every
 * write. Setting this to `short` keeps that surcharge off children while the
 * parent keeps `long`, the same split Claude Code makes between its main
 * conversation and its subagents.
 *
 * Unset means children inherit the parent's retention, which is the behaviour
 * before this setting existed.
 */
export function childCacheRetention(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.PI_SUBAGENT_CACHE_RETENTION || undefined;
}

/**
 * Launch-environment form for spawned children. Empty when unset, so the child
 * inherits the parent's `PI_CACHE_RETENTION` rather than having it cleared.
 */
export function childCacheRetentionEnv(env?: NodeJS.ProcessEnv): { PI_CACHE_RETENTION?: string } {
	const retention = childCacheRetention(env);
	return retention ? { PI_CACHE_RETENTION: retention } : {};
}

/**
 * Pi resolves retention per request as `options.env?.[name] || process.env[name]`,
 * so a per-call env beats the process-wide one. Wrapping the session's own
 * stream function keeps this scoped to one child, with no shared-state race
 * against a parent turn streaming concurrently.
 */
export function pinChildCacheRetention(agent: { streamFunction: StreamFn } | undefined, env?: NodeJS.ProcessEnv): void {
	if (!agent?.streamFunction) return;
	const retention = childCacheRetention(env);
	if (!retention) return;
	const base = agent.streamFunction;
	agent.streamFunction = (model, context, options) =>
		base(model, context, {
			...options,
			env: { ...(options?.env ?? {}), PI_CACHE_RETENTION: retention },
		});
}
