import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { deriveForkPromptCacheKey } from "../../src/runs/shared/child-tool-plan.ts";
import { rewriteForkCacheProviderRequest } from "../../src/runs/shared/subagent-prompt-runtime.ts";

const baseLaunch = {
	host: "parent" as const,
	cwd: os.tmpdir(),
	childAgentName: "worker",
	childIndex: 0,
	sessionEnabled: false,
	inheritProjectContext: false,
	inheritGlobalContext: false,
	inheritSkills: false,
};

function providerContext(api: string): Pick<ExtensionContext, "model"> {
	return { model: { api } };
}

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

	it("passes only the explicit fork cache key to the child config", () => {
		assert.equal(buildInProcessChildLaunch(baseLaunch).config.forkCacheKey, undefined);

		const forkCacheKey = deriveForkPromptCacheKey("parent-session");
		assert.equal(buildInProcessChildLaunch({ ...baseLaunch, forkCacheKey }).config.forkCacheKey, forkCacheKey);
	});

	it("rewrites only existing OpenAI-style string prompt cache keys", () => {
		const forkCacheKey = "pi-fork:parent-session";
		const payload = {
			model: "test-model",
			input: [{ role: "user", content: "hello" }],
			prompt_cache_key: "child-session",
		};

		assert.deepEqual(
			rewriteForkCacheProviderRequest({ type: "before_provider_request", payload }, providerContext("openai-responses"), forkCacheKey),
			{ ...payload, prompt_cache_key: "pi-fork:parent-session" },
		);
		assert.deepEqual(
			rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { ...payload, prompt_cache_key: "pi-fork:parent-session" } }, providerContext("openai-responses"), forkCacheKey),
			{ ...payload, prompt_cache_key: "pi-fork:parent-session" },
		);
	});

	it("does not add prompt cache keys or touch non-OpenAI payloads", () => {
		const forkCacheKey = "pi-fork:parent-session";

		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: "raw" }, providerContext("openai-responses"), forkCacheKey), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: [] }, providerContext("openai-responses"), forkCacheKey), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test" } }, providerContext("openai-responses"), forkCacheKey), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: undefined } }, providerContext("openai-responses"), forkCacheKey), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: "child" } }, providerContext("anthropic-messages"), forkCacheKey), undefined);
		assert.equal(rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: "child" } }, providerContext("unknown-api"), forkCacheKey), undefined);
	});

	it("is a no-op when fork cache affinity is not configured", () => {
		assert.equal(
			rewriteForkCacheProviderRequest({ type: "before_provider_request", payload: { model: "test", prompt_cache_key: "child" } }, providerContext("openai-responses"), undefined),
			undefined,
		);
	});
});
