import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectChildLifecycle, type ChildLifecycleState } from "../../src/runs/shared/child-lifecycle.ts";

describe("child lifecycle final drain", () => {
	for (const type of ["turn_start", "agent_start", "auto_retry_start"]) {
		it(`cancels the previous final drain when resumed work emits ${type}`, () => {
			const state: ChildLifecycleState = { compactionRetryActive: false };
			assert.equal(projectChildLifecycle({ type: "message_end" }, true, state), "start-drain");
			assert.equal(projectChildLifecycle({ type }, false, state), "cancel-drain");
			assert.equal(projectChildLifecycle({ type: "agent_settled" }, false, state), "start-drain");
		});
	}

	it("does not drain compaction settlement before its retry starts", () => {
		const state: ChildLifecycleState = { compactionRetryActive: false };
		assert.equal(projectChildLifecycle({ type: "compaction_end", willRetry: true }, false, state), "cancel-drain");
		assert.equal(projectChildLifecycle({ type: "agent_settled" }, false, state), "none");
		assert.equal(projectChildLifecycle({ type: "auto_retry_start" }, false, state), "cancel-drain");
		assert.equal(state.compactionRetryActive, false);
		assert.equal(projectChildLifecycle({ type: "agent_settled" }, false, state), "start-drain");
	});

	it("still drains a final message or settled session without resumed work", () => {
		assert.equal(projectChildLifecycle({ type: "message_end" }, true), "start-drain");
		assert.equal(projectChildLifecycle({ type: "agent_settled" }), "start-drain");
		assert.equal(projectChildLifecycle({ type: "message_update" }), "none");
	});
});
