import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { nestedRunScope } from "../../src/runs/shared/nested-events.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { describe, it } from "node:test";
import { drainOutstandingWork } from "../../src/runs/background/auto-drain.ts";
import type { Details, SubagentState } from "../../src/shared/types.ts";

function state(sessionId: string | null = "session-a"): SubagentState {
	return { currentSessionId: sessionId } as SubagentState;
}

function waitResult(text: string, isError = false, windowElapsed = false) {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
		details: {
			mode: "management" as const,
			results: [],
			...(windowElapsed ? { wait: { reason: "window_elapsed" as const, timedOut: true as const, activeRunIds: ["run-a"], activeProviderItems: [] } } : {}),
		} satisfies Details,
	};
}

describe("headless background-work auto-drain", () => {
	it("discovers both owned storage scopes, forwards them to wait, and leaves sibling work alone", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-drain-scopes-"));
		const nestedRootRunId = randomUUID();
		const nested = nestedRunScope(nestedRootRunId);
		const ordinary = { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") };
		t.after(() => { for (const dir of [root, nested.asyncDirRoot]) fs.rmSync(dir, { recursive: true, force: true }); });
		const writeStatus = (dir: string, sessionId: string, status: "running" | "complete") => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: path.basename(dir), sessionId, mode: "single", state: status, pid: process.pid, startedAt: Date.now(), lastUpdate: Date.now(), steps: [] }));
			updateActiveRunIndex(dir, status);
		};
		const owned = [path.join(ordinary.asyncDirRoot, "workflow"), path.join(nested.asyncDirRoot, "persona")];
		for (const dir of owned) writeStatus(dir, "owner", "running");
		const sibling = path.join(nested.asyncDirRoot, "sibling-persona");
		writeStatus(sibling, "sibling-session", "running");
		let waits = 0;
		await drainOutstandingWork({
			state: state("owner"), ...ordinary, nestedRootRunId,
			wait: async (_params, _signal, deps) => {
				assert.equal(deps.nestedRootRunId, nestedRootRunId);
				assert.equal(deps.asyncDirRoot, ordinary.asyncDirRoot);
				assert.equal(deps.resultsDir, ordinary.resultsDir);
				writeStatus(owned[waits++]!, "owner", "complete");
				return waitResult("done");
			},
		});
		assert.equal(waits, 2, "drain must continue when only nested owned work remains");
		assert.equal(JSON.parse(fs.readFileSync(path.join(sibling, "status.json"), "utf8")).state, "running");
	});

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
		const waits: Array<{ all?: boolean; timeoutMs?: number; stopOnAttention?: boolean; failOnFailedRuns?: boolean; failOnAttention?: boolean }> = [];
		await drainOutstandingWork({
			state: state(),
			timeoutMs: 1000,
			now: () => checks * 10,
			hasWork: () => checks++ < 2,
			wait: async (params, _signal, deps) => {
				waits.push({ ...params, stopOnAttention: deps.stopOnAttention, failOnFailedRuns: deps.failOnFailedRuns, failOnAttention: deps.failOnAttention });
				return waitResult("done");
			},
		});
		assert.equal(waits.length, 2);
		assert.ok(waits.every((entry) => entry.all === true && entry.stopOnAttention === false && entry.failOnFailedRuns === true && entry.failOnAttention === true));
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

	it("keeps its absolute deadline strict after a non-error wait window elapses", async () => {
		let clock = 0;
		await assert.rejects(() => drainOutstandingWork({
			state: state(),
			timeoutMs: 100,
			now: () => clock,
			hasWork: () => true,
			wait: async () => {
				clock = 101;
				return waitResult("Wait window elapsed; work remains active.", false, true);
			},
		}), /timed out after 100ms.*session 'session-a'/);
	});

	it("fails without a session identity", async () => {
		await assert.rejects(() => drainOutstandingWork({ state: state(null) }), /without an active session identity/);
	});

	it("does not settle while a remembered detached foreground descendant is still in flight", async () => {
		const current = state("owner");
		current.foregroundRuns = new Map([["fg", {
			runId: "fg", mode: "single", cwd: "/tmp", sessionId: "owner", updatedAt: 1,
			children: [{ agent: "reviewer", index: 0, status: "detached", updatedAt: 1 }],
		}]]);
		let waits = 0;
		await drainOutstandingWork({
			state: current,
			timeoutMs: 1000,
			now: () => waits * 10,
			wait: async () => {
				waits++;
				current.foregroundRuns!.get("fg")!.children[0]!.status = "completed";
				return waitResult("done");
			},
		});
		assert.equal(waits, 1);
	});

	it("yields to Pi for a pending supervisor turn and resumes draining the same work after resolution", async () => {
		let pending = true;
		let active = true;
		let waits = 0;
		const deps = {
			state: state(),
			hasPendingSupervisorRequest: () => pending,
			hasWork: () => active,
			wait: async () => {
				waits++;
				active = false;
				return waitResult("done");
			},
		};

		await drainOutstandingWork(deps);
		assert.equal(waits, 0, "the queued supervisor triggerTurn must get control before drain blocks again");
		assert.equal(active, true, "yielding must leave the owned workflow active");

		pending = false;
		await drainOutstandingWork(deps);
		assert.equal(waits, 1, "the same workflow can continue and drain after the reply resolves the barrier");
		assert.equal(active, false);
	});

	it("latches an inner supervisor yield even when the live request clears before continuation", async () => {
		let pending = false;
		let clock = 0;
		let waits = 0;
		await drainOutstandingWork({
			state: state(),
			timeoutMs: 50,
			now: () => clock,
			hasWork: () => true,
			hasPendingSupervisorRequest: () => pending,
			wait: async (_params, _signal, deps) => {
				waits++;
				assert.equal(typeof deps.hasPendingSupervisorRequest, "function");
				clock = 100;
				pending = false;
				return {
					content: [{ type: "text", text: "Wait yielded for a pending supervisor request." }],
					details: { mode: "management", results: [], wait: { reason: "supervisor_request", timedOut: false, activeRunIds: ["run-a"], activeProviderItems: [] } },
				};
			},
		});
		assert.equal(waits, 1);
	});
});
