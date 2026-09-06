import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WatchdogScopeArtifact } from "../../src/watchdog/scope.ts";

describe("watchdog scope artifact", () => {
	it("keeps bounded prompts in newest-last order", () => {
		const scope = new WatchdogScopeArtifact();
		for (let index = 0; index < 10; index++) scope.addPrompt(`prompt-${index}`, { createdAt: `t${index}` });

		const entries = scope.snapshot();
		assert.equal(entries.length, 8);
		assert.deepEqual(entries.map((entry) => entry.prompt), ["prompt-2", "prompt-3", "prompt-4", "prompt-5", "prompt-6", "prompt-7", "prompt-8", "prompt-9"]);
		assert.match(scope.render(), /newest last/);
		assert.match(scope.render(), /Side questions are additive/);
		assert.match(scope.render(), /evidence-backed reminders/);
		assert.match(scope.render(), /not dependencies still pending or explicit holds/);
		assert.match(scope.render(), /prompt-9/);
	});

	it("bounds each prompt and resets", () => {
		const scope = new WatchdogScopeArtifact();
		scope.addPrompt("x".repeat(3_000));
		assert.equal(scope.snapshot()[0]?.prompt.length, 2_000);

		scope.reset();
		assert.deepEqual(scope.snapshot(), []);
		assert.equal(scope.render(), "");
	});
});
