import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, waitForSubagents, type WaitDeps } from "../../src/runs/background/wait.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function writeStatus(asyncRoot: string, runId: string, state: string, extra: object = {}): void {
	const dir = path.join(asyncRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	// Use a recent timestamp so the stale-run reconciler doesn't mark a live
	// "running" fixture as failed for having a stale heartbeat.
	const nowMs = Date.now();
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state,
			startedAt: nowMs,
			lastUpdate: nowMs,
			steps: [{ agent: "worker", status: state }],
			...extra,
		}),
		"utf-8",
	);
}

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

function baseDeps(root: string, state: SubagentState, overrides: Partial<WaitDeps> = {}): WaitDeps {
	return {
		state,
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		// Never probe real PIDs in tests — treat every recorded pid as alive so
		// reconciliation doesn't flip a "running" fixture to failed.
		kill: () => true,
		pollIntervalMs: 250,
		...overrides,
	};
}

describe("wait tool", () => {
	it("resolves waitTool config and environment overrides strictly", () => {
		assert.deepEqual(resolveWaitToolConfig(undefined, {}), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(false, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, { [WAIT_TOOL_ENABLED_ENV]: "true" }), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(true, { [WAIT_TOOL_ENABLED_ENV]: "off" }), { enabled: false });
		assert.throws(() => resolveWaitToolConfig("false" as never, {}), /config\.waitTool/);
		assert.throws(() => resolveWaitToolConfig({ enabled: "false" } as never, {}), /config\.waitTool\.enabled/);
		assert.throws(() => resolveWaitToolConfig(undefined, { [WAIT_TOOL_ENABLED_ENV]: "maybe" }), /PI_SUBAGENT_WAIT_TOOL_ENABLED/);
	});

	it("returns immediately without polling when waitTool is disabled", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-disabled-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let slept = false;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				enabled: false,
				sleep: async () => {
					slept = true;
					throw new Error("disabled wait should not sleep");
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /disabled/i);
			assert.match(textOf(result), /without blocking/i);
			assert.equal(slept, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns immediately when there is nothing to wait for", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-empty-"));
		try {
			const state = makeState("sess-1");
			const result = await waitForSubagents({}, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /nothing to wait for/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("with all:true, resolves once every active run reaches a terminal state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-resolve-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "queued", { sessionId: "sess-1", pid: 999998 });

			// Flip one run terminal on the first poll, the other on the second — so
			// all:true must keep waiting past the first completion.
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
				if (polls === 2) writeStatus(asyncRoot, "run-b", "failed", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /done/i);
			assert.match(text, /1 complete/);
			assert.match(text, /1 failed/);
			assert.ok(polls >= 2, "all:true should wait for both completions");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes when a run needs attention, not only on completion", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// Two runs, all:true so it would normally block until both finish.
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999998 });

			// Neither completes; run-a flags needs_attention (blocked for a decision).
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) {
					writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999, activityState: "needs_attention" });
				}
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /need attention/i, "should report the attention run");
			assert.match(text, /run-a/, "should name the attention run");
			assert.ok(polls <= 2, `should break on attention promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports runs that already need attention before waiting starts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-initial-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-blocked", "running", { sessionId: "sess-1", pid: 999999, activityState: "needs_attention" });

			let polls = 0;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				sleep: async () => { polls += 1; },
			}));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.doesNotMatch(text, /nothing to wait for/i);
			assert.match(text, /need attention/i);
			assert.match(text, /run-blocked/);
			assert.equal(polls, 0, "initial attention should return without polling");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("by default returns as soon as the FIRST run finishes, leaving the rest in flight", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-first-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999998 });
			writeStatus(asyncRoot, "run-c", "running", { sessionId: "sess-1", pid: 999997 });

			// Only run-a finishes; b and c stay running forever.
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({}, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 of 3 run\(s\) finished/);
			assert.match(text, /1 complete/);
			assert.match(text, /2 run\(s\) still in flight/);
			// Must not have blocked on b and c: a bounded number of polls.
			assert.ok(polls <= 2, `first-completion should return promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("only waits for runs belonging to the current session", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// A run from another session must be ignored.
			writeStatus(asyncRoot, "run-other", "running", { sessionId: "sess-2", pid: 999999 });
			const result = await waitForSubagents({}, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /nothing to wait for/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("summarizes only runs that were active when waiting began", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-summary-scope-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "old-complete", "complete", { sessionId: "sess-1" });
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			const sleep = async () => {
				writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 complete/);
			assert.doesNotMatch(text, /2 complete/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("can target a single run by id prefix", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-alpha", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-beta", "running", { sessionId: "sess-1", pid: 999998 });

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				// Only alpha finishes; beta stays running but we're not waiting on it.
				if (polls === 1) writeStatus(asyncRoot, "run-alpha", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ id: "run-al" }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /run "run-al".*done/is);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous id prefixes but lets exact ids win", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-ambiguous-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-alpha", "running", { sessionId: "sess-1", pid: 999998 });

			const ambiguous = await waitForSubagents({ id: "ru" }, undefined, baseDeps(root, state));
			assert.equal(ambiguous.isError, true);
			assert.match(textOf(ambiguous), /Ambiguous async run id prefix "ru"/);
			assert.match(textOf(ambiguous), /run-alpha/);

			let polls = 0;
			const exact = await waitForSubagents({ id: "run" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					writeStatus(asyncRoot, "run", "complete", { sessionId: "sess-1" });
				},
			}));

			assert.equal(exact.isError, undefined);
			assert.match(textOf(exact), /run "run".*done/is);
			assert.equal(polls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("times out while runs are still active and reports them", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-timeout-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-stuck", "running", { sessionId: "sess-1", pid: 999999 });

			// Virtual clock that jumps past the timeout on the first sleep.
			let clock = 0;
			const now = () => clock;
			const sleep = async (ms: number) => {
				clock += ms + 10_000;
			};

			const result = await waitForSubagents({ timeoutMs: 5_000 }, undefined, baseDeps(root, state, { now, sleep }));
			assert.equal(result.isError, true);
			const text = textOf(result);
			assert.match(text, /timed out/i);
			assert.match(text, /run-stuck \(running\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves early when the turn is aborted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-abort-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-x", "running", { sessionId: "sess-1", pid: 999999 });

			const controller = new AbortController();
			const sleep = async () => {
				controller.abort();
			};

			const result = await waitForSubagents({}, controller.signal, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /aborted/i);
			assert.match(textOf(result), /run-x \(running\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes immediately on an event bus emission instead of waiting the poll interval", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-event-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			// Fake bus. Emitting on a wake channel should end wait's sleep early.
			const handlers = new Map<string, Array<(d: unknown) => void>>();
			const events = {
				on(channel: string, handler: (d: unknown) => void) {
					const list = handlers.get(channel) ?? [];
					list.push(handler);
					handlers.set(channel, list);
					return () => {
						const l = handlers.get(channel) ?? [];
						handlers.set(channel, l.filter((h) => h !== handler));
					};
				},
				emit(channel: string, data: unknown) {
					for (const h of handlers.get(channel) ?? []) h(data);
				},
			};

			// A real timer-based sleep with a LONG poll interval; if wait waited for
			// the poll it would take ~10s. The event should wake it in ~10ms.
			let sleepCalls = 0;
			const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
				sleepCalls += 1;
				const t = setTimeout(resolve, ms);
				signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
			});

			const startedAt = Date.now();
			const p = waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				events,
				pollIntervalMs: 10_000,
				sleep: realSleep,
			}));

			// After a short delay, flip the run terminal and emit a completion event.
			setTimeout(() => {
				writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
				events.emit("subagent:async-complete", { id: "run-a" });
			}, 15);

			const result = await p;
			const elapsed = Date.now() - startedAt;
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(elapsed < 5_000, `should wake via event, not the 10s poll; took ${elapsed}ms`);
			assert.ok(sleepCalls >= 1, "poll-interval sleep still armed as fallback");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still resolves via poll when no event bus is provided (fallback)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-nobus-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};
			// No `events` in deps → pure poll path.
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(polls >= 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
