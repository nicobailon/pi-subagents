import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { createMainWatchdogReview, resolveWatchdogReviewModel } from "../../src/watchdog/review.ts";
import type { WatchdogReviewRequest } from "../../src/watchdog/runtime.ts";
import type { ResolvedWatchdogConfig, WatchdogWarning } from "../../src/watchdog/types.ts";

function model(provider: string, id: string, overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id,
		name: id,
		api: "faux",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
		...overrides,
	};
}

function cloneConfig(): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
		autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.autoFollow },
		main: { ...DEFAULT_WATCHDOG_CONFIG.main },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.children.autoFollow },
			overrides: { ...DEFAULT_WATCHDOG_CONFIG.children.overrides },
		},
		asyncCompletion: { ...DEFAULT_WATCHDOG_CONFIG.asyncCompletion },
		lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp },
	};
}

function enabledConfig(main: Partial<ResolvedWatchdogConfig["main"]> = {}): ResolvedWatchdogConfig {
	const config = cloneConfig();
	config.enabled = true;
	config.main = { ...config.main, enabled: true, ...main };
	return config;
}

function createCtx(input: {
	current?: Model<any>;
	models?: Model<any>[];
	authenticated?: string[];
	thinkingLevel?: string;
	providerConfig?: { provider: string; api: string; streamSimple: StreamFn };
}) {
	const allModels = input.models ?? (input.current ? [input.current] : []);
	const authenticated = new Set(input.authenticated ?? allModels.map((entry) => `${entry.provider}/${entry.id}`));
	return {
		cwd: "/tmp/watchdog-review",
		model: input.current,
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		signal: undefined,
		getSystemPrompt: () => "Parent system prompt",
		modelRegistry: {
			getAvailable: () => allModels.filter((entry) => authenticated.has(`${entry.provider}/${entry.id}`)),
			find: (provider: string, id: string) => allModels.find((entry) => entry.provider === provider && entry.id === id),
			hasConfiguredAuth: (entry: Model<any>) => authenticated.has(`${entry.provider}/${entry.id}`),
			getApiKeyAndHeaders: async (entry: Model<any>) => authenticated.has(`${entry.provider}/${entry.id}`)
				? { ok: true as const, apiKey: `key-${entry.provider}-${entry.id}`, headers: { "x-model": entry.id }, env: { WATCHDOG_PROVIDER: entry.provider } }
				: { ok: false as const, error: `No auth for ${entry.provider}/${entry.id}` },
			getRegisteredProviderConfig: (provider: string) => input.providerConfig?.provider === provider ? input.providerConfig : undefined,
		},
	} as never;
}

function responseStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({ type: "done", reason: message.stopReason, message });
		}
	});
	return stream;
}

function createStreamFn(responses: AssistantMessage[]) {
	const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
	const streamFn: StreamFn = (nextModel, context, options) => {
		calls.push({ model: nextModel, context, options });
		return responseStream(responses.shift() ?? fauxAssistantMessage("done", { stopReason: "stop" }));
	};
	return { streamFn, calls };
}

function request(config: ResolvedWatchdogConfig, warnings: WatchdogWarning[]): WatchdogReviewRequest {
	return {
		delta: "Assistant changed src/example.ts and said tests passed.",
		epoch: 1,
		reviewId: 7,
		config,
		emitWarning(warning) {
			warnings.push(warning);
			return true;
		},
	};
}

describe("main watchdog review adapter", () => {
	it("ignores clean freeform review text and emits no warnings", async () => {
		const current = model("openai", "gpt-clean");
		const ctx = createCtx({ current });
		const { streamFn } = createStreamFn([fauxAssistantMessage("No concerns.", { stopReason: "stop" })]);
		const warnings: WatchdogWarning[] = [];

		const result = await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));

		assert.deepEqual(warnings, []);
		assert.equal(result?.stopReason, "stop");
	});

	it("records watchdog_warn emissions through the runtime seam", async () => {
		const current = model("openai", "gpt-warning");
		const ctx = createCtx({ current });
		const { streamFn } = createStreamFn([
			fauxAssistantMessage(fauxToolCall("watchdog_warn", {
				severity: "blocker",
				category: "correctness",
				confidence: "high",
				summary: "The test claim is unverified",
				evidence: "The delta says tests passed but no test command appears.",
				recommendedAction: "Run the focused test before accepting the result.",
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		const warnings: WatchdogWarning[] = [];

		await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));

		assert.equal(warnings.length, 1);
		assert.deepEqual(warnings[0], {
			severity: "blocker",
			category: "correctness",
			confidence: "high",
			source: "main",
			summary: "The test claim is unverified",
			evidence: "The delta says tests passed but no test command appears.",
			recommendedAction: "Run the focused test before accepting the result.",
		});
	});

	it("does not start the agent stream when the review request signal is already aborted", async () => {
		const current = model("openai", "gpt-pre-abort");
		const ctx = createCtx({ current });
		const controller = new AbortController();
		controller.abort();
		let streamStarted = false;
		const streamFn: StreamFn = () => {
			streamStarted = true;
			return responseStream(fauxAssistantMessage("should not start", { stopReason: "stop" }));
		};
		const warnings: WatchdogWarning[] = [];

		const result = await createMainWatchdogReview(ctx, { streamFn })(
			{ ...request(enabledConfig(), warnings), signal: controller.signal },
		);

		assert.equal(streamStarted, false);
		assert.equal(result?.stopReason, "aborted");
	});

	it("does not start the agent stream when the review request aborts during model setup", async () => {
		const current = model("openai", "gpt-setup-abort");
		const controller = new AbortController();
		let releaseAuth!: () => void;
		const authStarted = new Promise<void>((resolve) => { releaseAuth = resolve; });
		let streamStarted = false;
		const ctx = {
			...createCtx({ current }),
			modelRegistry: {
				...createCtx({ current }).modelRegistry,
				async getApiKeyAndHeaders(entry: Model<any>) {
					await authStarted;
					return { ok: true as const, apiKey: `key-${entry.provider}-${entry.id}` };
				},
			},
		} as never;
		const streamFn: StreamFn = () => {
			streamStarted = true;
			return responseStream(fauxAssistantMessage("should not start", { stopReason: "stop" }));
		};
		const warnings: WatchdogWarning[] = [];

		const review = createMainWatchdogReview(ctx, { streamFn })(
			{ ...request(enabledConfig(), warnings), signal: controller.signal },
		);
		controller.abort();
		releaseAuth();
		const result = await review;

		assert.equal(streamStarted, false);
		assert.equal(result?.stopReason, "aborted");
	});

	it("aborts the underlying agent stream when the review request signal aborts", async () => {
		const current = model("openai", "gpt-abort");
		const ctx = createCtx({ current });
		const controller = new AbortController();
		let streamStarted!: () => void;
		let streamAborted = false;
		const started = new Promise<void>((resolve) => { streamStarted = resolve; });
		const streamFn: StreamFn = (_nextModel, _context, options) => {
			const stream = createAssistantMessageEventStream();
			options?.signal?.addEventListener("abort", () => {
				streamAborted = true;
				stream.push({ type: "error", reason: "aborted", error: fauxAssistantMessage("aborted", { stopReason: "aborted" }) });
			}, { once: true });
			streamStarted();
			return stream;
		};
		const warnings: WatchdogWarning[] = [];

		const review = createMainWatchdogReview(ctx, { streamFn })(
			{ ...request(enabledConfig(), warnings), signal: controller.signal },
		);
		await started;
		controller.abort();
		const result = await review;

		assert.equal(streamAborted, true);
		assert.equal(result?.stopReason, "aborted");
	});

	it("does not expose mutating tools to the watchdog agent", async () => {
		const current = model("openai", "gpt-readonly");
		const ctx = createCtx({ current });
		const { streamFn, calls } = createStreamFn([
			fauxAssistantMessage(fauxToolCall("bash", { command: "touch should-not-run" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		const warnings: WatchdogWarning[] = [];

		await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), warnings));

		assert.equal(warnings.length, 0);
		assert.deepEqual(calls[0]?.context.tools?.map((tool) => tool.name).sort(), ["find", "grep", "ls", "read", "watchdog_warn"]);
		const toolResult = calls[1]?.context.messages.find((message) => message.role === "toolResult" && message.toolName === "bash");
		assert.equal(toolResult?.isError, true);
	});

	it("fails loudly for explicit unauthenticated watchdog models", async () => {
		const current = model("openai", "gpt-current");
		const watchdog = model("anthropic", "claude-watchdog");
		const ctx = createCtx({ current, models: [current, watchdog], authenticated: [`${current.provider}/${current.id}`] });

		await assert.rejects(
			() => resolveWatchdogReviewModel(ctx, enabledConfig({ model: "anthropic/claude-watchdog" })),
			/authenticated.*anthropic/s,
		);
	});

	it("fails loudly for explicit missing watchdog models", async () => {
		const current = model("openai", "gpt-current");
		const ctx = createCtx({ current });

		await assert.rejects(
			() => resolveWatchdogReviewModel(ctx, enabledConfig({ model: "anthropic/missing-watchdog" })),
			/was not found.*anthropic\/missing-watchdog/s,
		);
	});

	it("uses the registered stream for matching custom providers", async () => {
		const current = model("custom-provider", "watchdog", { api: "custom-api" });
		const { streamFn, calls } = createStreamFn([fauxAssistantMessage("clean", { stopReason: "stop" })]);
		const ctx = createCtx({ current, providerConfig: { provider: current.provider, api: "custom-api", streamSimple: streamFn } });
		const warnings: WatchdogWarning[] = [];

		const result = await createMainWatchdogReview(ctx)(request(enabledConfig(), warnings));

		assert.equal(result?.stopReason, "stop");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.model, current);
		assert.equal(calls[0]?.options?.apiKey, "key-custom-provider-watchdog");
		assert.equal(calls[0]?.options?.headers?.["x-model"], "watchdog");
		assert.deepEqual(calls[0]?.options?.env, { WATCHDOG_PROVIDER: "custom-provider" });
	});

	it("falls back to the current session model and thinking when no watchdog model is configured", async () => {
		const current = model("github-copilot", "gpt-session");
		const ctx = createCtx({ current });
		const { streamFn, calls } = createStreamFn([fauxAssistantMessage("clean", { stopReason: "stop" })]);
		const warnings: WatchdogWarning[] = [];

		await createMainWatchdogReview(ctx, { streamFn, getThinkingLevel: () => "high" })(request(enabledConfig(), warnings));

		assert.equal(calls[0]?.model, current);
		assert.equal(calls[0]?.options?.apiKey, "key-github-copilot-gpt-session");
		assert.equal(calls[0]?.options?.reasoning, "high");
		assert.deepEqual(calls[0]?.options?.env, { WATCHDOG_PROVIDER: "github-copilot" });
	});

	it("resolves configured model suffixes and thinking deterministically", async () => {
		const current = model("openai", "gpt-current");
		const dated = model("openai", "gpt-5-20260707");
		const ctx = createCtx({ current, models: [current, dated] });

		const suffixWins = await resolveWatchdogReviewModel(ctx, enabledConfig({ model: "openai.gpt_5:high", thinking: "low" }));
		const explicitOff = await resolveWatchdogReviewModel(ctx, enabledConfig({ model: "openai/gpt-5-20260707", thinking: false }));
		const suffixBeatsFalse = await resolveWatchdogReviewModel(ctx, enabledConfig({ model: "openai/gpt-5-20260707:medium", thinking: false }));

		assert.equal(suffixWins.model, dated);
		assert.equal(suffixWins.thinkingLevel, "high");
		assert.equal(explicitOff.model, dated);
		assert.equal(explicitOff.thinkingLevel, "off");
		assert.equal(suffixBeatsFalse.model, dated);
		assert.equal(suffixBeatsFalse.thinkingLevel, "medium");
	});
});
