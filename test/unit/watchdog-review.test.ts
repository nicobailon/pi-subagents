import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { WATCHDOG_GUIDANCE_MAX_CHARS } from "../../src/watchdog/guidance.ts";
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
import { MainWatchdogRuntime, type WatchdogReviewRequest } from "../../src/watchdog/runtime.ts";
import { buildWatchdogStatus } from "../../src/watchdog/register-main.ts";
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
		main: { ...DEFAULT_WATCHDOG_CONFIG.main },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			overrides: { ...DEFAULT_WATCHDOG_CONFIG.children.overrides },
		},
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
		sessionManager: { getSessionId: () => "watchdog-review-session" },
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
	it("keeps the runtime deadline authoritative during fallback setup and displays configured chains", async () => {
		const a = model("mock", "a");
		const b = model("mock", "b");
		const ctx = createCtx({ current: a, models: [a, b] });
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const registry = (ctx as any).modelRegistry;
		const getAuth = registry.getApiKeyAndHeaders;
		registry.getApiKeyAndHeaders = async (entry: Model<any>) => {
			if (entry.id === "b") await pending;
			return getAuth(entry);
		};
		const { streamFn, calls } = createStreamFn([fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit" })]);
		const config = enabledConfig({ fallbackModels: ["mock/b"] });
		config.agentEndTimeoutMs = 10;
		config.lsp.enabled = false;
		config.children.fallbackModels = ["mock/a"];
		config.children.overrides.worker = { fallbackModels: [] };
		const review = createMainWatchdogReview(ctx, { streamFn });
		let reviewDone: ReturnType<typeof review>;
		const runtime = new MainWatchdogRuntime({ resolveConfig: () => ({ ok: true, config, errors: [], sources: [] }), review: (req) => reviewDone = review(req) });
		try {
			runtime.enqueueDelta("Assistant changed a file");
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(runtime.getSnapshot().status, "stale");
			release();
			assert.equal((await reviewDone!)?.stopReason, "aborted");
			assert.deepEqual(calls.map((call) => call.model.id), ["a"]);
			const status = buildWatchdogStatus(runtime.getSnapshot(), ctx);
			assert.match(status, /Main model: .*fallbacks mock\/b/);
			assert.match(status, /Children: .*fallbacks mock\/a.*worker.*fallbacks none/);
		} finally {
			release();
			runtime.reset("cleanup");
		}
	});

	it("retries ordered provider failures with fresh model-specific context and deduplicated candidates", async () => {
		const primary = model("first", "a");
		const fallback = model("second", "b");
		const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn: StreamFn = (nextModel, context, options) => {
			calls.push({ model: nextModel, context: { ...context, messages: [...context.messages] }, options });
			return responseStream(fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }));
		};
		const ctx = createCtx({ current: primary, models: [fallback], authenticated: ["first/a", "second/b"], thinkingLevel: "high" });
		// Both provider registrations are resolved separately; no generic stream override.
		const providers: string[] = [];
		(ctx as any).modelRegistry.getRegisteredProviderConfig = (provider: string) => ({ api: "faux", streamSimple: (...args: Parameters<StreamFn>) => {
			providers.push(provider);
			return streamFn(...args);
		} });
		const result = await createMainWatchdogReview(ctx)(request(enabledConfig({ fallbackModels: ["first/a", "second/b:low", "second/b:low"] }), []));
		assert.equal(result?.stopReason, "error", "exhaustion must not become clean success");
		assert.deepEqual(calls.map((call) => call.model), [primary, fallback]);
		assert.deepEqual(providers, ["first", "second"]);
		assert.equal(calls[0].model, primary, "inherited primary retains session model identity");
		assert.deepEqual(calls.map((call) => call.options?.reasoning), ["high", "low"]);
		assert.deepEqual(calls.map((call) => call.options?.apiKey), ["key-first-a", "key-second-b"]);
		assert.deepEqual(calls.map((call) => call.options?.headers?.["x-model"]), ["a", "b"]);
		assert.deepEqual(calls.map((call) => call.options?.env?.WATCHDOG_PROVIDER), ["first", "second"]);
		assert.deepEqual(calls.map((call) => call.context.messages.length), [1, 1]);
	});

	it("skips an unavailable configured primary and retries a provider timeout", async () => {
		const a = model("mock", "a");
		const b = model("mock", "b");
		const { streamFn, calls } = createStreamFn([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider timeout" }),
			fauxAssistantMessage("", { stopReason: "stop" }),
		]);
		const result = await createMainWatchdogReview(createCtx({ current: a, models: [a, b] }), { streamFn })(request(enabledConfig({ model: "missing/model", fallbackModels: ["mock/a", "mock/b"] }), []));
		assert.equal(result?.stopReason, "stop");
		assert.deepEqual(calls.map((call) => call.model.id), ["a", "b"]);
	});

	it("retries OpenRouter's 401 on the configured cross-provider fallback", async () => {
		const a = model("openrouter", "a");
		const b = model("second", "b");
		const { streamFn, calls } = createStreamFn([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: '401: {"message":"User not found.","code":401}' }),
			fauxAssistantMessage("", { stopReason: "stop" }),
		]);
		const result = await createMainWatchdogReview(createCtx({ current: a, models: [a, b] }), { streamFn })(request(enabledConfig({ fallbackModels: ["second/b"] }), []));
		assert.equal(result?.stopReason, "stop");
		assert.deepEqual(calls.map((call) => call.model), [a, b]);
	});

	it("does not retry context overflow even when the provider error also says upstream", async () => {
		const a = model("mock", "a");
		const b = model("mock", "b");
		const { streamFn, calls } = createStreamFn([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream: maximum context length exceeded" }),
		]);
		const result = await createMainWatchdogReview(createCtx({ current: a, models: [a, b] }), { streamFn })(request(enabledConfig({ fallbackModels: ["mock/b"] }), []));
		assert.deepEqual(calls.map((call) => call.model.id), ["a"]);
		assert.equal(result?.stopReason, "error");
	});

	it("does not retry normal, length, aborted, or unclassified error outcomes", async () => {
		const a = model("mock", "a");
		const b = model("mock", "b");
		for (const stopReason of ["stop", "length", "aborted", "error"] as const) {
			const { streamFn, calls } = createStreamFn([fauxAssistantMessage("", { stopReason, errorMessage: stopReason === "error" ? "invalid request" : "provider timeout" })]);
			const result = await createMainWatchdogReview(createCtx({ current: a, models: [a, b] }), { streamFn })(request(enabledConfig({ fallbackModels: ["mock/b"] }), []));
			assert.equal(result?.stopReason, stopReason);
			assert.equal(calls.length, 1);
		}
	});

	it("does not retry provider errors after inspection or warnings, even rejected warnings", async () => {
		const a = model("mock", "a");
		const b = model("mock", "b");
		for (const toolCall of [fauxToolCall("ls", { path: "." }), fauxToolCall("watchdog_warn", { severity: "concern", summary: "Concern", evidence: "Evidence", recommendedAction: "Fix" })]) {
			let inspections = 0;
			const { streamFn, calls } = createStreamFn([
				fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }),
			]);
			const result = await createMainWatchdogReview(createCtx({ current: a, models: [a, b] }), {
				streamFn,
				createReadOnlyTools: () => [{ name: "ls", label: "ls", description: "List files", parameters: Type.Object({ path: Type.String() }), execute: async () => {
					inspections++;
					return { content: [{ type: "text", text: "file.ts" }], details: {} };
				} }],
			})({ ...request(enabledConfig({ fallbackModels: ["mock/b"] }), []), emitWarning: () => false });
			assert.equal(result?.stopReason, "error");
			assert.deepEqual(calls.map((call) => call.model.id), ["a", "a"]);
			assert.equal(inspections, toolCall.name === "ls" ? 1 : 0);
		}
	});

	it("retries pre-stream auth failure but never advances after request cancellation during setup", async () => {
		const a = model("mock", "a");
		const b = model("mock", "b");
		for (const cancel of [false, true]) {
			const controller = new AbortController();
			const ctx = createCtx({ current: a, models: [a, b] });
			const registry = (ctx as any).modelRegistry;
			const getAuth = registry.getApiKeyAndHeaders;
			registry.getApiKeyAndHeaders = async (entry: Model<any>) => {
				if (entry.id !== "a") return getAuth(entry);
				if (cancel) controller.abort();
				return { ok: false, error: "token expired" };
			};
			const { streamFn, calls } = createStreamFn([]);
			const result = await createMainWatchdogReview(ctx, { streamFn })({ ...request(enabledConfig({ fallbackModels: ["mock/b"] }), []), signal: controller.signal });
			assert.equal(result?.stopReason, cancel ? "aborted" : "stop");
			assert.deepEqual(calls.map((call) => call.model.id), cancel ? [] : ["b"]);
		}
	});

	it("yields an ask from a mixed batch without another model call or warning", async () => {
		const { streamFn, calls } = createStreamFn([fauxAssistantMessage([
			fauxToolCall("watchdog_ask", { question: "Which constraint applies?", evidence: "Two scope statements differ." }),
			fauxToolCall("watchdog_warn", { severity: "concern", summary: "Must not emit", evidence: "x", recommendedAction: "x" }),
			fauxToolCall("ls", { path: "." }),
		], { stopReason: "toolUse" })]);
		const warnings: WatchdogWarning[] = [];
		const current = model("mock", "review");
		const review = createMainWatchdogReview(createCtx({ current, models: [current, model("mock", "fallback")] }), { streamFn });
		const result = await review({ ...request(enabledConfig({ fallbackModels: ["mock/fallback"] }), warnings), allowClarification: true });
		assert.deepEqual(result, { clarification: { question: "Which constraint applies?", evidence: "Two scope statements differ." } });
		assert.equal(calls.length, 1);
		assert.deepEqual(warnings, []);
	});

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
			{ ...request(enabledConfig(), warnings), allowClarification: true, signal: controller.signal },
		);
		await started;
		controller.abort();
		const result = await review;

		assert.equal(streamAborted, true);
		assert.equal(result?.stopReason, "aborted");
	});

	it("includes WATCHDOG.md guidance in the system prompt", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-review-guidance-"));
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
			fs.mkdirSync(path.join(dir, "project", ".pi"), { recursive: true });
			fs.writeFileSync(path.join(dir, "project", ".pi", "WATCHDOG.md"), "Never accept skipped tests.\n", "utf-8");
			fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
			fs.writeFileSync(path.join(dir, "agent", "WATCHDOG.md"), "u".repeat(WATCHDOG_GUIDANCE_MAX_CHARS), "utf-8");
			const current = model("openai", "gpt-guidance");
			const ctx = { ...(createCtx({ current }) as object), cwd: path.join(dir, "project") } as never;
			const { streamFn, calls } = createStreamFn([fauxAssistantMessage("done", { stopReason: "stop" })]);

			await createMainWatchdogReview(ctx, { streamFn })(request(enabledConfig(), []));
			const prompt = String(calls[0]?.context.systemPrompt ?? "");
			assert.match(prompt, /Standing instructions from WATCHDOG\.md \(project first, then user\):\nNever accept skipped tests\.\n\nu+$/);
			assert.equal(prompt.split("(project first, then user):\n")[1]?.length, WATCHDOG_GUIDANCE_MAX_CHARS, "combined guidance is capped from the head");

			const disabled = enabledConfig();
			disabled.guidance = { watchdogMd: false };
			const second = createStreamFn([fauxAssistantMessage("done", { stopReason: "stop" })]);
			await createMainWatchdogReview(ctx, { streamFn: second.streamFn })(request(disabled, []));
			assert.doesNotMatch(String(second.calls[0]?.context.systemPrompt ?? ""), /Standing instructions/);
		} finally {
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("offers watchdog_diff only when a repo baseline is available", async () => {
		const current = model("openai", "gpt-diff");
		const ctx = createCtx({ current });
		const withBaseline = createStreamFn([fauxAssistantMessage("done", { stopReason: "stop" })]);
		await createMainWatchdogReview(ctx, { streamFn: withBaseline.streamFn, diffBaseline: () => ({ root: "/tmp/watchdog-review", ref: "abc123" }) })(request(enabledConfig(), []));
		assert.deepEqual(withBaseline.calls[0]?.context.tools?.map((tool) => tool.name).sort(), ["find", "grep", "ls", "read", "watchdog_diff", "watchdog_warn"]);
		assert.match(String(withBaseline.calls[0]?.context.systemPrompt ?? ""), /watchdog_diff/);

		const without = createStreamFn([fauxAssistantMessage("done", { stopReason: "stop" })]);
		await createMainWatchdogReview(ctx, { streamFn: without.streamFn, diffBaseline: () => undefined })(request(enabledConfig(), []));
		assert.deepEqual(without.calls[0]?.context.tools?.map((tool) => tool.name).sort(), ["find", "grep", "ls", "read", "watchdog_warn"]);
		assert.doesNotMatch(String(without.calls[0]?.context.systemPrompt ?? ""), /watchdog_diff/);
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
