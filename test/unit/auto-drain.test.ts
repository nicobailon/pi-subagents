import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { drainOutstandingWork } from "../../src/runs/background/auto-drain.ts";
import type { Details, SubagentState } from "../../src/shared/types.ts";

function state(sessionId: string | null = "session-a"): SubagentState {
	return { currentSessionId: sessionId } as SubagentState;
}

function waitResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management" as const, results: [] } satisfies Details,
	};
}

describe("headless background-work auto-drain", () => {
	it("is a no-op when the exact session has no work", async () => {
		let waited = false;
		await drainOutstandingWork({
			state: state(),
			hasWork: () => false,
			wait: async () => { waited = true; return waitResult("unexpected"); },
		});
		assert.equal(waited, false);
	});

	it("loops until work added while draining is also gone", async () => {
		let checks = 0;
		const waits: Array<{ all?: boolean; timeoutMs?: number; stopOnAttention?: boolean; failOnFailedRuns?: boolean }> = [];
		await drainOutstandingWork({
			state: state(),
			timeoutMs: 1000,
			now: () => checks * 10,
			hasWork: () => checks++ < 2,
			wait: async (params, _signal, deps) => {
				waits.push({ ...params, stopOnAttention: deps.stopOnAttention, failOnFailedRuns: deps.failOnFailedRuns });
				return waitResult("done");
			},
		});
		assert.equal(waits.length, 2);
		assert.ok(waits.every((entry) => entry.all === true && entry.stopOnAttention === false && entry.failOnFailedRuns === true));
		assert.ok((waits[1]!.timeoutMs ?? 0) < (waits[0]!.timeoutMs ?? 0), "each wait must share one absolute deadline");
	});

	it("preserves wait errors instead of treating them as a successful drain", async () => {
		await assert.rejects(() => drainOutstandingWork({
			state: state(),
			hasWork: () => true,
			wait: async () => waitResult("provider 'patty' snapshot failed", true),
		}), /Auto-drain failed.*provider 'patty' snapshot failed/);
	});

	it("propagates work-discovery errors", async () => {
		await assert.rejects(() => drainOutstandingWork({
			state: state(),
			hasWork: () => { throw new Error("provider reconcile failed"); },
		}), /provider reconcile failed/);
	});

	it("enforces one absolute timeout across repeated drains", async () => {
		let clock = 0;
		await assert.rejects(() => drainOutstandingWork({
			state: state(),
			timeoutMs: 100,
			now: () => clock,
			hasWork: () => true,
			wait: async () => {
				clock = 101;
				return waitResult("first batch done");
			},
		}), /timed out after 100ms.*session 'session-a'/);
	});

	it("fails without a session identity", async () => {
		await assert.rejects(() => drainOutstandingWork({ state: state(null) }), /without an active session identity/);
	});
});
