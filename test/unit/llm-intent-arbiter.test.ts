import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type AssistantMessage,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	arbitrateCompletionGuardRescue,
	createTaskMutationArbiter,
	isCompletionGuardFailure,
	mapArbiterDecision,
	maybeRescueCompletionGuardFailure,
	type TaskMutationArbiter,
} from "../../src/runs/shared/llm-intent-arbiter.ts";

const GUARD_ERROR =
	"Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";

function fakeCtx(overrides: {
	models?: Array<{ provider?: string; id?: string; api?: string }>;
	providerConfig?: { api?: string; streamSimple?: StreamFn };
} = {}) {
	const models = overrides.models ?? [{ provider: "test", id: "model-1", api: "test-api" }];
	return {
		model: models[0],
		modelRegistry: {
			getAvailable: () => models,
			getRegisteredProviderConfig: () => overrides.providerConfig,
		},
	} as never;
}

function responseStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
	return stream;
}

function decisionResponses(source: string): AssistantMessage[] {
	return [
		fauxAssistantMessage(fauxToolCall("task_mutation_decision", {
			classification: "read_only",
			confidence: "high",
			reason: `${source} stream selected`,
		}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	];
}

function decisionStream(source: string, calls: string[]): StreamFn {
	const responses = decisionResponses(source);
	return () => {
		calls.push(source);
		return responseStream(responses.shift() ?? fauxAssistantMessage("done", { stopReason: "stop" }));
	};
}

function stubArbiter(verdict: "read-only" | "implementation" | "unavailable" | "throw"): TaskMutationArbiter {
	return async () => {
		if (verdict === "throw") throw new Error("boom");
		return verdict;
	};
}

describe("arbitrateCompletionGuardRescue", () => {
	it("rescues on a read-only verdict, keeps the failure otherwise", async () => {
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

	it("never arbitrates from partial evidence on tasks over 8000 chars", async () => {
		const middle = "And now apply the fix in the middle of this long task. ";
		const longTask = "Review the setup. ".repeat(400) + middle + "Review more. ".repeat(400);
		assert.ok(longTask.length > 8000);
		const kept = await arbitrateCompletionGuardRescue({
			guardTriggered: true,
			task: longTask,
			arbiter: stubArbiter("read-only"),
		});
		assert.deepEqual(kept, { triggered: true, rescued: false });
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

describe("mapArbiterDecision", () => {
	it("only a high-confidence read_only rescues", () => {
		assert.equal(mapArbiterDecision({ classification: "read_only", confidence: "high" }), "read-only");
		for (const confidence of ["low", "medium", undefined] as const) {
			assert.equal(
				mapArbiterDecision({ classification: "read_only", confidence }),
				"implementation",
				String(confidence),
			);
		}
		assert.equal(mapArbiterDecision({ classification: "implementation", confidence: "high" }), "implementation");
		assert.equal(mapArbiterDecision(undefined), "unavailable");
	});
});

describe("arbiter auth receiver", () => {
	it("resolves registry credentials through the registry receiver (class instance state)", async () => {
		// Prototype method reading instance state: a detached call would lose
		// `this` and fail auth. The fix must call it as a method on the registry.
		class FakeRegistry {
			readonly key = "instance-key";
			async getApiKeyAndHeaders(_model: unknown) {
				return { ok: true, apiKey: this.key };
			}
		}
		let captured: Record<string, unknown> | undefined;
		const ctx = {
			model: { provider: "test", id: "model-1", api: "test-api" },
			modelRegistry: new FakeRegistry(),
		} as never;
		const arbiter = createTaskMutationArbiter(ctx, {
			streamFn: async (_model: unknown, _context: unknown, opts: Record<string, unknown>) => {
				captured = opts;
				throw new Error("stream fail");
			},
		})!;
		const verdict = await arbiter("t");
		assert.equal(verdict, "unavailable"); // stream deliberately fails
		assert.equal(captured?.apiKey, "instance-key", "registry credential must reach the stream function");
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

describe("arbiter stream selection", () => {
	it("uses a registered provider stream when its API matches the model", async () => {
		const calls: string[] = [];
		const arbiter = createTaskMutationArbiter(fakeCtx({
			models: [{ provider: "registered", id: "model-1", api: "registered-api" }],
			providerConfig: { api: "registered-api", streamSimple: decisionStream("registered", calls) },
		}))!;

		assert.equal(await arbiter("task"), "read-only");
		assert.deepEqual(calls, ["registered", "registered"]);
	});

	it("lets an explicit stream override a mismatched registered provider", async () => {
		const calls: string[] = [];
		const registeredCalls: string[] = [];
		const arbiter = createTaskMutationArbiter(fakeCtx({
			models: [{ provider: "registered", id: "model-1", api: "model-api" }],
			providerConfig: { api: "registered-api", streamSimple: decisionStream("registered", registeredCalls) },
		}), { streamFn: decisionStream("explicit", calls) })!;

		assert.equal(await arbiter("task"), "read-only");
		assert.deepEqual(calls, ["explicit", "explicit"]);
		assert.deepEqual(registeredCalls, []);
	});

	it("falls back to compat streamSimple for a mismatched registered provider", async () => {
		const compat = registerFauxProvider({
			api: "llm-intent-arbiter-compat-test",
			provider: "compat-provider",
			models: [{ id: "model-1", reasoning: false }],
		});
		try {
			compat.setResponses(decisionResponses("compat"));
			const registeredCalls: string[] = [];
			const arbiter = createTaskMutationArbiter(fakeCtx({
				models: [{ provider: "registered", id: "model-1", api: compat.api }],
				providerConfig: { api: "registered-api", streamSimple: decisionStream("registered", registeredCalls) },
			}))!;

			assert.equal(await arbiter("task"), "read-only");
			assert.deepEqual(registeredCalls, []);
			assert.equal(compat.state.callCount, 2);
		} finally {
			compat.unregister();
		}
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

	it("does not stream after explicit auth failure or an auth error", async () => {
		for (const throws of [false, true]) {
			let calls = 0;
			const arbiter = createTaskMutationArbiter({
				model: { provider: "test", id: "model-1", api: "test-api" },
				modelRegistry: {
					async getApiKeyAndHeaders() {
						if (throws) throw new Error("auth unavailable");
						return { ok: false, error: "auth unavailable" };
					},
				},
			} as never, { streamFn: () => { calls++; throw new Error("must not stream"); } });
			assert.equal(await arbiter!("Implement the fix"), "unavailable");
			assert.equal(calls, 0);
		}
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

	it("memoizes verdicts per task", async () => {
		let streamCalls = 0;
		const arbiter = createTaskMutationArbiter(fakeCtx(), {
			streamFn: async () => {
				streamCalls += 1;
				throw new Error("fail");
			},
		})!;
		const v1 = await arbiter("t");
		const v2 = await arbiter("t");
		assert.equal(v1, "unavailable");
		assert.equal(v2, "unavailable");
		assert.equal(streamCalls, 1);
	});

	it("uses the full task as the cache key", async () => {
		let streamCalls = 0;
		const arbiter = createTaskMutationArbiter(fakeCtx(), {
			streamFn: async () => {
				streamCalls += 1;
				throw new Error("fail");
			},
		})!;
		const prefix = "x".repeat(180);
		await arbiter(`${prefix}A`);
		await arbiter(`${prefix}B`);
		assert.equal(streamCalls, 2);
	});
});
