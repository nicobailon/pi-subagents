import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { waitForSubagents } from "../../src/runs/background/subagent-wait.ts";
import { registerWaitTool } from "../../src/runs/background/wait-tool.ts";
import { createWaitSubscriptionManager } from "../../src/runs/background/wait-subscriptions.ts";
import { recordWaitCompletion } from "../../src/runs/background/wait-completions.ts";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type IntercomEventBus, type SubagentState } from "../../src/shared/types.ts";

function writeStatus(asyncRoot: string, runId: string, state: string, extra: object = {}): void {
	const dir = path.join(asyncRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		runId,
		mode: "single",
		state,
		startedAt: now,
		lastUpdate: now,
		steps: [{ agent: "worker", status: state }],
		...extra,
	}), "utf-8");
}

function makeState(sessionId = "session-a"): SubagentState {
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

class TestBus implements IntercomEventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((entry) => entry.text ?? "").join("");
}

describe("non-blocking wait subscriptions", () => {
	it("returns immediately and binds an id prefix to one exact run", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-arm-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeStatus(asyncRoot, "run-alpha", "running", { sessionId: "session-a", pid: 999_999 });
			let armed: { targetKind: "async" | "foreground"; runId: string; requestedId: string; timeoutMs: number } | undefined;
			const result = await waitForSubagents({ id: "run-al", nonBlocking: true, timeoutMs: 5_000 }, undefined, {
				state: makeState(),
				asyncDirRoot: asyncRoot,
				resultsDir: path.join(root, "results"),
				kill: () => true,
				sleep: async () => { throw new Error("non-blocking wait must not sleep"); },
				subscribe: (input) => {
					armed = input;
					return { token: "wait-token", expiresAt: 6_000 };
				},
			});

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /Armed wait subscription wait-token/);
			assert.deepEqual(armed, { targetKind: "async", runId: "run-alpha", requestedId: "run-al", timeoutMs: 5_000 });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects non-blocking subscriptions from headless tool calls", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-headless-"));
		try {
			const state = makeState();
			state.foregroundRuns = new Map([["run-headless", {
				runId: "run-headless",
				mode: "single",
				cwd: root,
				sessionId: "session-a",
				updatedAt: Date.now(),
				children: [{ agent: "worker", index: 0, status: "detached" }],
			}]]);
			let tool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> } | undefined;
			registerWaitTool({
				events: new TestBus(),
				registerTool(value: unknown) { tool = value as typeof tool; },
			} as never, state, true, {
				arm() { throw new Error("headless calls must not arm subscriptions"); },
			});
			const result = await tool!.execute("wait", { id: "run-headless", nonBlocking: true }, undefined, undefined, { hasUI: false });
			assert.equal(result.isError, true);
			assert.match(textOf(result), /long-lived interactive subagent runtime/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores durable registrations and wakes on exact completion", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-restore-"));
		const asyncRoot = path.join(root, "runs");
		const resultsDir = path.join(root, "results");
		const subscriptionsDir = path.join(root, "subscriptions");
		const bus = new TestBus();
		const sent: Array<{ message: { content?: unknown; details?: { completions?: Array<{ runId?: string; archivePath?: string }> } }; options?: { triggerTurn?: boolean } }> = [];
		const pi = {
			events: bus,
			sendMessage(message: { content?: unknown; details?: { completions?: Array<{ runId?: string; archivePath?: string }> } }, options?: { triggerTurn?: boolean }) { sent.push({ message, options }); },
		};
		try {
			writeStatus(asyncRoot, "run-exact", "running", { sessionId: "session-a", pid: 999_999 });
			const firstState = makeState();
			const first = createWaitSubscriptionManager(pi as never, firstState, { asyncDirRoot: asyncRoot, resultsDir, subscriptionsDir, pollIntervalMs: 60_000, kill: () => true });
			const registration = first.arm({ targetKind: "async", runId: "run-exact", requestedId: "run-ex", timeoutMs: 30_000 });
			assert.equal(fs.existsSync(path.join(subscriptionsDir, `${registration.token}.json`)), true);
			first.dispose();

			const restoredState = makeState();
			const restored = createWaitSubscriptionManager(pi as never, restoredState, { asyncDirRoot: asyncRoot, resultsDir, subscriptionsDir, pollIntervalMs: 60_000, kill: () => true });
			restored.restore();
			assert.equal(restoredState.waitSubscriptions?.has(registration.token), true);
			const status = inspectSubagentStatus({}, { state: restoredState, asyncDirRoot: asyncRoot, resultsDir, kill: () => true });
			assert.match(textOf(status), new RegExp(`Armed wait subscriptions.*${registration.token}`, "s"));

			writeStatus(asyncRoot, "unrelated-run", "complete", { sessionId: "session-a" });
			restored.reconcile();
			assert.equal(sent.length, 0, "an unrelated exact run must not satisfy the subscription");

			writeStatus(asyncRoot, "run-exact", "complete", { sessionId: "session-a" });
			recordWaitCompletion(restoredState, "run-exact", {
				agent: "worker",
				state: "complete",
				success: true,
				results: [{ agent: "worker", success: true, output: "done" }],
			}, Date.now(), 60_000, { resultsDir, sessionId: "session-a" });
			restoredState.completedResults?.clear();
			bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-exact" });
			assert.equal(sent.length, 1);
			assert.match(String(sent[0]?.message.content), /run run-exact: completed/);
			assert.match(String(sent[0]?.message.content), /Completion archive:/);
			assert.equal(sent[0]?.message.details?.completions?.[0]?.runId, "run-exact");
			assert.ok(sent[0]?.message.details?.completions?.[0]?.archivePath);
			assert.equal(sent[0]?.options?.triggerTurn, true);
			assert.equal(restoredState.waitSubscriptions?.has(registration.token), false);
			assert.equal(fs.existsSync(path.join(subscriptionsDir, `${registration.token}.json`)), false);
			restored.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps subscriptions active across a session restart", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-restart-"));
		const asyncRoot = path.join(root, "runs");
		const subscriptionsDir = path.join(root, "subscriptions");
		const bus = new TestBus();
		const sent: string[] = [];
		const state = makeState();
		const manager = createWaitSubscriptionManager({
			events: bus,
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		} as never, state, { asyncDirRoot: asyncRoot, subscriptionsDir, pollIntervalMs: 60_000, kill: () => true });
		try {
			writeStatus(asyncRoot, "run-restart", "running", { sessionId: "session-a", pid: 999_999 });
			const registration = manager.arm({ targetKind: "async", runId: "run-restart", requestedId: "run-restart", timeoutMs: 30_000 });

			state.currentSessionId = null;
			manager.restore();
			state.currentSessionId = "session-a";
			writeStatus(asyncRoot, "run-restart", "complete", { sessionId: "session-a" });
			manager.restore();

			assert.match(sent[0] ?? "", /run run-restart: completed/);
			assert.equal(state.waitSubscriptions?.has(registration.token), false);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tells the parent to revive the failed child before replacing resumable async runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-revive-first-"));
		const asyncRoot = path.join(root, "runs");
		const subscriptionsDir = path.join(root, "subscriptions");
		const completedSessionFile = path.join(root, "completed-session.jsonl");
		const failedSessionFile = path.join(root, "failed-session.jsonl");
		const sent: string[] = [];
		const state = makeState();
		const manager = createWaitSubscriptionManager({
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		} as never, state, { asyncDirRoot: asyncRoot, subscriptionsDir, pollIntervalMs: 60_000, kill: () => true });
		try {
			fs.writeFileSync(completedSessionFile, "{}\n", "utf-8");
			fs.writeFileSync(failedSessionFile, "{}\n", "utf-8");
			writeStatus(asyncRoot, "run-revive", "running", { sessionId: "session-a", pid: 999_999 });
			manager.arm({ targetKind: "async", runId: "run-revive", requestedId: "run-revive", timeoutMs: 30_000 });

			writeStatus(asyncRoot, "run-revive", "failed", {
				sessionId: "session-a",
				steps: [
					{ agent: "first", status: "complete", sessionFile: completedSessionFile },
					{ agent: "second", status: "failed", sessionFile: failedSessionFile },
				],
			});
			manager.reconcile();

			const message = sent[0] ?? "";
			assert.match(message, /Resume-first/);
			assert.match(message, /subagent\(\{ action: "resume", id: "run-revive", index: 1, message:/);
			assert.match(message, /before reporting failure or launching a replacement/);
			assert.match(message, /only if revive fails or the user explicitly asks/);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits for foreground run restoration before reconciling a restored subscription", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-foreground-restore-"));
		const subscriptionsDir = path.join(root, "subscriptions");
		const bus = new TestBus();
		const sent: string[] = [];
		const firstState = makeState();
		firstState.foregroundRuns = new Map([["run-foreground", {
			runId: "run-foreground",
			mode: "single",
			cwd: root,
			sessionId: "session-a",
			updatedAt: Date.now(),
			children: [{ agent: "worker", index: 0, status: "detached" }],
		}]]);
		const pi = {
			events: bus,
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		};
		const first = createWaitSubscriptionManager(pi as never, firstState, { subscriptionsDir, pollIntervalMs: 60_000 });
		try {
			const registration = first.arm({ targetKind: "foreground", runId: "run-foreground", requestedId: "run-foreground", timeoutMs: 30_000 });
			first.dispose();

			const restoredState = makeState();
			restoredState.foregroundRuns = new Map();
			const restored = createWaitSubscriptionManager(pi as never, restoredState, { subscriptionsDir, pollIntervalMs: 60_000 });
			try {
				restored.restore();
				assert.equal(sent.length, 0);
				assert.equal(restoredState.waitSubscriptions?.has(registration.token), true);

				restoredState.foregroundRuns = new Map([["run-foreground", {
					runId: "run-foreground",
					mode: "single",
					cwd: root,
					sessionId: "session-a",
					updatedAt: Date.now(),
					children: [],
				}]]);
				restored.reconcile();
				assert.match(sent[0] ?? "", /run run-foreground: completed/);
				assert.equal(restoredState.waitSubscriptions?.has(registration.token), false);
			} finally {
				restored.dispose();
			}
		} finally {
			first.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("settles a missing live foreground run as unreconcilable", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-foreground-missing-"));
		const state = makeState();
		state.foregroundRuns = new Map();
		const sent: string[] = [];
		const manager = createWaitSubscriptionManager({
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		} as never, state, { subscriptionsDir: path.join(root, "subscriptions"), pollIntervalMs: 60_000 });
		try {
			manager.arm({ targetKind: "foreground", runId: "run-missing", requestedId: "run-missing", timeoutMs: 30_000 });
			manager.reconcile();
			assert.match(sent[0] ?? "", /could not be reconciled/);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a subscription armed when cleanup fails before delivery", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-cleanup-failure-"));
		const asyncRoot = path.join(root, "runs");
		const subscriptionsDir = path.join(root, "subscriptions");
		const sent: string[] = [];
		const state = makeState();
		const manager = createWaitSubscriptionManager({
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		} as never, state, { asyncDirRoot: asyncRoot, subscriptionsDir, pollIntervalMs: 60_000 });
		try {
			const registration = manager.arm({ targetKind: "async", runId: "run-missing", requestedId: "run-missing", timeoutMs: 30_000 });
			const file = path.join(subscriptionsDir, `${registration.token}.json`);
			fs.unlinkSync(file);
			fs.mkdirSync(file);

			manager.reconcile();
			assert.equal(sent.length, 0);
			assert.equal(state.waitSubscriptions?.has(registration.token), true);

			fs.rmdirSync(file);
			manager.reconcile();
			assert.match(sent[0] ?? "", /could not be reconciled/);
			assert.equal(sent.length, 1);
			assert.equal(state.waitSubscriptions?.has(registration.token), false);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes when async reconciliation throws", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-reconcile-error-"));
		const asyncRoot = path.join(root, "not-a-directory");
		const subscriptionsDir = path.join(root, "subscriptions");
		const bus = new TestBus();
		const sent: string[] = [];
		const state = makeState();
		fs.writeFileSync(asyncRoot, "not a directory", "utf-8");
		const manager = createWaitSubscriptionManager({
			events: bus,
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		} as never, state, { asyncDirRoot: asyncRoot, subscriptionsDir, pollIntervalMs: 60_000 });
		try {
			const registration = manager.arm({ targetKind: "async", runId: "run-error", requestedId: "run-error", timeoutMs: 30_000 });
			manager.reconcile();
			assert.match(sent[0] ?? "", /reconciliation failed/);
			assert.equal(state.waitSubscriptions?.has(registration.token), false);
			assert.equal(fs.existsSync(path.join(subscriptionsDir, `${registration.token}.json`)), false);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes for attention and timeout without treating subscriptions as child work", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-outcomes-"));
		const asyncRoot = path.join(root, "runs");
		const resultsDir = path.join(root, "results");
		const subscriptionsDir = path.join(root, "subscriptions");
		const bus = new TestBus();
		const sent: string[] = [];
		let now = 1_000;
		const state = makeState();
		const manager = createWaitSubscriptionManager({
			events: bus,
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		} as never, state, { asyncDirRoot: asyncRoot, resultsDir, subscriptionsDir, pollIntervalMs: 60_000, now: () => now, kill: () => true });
		try {
			writeStatus(asyncRoot, "run-attention", "running", { sessionId: "session-a", pid: 999_999 });
			manager.arm({ targetKind: "async", runId: "run-attention", requestedId: "run-attention", timeoutMs: 5_000 });
			writeStatus(asyncRoot, "run-attention", "running", {
				sessionId: "session-a",
				pid: 999_999,
				activityState: "needs_attention",
				steps: [{ agent: "worker", status: "running", activityState: "needs_attention" }],
			});
			manager.reconcile();
			assert.match(sent.shift() ?? "", /needs attention/);

			writeStatus(asyncRoot, "run-timeout", "running", { sessionId: "session-a", pid: 999_998 });
			manager.arm({ targetKind: "async", runId: "run-timeout", requestedId: "run-timeout", timeoutMs: 100 });
			now = 1_101;
			manager.reconcile();
			assert.match(sent.shift() ?? "", /timed out/);
			assert.equal(state.asyncJobs.size, 0);
			assert.equal(state.waitSubscriptions?.size, 0);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
