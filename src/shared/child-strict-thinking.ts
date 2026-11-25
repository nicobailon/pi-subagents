import { splitKnownThinkingSuffix } from "./model-info.ts";

export function childStrictThinking(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_SUBAGENT_STRICT_THINKING === "1";
}

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

export function assertPlacedChildThinkingApplied(input: { model: string | undefined; applied: unknown; env?: NodeJS.ProcessEnv }): void {
	if (!input.model || !childStrictThinking(input.env)) return;
	const requested = splitKnownThinkingSuffix(input.model).thinkingSuffix.slice(1);
	if (!requested || input.applied === requested) return;
	const outcome = typeof input.applied === "string" ? `ran at thinking level '${input.applied}'` : "did not report its thinking level";
	throw new Error(`Remote Pi model '${input.model}' ${outcome}. PI_SUBAGENT_STRICT_THINKING is set, so the child was not started.`);
}
