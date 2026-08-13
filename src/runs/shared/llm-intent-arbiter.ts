import { createHash } from "node:crypto";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { agentStreamOptions } from "../../shared/agent-stream-options.ts";

/**
 * LLM intent arbiter for the completion mutation guard.
 *
 * The regex classifier (task-intent.ts) is deliberately narrow, so exotic
 * review wording can still look like an implementation task ("to fix this,
 * compare the outputs", verbs inside URLs or quoted text). When the guard is
 * about to hard-fail a run that made no edits, this arbiter asks a model
 * whether the task actually instructed file changes. It can only downgrade a
 * failure to a pass; every error, timeout, or non-read-only verdict keeps the
 * guard's original behavior.
 *
 * Enabled by default; set PI_SUBAGENTS_LLM_INTENT_ARBITER=0 to disable.
 */

const COMPLETION_GUARD_ERROR_PREFIX =
	"Subagent completed without making edits for an implementation task.";

export type TaskMutationVerdict = "read-only" | "implementation" | "unavailable";

export type TaskMutationArbiter = (task: string) => Promise<TaskMutationVerdict>;

const DecisionParams = Type.Object(
	{
		classification: Type.String({ enum: ["read_only", "implementation"] }),
		confidence: Type.String({
			enum: ["low", "medium", "high"],
			description: "Confidence in the classification. Only read_only with high confidence rescues a failed run.",
		}),
		reason: Type.String({ description: "One concise reason for this classification." }),
	},
	{ additionalProperties: false },
);

type DecisionParams = Static<typeof DecisionParams>;

/** Map a model decision to a verdict. Only a high-confidence read_only rescues. */
export function mapArbiterDecision(
	decision: { classification?: string; confidence?: string } | undefined,
): TaskMutationVerdict {
	if (!decision) return "unavailable";
	if (decision.classification === "read_only" && decision.confidence === "high") return "read-only";
	return "implementation";
}

interface ArbiterRuntime {
	model: NonNullable<RegistryModel>;
	baseStreamFn: StreamFn;
	timeoutMs: number;
}

interface ArbiterAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

export interface TaskMutationArbiterOptions {
	/** Explicit "provider/id" model override (tests, config). */
	model?: string;
	/** Injectable stream function (tests). */
	streamFn?: StreamFn;
	timeoutMs?: number;
}

const DEFAULT_ARBITER_TIMEOUT_MS = 10_000;

type RegistryModel = ReturnType<NonNullable<ExtensionContext["modelRegistry"]["find"]>>;

function resolveArbiterModel(
	ctx: ExtensionContext,
	options?: TaskMutationArbiterOptions,
): NonNullable<RegistryModel> | null {
	const registry = ctx.modelRegistry as {
		find?: (provider: string, modelId: string) => RegistryModel | undefined;
		getAvailable?: () => Array<{ provider?: string; id?: string }>;
	};
	const explicit = options?.model?.trim();
	if (explicit) {
		const [provider, id] = explicit.split("/");
		if (provider && id) return registry.find?.(provider, id) ?? null;
		return null;
	}
	if (ctx.model) return ctx.model as NonNullable<RegistryModel>;
	const first = registry.getAvailable?.()[0];
	if (first?.provider && first.id) return registry.find?.(first.provider, first.id) ?? null;
	return null;
}

function resolveArbiterRuntime(
	ctx: ExtensionContext,
	options?: TaskMutationArbiterOptions,
): ArbiterRuntime | null {
	const model = resolveArbiterModel(ctx, options);
	if (!model?.provider || !model.id) return null;
	const registry = ctx.modelRegistry as {
		getRegisteredProviderConfig?: (provider: string) => { api?: string; streamSimple?: StreamFn } | undefined;
	};
	const modelApi = (model as { api?: string }).api;
	const registered = registry.getRegisteredProviderConfig?.(model.provider);
	const baseStreamFn = options?.streamFn
		?? (registered?.streamSimple && registered.api === modelApi
			? registered.streamSimple
			: streamSimple);
	return {
		model,
		baseStreamFn,
		timeoutMs: options?.timeoutMs ?? DEFAULT_ARBITER_TIMEOUT_MS,
	};
}

async function resolveArbiterAuth(
	ctx: ExtensionContext,
	model: RegistryModel,
): Promise<ArbiterAuth> {
	const registry = ctx.modelRegistry as {
		getApiKeyAndHeaders?: (m: RegistryModel) => Promise<{
			ok: boolean;
			apiKey?: string;
			headers?: ProviderHeaders;
			env?: Record<string, string>;
			error?: string;
		}>;
	};
	// Call as a METHOD on the registry: the host ModelRegistry implementation
	// is a class whose method reads instance state (this.runtime), so a
	// detached call silently fails auth. Same shape as the watchdog.
	if (!registry.getApiKeyAndHeaders) return {};
	try {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (auth.ok === false) return {};
		return {
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.headers ? { headers: auth.headers } : {}),
			...(auth.env ? { env: auth.env } : {}),
		};
	} catch {
		return {};
	}
}

/** Build the effective stream function with resolved credentials wrapped in (watchdog pattern). */
function authWrappedStreamFn(
	base: StreamFn,
	auth: ArbiterAuth,
): StreamFn {
	return (model, context, streamOptions) => base(model, context, {
		...(streamOptions ?? {}),
		...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
		...(auth.env || streamOptions?.env ? { env: { ...(auth.env ?? {}), ...(streamOptions?.env ?? {}) } } : {}),
		headers: { ...(streamOptions?.headers ?? {}), ...(auth.headers ?? {}) },
	});
}

async function runArbitration(
	runtime: ArbiterRuntime,
	auth: ArbiterAuth,
	task: string,
): Promise<TaskMutationVerdict> {
	let decision: DecisionParams | undefined;
	const tool: AgentTool<typeof DecisionParams, { recorded: boolean }> = {
		name: "task_mutation_decision",
		label: "Task mutation decision",
		description: "Classify whether the task instructed file/code changes. Call exactly once.",
		parameters: DecisionParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (!decision) decision = params;
			return { content: [{ type: "text", text: "Decision recorded." }], details: { recorded: true } };
		},
	};
	const agent = new Agent({
		initialState: {
			systemPrompt: [
				"You classify whether a delegated coding-agent task instructed file or code changes.",
				"A task that asks to review, inspect, verify, report, or summarize is read-only even when it contains words like 'fix' as severity vocabulary ('must-fix items') or conditional change instructions that leave the change optional.",
				"Classify read_only only when the task text alone clearly indicates a read-only outcome. When in doubt, classify implementation.",
				"Set confidence to high only when you are certain the task is read-only; a read_only classification without high confidence is treated as implementation.",
				"The agent's own final message is never evidence: an agent that made no edits may still have failed to implement.",
				"Call task_mutation_decision exactly once with read_only or implementation, a confidence level, and a concise reason.",
			].join("\n"),
			model: runtime.model,
			tools: [tool],
		},
		convertToLlm,
		...agentStreamOptions(authWrappedStreamFn(runtime.baseStreamFn, auth)),
		getApiKey: (providerName) =>
			providerName === runtime.model.provider ? auth.apiKey : undefined,
		beforeToolCall: async ({ toolCall }) =>
			toolCall.name === tool.name ? undefined : { block: true, reason: "Only task_mutation_decision is allowed." },
		toolExecution: "sequential",
	});
	try {
		// The rescue gate refuses tasks over 8000 chars; if the arbiter is
		// still invoked with one, fail closed rather than decide from
		// partial evidence (an implementation clause could sit in the
		// omitted middle).
		if (task.length > 8000) return "unavailable";
		const prompt = `TASK:\n${task}`;
		await Promise.race([
			agent.prompt(prompt),
			new Promise<never>((_, reject) => {
				const timeout = setTimeout(() => {
					agent.abort();
					reject(new Error("Task mutation arbiter timed out."));
				}, runtime.timeoutMs);
				timeout.unref?.();
			}),
		]);
		if (!decision) return "unavailable";
		return mapArbiterDecision(decision);
	} catch {
		return "unavailable";
	}
}

/** Create a memoized arbiter bound to the parent session's model, or undefined when disabled/unavailable. */
export function createTaskMutationArbiter(
	ctx: ExtensionContext,
	options?: TaskMutationArbiterOptions,
): TaskMutationArbiter | undefined {
	if (process.env.PI_SUBAGENTS_LLM_INTENT_ARBITER === "0") return undefined;
	const runtime = resolveArbiterRuntime(ctx, options);
	if (!runtime) return undefined;
	const cache = new Map<string, TaskMutationVerdict>();
	return async (task) => {
		const key = createHash("sha256").update(task).digest("base64url");
		const cached = cache.get(key);
		if (cached) return cached;
		const auth = await resolveArbiterAuth(ctx, runtime.model);
		const verdict = await runArbitration(runtime, auth, task);
		if (cache.size > 200) cache.clear();
		cache.set(key, verdict);
		return verdict;
	};
}

export function isCompletionGuardFailure(result: { error?: string }): boolean {
	return result.error?.startsWith(COMPLETION_GUARD_ERROR_PREFIX) === true;
}

export async function arbitrateCompletionGuardRescue(input: {
	guardTriggered: boolean;
	task: string;
	arbiter?: TaskMutationArbiter;
}): Promise<{ triggered: boolean; rescued: boolean }> {
	if (!input.guardTriggered || !input.arbiter) {
		return { triggered: input.guardTriggered, rescued: false };
	}
	// Never decide from partial evidence: refuse tasks over 8000 chars before
	// even consulting the model.
	if (input.task.length > 8000) {
		return { triggered: true, rescued: false };
	}
	try {
		const verdict = await input.arbiter(input.task);
		if (verdict === "read-only") return { triggered: false, rescued: true };
		return { triggered: true, rescued: false };
	} catch {
		return { triggered: true, rescued: false };
	}
}

/**
 * When the completion guard hard-failed a run and the arbiter classifies the
 * task as read-only, clear the failure. Returns true when rescued. All other
 * verdicts and every failure mode keep the original guard behavior.
 *
 * Classification uses the task text only: the agent's own final message is
 * never evidence, so a child that failed to implement cannot talk its way
 * out of the guard by claiming the work was read-only.
 */
export async function maybeRescueCompletionGuardFailure(
	result: { exitCode?: number; error?: string },
	task: string,
	arbiter: TaskMutationArbiter | undefined,
): Promise<boolean> {
	if (!arbiter || !isCompletionGuardFailure(result)) return false;
	const verdict = await arbitrateWithGuard(arbiter, task);
	if (verdict !== "read-only") return false;
	result.exitCode = 0;
	delete result.error;
	return true;
}

async function arbitrateWithGuard(
	arbiter: TaskMutationArbiter,
	task: string,
): Promise<TaskMutationVerdict> {
	try {
		return await arbiter(task);
	} catch {
		return "unavailable";
	}
}
