import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cancelOutstandingWork, drainOutstandingWork } from "../../src/runs/background/auto-drain.ts";
import { DIRS, type Details, type SubagentState } from "../../src/shared/types.ts";
import { nestedRunScope } from "../../src/runs/shared/nested-events.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { consumeInterruptRequest, consumeStopRequestPayload, consumeTimeoutRequest } from "../../src/runs/background/control-channel.ts";
import registerFanoutChild from "../../src/extension/fanout-child.ts";

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

function activeFixture(root: string, id: string, sessionId: string) {
	const dir = path.join(root, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: id, sessionId, mode: "single", state: "running", pid: process.pid, startedAt: Date.now(), lastUpdate: Date.now(), steps: [] }));
	fs.writeFileSync(path.join(dir, "recovery-descriptor.json"), "durable evidence");
	updateActiveRunIndex(dir, "running");
	return dir;
}

describe("headless background-work auto-drain", () => {
	for (const action of ["interrupt", "stop", "timeout"] as const) it(`cascades ${action} to exact-session ordinary and nested descendants with durable controls`, () => {
		const rootId = `cascade-${action}`;
		const scope = nestedRunScope(rootId);
		const own = activeFixture(DIRS.async, `${rootId}-own`, "owner");
		const nested = activeFixture(scope.asyncDirRoot, `${rootId}-nested`, "owner");
		const foreign = activeFixture(scope.asyncDirRoot, `${rootId}-foreign`, "foreign");
		let interrupted = 0;
		let stopped = 0;
		try {
			const current = state("owner");
			current.foregroundControls = new Map([["foreground", { runId: "foreground", sessionId: "owner", mode: "single", startedAt: 0, updatedAt: 0, interrupt: () => { interrupted++; return true; }, stop: () => { stopped++; return true; } }]]);
			cancelOutstandingWork(current, action, rootId);
			assert.equal(interrupted, action === "interrupt" ? 1 : 0);
			assert.equal(stopped, action === "interrupt" ? 0 : 1);
			for (const dir of [own, nested]) {
				assert.equal(action === "interrupt" ? consumeInterruptRequest(dir) : action === "timeout" ? consumeTimeoutRequest(dir) : consumeStopRequestPayload(dir)?.type === "stop", true);
				assert.equal(fs.readFileSync(path.join(dir, "recovery-descriptor.json"), "utf8"), "durable evidence");
			}
			assert.equal(consumeInterruptRequest(foreign), false);
			assert.equal(consumeStopRequestPayload(foreign), undefined);
			assert.equal(consumeTimeoutRequest(foreign), false);
		} finally { fs.rmSync(own, { recursive: true, force: true }); fs.rmSync(scope.asyncDirRoot, { recursive: true, force: true }); }
	});

	it("bounds cancellation teardown even when a descendant ignores its durable stop request", async () => {
		const sessionId = "unresponsive-owner";
		const dir = activeFixture(DIRS.async, "unresponsive-descendant", sessionId);
		const controller = new AbortController();
		let tool: any;
		let shutdown: (() => Promise<void>) | undefined;
		const pi = { events: { on: () => () => {}, emit: () => {} }, getSessionName: () => undefined,
			registerTool: (value: any) => { tool = value; },
			on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") shutdown = handler; },
		};
		try {
			registerFanoutChild(pi as never, { fanoutChild: true, depth: 1, fast: false, waitTool: { enabled: true, defaultTimeoutMs: 1800000 }, backgroundDrain: { signal: controller.signal, abort: () => controller.abort("stop"), report: () => {} } });
			await tool.execute("status", { action: "status", id: "unresponsive-descendant" }, undefined, undefined, { cwd: path.dirname(dir), hasUI: false, sessionManager: { getSessionFile: () => sessionId, getSessionId: () => sessionId }, modelRegistry: { getAvailable: () => [] } });
			controller.abort("stop");
			const start = Date.now();
			await assert.rejects(shutdown!(), /cancellation remains unconfirmed.*unresponsive-descendant/s);
			assert.ok(Date.now() - start < 2500, "shutdown must not use the 30-minute wait window");
			assert.equal(consumeStopRequestPayload(dir)?.type, "stop");
			assert.equal(fs.readFileSync(path.join(dir, "recovery-descriptor.json"), "utf8"), "durable evidence");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

	it("delivers wait results before settling and forwards cancellation", async () => {
		let active = true;
		const controller = new AbortController();
		const delivered: string[] = [];
		await drainOutstandingWork({
			state: state(), signal: controller.signal,
			hasWork: () => active,
			wait: async (_params, signal) => {
				assert.equal(signal, controller.signal);
				active = false;
				return waitResult("PERSONA FINDING");
			},
			deliver: (result) => { delivered.push(result.content[0].text); },
		});
		assert.deepEqual(delivered, ["PERSONA FINDING"]);
		controller.abort();
		await assert.rejects(drainOutstandingWork({ state: state(), signal: controller.signal, hasWork: () => false }), /abort/i);
	});

	it("fails if the owning session changes during a wait", async () => {
		const current = state();
		await assert.rejects(drainOutstandingWork({
			state: current, hasWork: () => true,
			wait: async () => { current.currentSessionId = "other-session"; return waitResult("foreign"); },
			deliver: () => { assert.fail("must not deliver into another session"); },
		}), /session changed/i);
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
});
