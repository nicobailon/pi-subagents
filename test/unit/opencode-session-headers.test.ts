import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { opencodeSessionHeaders } from "../../src/shared/opencode-session-headers.ts";

function model(provider: string, baseUrl: string): Model<any> {
	return { provider, baseUrl } as Model<any>;
}

describe("opencodeSessionHeaders", () => {
	it("emits pi's OpenCode session-routing headers for OpenCode models", () => {
		assert.deepEqual(
			opencodeSessionHeaders(model("opencode", "https://opencode.ai/zen/v1"), "session-1"),
			{ "x-opencode-session": "session-1", "x-opencode-client": "pi" },
		);
		assert.deepEqual(
			opencodeSessionHeaders(model("opencode-go", "https://opencode.ai/go/v1"), "session-1"),
			{ "x-opencode-session": "session-1", "x-opencode-client": "pi" },
		);
		assert.deepEqual(
			opencodeSessionHeaders(model("custom-gateway", "https://opencode.ai/zen/v1"), "session-1"),
			{ "x-opencode-session": "session-1", "x-opencode-client": "pi" },
		);
	});

	it("returns undefined for every other provider or without a session id", () => {
		assert.equal(opencodeSessionHeaders(model("opencode", "https://opencode.ai/zen/v1"), undefined), undefined);
		assert.equal(opencodeSessionHeaders(model("anthropic", "https://api.anthropic.com"), "session-1"), undefined);
		assert.equal(opencodeSessionHeaders(model("openai-compat", "https://proxy.example/v1"), "session-1"), undefined);
		assert.equal(opencodeSessionHeaders(model("openai-compat", "https://opencode.ai.evil.example/v1"), "session-1"), undefined);
	});
});
