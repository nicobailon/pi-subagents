import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../src/shared/types.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { makeAgent } from "../support/helpers.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, executeAsyncSingle, executeAsyncChain,
	ASYNC_DIR, RESULTS_DIR, tempDir, mockPi,
} from "../support/async-execution-fixture.ts";

function fileBarrier(file: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// libuv on Windows compares long event paths against this watch path; expand TEMP's 8.3 aliases.
		const watcher = fs.watch(fs.realpathSync.native(path.dirname(file)), check);
		const deadline = setTimeout(() => { watcher.close(); reject(new Error(`Missing barrier: ${file}`)); }, 15_000);
		function check() {
			if (!fs.existsSync(file)) return;
			clearTimeout(deadline);
			watcher.close();
			resolve();
		}
		check();
	});
}

function publicationState(sessionId: string, owner: string): SubagentState {
	return {
		baseCwd: tempDir, currentSessionId: sessionId, completionOwnerId: owner,
		asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
		watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	};
}

describe("native runner result publication", { skip: !available ? "pi packages unavailable" : undefined }, () => {
	installAsyncExecutionHooks();
	it("renews Darwin delivery after early native failure and deferred indexed publication", { timeout: 15_000, skip: !isAsyncAvailable() ? "jiti unavailable" : undefined }, async (t) => {
		const root = path.join(tempDir, "early-terminal-barriers");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "early-terminal"), "");
		const id = "early-terminal-publication";
		const sessionId = "publication-session";
		const owner = "publication-owner";
		const asyncDir = path.join(ASYNC_DIR, id);
		const state = publicationState(sessionId, owner);
		let delivered = 0;
		let terminalRefreshes = 0;
		let demandTick: (() => void) | undefined;
		let trackerTick!: () => void;
		let complete!: () => void;
		const completion = new Promise<void>((resolve) => { complete = resolve; });
		const pi = { events: { on: () => () => {}, emit(event: string) {
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) complete();
		} }, sendMessage() { delivered++; } };
		const notifier = registerSubagentNotify(pi, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, RESULTS_DIR, 60_000, {
			platform: "darwin", coalesceDelayMs: 0, notifier,
			// index.ts wiring: no foreground controls, scheduled observations or missions in this fixture.
			hasDeliveryDemand: () => [...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running") || state.foregroundControls.size > 0,
			timers: {
				setTimeout, clearTimeout,
				setInterval: ((handler: () => void, delay: number) => {
					assert.equal(delay, 3000);
					demandTick = handler;
					return { unref() {} } as ReturnType<typeof setInterval>;
				}) as typeof setInterval,
				clearInterval: (() => { demandTick = undefined; }) as typeof clearInterval,
			},
		});
		const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR, {
			platform: "darwin", resultsDir: RESULTS_DIR, widgetEnabled: false,
			pollIntervalMs: 0, completionRetentionMs: 60_000,
			onJobTerminal: () => { terminalRefreshes++; watcher.refreshResultDelivery(); },
		});
		const oldOptions = process.env.NODE_OPTIONS;
		const oldRoot = process.env.RESULT_PUBLICATION_TEST_ROOT;
		try {
			process.env.NODE_OPTIONS = `${oldOptions ?? ""} --import=${new URL("../support/result-publication-capacity-preload.mjs", import.meta.url).href}`;
			process.env.RESULT_PUBLICATION_TEST_ROOT = root;
			mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "a.ts" }, { path: "b.ts" }] } });
			const receipt = executeAsyncChain(id, {
				chain: [
					{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", maxItems: 2 },
						parallel: { agent: "reviewer", task: "Review {target.path}", output: "shared.md" },
						collect: { as: "reviews" }, concurrency: 2,
					},
				],
				agents: [makeAgent("producer", { completionGuard: false }), makeAgent("reviewer", { completionGuard: false })],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: sessionId, completionOwnerId: owner },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, maxSubagentDepth: 2, acceptance: false,
			});
			assert.notEqual(receipt.isError, true);
			// Capture only the real tracker's liveness callback; execute it at explicit filesystem boundaries.
			const intervalMock = t.mock.method(globalThis, "setInterval", ((handler: () => void) => {
				trackerTick = handler;
				return { unref() {} } as ReturnType<typeof setInterval>;
			}) as typeof setInterval);
			tracker.handleStarted({ id, asyncDir, sessionId, completionOwnerId: owner, mode: "chain" });
			intervalMock.mock.restore();
			watcher.startResultWatcher();
			await fileBarrier(path.join(root, "blocked.json"));
			await fileBarrier(path.join(root, "terminal.json"));
			const early = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
			assert.equal(early.state, "failed", "early failure remains visible while publication is blocked");
			assert.match(early.error, /materialized 2 items that resolve output to the same path/);
			trackerTick();
			assert.equal(state.asyncJobs.get(id)?.status, "failed");
			assert.equal(terminalRefreshes, 1);
			assert.equal(state.cleanupTimers.has(id), false, "retain the early terminal publisher beyond display retention");
			assert.ok(demandTick);
			demandTick(); // Real Darwin scan-before-stop callback, not elapsed silence.
			assert.equal(demandTick, undefined);
			assert.equal(delivered, 0);
			assert.equal(fs.existsSync(path.join(RESULTS_DIR, "result-index", "sessions", sessionId, `${id}.json`)), false);
			fs.writeFileSync(path.join(root, "release"), "");
			await fileBarrier(path.join(root, "drained.json"));
			const index = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, "result-index", "sessions", sessionId, `${id}.json`), "utf8"));
			assert.equal(index.runId, id, "deferred publication committed its session index");
			const publicPath = path.join(RESULTS_DIR, `${id}.json`);
			const publishedPath = fs.existsSync(publicPath) ? publicPath : path.join(RESULTS_DIR, "result-pending", sessionId, `${id}.json`);
			const published = JSON.parse(fs.readFileSync(publishedPath, "utf8"));
			assert.equal(published.completionOwnerId, owner);
			assert.equal(published.success, false);
			assert.equal(mockPi.callCount(), 1, "dynamic failure occurs before reviewer children start");
			trackerTick(); // Final failed-to-failed refresh through the actual tracker.
			assert.equal(state.asyncJobs.get(id)?.status, "failed");
			assert.equal(terminalRefreshes, 2, "settled publication renews delivery exactly once");
			await completion;
			assert.equal(delivered, 1, "actual notifier send, without an injected result refresh");
			trackerTick();
			assert.equal(terminalRefreshes, 2);
			assert.equal(state.cleanupTimers.has(id), true, "settlement retires the publication obligation");
			assert.equal(state.watcher, null, "Darwin has no native result watcher");
			assert.equal(demandTick, undefined);
			assert.equal(state.watcherRestartTimer, null);
		} finally {
			fs.writeFileSync(path.join(root, "release"), "");
			tracker.resetJobs();
			watcher.stopResultWatcher();
			notifier.dispose();
			if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
			if (oldRoot === undefined) delete process.env.RESULT_PUBLICATION_TEST_ROOT; else process.env.RESULT_PUBLICATION_TEST_ROOT = oldRoot;
		}
	});
	for (const terminal of ["failed", "stopped"] as const) {
		it(`keeps consumed ${terminal} publication settled before the first terminal refresh`, (t) => {
			const id = `consumed-${terminal}`;
			const asyncDir = path.join(ASYNC_DIR, id);
			fs.mkdirSync(asyncDir, { recursive: true });
			const state = publicationState("session", "owner");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: id, sessionId: "session", completionOwnerId: "owner", mode: "single",
				state: terminal, startedAt: Date.now(), steps: [],
				processTerminal: { version: 1, state: "pending", runId: id, runnerProcessInstanceId: "instance" },
			}));
			let tick!: () => void;
			let refreshes = 0;
			const tracker = createAsyncJobTracker({ events: { emit() {} } }, state, ASYNC_DIR, {
				platform: "darwin", widgetEnabled: false, resultsDir: RESULTS_DIR, pollIntervalMs: 0,
				onJobTerminal: () => { refreshes++; },
			});
			const interval = t.mock.method(globalThis, "setInterval", ((handler: () => void) => {
				tick = handler;
				return { unref() {} } as ReturnType<typeof setInterval>;
			}) as typeof setInterval);
			try {
				tracker.handleStarted({ id, asyncDir, sessionId: "session", completionOwnerId: "owner" });
				interval.mock.restore();
				// The result watcher has consumed the payload before status polling.
				tracker.handleComplete({ id, sessionId: "session", state: terminal, success: false });
				const cleanup = state.cleanupTimers.get(id);
				assert.ok(cleanup);
				tick();
				tick();
				assert.equal(state.asyncJobs.get(id)?.status, terminal);
				assert.equal(state.cleanupTimers.get(id), cleanup, "consumed publication must not reopen or replace cleanup");
				assert.equal(refreshes, 0, "consumed publication needs no delivery renewal");
			} finally {
				tracker.resetJobs();
			}
		});
		it(`retires an early ${terminal} publisher on identity-proven close or reset`, (t) => {
			const id = `closed-${terminal}`;
			const asyncDir = path.join(ASYNC_DIR, id);
			fs.mkdirSync(asyncDir);
			const state = publicationState("session", "owner");
			const proof = { version: 1, state: "pending", runId: id, runnerProcessInstanceId: "instance" };
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: id, sessionId: "session", completionOwnerId: "owner", mode: "single",
				state: terminal, startedAt: Date.now(), steps: [], processTerminal: proof,
			}));
			let tick!: () => void;
			let refreshes = 0;
			const tracker = createAsyncJobTracker({ events: { emit() {} } }, state, ASYNC_DIR, {
				platform: "darwin", widgetEnabled: false, resultsDir: RESULTS_DIR, pollIntervalMs: 0,
				onJobTerminal: () => { refreshes++; },
			});
			const interval = t.mock.method(globalThis, "setInterval", ((handler: () => void) => {
				tick = handler;
				return { unref() {} } as ReturnType<typeof setInterval>;
			}) as typeof setInterval);
			try {
				tracker.handleStarted({ id, asyncDir, sessionId: "session", completionOwnerId: "owner" });
				interval.mock.restore();
				tick();
				assert.equal(state.asyncJobs.get(id)?.status, terminal);
				assert.equal(state.cleanupTimers.has(id), false);
				const closed = { ...proof, state: "observed", observedAt: Date.now(), instances: [{
					kind: "runner", processInstanceId: "instance", closeObservedAt: Date.now(), exitCode: 1, signal: null,
				}] };
				fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify({ ...closed, runnerProcessInstanceId: "other" }));
				tick();
				assert.equal(state.cleanupTimers.has(id), false, "foreign/unknown process proof cannot discharge publication");
				assert.equal(refreshes, 1);
				if (terminal === "failed") {
					fs.writeFileSync(path.join(asyncDir, "process-terminal.json"), JSON.stringify(closed));
					tick();
					assert.equal(state.cleanupTimers.has(id), true, "definitive publisher failure needs no further observation");
					assert.equal(refreshes, 2, "close supplies a final scan for publication racing the proof read");
					tick();
					assert.equal(refreshes, 2);
				}
			} finally {
				tracker.resetJobs();
			}
			assert.equal(state.poller, null);
			assert.equal(state.asyncJobs.size, 0);
			assert.equal(state.cleanupTimers.size, 0);
		});
	}
	it("watches the canonical barrier directory through a path alias", async (t) => {
		const directory = path.join(tempDir, "barrier-directory");
		const alias = path.join(tempDir, "barrier-alias");
		fs.mkdirSync(directory);
		fs.symlinkSync(directory, alias, "junction");
		const watch = fs.watch;
		t.mock.method(fs, "watch", ((watched, ...args) => {
			assert.equal(watched, fs.realpathSync.native(directory));
			return Reflect.apply(watch, fs, [watched, ...args]);
		}) as typeof fs.watch);
		const file = path.join(alias, "ready");
		const ready = fileBarrier(file);
		fs.writeFileSync(file, "");
		await ready;
	});
	for (const outcome of ["recovered", "retry-error"] as const) {
		it(`keeps Darwin delivery demand until deferred indexed final result publication settles (${outcome})`, { skip: !isAsyncAvailable() ? "jiti unavailable" : undefined }, async () => {
			const root = path.join(tempDir, "publication-barriers");
			fs.mkdirSync(root);
			if (outcome === "retry-error") fs.writeFileSync(path.join(root, "fail-on-recovery"), "");
			const id = "publication-capacity";
			const sessionId = "publication-session";
			const owner = "publication-owner";
			const asyncDir = path.join(ASYNC_DIR, id);
			const resultPath = path.join(RESULTS_DIR, `${id}.json`);
			const state = publicationState(sessionId, owner);
			let poll: ReturnType<typeof setInterval> | undefined;
			let delivered = 0;
			let complete!: () => void;
			let deliveryDeadline: ReturnType<typeof setTimeout> | undefined;
			const completion = new Promise<void>((resolve) => { complete = resolve; });
			const pi = {
				events: { on: () => () => {}, emit(event: string, data: unknown) {
					if (event !== SUBAGENT_ASYNC_COMPLETE_EVENT) return;
					assert.equal((data as { completionOwnerId?: string }).completionOwnerId, owner);
					complete();
				} },
				sendMessage() { delivered++; },
			};
			const notifier = registerSubagentNotify(pi, state, { batchConfig: { enabled: false } });
			const watcher = createResultWatcher(pi, state, RESULTS_DIR, 60_000, {
				platform: "darwin", coalesceDelayMs: 0,
				hasDeliveryDemand: () => {
					const statusPath = path.join(asyncDir, "status.json");
					if (!fs.existsSync(statusPath)) return true;
					const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
					return status.state === "running" || status.state === "queued";
				},
				notifier,
				timers: {
					setTimeout, clearTimeout,
					setInterval: ((handler: () => void, delay: number) => {
						assert.equal(delay, 3000);
						poll = setInterval(() => {
							handler();
							if (fs.existsSync(path.join(root, "blocked.json"))) fs.writeFileSync(path.join(root, "polled"), "");
						}, delay);
						return poll;
					}) as typeof setInterval,
					clearInterval: ((handle: ReturnType<typeof setInterval>) => { clearInterval(handle); poll = undefined; }) as typeof clearInterval,
				},
			});
			const oldOptions = process.env.NODE_OPTIONS;
			const oldRoot = process.env.RESULT_PUBLICATION_TEST_ROOT;
			try {
				process.env.NODE_OPTIONS = `${oldOptions ?? ""} --import=${new URL("../support/result-publication-capacity-preload.mjs", import.meta.url).href}`;
				process.env.RESULT_PUBLICATION_TEST_ROOT = root;
				mockPi.onCall({ output: "Indexed completion after capacity recovery" });
				const receipt = executeAsyncSingle(id, {
					agent: "worker", task: "Complete without a provider", agentConfig: makeAgent("worker", { completionGuard: false }),
					ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: sessionId, completionOwnerId: owner },
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2, acceptance: false,
				});
				assert.notEqual(receipt.isError, true);
				watcher.startResultWatcher();
				await fileBarrier(path.join(root, "blocked.json"));
				const blocked = JSON.parse(fs.readFileSync(path.join(root, "blocked.json"), "utf8"));
				assert.equal(blocked.statusDeferred, true, "exercise an older deferred status write too");
				await fileBarrier(path.join(root, "polled")); // A real demand-interval tick while capacity is held.
				assert.equal(blocked.state, "running", "terminal status must not precede indexed final result publication");
				assert.equal(blocked.active, true, "older status retry must not remove the active index");
				const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
				assert.ok(events.some((event) => event.type === "subagent.steer.failed" && event.requestId === "publication-steer"), "exercise incidental status writing during finalization");
				assert.ok(poll, "the demand interval must remain installed before recovery");
				assert.equal(fs.existsSync(resultPath), false);
				assert.equal(delivered, 0);
				fs.writeFileSync(path.join(root, "release"), "");
				await fileBarrier(path.join(root, "terminal.json"));
				const terminal = JSON.parse(fs.readFileSync(path.join(root, "terminal.json"), "utf8"));
				assert.equal(terminal.state, outcome === "recovered" ? "complete" : "failed");
				if (outcome === "retry-error") assert.match(terminal.error, /injected non-capacity publication failure/);
				const publishedPath = outcome === "recovered" ? resultPath : path.join(RESULTS_DIR, "result-pending", sessionId, `${id}.json`);
				// An automatic tick may already have accepted and cleaned the indexed result.
				assert.ok(fs.existsSync(publishedPath) || delivered === 1, "terminal result must be published or already delivered");
				if (fs.existsSync(publishedPath)) assert.equal(JSON.parse(fs.readFileSync(publishedPath, "utf8")).completionOwnerId, owner);
				await Promise.race([completion, new Promise((_, reject) => {
					deliveryDeadline = setTimeout(() => reject(new Error("completion not delivered")), 5000);
				})]);
				clearTimeout(deliveryDeadline);
				assert.equal(delivered, 1);
				assert.equal(fs.existsSync(resultPath), false);
				assert.equal(poll, undefined);
				assert.equal(state.watcherRestartTimer, null);
				await fileBarrier(path.join(asyncDir, "process-terminal-candidate.json"));
			} finally {
				clearTimeout(deliveryDeadline);
				fs.writeFileSync(path.join(root, "release"), "");
				watcher.stopResultWatcher();
				notifier.dispose();
				if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
				if (oldRoot === undefined) delete process.env.RESULT_PUBLICATION_TEST_ROOT; else process.env.RESULT_PUBLICATION_TEST_ROOT = oldRoot;
			}
		});
	}
});
