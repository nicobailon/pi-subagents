/**
 * Pi adjusts a thinking level the model does not support to the nearest one it does, so a child asked
 * for `provider/model:high` can run at `medium` without saying so. With `PI_SUBAGENT_STRICT_THINKING=1`
 * a child whose requested level Pi adjusted fails before its first request instead.
 *
 * Unset means Pi's adjustment stands, as before.
 */
export function childStrictThinking(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_SUBAGENT_STRICT_THINKING === "1";
}

/** Throws when strict thinking is on and the session's thinking level differs from the requested one. */
export function assertChildThinkingApplied(input: {
	requested: string | undefined;
	session: { readonly thinkingLevel: string; readonly model?: { provider: string; id: string }; getAvailableThinkingLevels(): readonly string[] };
	env?: NodeJS.ProcessEnv;
}): void {
	const { requested, session } = input;
	if (!requested || !childStrictThinking(input.env) || session.thinkingLevel === requested) return;
	const model = session.model ? `${session.model.provider}/${session.model.id}` : "the child model";
	throw new Error(`Model '${model}' does not support thinking level '${requested}' (supported: ${session.getAvailableThinkingLevels().join(", ")}). PI_SUBAGENT_STRICT_THINKING is set, so the child was not started at '${session.thinkingLevel}' instead.`);
}
