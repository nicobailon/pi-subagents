import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { waitForSubagents } from "../../src/runs/background/subagent-wait.ts";
import { registerWaitTool } from "../../src/runs/background/wait-tool.ts";
import { createWaitSubscriptionManager } from "../../src/runs/background/wait-subscriptions.ts";
import { recordWaitCompletion } from "../../src/runs/background/wait-completions.ts";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type IntercomEventBus, type SubagentState, type WaitSubscriptionRecord } from "../../src/shared/types.ts";
import { recoveryDescriptorPath } from "../../src/runs/shared/run-launch-folder.ts";
import { writeFileCreatingDir } from "../support/helpers.ts";

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

function writeRecoveryDescriptor(asyncRoot: string, runId: string, agent: string, sessionFile: string, cwd: string): void {
	writeFileCreatingDir(recoveryDescriptorPath(asyncRoot, runId), JSON.stringify({
		version: 1,
		sourceRunId: runId,
		agent,
		sessionFile,
		cwd,
		systemPromptMode: "append",
		outputMode: "inline",
		inheritGlobalContext: false,
		inheritProjectContext: false,
		inheritSkills: false,
		maxSubagentDepth: 0,
		share: false,
		runFanoutBudget: createRunFanoutBudget(runId, 64),
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

const DEAD_PID = 999_999;

function claimName(token: string, replacedOwnerId: string, generation: number): string {
	return `${token}.claim-${createHash("sha256").update(replacedOwnerId).digest("hex").slice(0, 16)}.${generation}`;
}

/** A session-a wait armed by "owner-a", whose process is dead; `open` starts another Pi process on the session. */
function deadOwnerFixture(prefix: string, now: () => number = Date.now) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const asyncRoot = path.join(root, "runs");
	const resultsDir = path.join(root, "results");
	const subscriptionsDir = path.join(root, "subscriptions");
	const sent: string[] = [];
	const managers: Array<{ dispose(): void }> = [];
	let deadPidReused = false;
	const open = (ownerId: string) => {
		const state = makeState();
		state.completionOwnerId = ownerId;
		const manager = createWaitSubscriptionManager({
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { sent.push(`${ownerId}: ${String(message.content)}`); },
		} as never, state, {
			asyncDirRoot: asyncRoot, resultsDir, subscriptionsDir, pollIntervalMs: 60_000, now,
			kill: (pid: number) => {
				if (pid === DEAD_PID && !deadPidReused) throw Object.assign(new Error("gone"), { code: "ESRCH" });
				return true;
			},
		});
		managers.push(manager);
		return { manager, state };
	};
	writeStatus(asyncRoot, "run-takeover", "running", { sessionId: "session-a", pid: process.pid });
	const armer = open("owner-a");
	const { token } = armer.manager.arm({ targetKind: "async", runId: "run-takeover", requestedId: "run-takeover", timeoutMs: 30_000 });
	armer.manager.dispose();
	const recordPath = path.join(subscriptionsDir, `${token}.json`);
	const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as WaitSubscriptionRecord;
	assert.equal(record.completionOwnerProcess?.pid, process.pid);
	fs.writeFileSync(recordPath, JSON.stringify({ ...record, completionOwnerProcess: { pid: DEAD_PID } }), "utf-8");
	return {
		subscriptionsDir, token, recordPath, sent, open,
		claimPath: (replacedOwnerId: string, generation: number) => path.join(subscriptionsDir, claimName(token, replacedOwnerId, generation)),
		recordOwner: () => (JSON.parse(fs.readFileSync(recordPath, "utf-8")) as WaitSubscriptionRecord).completionOwnerId,
		complete: () => writeStatus(asyncRoot, "run-takeover", "complete", { sessionId: "session-a" }),
		/** The OS hands the dead owner's pid to an unrelated live process. */
		reusePid: () => { deadPidReused = true; },
		dispose: () => {
			for (const manager of managers) manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
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
			const result = await waitForSubagents({ id: "run-alph", nonBlocking: true, timeoutMs: 5_000 }, undefined, {
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
			assert.deepEqual(armed, { targetKind: "async", runId: "run-alpha", requestedId: "run-alph", timeoutMs: 5_000 });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers bg_wait and rejects non-blocking subscriptions from headless tool calls", async () => {
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
			const registered: Array<{ name: string; description: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> }> = [];
			registerWaitTool({
				events: new TestBus(),
				on() {},
				registerTool(value: unknown) { registered.push(value as typeof registered[number]); },
			} as never, state, true, {
				arm() { throw new Error("headless calls must not arm subscriptions"); },
			});
			assert.deepEqual(registered.map((entry) => entry.name), ["bg_wait"]);
			await assert.rejects(
				registered[0]!.execute("wait", { id: "run-headless", nonBlocking: true }, undefined, undefined, { hasUI: false }),
				/long-lived interactive subagent runtime/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tells the root session that async runs wake it natively and a child to collect its descendants", () => {
		const descriptions: string[] = [];
		const pi = { events: new TestBus(), on() {}, registerTool(value: { description: string }) { descriptions.push(value.description); } } as never;
		registerWaitTool(pi, makeState(), true);
		registerWaitTool(pi, makeState(), true, undefined, undefined, { nestedRootRunId: "root" });
		assert.match(descriptions[0]!, /async subagent runs already wake this session natively/);
		assert.match(descriptions[1]!, /no native completion notifier: use blocking bg_wait to collect your owned descendants/);
	});

	it("ends a blocking bg_wait when the user sends a message while the agent is busy", async () => {
		const state = makeState();
		state.foregroundRuns = new Map([["run-live", {
			runId: "run-live",
			mode: "single",
			cwd: os.tmpdir(),
			sessionId: "session-a",
			updatedAt: Date.now(),
			children: [{ agent: "worker", index: 0, status: "detached" }],
		}]]);
		type WaitResult = { isError?: boolean; details: { wait?: { reason: string; activeRunIds: string[] } } };
		const registered: Array<{ execute: (...args: unknown[]) => Promise<WaitResult> }> = [];
		const inputHandlers: Array<(event: { source: string; streamingBehavior?: string }) => void> = [];
		const sendInput = (event: { source: string; streamingBehavior?: string }) => {
			for (const handler of inputHandlers) handler(event);
		};
		registerWaitTool({
			events: new TestBus(),
			on(event: string, handler: typeof inputHandlers[number]) { if (event === "input") inputHandlers.push(handler); },
			registerTool(value: unknown) { registered.push(value as typeof registered[number]); },
		} as never, state, true);

		const pending = registered[0]!.execute("wait", { id: "run-live", timeoutMs: 60_000 }, undefined, undefined, { hasUI: true });
		sendInput({ source: "extension", streamingBehavior: "steer" });
		sendInput({ source: "interactive" });
		const early = await Promise.race([pending.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), 300))]);
		assert.equal(early, "pending");

		sendInput({ source: "interactive", streamingBehavior: "steer" });
		const result = await pending;
		assert.equal(result.isError, undefined);
		assert.equal(result.details.wait?.reason, "user_input");
		assert.deepEqual(result.details.wait?.activeRunIds, ["run-live"]);
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
				runId: "run-exact",
				sessionId: "session-a",
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

	it("leaves a same-session subscription to the process that armed it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-shared-session-"));
		const asyncRoot = path.join(root, "runs");
		const resultsDir = path.join(root, "results");
		const subscriptionsDir = path.join(root, "subscriptions");
		const armed: string[] = [];
		const foreign: string[] = [];
		const armerState = makeState();
		armerState.completionOwnerId = "owner-a";
		const foreignState = makeState();
		foreignState.completionOwnerId = "owner-b";
		const armer = createWaitSubscriptionManager({
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { armed.push(String(message.content)); },
		} as never, armerState, { asyncDirRoot: asyncRoot, resultsDir, subscriptionsDir, pollIntervalMs: 60_000 });
		const other = createWaitSubscriptionManager({
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { foreign.push(String(message.content)); },
		} as never, foreignState, { asyncDirRoot: asyncRoot, resultsDir, subscriptionsDir, pollIntervalMs: 60_000 });
		try {
			writeStatus(asyncRoot, "run-shared", "running", { sessionId: "session-a", pid: 999_999 });
			const registration = armer.arm({ targetKind: "async", runId: "run-shared", requestedId: "run-shared", timeoutMs: 30_000 });

			// A second Pi process opens the same session on another branch while the armer is alive.
			other.restore();
			assert.equal(foreignState.waitSubscriptions?.size ?? 0, 0, "a live owner keeps its subscription private to its process");

			writeStatus(asyncRoot, "run-shared", "complete", { sessionId: "session-a" });
			other.restore();
			other.reconcile();
			assert.deepEqual(foreign, [], "the other process must not deliver the owner's completion wake");
			assert.equal(fs.existsSync(path.join(subscriptionsDir, `${registration.token}.json`)), true);

			armer.reconcile();
			assert.match(armed[0] ?? "", /run run-shared: completed/);
		} finally {
			armer.dispose();
			other.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("hands a dead owner's subscription to the first process that restores it, not to a later one", () => {
		const fixture = deadOwnerFixture("pi-wait-subscribe-shared-session-exit-");
		try {
			const next = fixture.open("owner-b");
			const other = fixture.open("owner-c");
			next.manager.restore();
			other.manager.restore();
			assert.equal(next.state.waitSubscriptions?.has(fixture.token), true);
			assert.equal(other.state.waitSubscriptions?.has(fixture.token) ?? false, false, "the live adopter keeps the subscription");
			assert.equal(fixture.recordOwner(), "owner-b");
			assert.deepEqual(fixture.sent, []);

			fixture.complete();
			other.manager.reconcile();
			assert.deepEqual(fixture.sent, []);
			next.manager.reconcile();

			assert.equal(fixture.sent.length, 1);
			assert.match(fixture.sent[0] ?? "", /^owner-b: .*run run-takeover: completed/s);
			assert.equal(next.state.waitSubscriptions?.has(fixture.token), false);
			assert.equal(other.state.waitSubscriptions?.has(fixture.token), false);
			assert.deepEqual(fs.readdirSync(fixture.subscriptionsDir), [], "settling removes the record and its claim");
		} finally {
			fixture.dispose();
		}
	});

	it("does not take a dead owner's subscription while its latest claimant is alive", () => {
		const fixture = deadOwnerFixture("pi-wait-subscribe-claimed-");
		try {
			const recordBytes = fs.readFileSync(fixture.recordPath, "utf-8");
			// "owner-b" is alive and has claimed the takeover from owner-a, but has not rewritten the record yet.
			const claimPath = fixture.claimPath("owner-a", 1);
			const claimBytes = JSON.stringify({ ownerId: "owner-b", process: { pid: process.pid } });
			fs.writeFileSync(claimPath, claimBytes, "utf-8");

			const later = fixture.open("owner-c");
			later.manager.restore();

			assert.equal(later.state.waitSubscriptions?.has(fixture.token), false);
			assert.equal(fs.readFileSync(fixture.recordPath, "utf-8"), recordBytes);
			assert.equal(fs.readFileSync(claimPath, "utf-8"), claimBytes);
			assert.deepEqual(fs.readdirSync(fixture.subscriptionsDir).sort(), [path.basename(claimPath), `${fixture.token}.json`].sort());
		} finally {
			fixture.dispose();
		}
	});

	it("takes over a dead owner's subscription when its latest claimant died before rewriting it", () => {
		const fixture = deadOwnerFixture("pi-wait-subscribe-dead-claimant-");
		try {
			fs.writeFileSync(fixture.claimPath("owner-a", 1), JSON.stringify({ ownerId: "owner-b", process: { pid: DEAD_PID } }), "utf-8");

			const later = fixture.open("owner-c");
			later.manager.restore();
			assert.equal(later.state.waitSubscriptions?.has(fixture.token), true);
			assert.equal(fixture.recordOwner(), "owner-c");
		} finally {
			fixture.dispose();
		}
	});

	it("releases the claim when a takeover cannot rewrite the record, so the next process takes over", (t) => {
		const fixture = deadOwnerFixture("pi-wait-subscribe-claim-write-failure-");
		try {
			const recordBytes = fs.readFileSync(fixture.recordPath, "utf-8");
			const failing = fixture.open("owner-b");
			const rename = fsDefault.renameSync;
			t.mock.method(fsDefault, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
				if (to === fixture.recordPath) throw Object.assign(new Error("injected write failure"), { code: "EIO" });
				return rename(from, to);
			});
			syncBuiltinESMExports();
			try {
				failing.manager.restore();
			} finally {
				t.mock.restoreAll();
				syncBuiltinESMExports();
			}
			assert.equal(failing.state.waitSubscriptions?.has(fixture.token), false);
			assert.equal(fs.readFileSync(fixture.recordPath, "utf-8"), recordBytes);
			assert.deepEqual(fs.readdirSync(fixture.subscriptionsDir), [`${fixture.token}.json`], "no claim is left behind");

			// owner-b is still alive; owner-c takes over.
			const later = fixture.open("owner-c");
			later.manager.restore();
			assert.equal(later.state.waitSubscriptions?.has(fixture.token), true);
			assert.equal(fixture.recordOwner(), "owner-c");
		} finally {
			fixture.dispose();
		}
	});

	it("does not recreate a settled subscription for a process that read it before the settle", (t) => {
		const fixture = deadOwnerFixture("pi-wait-subscribe-stale-claimer-");
		try {
			const staleBytes = fs.readFileSync(fixture.recordPath, "utf-8");
			const first = fixture.open("owner-b");
			first.manager.restore();
			fixture.complete();
			first.manager.reconcile();
			assert.equal(fixture.sent.length, 1);
			assert.deepEqual(fs.readdirSync(fixture.subscriptionsDir), []);

			// owner-c listed the directory and read the record before owner-b settled it:
			// it sees the old owner-a record until it has created a claim, then real reads.
			const readdir = fsDefault.readdirSync;
			const readFile = fsDefault.readFileSync;
			const recordFile = `${fixture.token}.json`;
			const claimed = () => readdir(fixture.subscriptionsDir).some((file) => file.startsWith(`${fixture.token}.claim-`));
			t.mock.method(fsDefault, "readdirSync", (dir: fs.PathLike, ...rest: unknown[]) => {
				const files = (readdir as (...args: unknown[]) => string[])(dir, ...rest);
				return dir === fixture.subscriptionsDir && !files.includes(recordFile) ? [...files, recordFile] : files;
			});
			t.mock.method(fsDefault, "readFileSync", (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => (
				file === fixture.recordPath && !claimed() ? staleBytes : (readFile as (...args: unknown[]) => unknown)(file, ...rest)
			));
			syncBuiltinESMExports();
			const later = fixture.open("owner-c");
			try {
				later.manager.restore();
			} finally {
				t.mock.restoreAll();
				syncBuiltinESMExports();
			}

			assert.equal(later.state.waitSubscriptions?.has(fixture.token), false);
			assert.deepEqual(fs.readdirSync(fixture.subscriptionsDir), [], "no record or claim reappears");
			later.manager.reconcile();
			assert.equal(fixture.sent.length, 1);
		} finally {
			fixture.dispose();
		}
	});

	it("keeps a subscription taken from a dead owner across a reload after that pid is reused", () => {
		let clock = Date.now();
		const fixture = deadOwnerFixture("pi-wait-subscribe-pid-reuse-", () => clock);
		try {
			const first = fixture.open("owner-b");
			first.manager.restore();
			assert.equal(first.state.waitSubscriptions?.has(fixture.token), true);

			// /reload builds a new manager with the same completion owner after the dead owner's pid was reused.
			fixture.reusePid();
			first.manager.dispose();
			const reloaded = fixture.open("owner-b");
			reloaded.manager.restore();
			assert.equal(reloaded.state.waitSubscriptions?.has(fixture.token), true, "the reloaded process still owns the subscription");
			clock += 60_000;
			reloaded.manager.reconcile();

			assert.match(fixture.sent[0] ?? "", /^owner-b: .*timed out/s);
			assert.deepEqual(fs.readdirSync(fixture.subscriptionsDir), []);
		} finally {
			fixture.dispose();
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
			writeRecoveryDescriptor(asyncRoot, "run-revive", "second", failedSessionFile, root);
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
			assert.match(message, /subagent\(\{ action: "resume", id: "run-revive", message: "[^"]*", options: \{ index: 1 \} \}\)/);
			assert.match(message, /before reporting failure or launching a replacement/);
			assert.match(message, /only if revive fails or the user explicitly asks/);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tells the parent to reply and wait for an intercom-detached failed async run", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-intercom-detach-"));
		const asyncRoot = path.join(root, "runs");
		const subscriptionsDir = path.join(root, "subscriptions");
		const sessionFile = path.join(root, "worker-session.jsonl");
		const sent: string[] = [];
		const state = makeState();
		const manager = createWaitSubscriptionManager({
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		} as never, state, { asyncDirRoot: asyncRoot, subscriptionsDir, pollIntervalMs: 60_000, kill: () => true });
		try {
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			writeStatus(asyncRoot, "run-detached", "running", { sessionId: "session-a", pid: 999_999 });
			manager.arm({ targetKind: "async", runId: "run-detached", requestedId: "run-detached", timeoutMs: 30_000 });

			writeStatus(asyncRoot, "run-detached", "failed", {
				sessionId: "session-a",
				error: "Step failed: worker",
				steps: [{ agent: "worker", status: "failed", sessionFile, error: "Detached for intercom coordination before task completion." }],
			});
			manager.reconcile();

			const message = sent[0] ?? "";
			assert.match(message, /Reply to the supervisor request first/);
			assert.match(message, /wait with bg_wait/);
			assert.match(message, /do not resume or launch a replacement/);
			assert.doesNotMatch(message, /Resume-first/);
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

			// settle() only delivers from the process that removes the record, so put the record
			// back before the retry. Losing the race means another process already delivered it.
			fs.rmdirSync(file);
			fs.writeFileSync(file, JSON.stringify(registration), "utf-8");
			manager.reconcile();
			assert.match(sent[0] ?? "", /could not be reconciled/);
			assert.equal(sent.length, 1);
			assert.equal(state.waitSubscriptions?.has(registration.token), false);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes when an exact async run cannot be reconciled", () => {
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
			assert.match(sent[0] ?? "", /could not be reconciled/);
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
			assert.match(sent.shift() ?? "", /timed out[\s\S]*Parent action: Check the run status/, "a wait with no saved results points at the run status");
			assert.equal(state.asyncJobs.size, 0);
			assert.equal(state.waitSubscriptions?.size, 0);
		} finally {
			manager.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("wait subscriptions armed by another session", () => {
	function subscriptionFiles(dir: string): string[] {
		try {
			return fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
		} catch {
			return [];
		}
	}

	it("sweeps an expired record whose owning session never came back", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-orphan-"));
		const subscriptionsDir = path.join(root, "subscriptions");
		const sent: string[] = [];
		const pi = {
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		};
		let now = 1_000;
		const owner = makeState("session-a");
		const armer = createWaitSubscriptionManager(pi as never, owner, {
			subscriptionsDir,
			pollIntervalMs: 60_000,
			now: () => now,
		});
		try {
			const { token } = armer.arm({ targetKind: "async", runId: "run-orphan", requestedId: "run-orphan", timeoutMs: 100 });
			assert.equal(subscriptionFiles(subscriptionsDir).length, 1);
			armer.dispose();
			// A takeover claim and the temp file of a claim create that crashed.
			const claim = path.join(subscriptionsDir, claimName(token, "owner-x", 1));
			fs.writeFileSync(claim, JSON.stringify({ ownerId: "owner-y", process: { pid: DEAD_PID } }), "utf-8");
			fs.writeFileSync(`${claim}.123.abc.tmp`, "", "utf-8");

			// A different session starts well after the record expired.
			now = 1_101 + 86400000;
			const other = makeState("session-b");
			const restarted = createWaitSubscriptionManager(pi as never, other, {
				subscriptionsDir,
				pollIntervalMs: 60_000,
				now: () => now,
			});
			try {
				restarted.restore();
				assert.deepEqual(fs.readdirSync(subscriptionsDir), [], "expired foreign record and its claims are removed");
				assert.equal(sent.length, 0, "no wake is delivered to the wrong session");
			} finally {
				restarted.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps another session's record until it expires", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-foreign-live-"));
		const subscriptionsDir = path.join(root, "subscriptions");
		const pi = {
			events: new TestBus(),
			sendMessage() {},
		};
		let now = 1_000;
		const owner = makeState("session-a");
		const armer = createWaitSubscriptionManager(pi as never, owner, {
			subscriptionsDir,
			pollIntervalMs: 60_000,
			now: () => now,
		});
		try {
			armer.arm({ targetKind: "async", runId: "run-live", requestedId: "run-live", timeoutMs: 10_000 });
			armer.dispose();

			now = 1_500; // still well inside the window
			const other = makeState("session-b");
			const restarted = createWaitSubscriptionManager(pi as never, other, {
				subscriptionsDir,
				pollIntervalMs: 60_000,
				now: () => now,
			});
			try {
				restarted.restore();
				assert.equal(subscriptionFiles(subscriptionsDir).length, 1, "an unexpired record still belongs to its owner");
			} finally {
				restarted.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("sweeps a foreign record that expires while another session stays open", () => {
		// restore() only fires on session_start and reconcile() walks the in-memory
		// map, which holds current-session records only. A record that is still live
		// when the next session starts is therefore retained by restore() and, without
		// a periodic sweep, never looked at again once it expires.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-late-expiry-"));
		const subscriptionsDir = path.join(root, "subscriptions");
		const pi = {
			events: new TestBus(),
			sendMessage() {},
		};
		let now = 1_000;
		const armer = createWaitSubscriptionManager(pi as never, makeState("session-a"), {
			subscriptionsDir,
			pollIntervalMs: 60_000,
			now: () => now,
		});
		try {
			armer.arm({ targetKind: "async", runId: "run-late", requestedId: "run-late", timeoutMs: 30_000 });
			armer.dispose();

			const other = makeState("session-b");
			const open = createWaitSubscriptionManager(pi as never, other, {
				subscriptionsDir,
				pollIntervalMs: 60_000,
				now: () => now,
			});
			try {
				open.restore();
				assert.equal(subscriptionFiles(subscriptionsDir).length, 1, "still live, so retained");

				// The other session stays open past the record's expiry and grace.
				now = 1_000 + 30_000 + 86400000 + 120_000;
				open.reconcile();
				assert.deepEqual(subscriptionFiles(subscriptionsDir), [], "expired record is swept without a restart");
			} finally {
				open.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps an expired foreign record through the grace window", () => {
		// The owner settles its own expired records with a timeout notice on its next
		// restore(). Sweeping the instant it expires would take that away from a
		// session that had simply not resumed yet.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-grace-"));
		const subscriptionsDir = path.join(root, "subscriptions");
		const pi = { events: new TestBus(), sendMessage() {} };
		let now = 1_000;
		const armer = createWaitSubscriptionManager(pi as never, makeState("session-a"), {
			subscriptionsDir,
			pollIntervalMs: 60_000,
			now: () => now,
		});
		try {
			armer.arm({ targetKind: "async", runId: "run-grace", requestedId: "run-grace", timeoutMs: 100 });
			armer.dispose();

			now = 1_101 + 60_000; // expired, but well inside the grace window
			const other = createWaitSubscriptionManager(pi as never, makeState("session-b"), {
				subscriptionsDir,
				pollIntervalMs: 60_000,
				now: () => now,
			});
			try {
				other.restore();
				assert.equal(subscriptionFiles(subscriptionsDir).length, 1, "owner can still collect its timeout notice");
			} finally {
				other.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still gives the owning session its timeout notice after a restart", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-subscribe-owner-timeout-"));
		const asyncRoot = path.join(root, "runs");
		const subscriptionsDir = path.join(root, "subscriptions");
		const sent: string[] = [];
		const pi = {
			events: new TestBus(),
			sendMessage(message: { content?: unknown }) { sent.push(String(message.content)); },
		};
		let now = 1_000;
		writeStatus(asyncRoot, "run-owned", "running", { sessionId: "session-a", pid: 999_997 });
		const first = createWaitSubscriptionManager(pi as never, makeState("session-a"), {
			asyncDirRoot: asyncRoot,
			subscriptionsDir,
			pollIntervalMs: 60_000,
			now: () => now,
			kill: () => true,
		});
		try {
			first.arm({ targetKind: "async", runId: "run-owned", requestedId: "run-owned", timeoutMs: 100 });
			first.dispose();

			now = 1_101; // expired, but this session owns it
			const resumed = createWaitSubscriptionManager(pi as never, makeState("session-a"), {
				asyncDirRoot: asyncRoot,
				subscriptionsDir,
				pollIntervalMs: 60_000,
				now: () => now,
				kill: () => true,
			});
			try {
				resumed.restore();
				assert.match(sent.shift() ?? "", /timed out/, "the owner is still told its wait expired");
				assert.deepEqual(subscriptionFiles(subscriptionsDir), []);
			} finally {
				resumed.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
