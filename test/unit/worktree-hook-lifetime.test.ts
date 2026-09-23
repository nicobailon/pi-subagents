import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveWorktreeSetupHookTimeout, worktreeSetupHookTimeoutForLifetime } from "../../src/runs/shared/worktree.ts";

it("removes only the implicit worktree hook deadline in unbounded mode", () => {
	assert.equal(worktreeSetupHookTimeoutForLifetime(undefined, { mode: "unbounded" }), false);
	assert.equal(worktreeSetupHookTimeoutForLifetime(1_000, { mode: "unbounded" }), 1_000);
	assert.equal(worktreeSetupHookTimeoutForLifetime(undefined, { mode: "bounded", timeoutMs: 2_000 }), undefined);
	assert.equal(resolveWorktreeSetupHookTimeout(false), undefined);
	assert.equal(resolveWorktreeSetupHookTimeout(undefined), 30_000);
	assert.equal(resolveWorktreeSetupHookTimeout(1_000), 1_000);
	assert.throws(() => resolveWorktreeSetupHookTimeout(0), /integer greater than 0/);
});
