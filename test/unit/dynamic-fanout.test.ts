import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChainOutputValidationError, validateChainOutputBindings, validateChainOutputBindingsWithContext } from "../../src/runs/shared/chain-outputs.ts";
import {
	DynamicFanoutError,
	collectDynamicResults,
	materializeDynamicParallelStep,
	resolveJsonPointer,
	validateDynamicCollection,
	validateDynamicStepShape,
} from "../../src/runs/shared/dynamic-fanout.ts";
import type { ChainStep } from "../../src/shared/settings.ts";
import type { ChainOutputMap, SingleResult } from "../../src/shared/types.ts";

const outputs: ChainOutputMap = {
	targets: {
		text: "{\"items\":[{\"path\":\"src/a.ts\"},{\"path\":\"src/b.ts\"}]}",
		structured: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		agent: "scout",
		stepIndex: 0,
	},
};

describe("dynamic fanout helpers", () => {
	it("resolves JSON Pointers and materializes item templates", () => {
		assert.deepEqual(resolveJsonPointer({ items: [1, 2] }, "/items/1", "path"), 2);
		const step: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}" },
			collect: { as: "reviews" },
		};
		const materialized = materializeDynamicParallelStep(step, outputs, 1);
		assert.deepEqual(materialized.items.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(materialized.parallel.map((task) => task.task), ["Review src/a.ts", "Review src/b.ts"]);
		assert.deepEqual(materialized.parallel.map((task) => task.label), ["Review src/a.ts", "Review src/b.ts"]);
	});

	it("rejects missing structured sources, over-limit arrays, duplicate keys, colliding ids, and bad templates", () => {
		const base: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {target.path}" },
			collect: { as: "reviews" },
		};
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, expand: { ...base.expand, maxItems: 1 } }, outputs, 1),
			/exceeding maxItems/,
		);
		assert.throws(
			() => materializeDynamicParallelStep(base, { targets: { text: "plain", agent: "scout", stepIndex: 0 } }, 1),
			/requires structured output/,
		);
		assert.throws(
			() => materializeDynamicParallelStep(base, { targets: { ...outputs.targets, structured: { items: [{ path: "x" }, { path: "x" }] } } }, 1),
			/duplicate item key/,
		);
		assert.throws(
			() => materializeDynamicParallelStep(base, { targets: { ...outputs.targets, structured: { items: [{ path: "a/b" }, { path: "a-b" }] } } }, 1),
			/colliding item id/,
		);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, parallel: { agent: "reviewer", task: "Review {other.path}" } }, outputs, 1),
			/Unsupported template reference/,
		);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, parallel: { agent: "reviewer", task: "Review {target[path]}" } }, outputs, 1),
			/Invalid item reference/,
		);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, parallel: { agent: "reviewer", task: "Review {target.path" } }, outputs, 1),
			/Invalid item reference/,
		);
	});

	it("allows config maxItems defaults and handles empty arrays deterministically", () => {
		const base: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path" },
			parallel: { agent: "reviewer", task: "Review {target.path}" },
			collect: { as: "reviews" },
		};
		const materialized = materializeDynamicParallelStep(base, outputs, 1, { maxItems: 4 });
		assert.equal(materialized.parallel.length, 2);
		assert.doesNotThrow(() => validateChainOutputBindings([
			{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
			base,
		], { maxItems: 4 }));
		const empty = materializeDynamicParallelStep(base, { targets: { ...outputs.targets, structured: { items: [] } } }, 1, { maxItems: 4 });
		assert.equal(empty.parallel.length, 0);
		assert.throws(
			() => materializeDynamicParallelStep({ ...base, expand: { ...base.expand, onEmpty: "fail" } }, { targets: { ...outputs.targets, structured: { items: [] } } }, 1, { maxItems: 4 }),
			/source array is empty/,
		);
	});

	it("rejects malformed dynamic-like shapes before they can run as static parallel", () => {
		const malformed = [
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: [{ agent: "reviewer", task: "Review" }],
				collect: { as: "reviews" },
			},
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}" },
			},
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}" },
				collect: { as: "reviews" },
				when: "later",
			},
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}", as: "child" },
				collect: { as: "reviews" },
			},
		] as ChainStep[];

		for (const step of malformed) {
			assert.throws(
				() => validateChainOutputBindings([{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } }, step]),
				ChainOutputValidationError,
			);
		}
	});

	it("accepts a runner-injected parentSessionId on the parallel template but keeps it out of user-facing validation", () => {
		// Regression: the async runner threads parentSessionId onto the dynamic parallel
		// template for permission-system forwarding. It must pass runner-internal validation
		// (allowRunnerFields) without leaking into the user-facing dynamic field whitelist.
		const runnerStep = {
			expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {item.path}", parentSessionId: "session-parent" },
			collect: { as: "reviews" },
		} as unknown as Parameters<typeof validateDynamicStepShape>[0];
		assert.doesNotThrow(() => validateDynamicStepShape(runnerStep, 1, { allowRunnerFields: true }));
		assert.throws(
			() => validateDynamicStepShape(runnerStep, 1),
			(error: unknown) => error instanceof DynamicFanoutError && /parentSessionId/.test(error.message),
		);
	});

	it("accepts toolBudget on dynamic parallel templates", () => {
		const step = {
			expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {item.path}", toolBudget: { hard: 3 } },
			collect: { as: "reviews" },
		} as unknown as Parameters<typeof validateDynamicStepShape>[0];

		assert.doesNotThrow(() => validateDynamicStepShape(step, 1));
	});

	it("validates source ordering and collect name collisions", () => {
		const chain: ChainStep[] = [
			{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}" },
				collect: { as: "targets" },
			},
		];
		assert.throws(() => validateChainOutputBindings(chain), ChainOutputValidationError);
		assert.throws(
			() => validateChainOutputBindings([chain[1]!]),
			/unknown output 'targets'/,
		);
	});

	it("validates appended steps against prior and reserved output names", () => {
		assert.doesNotThrow(() => validateChainOutputBindingsWithContext([
			{ agent: "worker", task: "Use {outputs.targets}", as: "summary" },
		], {}, { priorOutputNames: ["targets"], startStepIndex: 2 }));
		assert.throws(
			() => validateChainOutputBindingsWithContext([
				{ agent: "worker", task: "Use {outputs.missing}" },
			], {}, { priorOutputNames: ["targets"], startStepIndex: 2 }),
			/Unknown chain output reference '\{outputs\.missing\}' at step 3/,
		);
		assert.throws(
			() => validateChainOutputBindingsWithContext([
				{ agent: "worker", task: "Use {previous}", as: "targets" },
			], {}, { priorOutputNames: ["targets"], startStepIndex: 2 }),
			/Duplicate chain output name 'targets'/,
		);
		assert.doesNotThrow(() => validateChainOutputBindingsWithContext([
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item.path}" },
				collect: { as: "reviews" },
			},
		], {}, { priorOutputNames: ["targets"], startStepIndex: 2 }));
	});

	it("collects ordered child result records and validates aggregate schema", () => {
		const step: ChainStep = {
			expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
			parallel: { agent: "reviewer", task: "Review {item.path}" },
			collect: { as: "reviews" },
		};
		const materialized = materializeDynamicParallelStep(step, outputs, 1);
		const result = (agent: string, structuredOutput: unknown): SingleResult => ({
			agent,
			task: "t",
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			finalOutput: "ok",
			structuredOutput,
		});
		const timedOut = { ...result("reviewer", { ok: "b" }), exitCode: 1, error: "Subagent timed out after 300ms.", timedOut: true };
		const collected = collectDynamicResults(step, materialized.items, [result("reviewer", { ok: "a" }), timedOut]);
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		assert.equal(collected[1]?.timedOut, true);
		assert.doesNotThrow(() => validateDynamicCollection({ type: "array", minItems: 2 }, collected));
		assert.throws(() => validateDynamicCollection({ type: "object" }, collected), DynamicFanoutError);
	});
});
