import { Agent, type AgentTool, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools, convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { resolveModelCandidate } from "../runs/shared/model-fallback.ts";
import { resolveEffectiveThinking, splitKnownThinkingSuffix, THINKING_LEVELS, toModelInfo } from "../shared/model-info.ts";
import type { WatchdogReviewFunction, WatchdogReviewRequest } from "./runtime.ts";
import {
	WATCHDOG_WARNING_CATEGORIES,
	WATCHDOG_WARNING_CONFIDENCES,
	WATCHDOG_WARNING_SEVERITIES,
	type ResolvedWatchdogConfig,
	type WatchdogCategory,
	type WatchdogConfidence,
	type WatchdogSeverity,
	type WatchdogWarning,
} from "./types.ts";

const WATCHDOG_ALLOWED_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "watchdog_warn"]);

const WatchdogWarnParams = Type.Object({
	severity: Type.String({ enum: WATCHDOG_WARNING_SEVERITIES, description: "concern for actionable risk, blocker for a likely wrong or unsafe outcome" }),
	summary: Type.String({ description: "One concise sentence naming the issue." }),
	evidence: Type.String({ description: "Specific evidence from the turn delta or inspected files." }),
	recommendedAction: Type.String({ description: "Specific action the parent should take before accepting or continuing." }),
	category: Type.Optional(Type.String({ enum: WATCHDOG_WARNING_CATEGORIES })),
	confidence: Type.Optional(Type.String({ enum: WATCHDOG_WARNING_CONFIDENCES })),
}, { additionalProperties: false });

type WatchdogWarnParams = Static<typeof WatchdogWarnParams>;

type WatchdogContextProvider = ExtensionContext | (() => ExtensionContext | undefined);

type RegistryModel = Model<any>;

interface WatchdogReviewAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export interface WatchdogReviewModelSelection {
	model: RegistryModel;
	thinkingLevel: ThinkingLevel;
	auth: WatchdogReviewAuth;
	explicit: boolean;
}

export interface CreateMainWatchdogReviewOptions {
	streamFn?: StreamFn;
	createReadOnlyTools?: (cwd: string) => AgentTool[];
	getThinkingLevel?: () => ThinkingLevel | undefined;
}

function fullModelId(model: Pick<RegistryModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function splitProviderModel(value: string): { provider: string; id: string } | undefined {
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex === value.length - 1) return undefined;
	return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) };
}

function assertThinkingLevel(value: string, source: string): ThinkingLevel {
	if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
	throw new Error(`Unsupported watchdog thinking level '${value}' from ${source}; expected ${THINKING_LEVELS.join(", ")} or false.`);
}

function contextThinkingLevel(ctx: ExtensionContext, currentThinkingLevel: ThinkingLevel | undefined): ThinkingLevel | undefined {
	if (currentThinkingLevel) return currentThinkingLevel;
	const value = (ctx as { thinkingLevel?: unknown }).thinkingLevel;
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value) ? value as ThinkingLevel : undefined;
}

function resolveReviewThinking(input: {
	modelString: string;
	configThinking: string | false | undefined;
	ctx: ExtensionContext;
	allowContextThinking: boolean;
	currentThinkingLevel?: ThinkingLevel;
}): ThinkingLevel {
	const fromModelOrConfig = resolveEffectiveThinking(input.modelString, input.configThinking);
	if (fromModelOrConfig) return assertThinkingLevel(fromModelOrConfig, "watchdog model/config");
	if (input.configThinking === false) return "off";
	if (input.configThinking !== undefined) return assertThinkingLevel(input.configThinking, "watchdog config");
	if (input.allowContextThinking) return contextThinkingLevel(input.ctx, input.currentThinkingLevel) ?? "off";
	return "off";
}

function resolveConfiguredModel(ctx: ExtensionContext, rawModel: string): { model: RegistryModel; modelString: string } {
	const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const preferredProvider = typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined;
	const resolved = resolveModelCandidate(rawModel, availableModels, preferredProvider);
	const { baseModel } = splitKnownThinkingSuffix(resolved);
	const named = splitProviderModel(baseModel);
	if (!named) {
		throw new Error(`Configured watchdog model '${rawModel}' did not match exactly one authenticated available model. Use provider/model or configure credentials for the intended provider.`);
	}

	const model = ctx.modelRegistry.find(named.provider, named.id);
	if (!model) throw new Error(`Configured watchdog model '${rawModel}' was not found as '${baseModel}'.`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Configured watchdog model '${baseModel}' is not authenticated. Configure credentials for provider '${named.provider}' or choose an authenticated model.`);
	}
	return { model, modelString: resolved };
}

async function resolveReviewAuth(ctx: ExtensionContext, model: RegistryModel): Promise<WatchdogReviewAuth> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Watchdog model auth failed for ${fullModelId(model)}: ${auth.error}`);
	return {
		...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
		...(auth.headers ? { headers: auth.headers } : {}),
		...(auth.env ? { env: auth.env } : {}),
	};
}

export async function resolveWatchdogReviewModel(
	ctx: ExtensionContext,
	config: ResolvedWatchdogConfig,
	options: { currentThinkingLevel?: ThinkingLevel } = {},
): Promise<WatchdogReviewModelSelection> {
	if (config.main.model) {
		const resolved = resolveConfiguredModel(ctx, config.main.model);
		return {
			model: resolved.model,
			thinkingLevel: resolveReviewThinking({
				modelString: resolved.modelString,
				configThinking: config.main.thinking,
				ctx,
				allowContextThinking: false,
				currentThinkingLevel: options.currentThinkingLevel,
			}),
			auth: await resolveReviewAuth(ctx, resolved.model),
			explicit: true,
		};
	}

	const currentModel = ctx.model;
	if (!currentModel) {
		throw new Error("Main watchdog review cannot run because the current Pi session model is unavailable and subagents.watchdog.main.model is not configured.");
	}
	return {
		model: currentModel,
		thinkingLevel: resolveReviewThinking({
			modelString: fullModelId(currentModel),
			configThinking: config.main.thinking,
			ctx,
			allowContextThinking: true,
			currentThinkingLevel: options.currentThinkingLevel,
		}),
		auth: await resolveReviewAuth(ctx, currentModel),
		explicit: false,
	};
}

function nonEmptyString(value: string, field: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`watchdog_warn.${field} must be a non-empty string.`);
	return trimmed;
}

function toWatchdogWarning(params: WatchdogWarnParams): WatchdogWarning {
	return {
		severity: params.severity as WatchdogSeverity,
		category: (params.category ?? "other") as WatchdogCategory,
		confidence: (params.confidence ?? "medium") as WatchdogConfidence,
		source: "main",
		summary: nonEmptyString(params.summary, "summary"),
		evidence: nonEmptyString(params.evidence, "evidence"),
		recommendedAction: nonEmptyString(params.recommendedAction, "recommendedAction"),
	};
}

function createWatchdogWarnTool(request: WatchdogReviewRequest): AgentTool<typeof WatchdogWarnParams, { accepted: boolean }> {
	return {
		name: "watchdog_warn",
		label: "Watchdog warning",
		description: [
			"Emit one actionable main-session watchdog warning.",
			"Use only for medium/high confidence concerns or blockers that the parent should consider before accepting the work.",
			"Do not use for nits, praise, informational notes, or clean reviews.",
		].join(" "),
		parameters: WatchdogWarnParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const warning = toWatchdogWarning(params);
			const accepted = request.emitWarning(warning);
			return {
				content: [{
					type: "text",
					text: accepted
						? "Watchdog warning recorded."
						: "Watchdog warning was ignored by the runtime guard because it was stale, duplicate, or over budget.",
				}],
				details: { accepted },
			};
		},
	};
}

function buildWatchdogSystemPrompt(ctx: ExtensionContext): string {
	return [
		"You are the main-session subagent watchdog for Pi.",
		`Working directory: ${ctx.cwd}`,
		"Review only the supplied parent turn delta. Inspect repository files only when needed to verify a concrete concern.",
		"You are read-only. You may use read, grep, find, and ls. Do not edit files, run shell commands, spawn agents, or mutate state.",
		"Emit warnings only by calling watchdog_warn. Freeform assistant text is ignored and must not be used to report warnings.",
		"Emit only medium/high confidence actionable concerns or blockers: missed user constraints, correctness risks, test gaps that matter, unsafe changes, stale facts, loop risks, or scope drift.",
		"Do not emit nits, style preferences, low-confidence guesses, informational notes, praise, or summaries.",
		"If the turn is clean, call no tools and end normally.",
		"Use severity='blocker' only when the issue should stop acceptance until addressed; otherwise use severity='concern'.",
	].join("\n");
}

function buildReviewPrompt(request: WatchdogReviewRequest, selection: WatchdogReviewModelSelection): string {
	return [
		"Review this parent-session turn delta for subagent-watchdog-worthy issues.",
		`Review id: ${request.reviewId}; epoch: ${request.epoch}; review model: ${fullModelId(selection.model)}; thinking: ${selection.thinkingLevel}.`,
		"Call watchdog_warn for each qualifying concern or blocker. Call no tools when clean.",
		"<turn_delta>",
		request.delta,
		"</turn_delta>",
	].join("\n\n");
}

function finalStopReason(agent: Agent): "stop" | "error" | "aborted" | "length" {
	for (let index = agent.state.messages.length - 1; index >= 0; index--) {
		const message = agent.state.messages[index];
		if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
			const stopReason = (message as { stopReason?: unknown }).stopReason;
			if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") return stopReason;
			return "stop";
		}
	}
	return "stop";
}

function resolveContext(provider: WatchdogContextProvider): ExtensionContext | undefined {
	return typeof provider === "function" ? provider() : provider;
}

export function createMainWatchdogReview(provider: WatchdogContextProvider, options: CreateMainWatchdogReviewOptions = {}): WatchdogReviewFunction {
	return async (request) => {
		const ctx = resolveContext(provider);
		if (!ctx) throw new Error("Main watchdog review cannot run without an active Pi extension context.");
		if (ctx.signal?.aborted || request.signal?.aborted) return { stopReason: "aborted" };
		const selection = await resolveWatchdogReviewModel(ctx, request.config, {
			currentThinkingLevel: options.getThinkingLevel?.(),
		});
		if (ctx.signal?.aborted || request.signal?.aborted) return { stopReason: "aborted" };
		const auth = selection.auth;
		const baseStreamFn = options.streamFn ?? streamSimple;
		const streamFn: StreamFn = (model, context, streamOptions) => baseStreamFn(model, context, {
			...streamOptions,
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			env: auth.env || streamOptions?.env ? { ...(auth.env ?? {}), ...(streamOptions?.env ?? {}) } : undefined,
			headers: { ...(streamOptions?.headers ?? {}), ...(auth.headers ?? {}) },
		});
		const tools = [
			...(options.createReadOnlyTools ?? createReadOnlyTools)(ctx.cwd).filter((tool) => WATCHDOG_ALLOWED_TOOL_NAMES.has(tool.name) && tool.name !== "watchdog_warn"),
			createWatchdogWarnTool(request),
		];
		const agent = new Agent({
			initialState: {
				systemPrompt: buildWatchdogSystemPrompt(ctx),
				model: selection.model,
				thinkingLevel: selection.thinkingLevel,
				tools,
			},
			convertToLlm,
			streamFn,
			getApiKey: (providerName) => providerName === selection.model.provider ? auth.apiKey : undefined,
			beforeToolCall: async ({ toolCall }) => WATCHDOG_ALLOWED_TOOL_NAMES.has(toolCall.name)
				? undefined
				: { block: true, reason: `Watchdog reviews are read-only; tool '${toolCall.name}' is not allowed.` },
			toolExecution: "sequential",
		});
		const abort = () => agent.abort();
		ctx.signal?.addEventListener("abort", abort, { once: true });
		request.signal?.addEventListener("abort", abort, { once: true });
		try {
			if (ctx.signal?.aborted || request.signal?.aborted) return { stopReason: "aborted" };
			await agent.prompt(buildReviewPrompt(request, selection));
		} finally {
			ctx.signal?.removeEventListener("abort", abort);
			request.signal?.removeEventListener("abort", abort);
		}
		return { stopReason: finalStopReason(agent) };
	};
}
