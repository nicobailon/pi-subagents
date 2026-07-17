import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatSpawnBudget,
	getSpawnBudgetSnapshot,
	grantSpawnBudget,
	preflightSpawnBudget,
	reserveSpawnBudget,
} from "../../src/runs/shared/spawn-budget.ts";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";

function makeState(sessionId = "session-a"): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
	};
}

const capped: ExtensionConfig = { maxSubagentSpawnsPerSession: 4 };

describe("spawn budget", () => {
	it("keeps unset and zero caps unlimited without cumulative accounting", () => {
		for (const config of [{}, { maxSubagentSpawnsPerSession: 0 }]) {
			const state = makeState();
			const reserved = reserveSpawnBudget(state, config, "session-a", 50);
			assert.equal(reserved.error, undefined);
			assert.deepEqual(reserved.snapshot, {
				used: 0,
				configuredLimit: null,
				granted: 0,
				limit: null,
				remaining: null,
				grantRemaining: null,
				grantHistory: [],
			});
			assert.equal(formatSpawnBudget(reserved.snapshot), "Spawn budget: unlimited");
		}
	});

	it("preflights declared capacity without reserving partial work", () => {
		const state = makeState();
		state.subagentSpawns = { sessionId: "session-a", count: 2 };

		const checked = preflightSpawnBudget(state, capped, "session-a", 3);
		assert.match(checked.error ?? "", /2\/4 used, 3 requested\).*2 remaining/);
		assert.equal(state.subagentSpawns.count, 2);
	});

	it("reserves cumulative declared capacity", () => {
		const state = makeState();
		const first = reserveSpawnBudget(state, capped, "session-a", 3);
		assert.equal(first.error, undefined);
		assert.equal(first.snapshot.used, 3);
		assert.equal(first.snapshot.remaining, 1);

		const rejected = reserveSpawnBudget(state, capped, "session-a", 2);
		assert.match(rejected.error ?? "", /3\/4 used, 2 requested\).*1 remaining/);
		assert.equal(state.subagentSpawns?.count, 3);
	});

	it("grants at most the original configured limit and keeps bounded audit records", () => {
		const state = makeState();
		state.subagentSpawns = { sessionId: "session-a", count: 4 };

		const first = grantSpawnBudget(state, capped, "session-a", 3, 100);
		assert.equal(first.error, undefined);
		assert.equal(first.snapshot.limit, 7);
		assert.equal(first.snapshot.remaining, 3);
		assert.equal(first.snapshot.grantRemaining, 1);
		assert.deepEqual(first.snapshot.grantHistory, [
			{ sessionId: "session-a", amount: 3, grantedAt: 100, previousLimit: 4, limit: 7 },
		]);

		const rejected = grantSpawnBudget(state, capped, "session-a", 2, 200);
		assert.match(rejected.error ?? "", /2 requested but only 1/);
		assert.equal(rejected.snapshot.limit, 7);

		const final = grantSpawnBudget(state, capped, "session-a", 1, 300);
		assert.equal(final.error, undefined);
		assert.equal(final.snapshot.limit, 8);
		assert.equal(final.snapshot.granted, 4);
		assert.equal(final.snapshot.grantRemaining, 0);
	});

	it("bounds grant history while preserving aggregate granted capacity", () => {
		const state = makeState();
		const config = { maxSubagentSpawnsPerSession: 100 };
		for (let index = 0; index < 25; index += 1) {
			const granted = grantSpawnBudget(state, config, "session-a", 1, index);
			assert.equal(granted.error, undefined);
		}

		const snapshot = getSpawnBudgetSnapshot(state, config, "session-a");
		assert.equal(snapshot.granted, 25);
		assert.equal(snapshot.limit, 125);
		assert.equal(snapshot.grantHistory.length, 20);
		assert.equal(snapshot.grantHistory[0]?.grantedAt, 5);
	});

	it("rejects meaningless or invalid grants", () => {
		const state = makeState();
		assert.match(grantSpawnBudget(state, {}, "session-a", 1).error ?? "", /no configured spawn cap/);
		assert.match(grantSpawnBudget(state, capped, "session-a", 0).error ?? "", /positive integer/);
		assert.match(grantSpawnBudget(state, capped, "session-a", 1.5).error ?? "", /positive integer/);
	});

	it("resets usage and grants only when the logical session changes", () => {
		const state = makeState();
		reserveSpawnBudget(state, capped, "session-a", 2);
		grantSpawnBudget(state, capped, "session-a", 2, 100);

		const sameSession = getSpawnBudgetSnapshot(state, capped, "session-a");
		assert.equal(sameSession.used, 2);
		assert.equal(sameSession.granted, 2);

		const newSession = getSpawnBudgetSnapshot(state, capped, "session-b");
		assert.equal(newSession.used, 0);
		assert.equal(newSession.granted, 0);
		assert.equal(newSession.limit, 4);
	});
});
