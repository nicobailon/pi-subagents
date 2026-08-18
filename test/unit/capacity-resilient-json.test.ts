import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCapacityResilientJsonWriter } from "../../src/shared/capacity-resilient-json.ts";

type TimerTask = { callback: () => void; delayMs: number };

function createTimers() {
	const tasks: TimerTask[] = [];
	return {
		timerApi: {
			setTimeout(callback: () => void, delayMs: number): object {
				const timer = { callback, delayMs };
				tasks.push(timer);
				return timer;
			},
			clearTimeout(timer: unknown): void {
				const index = tasks.indexOf(timer as TimerTask);
				if (index >= 0) tasks.splice(index, 1);
			},
		},
		runNext(): void {
			const timer = tasks.shift();
			if (timer) timer.callback();
		},
		pendingCount: () => tasks.length,
	};
}

function capacityError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe("createCapacityResilientJsonWriter", () => {
	it("retains only the latest payload and retries after capacity recovers", () => {
		const timers = createTimers();
		const writes: object[] = [];
		let available = false;
		const writer = createCapacityResilientJsonWriter({
			timerApi: timers.timerApi,
			retryDelayMs: 25,
			write: (_filePath, payload) => {
				if (!available) throw capacityError("ENOSPC");
				writes.push(payload);
			},
		});

		writer.write("status.json", { state: "running" });
		writer.write("status.json", { state: "complete" });
		assert.equal(writer.pendingCount(), 1);
		assert.equal(timers.pendingCount(), 1);
		available = true;
		timers.runNext();

		assert.deepEqual(writes, [{ state: "complete" }]);
		assert.equal(writer.pendingCount(), 0);
		assert.equal(timers.pendingCount(), 0);
	});

	it("handles every storage-capacity code without escaping the retry timer", () => {
		for (const code of ["ENOSPC", "EDQUOT", "EMFILE", "ENFILE"]) {
			const timers = createTimers();
			let attempts = 0;
			let available = false;
			const writer = createCapacityResilientJsonWriter({
				timerApi: timers.timerApi,
				write: () => {
					attempts += 1;
					if (!available) throw capacityError(code);
				},
			});
			writer.write("status.json", { state: "running" });
			assert.doesNotThrow(() => timers.runNext());
			assert.equal(attempts, 2);
			available = true;
			timers.runNext();
			assert.equal(writer.pendingCount(), 0);
		}
	});

	it("preserves synchronous throwing for non-capacity failures", () => {
		const writer = createCapacityResilientJsonWriter({ write: () => { throw new Error("invalid path"); } });
		assert.throws(() => writer.write("status.json", {}), /invalid path/);
	});

	it("does not let error callbacks escape a retry timer", () => {
		const timers = createTimers();
		const writer = createCapacityResilientJsonWriter({
			timerApi: timers.timerApi,
			onError: () => { throw new Error("reporting failed"); },
			write: (filePath) => {
				if (filePath === "status.json") throw capacityError("ENOSPC");
			},
		});
		writer.write("status.json", { state: "running" });
		assert.doesNotThrow(() => timers.runNext());
		assert.equal(writer.pendingCount(), 1);
		writer.dispose();
	});

	it("notifies only after a write succeeds, including a deferred retry", () => {
		const timers = createTimers();
		const successfulPayloads: object[] = [];
		let available = false;
		const writer = createCapacityResilientJsonWriter({
			timerApi: timers.timerApi,
			onSuccess: (_filePath, payload) => successfulPayloads.push(payload),
			write: () => { if (!available) throw capacityError("ENOSPC"); },
		});
		writer.write("status.json", { state: "running" });
		assert.deepEqual(successfulPayloads, []);
		available = true;
		timers.runNext();
		assert.deepEqual(successfulPayloads, [{ state: "running" }]);
	});

	it("orders deferred index work after authoritative status recovery", () => {
		const timers = createTimers();
		let statusAvailable = false;
		let indexUpdates = 0;
		const indexWriter = createCapacityResilientJsonWriter({
			timerApi: timers.timerApi,
			write: () => { indexUpdates += 1; },
		});
		const statusWriter = createCapacityResilientJsonWriter({
			timerApi: timers.timerApi,
			onSuccess: () => indexWriter.write("run", { state: "complete" }),
			write: () => { if (!statusAvailable) throw capacityError("ENOSPC"); },
		});
		statusWriter.write("status", { state: "complete" });
		assert.equal(indexUpdates, 0);
		statusAvailable = true;
		timers.runNext();
		assert.equal(indexUpdates, 1);
		statusWriter.dispose();
		indexWriter.dispose();
	});

	it("reports non-capacity failures from a retry without throwing from the timer", () => {
		const timers = createTimers();
		const errors: unknown[] = [];
		let attempts = 0;
		const writer = createCapacityResilientJsonWriter({
			timerApi: timers.timerApi,
			onError: (error) => errors.push(error),
			write: () => {
				if (attempts++ === 0) throw capacityError("ENOSPC");
				throw new Error("permission denied");
			},
		});
		assert.doesNotThrow(() => writer.write("status.json", { state: "running" }));
		assert.doesNotThrow(() => timers.runNext());
		assert.equal(errors.length, 1);
		assert.match(String(errors[0]), /permission denied/);
	});
});
