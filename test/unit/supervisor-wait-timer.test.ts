import assert from "node:assert/strict";
import { it } from "node:test";
import { startPausableTimer } from "../../src/runs/shared/supervisor-wait-timer.ts";

it("keeps the remaining budget when the system clock jumps", () => {
	const realNow = Date.now;
	try {
		for (const jumpMs of [60_000, -60_000]) {
			const base = realNow();
			Date.now = () => base;
			const timer = startPausableTimer(10_000, () => {});
			Date.now = () => base + jumpMs;
			timer.pause("ask");
			const remaining = timer.remainingMs();
			timer.clear();
			assert.ok(remaining > 9_000 && remaining <= 10_000, `jump ${jumpMs} ms left ${remaining} ms`);
		}
	} finally {
		Date.now = realNow;
	}
});
