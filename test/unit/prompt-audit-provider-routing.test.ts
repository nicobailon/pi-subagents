import assert from "node:assert/strict";
import test from "node:test";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { rewritePromptWithGuidance } from "../../src/runs/foreground/prompt-audit.ts";

function model(): Model<any> {
	return {
		id: "complete-provider-model",
		name: "Complete provider model",
		api: "custom-api",
		provider: "complete-provider",
		baseUrl: "https://opencode.ai",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
}

test("Prompt Audit rewrite uses the session model registry stream for complete providers", async () => {
	const current = model();
	const calls: Array<{ model: Model<any>; context: TranscriptContext; options?: SimpleStreamOptions }> = [];
	const ctx = {
		model: current,
		signal: undefined,
		sessionManager: { getSessionId: () => "prompt-audit-session" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: "complete-provider-key",
				headers: { "x-provider-auth": "present" },
				env: { COMPLETE_PROVIDER: "1" },
			}),
			streamSimple(nextModel: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) {
				calls.push({ model: nextModel, context, options });
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({
					type: "done",
					reason: "stop",
					message: fauxAssistantMessage("rewritten task", { stopReason: "stop" }),
				}));
				return stream;
			},
		},
	} as never;

	const rewritten = await rewritePromptWithGuidance({
		ctx,
		authoredTask: "original task",
		runtimeAdditions: "runtime context",
		finalEffectivePrompt: "runtime context\noriginal task",
		guidance: "Make it concise.",
	});

	assert.equal(rewritten, "rewritten task");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.model, current);
	assert.equal(calls[0]?.options?.apiKey, "complete-provider-key");
	assert.equal(calls[0]?.options?.headers?.["x-opencode-session"], "prompt-audit-session");
	assert.equal(calls[0]?.options?.headers?.["x-provider-auth"], "present");
	assert.deepEqual(calls[0]?.options?.env, { COMPLETE_PROVIDER: "1" });
});
