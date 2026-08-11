import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFileCoalescer } from "../../src/shared/file-coalescer.ts";

type TimerTask = { id: number; cb: () => void; delay: number };

function createFakeTimers() {
	let nextId = 1;
	const tasks = new Map<number, TimerTask>();
	return {
		timerApi: {
			setTimeout(handler: () => void, delayMs: number): unknown {
				const id = nextId++;
				tasks.set(id, { id, cb: handler, delay: delayMs });
				return id;
			},
			clearTimeout(handle: unknown): void {
				if (typeof handle === "number") tasks.delete(handle);
			},
		},
		runAll(): void {
			const batch = Array.from(tasks.values()).sort((a, b) => a.id - b.id);
			tasks.clear();
			for (const task of batch) task.cb();
		},
		pendingCount(): number {
			return tasks.size;
		},
	};
}

describe("createFileCoalescer", () => {
	it("coalesces duplicate schedule calls per file", () => {
		const events: string[] = [];
		const timers = createFakeTimers();
		const coalescer = createFileCoalescer((file) => events.push(file), 50, timers.timerApi);
		assert.equal(coalescer.schedule("a.json"), true);
		assert.equal(coalescer.schedule("a.json"), false);
		assert.equal(timers.pendingCount(), 1);
		timers.runAll();
		assert.deepEqual(events, ["a.json"]);
		assert.equal(coalescer.schedule("a.json"), true);
	});

	it("allows different files to schedule independently", () => {
		const events: string[] = [];
		const timers = createFakeTimers();
		const coalescer = createFileCoalescer((file) => events.push(file), 50, timers.timerApi);
		coalescer.schedule("a.json");
		coalescer.schedule("b.json");
		assert.equal(timers.pendingCount(), 2);
		timers.runAll();
		assert.deepEqual(events.sort(), ["a.json", "b.json"]);
	});

	it("flushes a pending file immediately without a duplicate timer write", () => {
		const events: string[] = [];
		const timers = createFakeTimers();
		const coalescer = createFileCoalescer((file) => events.push(file), 50, timers.timerApi);
		coalescer.schedule("status.json");
		coalescer.schedule("status.json");
		assert.equal(timers.pendingCount(), 1);
		assert.equal(coalescer.flush("status.json"), true);
		assert.deepEqual(events, ["status.json"]);
		assert.equal(timers.pendingCount(), 0);
		timers.runAll();
		assert.deepEqual(events, ["status.json"]);
		assert.equal(coalescer.flush("status.json"), false);
	});

	it("clear cancels all pending handlers", () => {
		const events: string[] = [];
		const timers = createFakeTimers();
		const coalescer = createFileCoalescer((file) => events.push(file), 50, timers.timerApi);
		coalescer.schedule("a.json");
		coalescer.schedule("b.json");
		assert.equal(timers.pendingCount(), 2);
		coalescer.clear();
		assert.equal(timers.pendingCount(), 0);
		timers.runAll();
		assert.deepEqual(events, []);
	});
});
