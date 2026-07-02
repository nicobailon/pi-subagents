/**
 * wait × pi-patty-bg-tasks integration. Deterministic: no real subagents, no
 * real bash. A fake bgTaskCount() models pi-patty-bg-tasks' process-global live
 * set, and a fake event bus emits patty:bg-task-finished. Asserts wait blocks on
 * outstanding background jobs and returns when one (or all) finish.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { waitForSubagents, type SubagentWaitDeps } from "../../src/runs/background/subagent-wait.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(sessionId: string | null): SubagentState {
	return {
		baseCwd: "", currentSessionId: sessionId, asyncJobs: new Map(),
		foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null,
		completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
	return r.content.map((c) => c.text ?? "").join("");
}

function fakeBus() {
	const handlers = new Map<string, Array<(d: unknown) => void>>();
	return {
		on(ch: string, h: (d: unknown) => void) {
			const l = handlers.get(ch) ?? []; l.push(h); handlers.set(ch, l);
			return () => handlers.set(ch, (handlers.get(ch) ?? []).filter((x) => x !== h));
		},
		emit(ch: string, d: unknown) { for (const h of [...(handlers.get(ch) ?? [])]) h(d); },
	};
}

function emptyRunsDeps(root: string, state: SubagentState, overrides: Partial<SubagentWaitDeps>): SubagentWaitDeps {
	return {
		state,
		asyncDirRoot: path.join(root, "runs"),   // empty dir → no subagent runs
		resultsDir: path.join(root, "results"),
		kill: () => true,
		pollIntervalMs: 5,
		...overrides,
	};
}

describe("wait × background tasks", () => {
	it("nothing to wait for when no runs and no bg jobs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-bg-none-"));
		try {
			const r = await waitForSubagents({}, undefined, emptyRunsDeps(root, makeState("s1"), { bgTaskCount: () => 0 }));
			assert.equal(r.isError, undefined);
			assert.match(textOf(r), /nothing to wait for/i);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("blocks on an outstanding bg job and returns (first-completion) when it finishes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-bg-first-"));
		try {
			let live = 2; // two bg jobs in flight at start
			let polls = 0;
			const sleep = async () => { polls += 1; if (polls === 1) live = 1; }; // one finishes
			const r = await waitForSubagents({}, undefined, emptyRunsDeps(root, makeState("s1"), {
				bgTaskCount: () => live, sleep,
			}));
			assert.equal(r.isError, undefined);
			assert.match(textOf(r), /1 of 2 background job\(s\) finished/);
			assert.match(textOf(r), /1 still running/);
			assert.ok(polls <= 2, `first bg completion should return promptly, polled ${polls}`);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("all:true blocks until every bg job finishes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-bg-all-"));
		try {
			let live = 3;
			let polls = 0;
			const sleep = async () => { polls += 1; live = Math.max(0, 3 - polls); }; // drains 1/poll
			const r = await waitForSubagents({ all: true }, undefined, emptyRunsDeps(root, makeState("s1"), {
				bgTaskCount: () => live, sleep,
			}));
			assert.equal(r.isError, undefined);
			assert.match(textOf(r), /3 of 3 background job\(s\) finished\./);
			assert.ok(polls >= 3, `all:true should wait for all three, polled ${polls}`);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("wakes instantly on patty:bg-task-finished instead of the poll interval", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-bg-event-"));
		try {
			let live = 1;
			const bus = fakeBus();
			const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => {
				const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
			});
			const startedAt = Date.now();
			const p = waitForSubagents({ all: true }, undefined, emptyRunsDeps(root, makeState("s1"), {
				bgTaskCount: () => live, events: bus, pollIntervalMs: 10_000, sleep: realSleep,
			}));
			setTimeout(() => { live = 0; bus.emit("patty:bg-task-finished", { jobId: "job-1", status: "completed" }); }, 15);
			const r = await p;
			const elapsed = Date.now() - startedAt;
			assert.equal(r.isError, undefined);
			assert.match(textOf(r), /1 of 1 background job\(s\) finished\./);
			assert.ok(elapsed < 2000, `should wake via bg event (~15ms), not the 10s poll; took ${elapsed}ms`);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("waits across BOTH a subagent run and a bg job (mixed), first-completion", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-bg-mixed-"));
		try {
			const asyncRoot = path.join(root, "runs");
			// one real subagent run fixture, still running
			const dir = path.join(asyncRoot, "run-a");
			fs.mkdirSync(dir, { recursive: true });
			const nowMs = Date.now();
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
				runId: "run-a", mode: "single", state: "running", startedAt: nowMs, lastUpdate: nowMs,
				sessionId: "s1", pid: 999999, steps: [{ agent: "w", status: "running" }],
			}));
			let live = 1; // plus one bg job
			let polls = 0;
			// The bg job finishes first; the subagent run stays running.
			const sleep = async () => { polls += 1; if (polls === 1) live = 0; };
			const r = await waitForSubagents({}, undefined, emptyRunsDeps(root, makeState("s1"), {
				bgTaskCount: () => live, sleep,
			}));
			assert.equal(r.isError, undefined);
			assert.match(textOf(r), /1 of 1 background job\(s\) finished/);
			// subagent run still in flight → invites another wait
			assert.match(textOf(r), /still in flight/i);
			assert.ok(polls <= 2, `bg finishing first should return promptly, polled ${polls}`);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
