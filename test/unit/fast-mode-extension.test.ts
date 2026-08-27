import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewriteFastModeProviderRequest } from "../../src/runs/shared/fast-mode-extension.ts";

describe("fast mode provider request", () => {
	it("returns the rewritten provider payload without a wrapper", () => {
		const payload = {
			model: "gpt-5.6-luna",
			input: [{ role: "user", content: "test" }],
		};

		assert.deepEqual(
			rewriteFastModeProviderRequest({ type: "before_provider_request", payload }),
			{
				...payload,
				service_tier: "priority",
			},
		);
	});

	it("preserves a non-object provider payload", () => {
		assert.equal(
			rewriteFastModeProviderRequest({ type: "before_provider_request", payload: "request" }),
			"request",
		);
	});
});
