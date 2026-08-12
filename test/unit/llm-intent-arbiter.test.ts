import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	arbitrateCompletionGuardRescue,
	createTaskMutationArbiter,
	isCompletionGuardFailure,
	maybeRescueCompletionGuardFailure,
	type TaskMutationArbiter,
} from "../../src/runs/shared/llm-intent-arbiter.ts";

const GUARD_ERROR =
	"Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";

function fakeCtx(overrides: { models?: Array<{ provider?: string; id?: string; api?: string }> } = {}) {
	const models = overrides.models ?? [{ provider: "test", id: "model-1", api: "test-api" }];
	return {
		model: models[0],
		modelRegistry: {
			getAvailable: () => models,
			getRegisteredProviderConfig: () => undefined,
		},
	} as never;
}

function stubArbiter(verdict: "read-only" | "implementation" | "unavailable" | "throw"): TaskMutationArbiter {
	return async () => {
		if (verdict === "throw") throw new Error("boom");
		return verdict;
	};
}

describe("arbitrateCompletionGuardRescue", () => {
	it("rescues only a confident read-only verdict", async () => {
		const rescued = await arbitrateCompletionGuardRescue({
			guardTriggered: true,
			task: "t",
			arbiter: stubArbiter("read-only"),
		});
		assert.deepEqual(rescued, { triggered: false, rescued: true });
		for (const verdict of ["implementation", "unavailable"] as const) {
			const kept = await arbitrateCompletionGuardRescue({
				guardTriggered: true,
				task: "t",
				arbiter: stubArbiter(verdict),
			});
			assert.deepEqual(kept, { triggered: true, rescued: false }, verdict);
		}
	});

	it("keeps the guard verdict without an arbiter or on arbiter failure", async () => {
		assert.deepEqual(
			await arbitrateCompletionGuardRescue({ guardTriggered: true, task: "t" }),
			{ triggered: true, rescued: false },
		);
		assert.deepEqual(
			await arbitrateCompletionGuardRescue({ guardTriggered: true, task: "t", arbiter: stubArbiter("throw") }),
			{ triggered: true, rescued: false },
		);
		assert.deepEqual(
			await arbitrateCompletionGuardRescue({ guardTriggered: false, task: "t", arbiter: stubArbiter("read-only") }),
			{ triggered: false, rescued: false },
		);
	});
});

describe("isCompletionGuardFailure", () => {
	it("recognizes the guard error prefix", () => {
		assert.equal(isCompletionGuardFailure({ error: GUARD_ERROR }), true);
		assert.equal(isCompletionGuardFailure({ error: "Some other failure." }), false);
		assert.equal(isCompletionGuardFailure({}), false);
	});
});

describe("maybeRescueCompletionGuardFailure", () => {
	it("keeps the failure without an arbiter", async () => {
		const result = { exitCode: 1, error: GUARD_ERROR };
		const rescued = await maybeRescueCompletionGuardFailure(result, "task", undefined);
		assert.equal(rescued, false);
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, GUARD_ERROR);
	});

	it("rescues only a confident read-only verdict", async () => {
		for (const verdict of ["implementation", "unavailable"] as const) {
			const result = { exitCode: 1, error: GUARD_ERROR };
			const rescued = await maybeRescueCompletionGuardFailure(result, "task", stubArbiter(verdict));
			assert.equal(rescued, false, verdict);
			assert.equal(result.exitCode, 1);
			assert.equal(result.error, GUARD_ERROR);
		}
		const result = { exitCode: 1, error: GUARD_ERROR };
		const rescued = await maybeRescueCompletionGuardFailure(result, "task", stubArbiter("read-only"));
		assert.equal(rescued, true);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
	});

	it("fails closed when the arbiter throws", async () => {
		const result = { exitCode: 1, error: GUARD_ERROR };
		const rescued = await maybeRescueCompletionGuardFailure(result, "task", stubArbiter("throw"));
		assert.equal(rescued, false);
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, GUARD_ERROR);
	});

	it("does not touch unrelated failures", async () => {
		const result = { exitCode: 1, error: "Something else broke." };
		const rescued = await maybeRescueCompletionGuardFailure(result, "task", stubArbiter("read-only"));
		assert.equal(rescued, false);
		assert.equal(result.exitCode, 1);
	});
});

describe("createTaskMutationArbiter", () => {
	it("is disabled by the env opt-out", () => {
		const previous = process.env.PI_SUBAGENTS_LLM_INTENT_ARBITER;
		process.env.PI_SUBAGENTS_LLM_INTENT_ARBITER = "0";
		try {
			assert.equal(createTaskMutationArbiter(fakeCtx()), undefined);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_LLM_INTENT_ARBITER;
			else process.env.PI_SUBAGENTS_LLM_INTENT_ARBITER = previous;
		}
	});

	it("returns undefined when no model can be resolved", () => {
		assert.equal(createTaskMutationArbiter(fakeCtx({ models: [] })), undefined);
	});

	it("returns a working arbiter bound to the host model", async () => {
		const arbiter = createTaskMutationArbiter(fakeCtx(), {
			streamFn: async () => {
				throw new Error("not reached in this seam test");
			},
		});
		assert.notEqual(arbiter, undefined);
		// Without a scripted stream the underlying Agent call cannot succeed;
		// the arbiter must degrade to "unavailable" rather than throw.
		const verdict = await arbiter!("task");
		assert.equal(verdict, "unavailable");
	});

	it("memoizes verdicts per task/message key", async () => {
		let streamCalls = 0;
		const arbiter = createTaskMutationArbiter(fakeCtx(), {
			streamFn: async () => {
				streamCalls += 1;
				throw new Error("fail");
			},
		})!;
		const v1 = await arbiter("t", "m");
		const v2 = await arbiter("t", "m");
		assert.equal(v1, "unavailable");
		assert.equal(v2, "unavailable");
		assert.equal(streamCalls, 1); // second call served from cache
	});
});
