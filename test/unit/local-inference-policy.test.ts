import assert from "node:assert/strict";
import test from "node:test";
import { localInferenceEnabled, withoutExecutionDeadline } from "../../src/runs/shared/local-inference-policy.ts";
import { resolveSingleAgentLaunchTimeout } from "../../src/runs/foreground/subagent-executor.ts";

test("local-AI policy is owner opt-in and malformed values do not silently turn it off", () => {
	assert.equal(localInferenceEnabled({}), false);
	assert.equal(localInferenceEnabled({ localInference: { enabled: true } }), true);
	for (const value of [null, {}, { enabled: "true" }, { enabled: true, timeout: 1 }]) {
		assert.throws(() => localInferenceEnabled({ localInference: value } as never), /refusing/);
	}
});

test("owner policy overrides model-supplied deadlines for foreground, async, and composites", () => {
	for (const async of [false, true]) {
		for (const params of [{ timeoutMs: 1 }, { maxRuntimeMs: 1 }, { timeoutMs: 1, chain: [{ agent: "worker", task: "test" }] }, { timeoutMs: 1, workflowScript: "return 1" }]) {
			assert.deepEqual(resolveSingleAgentLaunchTimeout(params, async, 1, true), {});
		}
	}
});

test("deadline removal preserves cancellation, tools, limits, and the original input", () => {
	const signal = new AbortController().signal;
	const original = { timeoutMs: 1, maxRuntimeMs: 2, deadlineAt: 3, workflowParentDeadlineAt: 4, signal, toolTimeoutMs: 5, maxTokens: 262144, concurrency: 8 };
	assert.deepEqual(withoutExecutionDeadline(original), { signal, toolTimeoutMs: 5, maxTokens: 262144, concurrency: 8 });
	assert.equal(original.timeoutMs, 1);
});
