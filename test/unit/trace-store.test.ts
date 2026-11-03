import { it } from "node:test";
import assert from "node:assert/strict";
import { createTraceStore, traceContentSignature, traceProjectionWindow } from "../../src/workflows/trace-store.ts";

const reused = { operation: "run", key: "q_a", state: "reused", agent: "query-runner" } as const;

it("folds consecutive duplicate trace entries so a re-delivered launch cannot grow the trace", () => {
	const store = createTraceStore<Record<string, unknown>>();
	// The field incident re-delivered the same `runs.run` call ~14k times.
	const retained = Array.from({ length: 25 }, () => store.push({ ...reused })).filter(Boolean);
	assert.equal(store.length, 1);
	assert.equal(retained.length, 1);
	assert.deepEqual(store.trace, [{ ...reused }]);
});

it("keeps distinct entries and non-consecutive duplicates", () => {
	const store = createTraceStore<Record<string, unknown>>();
	store.push({ operation: "run", key: "a", state: "started" });
	store.push({ operation: "run", key: "a", state: "completed" });
	store.push({ operation: "run", key: "a", state: "started" });
	assert.equal(store.length, 3);
});

it("reports a stable signature for an unchanged trace and a new one after a real change", () => {
	const store = createTraceStore<Record<string, unknown>>();
	store.push({ operation: "run", key: "a", state: "reused" });
	const before = store.signature();
	store.push({ operation: "run", key: "a", state: "reused" });
	store.push({ operation: "run", key: "a", state: "reused" });
	assert.equal(store.signature(), before);
	store.push({ operation: "run", key: "a", state: "completed" });
	assert.notEqual(store.signature(), before);
});

it("drops the oldest entries at the cap and reports it once", () => {
	const warnings: string[] = [];
	const store = createTraceStore<Record<string, unknown>>({ maxEntries: 3, onWarn: (message) => warnings.push(message) });
	for (let index = 0; index < 6; index += 1) store.push({ operation: "run", key: `k${index}`, state: "started" });
	assert.deepEqual(store.trace.map((entry) => entry.key), ["k3", "k4", "k5"]);
	assert.equal(store.dropped, 3);
	assert.equal(store.capped, true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /3-entry cap/u);
});

it("honors PI_SUBAGENTS_TRACE_MAX_ENTRIES and prefers the explicit option", () => {
	const previous = process.env.PI_SUBAGENTS_TRACE_MAX_ENTRIES;
	try {
		process.env.PI_SUBAGENTS_TRACE_MAX_ENTRIES = "2";
		const fromEnv = createTraceStore<{ index: number }>();
		for (let index = 0; index < 4; index += 1) fromEnv.push({ index });
		assert.equal(fromEnv.maxEntries, 2);
		assert.deepEqual(fromEnv.trace.map((entry) => entry.index), [2, 3]);
		const explicit = createTraceStore<{ index: number }>({ maxEntries: 5 });
		assert.equal(explicit.maxEntries, 5);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_TRACE_MAX_ENTRIES;
		else process.env.PI_SUBAGENTS_TRACE_MAX_ENTRIES = previous;
	}
});

it("signature distinguishes an empty trace and tracks the last entry only", () => {
	assert.equal(traceContentSignature([]), "0|");
	const trace = [{ operation: "run", key: "a", state: "started" }];
	assert.notEqual(traceContentSignature(trace), "0|");
	assert.equal(traceContentSignature([...trace]), traceContentSignature(trace));
});

it("projects one entry for a cap rotation and rebuilds only when the array is not a rotation", () => {
	const store = createTraceStore<{ index: number }>({ maxEntries: 3, onWarn: () => undefined });
	for (const index of [0, 1, 2]) store.push({ index });
	const projectedLength = store.trace.length;
	const projectedTail = store.trace.at(-1);

	// First projection and a plain append start where the consumer left off.
	assert.deepEqual(traceProjectionWindow(store.trace, 0, undefined), { mode: "append", from: 0 });
	assert.deepEqual(traceProjectionWindow(store.trace, projectedLength, projectedTail), { mode: "append", from: 3 });

	// At the cap the store drops the oldest entry and appends one, so the length stops changing
	// and the entry the consumer saw last moves one slot earlier.
	store.push({ index: 3 });
	assert.deepEqual(store.trace.map((entry) => entry.index), [1, 2, 3]);
	assert.deepEqual(traceProjectionWindow(store.trace, projectedLength, projectedTail), { mode: "rotate", from: 2 });

	// A shorter array (resume, state restore) and a replaced one both need the whole trace.
	assert.deepEqual(traceProjectionWindow(store.trace.slice(0, 2), projectedLength, store.trace[2]), { mode: "rebuild", from: 0 });
	assert.deepEqual(traceProjectionWindow([{ index: 9 }, { index: 8 }, { index: 7 }], projectedLength, store.trace[2]), { mode: "rebuild", from: 0 });
});
