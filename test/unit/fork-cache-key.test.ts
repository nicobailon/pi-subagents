import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildPiArgs, deriveForkPromptCacheKey, SUBAGENT_FORK_CACHE_KEY_ENV } from "../../src/runs/shared/pi-args.ts";
import { rewriteForkCacheProviderRequest } from "../../src/runs/shared/subagent-prompt-runtime.ts";

const originalForkCacheKey = process.env[SUBAGENT_FORK_CACHE_KEY_ENV];

const baseLaunch = {
	baseArgs: [] as string[],
	task: "test",
	sessionEnabled: false,
	inheritProjectContext: false,
	inheritGlobalContext: false,
	inheritSkills: false,
};

function providerContext(api: string): Pick<ExtensionContext, "model"> {
	return { model: { api } };
}

afterEach(() => {
	if (originalForkCacheKey === undefined) delete process.env[SUBAGENT_FORK_CACHE_KEY_ENV];
	else process.env[SUBAGENT_FORK_CACHE_KEY_ENV] = originalForkCacheKey;
});

describe("fork prompt cache keys", () => {
	it("derives a bounded sibling cache key from the parent session id", () => {
		assert.equal(deriveForkPromptCacheKey(undefined), undefined);
		assert.equal(deriveForkPromptCacheKey("   "), undefined);
		const key = deriveForkPromptCacheKey("parent-session");
		assert.ok(key);
		assert.match(key, /^pi-fork:[0-9a-f]{56}$/);
		assert.equal(Array.from(key).length, 64);
		assert.equal(key.includes("parent-session"), false);

		const longKey = deriveForkPromptCacheKey(`${"🙂".repeat(80)}-parent`);
		assert.ok(longKey);
		assert.equal(Array.from(longKey).length, 64);
		assert.match(longKey, /^pi-fork:[0-9a-f]{56}$/);

		const prefix = "/Users/example/.pi/agent/sessions/".repeat(3);
		assert.notEqual(deriveForkPromptCacheKey(`${prefix}/one.jsonl`), deriveForkPromptCacheKey(`${prefix}/two.jsonl`));
	});

	it("passes the explicit fork cache key without inheriting ambient values", () => {
		process.env[SUBAGENT_FORK_CACHE_KEY_ENV] = "leaked-parent-value";

		assert.equal(buildPiArgs(baseLaunch).env[SUBAGENT_FORK_CACHE_KEY_ENV], undefined);

		const forkCacheKey = deriveForkPromptCacheKey("parent-session");
		assert.equal(buildPiArgs({ ...baseLaunch, forkCacheKey }).env[SUBAGENT_FORK_CACHE_KEY_ENV], forkCacheKey);
	});

	it("rewrites only existing OpenAI-style string prompt cache keys", () => {
		process.env[SUBAGENT_FORK_CACHE_KEY_ENV] = "pi-fork:parent-session";
		const payload = {
			model: "test-model",
			input: [{ role: "user", content: "hello" }],
			prompt_cache_key: "child-session",
		};

		assert.deepEqual(
			rewriteForkCacheProviderRequest({ type: "before_provider_request", payload }, providerContext("openai-responses")),
			{ ...payload, prompt_cache_key: "pi-fork:parent-session" },
		);
		assert.deepEqual(
			rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { ...payload, prompt_cache_key: "pi-fork:parent-session" } }, providerContext("openai-responses")),
			{ ...payload, prompt_cache_key: "pi-fork:parent-session" },
		);
	});

	it("does not add prompt cache keys or touch non-OpenAI payloads", () => {
		process.env[SUBAGENT_FORK_CACHE_KEY_ENV] = "pi-fork:parent-session";

		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: "raw" }, providerContext("openai-responses")), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: [] }, providerContext("openai-responses")), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test" } }, providerContext("openai-responses")), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: undefined } }, providerContext("openai-responses")), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: "child" } }, providerContext("anthropic-messages")), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: "child" } }, providerContext("unknown-api")), undefined);
	});

	it("is a no-op when fork cache affinity is not configured", () => {
		delete process.env[SUBAGENT_FORK_CACHE_KEY_ENV];
		assert.equal(
			rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: "child" } }, providerContext("openai-responses")),
			undefined,
		);
	});
});
