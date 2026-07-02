/**
 * Stress tests for the wait tool. Deterministic (no LLM): synthesize many async
 * run status files and drive waitForSubagents through fixtures + a fake event
 * bus, exercising high concurrency, rapid/staggered completions, churn, mixed
 * terminal states, event storms, and the reconciliation fallback. Guards against
 * hangs, missed completions, cross-session leakage, and O(n^2) blowups.
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
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

function writeRun(asyncRoot: string, runId: string, state: string, extra: object = {}): void {
	const dir = path.join(asyncRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	const nowMs = Date.now();
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({ runId, mode: "single", state, startedAt: nowMs, lastUpdate: nowMs, steps: [{ agent: "w", status: state }], ...extra }),
		"utf-8",
	);
}

function baseDeps(root: string, state: SubagentState, overrides: Partial<SubagentWaitDeps> = {}): SubagentWaitDeps {
	return {
		state,
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		kill: () => true,
		pollIntervalMs: 5,
		...overrides,
	};
}

function tmp(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `pi-wait-stress-${label}-`));
}

describe("wait stress", () => {
	it("all:true drains a large fleet (100 runs) completing in staggered waves", async () => {
		const root = tmp("fleet100");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			const N = 100;
			for (let i = 0; i < N; i++) writeRun(asyncRoot, `run-${i}`, "running", { sessionId: "sess-1", pid: 900000 + i });

			// Each poll completes the next 7 runs, so it takes ~15 polls to drain.
			let completed = 0;
			const sleep = async () => {
				for (let k = 0; k < 7 && completed < N; k++, completed++) {
					writeRun(asyncRoot, `run-${completed}`, completed % 5 === 0 ? "failed" : "complete", { sessionId: "sess-1" });
				}
			};
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			// 100 runs: 80 complete (non-mult-of-5) + 20 failed.
			assert.match(textOf(result), /80 complete/);
			assert.match(textOf(result), /20 failed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("first-completion returns after exactly one of a large fleet finishes", async () => {
		const root = tmp("first-of-many");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			for (let i = 0; i < 50; i++) writeRun(asyncRoot, `run-${i}`, "running", { sessionId: "sess-1", pid: 900000 + i });
			let polls = 0;
			const sleep = async () => { polls += 1; if (polls === 1) writeRun(asyncRoot, "run-7", "complete", { sessionId: "sess-1" }); };
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /1 of 50 run\(s\) finished/);
			assert.match(textOf(result), /49 run\(s\).*still in flight/);
			assert.ok(polls <= 2, `should return promptly on first completion, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("survives rapid event storm on the bus without hanging or double-resolving", async () => {
		const root = tmp("event-storm");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			for (let i = 0; i < 10; i++) writeRun(asyncRoot, `run-${i}`, "running", { sessionId: "sess-1", pid: 900000 + i });
			const handlers = new Map<string, Array<(d: unknown) => void>>();
			const events = {
				on(ch: string, h: (d: unknown) => void) {
					const l = handlers.get(ch) ?? []; l.push(h); handlers.set(ch, l);
					return () => handlers.set(ch, (handlers.get(ch) ?? []).filter((x) => x !== h));
				},
				emit(ch: string, d: unknown) { for (const h of [...(handlers.get(ch) ?? [])]) h(d); },
			};
			let resolves = 0;
			const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
				const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
			});
			// Fire a storm of events; on the 3rd poll, everything completes.
			let polls = 0;
			const sleepWrap = (ms: number, signal?: AbortSignal) => {
				polls += 1;
				if (polls === 3) for (let i = 0; i < 10; i++) writeRun(asyncRoot, `run-${i}`, "complete", { sessionId: "sess-1" });
				return sleep(ms, signal);
			};
			const p = waitForSubagents({ all: true }, undefined, baseDeps(root, state, { events, sleep: sleepWrap, pollIntervalMs: 20 }))
				.then((r) => { resolves += 1; return r; });
			// Hammer the bus with events from many channels.
			const storm = setInterval(() => {
				events.emit("subagent:control-event", {});
				events.emit("subagent:async-complete", {});
				events.emit("subagent:result-intercom", {});
			}, 1);
			const result = await p;
			clearInterval(storm);
			await new Promise((r) => setTimeout(r, 30));
			assert.equal(result.isError, undefined);
			assert.equal(resolves, 1, "must resolve exactly once despite the event storm");
			assert.match(textOf(result), /10 complete/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("100 sequential first-completion waits over a churning fleet never hang", async () => {
		const root = tmp("churn");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// Keep ~5 in flight; each wait finishes one and we "replace" it.
			let nextId = 0;
			const inflight = new Set<string>();
			const spawn = () => { const id = `run-${nextId++}`; writeRun(asyncRoot, id, "running", { sessionId: "sess-1", pid: 900000 + (nextId % 1000) }); inflight.add(id); };
			for (let i = 0; i < 5; i++) spawn();
			for (let round = 0; round < 100; round++) {
				const victim = [...inflight][0];
				let polls = 0;
				const sleep = async () => { polls += 1; if (polls === 1) { writeRun(asyncRoot, victim, "complete", { sessionId: "sess-1" }); inflight.delete(victim); } };
				const result = await waitForSubagents({}, undefined, baseDeps(root, state, { sleep }));
				assert.equal(result.isError, undefined, `round ${round} errored: ${textOf(result)}`);
				assert.ok(polls <= 3, `round ${round} polled ${polls}`);
				spawn(); // rolling replacement
			}
			assert.equal(inflight.size, 5, "fleet stays at 5 in flight");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores a flood of other-session runs (no cross-session leak at scale)", async () => {
		const root = tmp("xsession");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-mine");
			// 200 runs from OTHER sessions, plus 1 of mine.
			for (let i = 0; i < 200; i++) writeRun(asyncRoot, `other-${i}`, "running", { sessionId: `sess-${i % 7}`, pid: 800000 + i });
			writeRun(asyncRoot, "mine", "running", { sessionId: "sess-mine", pid: 999999 });
			let polls = 0;
			const sleep = async () => { polls += 1; if (polls === 1) writeRun(asyncRoot, "mine", "complete", { sessionId: "sess-mine" }); };
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /1 async run\(s\)|done/i);
			assert.match(textOf(result), /1 complete/);
			assert.ok(polls <= 2, `should only track my 1 run, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tolerates malformed / partially-written status files during polling", async () => {
		const root = tmp("malformed");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeRun(asyncRoot, "good", "running", { sessionId: "sess-1", pid: 999999 });
			// A directory with a garbage status.json — must not crash the wait.
			const bad = path.join(asyncRoot, "bad");
			fs.mkdirSync(bad, { recursive: true });
			fs.writeFileSync(path.join(bad, "status.json"), "{ this is not json ", "utf-8");
			let polls = 0;
			const sleep = async () => { polls += 1; if (polls === 1) writeRun(asyncRoot, "good", "complete", { sessionId: "sess-1" }); };
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			// Either it resolves cleanly or reports an error — but it must not hang.
			assert.ok(typeof textOf(result) === "string");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("timeout fires deterministically with a virtual clock under load", async () => {
		const root = tmp("timeout");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			for (let i = 0; i < 30; i++) writeRun(asyncRoot, `run-${i}`, "running", { sessionId: "sess-1", pid: 900000 + i });
			let clock = 0;
			const now = () => clock;
			const sleep = async (ms: number) => { clock += ms; }; // nothing ever completes
			const result = await waitForSubagents({ all: true, timeoutMs: 1000 }, undefined, baseDeps(root, state, { now, sleep, pollIntervalMs: 50 }));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /timed out/i);
			assert.match(textOf(result), /30 run\(s\) still active/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats paused runs as terminal (blocked-for-decision children)", async () => {
		const root = tmp("paused");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			for (let i = 0; i < 20; i++) writeRun(asyncRoot, `run-${i}`, "running", { sessionId: "sess-1", pid: 900000 + i });
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				// On first poll, everything pauses (e.g. all blocked on contact_supervisor).
				if (polls === 1) for (let i = 0; i < 20; i++) writeRun(asyncRoot, `run-${i}`, "paused", { sessionId: "sess-1" });
			};
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /20 paused/);
			assert.ok(polls <= 2, `paused should end the wait promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("handles attention and completion arriving together in the same poll", async () => {
		const root = tmp("mixed");
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			for (let i = 0; i < 10; i++) writeRun(asyncRoot, `run-${i}`, "running", { sessionId: "sess-1", pid: 900000 + i });
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) {
					writeRun(asyncRoot, "run-0", "complete", { sessionId: "sess-1" });
					writeRun(asyncRoot, "run-1", "running", { sessionId: "sess-1", pid: 900001, activityState: "needs_attention" });
				}
			};
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			// Reports both the completion outcome and the attention run.
			assert.match(textOf(result), /1 complete/);
			assert.match(textOf(result), /need attention/i);
			assert.match(textOf(result), /run-1/);
			assert.ok(polls <= 2, `mixed signals should end wait promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
