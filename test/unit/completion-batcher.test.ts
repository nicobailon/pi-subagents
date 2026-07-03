import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createCompletionBatcher,
	DEFAULT_COMPLETION_BATCH_CONFIG,
	resolveCompletionBatchConfig,
} from "../../src/runs/background/completion-batcher.ts";

interface FakeJob {
	id: number;
	fireAt: number;
	handler: () => void;
}

function createFakeClock() {
	let now = 0;
	let nextId = 1;
	const jobs = new Map<number, FakeJob>();
	const api = {
		setTimeout(handler: () => void, delayMs: number): unknown {
			const id = nextId++;
			jobs.set(id, { id, fireAt: now + delayMs, handler });
			return id;
		},
		clearTimeout(handle: unknown): void {
			if (typeof handle === "number") jobs.delete(handle);
		},
	};
	return {
		api,
		now: () => now,
		advance(ms: number): void {
			now += ms;
			const due = [...jobs.values()].filter((job) => job.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
			for (const job of due) {
				if (!jobs.has(job.id)) continue;
				jobs.delete(job.id);
				job.handler();
			}
		},
		pendingCount: () => jobs.size,
	};
}

function item(label: string): { label: string } {
	return { label };
}

describe("resolveCompletionBatchConfig", () => {
	it("applies defaults when no config is provided", () => {
		assert.deepEqual(resolveCompletionBatchConfig(), DEFAULT_COMPLETION_BATCH_CONFIG);
	});

	it("override wins over global config", () => {
		const resolved = resolveCompletionBatchConfig({ debounceMs: 50, maxWaitMs: 200 }, { debounceMs: 80 });
		assert.equal(resolved.debounceMs, 80);
		assert.equal(resolved.maxWaitMs, 200);
	});

	it("rejects invalid booleans and non-positive or fractional integers", () => {
		const resolved = resolveCompletionBatchConfig({ enabled: "false", debounceMs: 0, maxWaitMs: -5, stragglerDebounceMs: 1.5, stragglerWindowMs: Number.NaN } as never);
		assert.equal(resolved.enabled, DEFAULT_COMPLETION_BATCH_CONFIG.enabled);
		assert.equal(resolved.debounceMs, DEFAULT_COMPLETION_BATCH_CONFIG.debounceMs);
		assert.equal(resolved.maxWaitMs, DEFAULT_COMPLETION_BATCH_CONFIG.maxWaitMs);
		assert.equal(resolved.stragglerDebounceMs, DEFAULT_COMPLETION_BATCH_CONFIG.stragglerDebounceMs);
		assert.equal(resolved.stragglerWindowMs, DEFAULT_COMPLETION_BATCH_CONFIG.stragglerWindowMs);
	});

	it("ignores invalid overrides instead of masking valid global config", () => {
		const resolved = resolveCompletionBatchConfig(
			{ enabled: false, debounceMs: 80 },
			{ enabled: "false", debounceMs: "bad" } as never,
		);
		assert.equal(resolved.enabled, false);
		assert.equal(resolved.debounceMs, 80);
	});
});

describe("createCompletionBatcher", () => {
	it("emits immediately when batching is disabled", () => {
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<{ label: string }>({
			config: { ...DEFAULT_COMPLETION_BATCH_CONFIG, enabled: false },
			emit: (items) => emitted.push(items.map((i) => i.label)),
		});
		batcher.push(item("a"));
		batcher.push(item("b"));
		assert.deepEqual(emitted, [["a"], ["b"]]);
		batcher.dispose();
	});

	it("coalesces a burst into one grouped emit when the debounce fires", () => {
		const clock = createFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<{ label: string }>({
			config: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 },
			emit: (items) => emitted.push(items.map((i) => i.label)),
			timers: clock.api,
			now: clock.now,
		});

		batcher.push(item("a"));
		batcher.push(item("b"));
		clock.advance(40);
		batcher.push(item("c"));
		assert.deepEqual(emitted, []);

		clock.advance(150);
		assert.deepEqual(emitted, [["a", "b", "c"]]);
		assert.equal(clock.pendingCount(), 0);
		batcher.dispose();
	});

	it("emits at the max-wait cap even when items keep arriving", () => {
		const clock = createFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<{ label: string }>({
			config: { enabled: true, debounceMs: 100, maxWaitMs: 300, stragglerDebounceMs: 50, stragglerMaxWaitMs: 150, stragglerWindowMs: 2000 },
			emit: (items) => emitted.push(items.map((i) => i.label)),
			timers: clock.api,
			now: clock.now,
		});

		batcher.push(item("a"));
		// Keep resetting the debounce so it never fires on its own, while staying
		// under the max-wait cap (cumulative 250ms < 300ms).
		for (let step = 0; step < 5; step++) {
			batcher.push(item(`late-${step}`));
			clock.advance(50);
		}
		assert.deepEqual(emitted, []);

		// Cross the max-wait cap (300ms from the first arrival).
		clock.advance(50);
		assert.deepEqual(emitted, [["a", "late-0", "late-1", "late-2", "late-3", "late-4"]]);
		batcher.dispose();
	});

	it("flush emits held items immediately and clears timers", () => {
		const clock = createFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<{ label: string }>({
			config: { ...DEFAULT_COMPLETION_BATCH_CONFIG, enabled: true, debounceMs: 150, maxWaitMs: 1000 },
			emit: (items) => emitted.push(items.map((i) => i.label)),
			timers: clock.api,
			now: clock.now,
		});

		batcher.push(item("a"));
		batcher.push(item("b"));
		assert.equal(clock.pendingCount(), 2);
		batcher.flush();
		assert.deepEqual(emitted, [["a", "b"]]);
		assert.equal(clock.pendingCount(), 0);

		// A later timer fire must not re-emit.
		clock.advance(1000);
		assert.deepEqual(emitted, [["a", "b"]]);
		batcher.dispose();
	});

	it("dispose clears timers without emitting", () => {
		const clock = createFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<{ label: string }>({
			config: { ...DEFAULT_COMPLETION_BATCH_CONFIG, enabled: true, debounceMs: 150, maxWaitMs: 1000 },
			emit: (items) => emitted.push(items.map((i) => i.label)),
			timers: clock.api,
			now: clock.now,
		});

		batcher.push(item("a"));
		batcher.dispose();
		assert.deepEqual(emitted, []);
		assert.equal(clock.pendingCount(), 0);
		clock.advance(1000);
		assert.deepEqual(emitted, []);
	});

	it("creates a shorter straggler group for late siblings", () => {
		const clock = createFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<{ label: string }>({
			config: { enabled: true, debounceMs: 200, maxWaitMs: 1000, stragglerDebounceMs: 50, stragglerMaxWaitMs: 150, stragglerWindowMs: 2000 },
			emit: (items) => emitted.push(items.map((i) => i.label)),
			timers: clock.api,
			now: clock.now,
		});

		// First group emits via debounce.
		batcher.push(item("a"));
		clock.advance(200);
		assert.deepEqual(emitted, [["a"]]);

		// A sibling finishing soon after joins a straggler group with the
		// shorter debounce window.
		clock.advance(100);
		batcher.push(item("b"));
		assert.deepEqual(emitted, [["a"]]);
		clock.advance(50);
		assert.deepEqual(emitted, [["a"], ["b"]]);
		batcher.dispose();
	});

	it("starts a fresh normal group after the straggler window passes", () => {
		const clock = createFakeClock();
		const emitted: string[][] = [];
		const batcher = createCompletionBatcher<{ label: string }>({
			config: { enabled: true, debounceMs: 200, maxWaitMs: 1000, stragglerDebounceMs: 50, stragglerMaxWaitMs: 150, stragglerWindowMs: 500 },
			emit: (items) => emitted.push(items.map((i) => i.label)),
			timers: clock.api,
			now: clock.now,
		});

		batcher.push(item("a"));
		clock.advance(200);
		assert.deepEqual(emitted, [["a"]]);

		// Past the straggler window: the next arrival is a normal group again.
		clock.advance(600);
		batcher.push(item("b"));
		clock.advance(50);
		assert.deepEqual(emitted, [["a"]]);
		clock.advance(150);
		assert.deepEqual(emitted, [["a"], ["b"]]);
		batcher.dispose();
	});
});
