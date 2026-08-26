import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey } from "../../src/runs/background/completion-dedupe.ts";
import { createResultWatcher as createRawResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createResultDeliveryOwnership } from "../../src/runs/background/result-delivery-ownership.ts";
import { writeAsyncResultFile, writePendingAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { encodeIndexSegment, MAX_INDEX_SEGMENT_BYTES } from "../../src/runs/background/index-segment.ts";
import { createScheduledRunManager, scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";
import { prepareMissionLaunch, writeMissionAsyncBinding } from "../../src/missions/lifecycle.ts";
import { readMission, updateMission } from "../../src/missions/store.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const COMPLETION_OWNER_ID = "completion-owner-default";

function createState(): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		completionOwnerId: COMPLETION_OWNER_ID,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function createResultWatcher(
	pi: Parameters<typeof createRawResultWatcher>[0],
	state: Parameters<typeof createRawResultWatcher>[1],
	resultsDir: Parameters<typeof createRawResultWatcher>[2],
	completionTtlMs: Parameters<typeof createRawResultWatcher>[3],
	deps: Parameters<typeof createRawResultWatcher>[4] = {},
): ReturnType<typeof createRawResultWatcher> {
	return createRawResultWatcher(pi, state, resultsDir, completionTtlMs, { platform: "linux", coalesceDelayMs: 0, ...deps });
}

function writeIndexedResult(filePath: string, data: Record<string, unknown>): void {
	writeAsyncResultFile(filePath, { completionOwnerId: COMPLETION_OWNER_ID, ...data });
}

function pendingResultPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(resultsDir, "result-pending", encodeURIComponent(sessionId), `${encodeURIComponent(runId)}.json`);
}

async function waitForPredicate(predicate: () => boolean, timeoutMs = 2_500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) return predicate();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return true;
}

describe("result watcher", () => {
	it("does not create Darwin native watchers or idle timers", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-darwin-idle-"));
		try {
			let watchCalls = 0;
			const intervals: number[] = [];
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				platform: "darwin",
				hasDeliveryDemand: () => false,
				fs: { ...fs, watch: (() => { watchCalls += 1; throw new Error("Darwin must not use fs.watch."); }) as typeof fs.watch },
				timers: {
					setTimeout,
					clearTimeout,
					setInterval: ((_handler: () => void, delay?: number) => { intervals.push(delay ?? 0); return { unref() {} } as NodeJS.Timeout; }) as typeof setInterval,
					clearInterval,
				},
			});
			try {
				watcher.startResultWatcher();
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(watchCalls, 0);
			assert.deepEqual(intervals, []);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("uses demand-gated Darwin polling for result delivery", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-darwin-demand-"));
		try {
			let demand = true;
			let poll: (() => void) | undefined;
			let cleared = false;
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				platform: "darwin",
				hasDeliveryDemand: () => demand,
				fs: { ...fs, watch: (() => { throw new Error("Darwin must not use fs.watch."); }) as typeof fs.watch },
				timers: {
					setTimeout,
					clearTimeout,
					setInterval: ((handler: () => void, delay?: number) => { assert.equal(delay, 3000); poll = handler; return { unref() {} } as NodeJS.Timeout; }) as typeof setInterval,
					clearInterval: (() => { cleared = true; }) as typeof clearInterval,
				},
			});
			try {
				watcher.startResultWatcher();
				assert.equal(typeof poll, "function");
				demand = false;
				poll?.();
				assert.equal(cleared, true);
			} finally {
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("processes deferred session-scoped results after session identity is restored", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-session-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.asyncJobs.set("session-run", { asyncId: "session-run", asyncDir: path.join(resultsDir, "session-run"), status: "running", startedAt: Date.now(), updatedAt: Date.now() });
			const resultPath = path.join(resultsDir, "session-run.json");
			writeIndexedResult(resultPath, {
				id: "session-run",
				sessionId: "session-current",
				success: true,
				summary: "done",
			});

			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
				assert.equal(emitted.length, 0);
				assert.equal(fs.existsSync(resultPath), true);

				state.currentSessionId = "session-current";
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("hands predecessor results to the replacement session without widening ownership", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-transition-"));
		try {
			const state = createState();
			state.currentSessionId = "session-old";
			const ownership = createResultDeliveryOwnership(state);
			const delivered: string[] = [];
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				ownership,
				notifier: { async deliver(result) { delivered.push(result.id!); return true; } },
			});
			try {
				watcher.startResultWatcher();
				assert.equal(ownership.claimPredecessor("session-old", "session-old"), true);
				state.currentSessionId = "session-new";
				watcher.transitionResultDelivery();
				writeIndexedResult(path.join(resultsDir, "old-run.json"), { id: "old-run", sessionId: "session-old", success: true, summary: "old" });
				writeIndexedResult(path.join(resultsDir, "new-run.json"), { id: "new-run", sessionId: "session-new", success: true, summary: "new" });
				writeIndexedResult(path.join(resultsDir, "foreign-run.json"), { id: "foreign-run", sessionId: "session-foreign", success: true, summary: "foreign" });
				writeAsyncResultFile(path.join(resultsDir, "wrong-owner.json"), { id: "wrong-owner", sessionId: "session-old", completionOwnerId: "other-owner", success: true, summary: "wrong" });

				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => delivered.length === 2), true);
				assert.deepEqual(delivered.sort(), ["new-run", "old-run"]);
				assert.equal(fs.existsSync(path.join(resultsDir, "old-run.json")), false);
				assert.equal(fs.existsSync(path.join(resultsDir, "new-run.json")), false);
				assert.equal(fs.existsSync(path.join(resultsDir, "foreign-run.json")), true);
				assert.equal(fs.existsSync(path.join(resultsDir, "wrong-owner.json")), true);
			} finally {
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("includes scheduled observer ids while priming current-session results", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-current-prime-"));
		try {
			const state = createState();
			state.currentSessionId = "session-current";
			let observedRunIdLookups = 0;
			writeIndexedResult(path.join(resultsDir, "current.json"), { id: "current", sessionId: "session-current", success: true, summary: "done" });
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				observedCompletionRunIds() {
					observedRunIdLookups += 1;
					return ["scheduled-a"];
				},
			});
			watcher.primeExistingResults();
			assert.equal(observedRunIdLookups, 1);
			watcher.stopResultWatcher();
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("skips full parsing for unrelated sessions during priming, safety scans, and native watch events", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-filter-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const parsedIds: string[] = [];
			const state = createState();
			state.currentSessionId = "session-current";
			let safetyScan: (() => void) | undefined;
			let watchEvent: ((event: string, file: string | Buffer | null) => void) | undefined;
			let safetyScanIntervalMs: number | undefined;
			let observedRunIdScans = 0;
			const fakeWatcher = {
				on() { return fakeWatcher; },
				close() {},
				unref() {},
			} as unknown as fs.FSWatcher;
			const writeResult = (id: string, sessionId: string) => {
				writeIndexedResult(path.join(resultsDir, `${id}.json`), {
					id,
					results: [{ structuredOutput: { sessionId: "nested-not-owner" } }],
					sessionId,
					success: true,
					summary: "done",
				});
			};
			writeResult("startup-current", "session-current");
			writeResult("startup-stale", "session-stale");
			const watcher = createResultWatcher({
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			}, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				observedCompletionRunIds() {
					observedRunIdScans += 1;
					return [];
				},
				parseResult(raw) {
					const parsed = JSON.parse(raw) as { id: string };
					parsedIds.push(parsed.id);
					return parsed;
				},
				fs: {
					...fs,
					watch(_dir, listener) {
						watchEvent = listener as typeof watchEvent;
						return fakeWatcher;
					},
				},
				timers: {
					setTimeout,
					clearTimeout,
					setInterval: ((handler: () => void, delay?: number) => {
						safetyScan = handler;
						safetyScanIntervalMs = delay;
						return { unref() {} } as NodeJS.Timeout;
					}) as typeof setInterval,
					clearInterval() { safetyScan = undefined; },
				},
			});
			try {
				watcher.startResultWatcher();
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(path.join(resultsDir, "startup-current.json"))), true);
				assert.deepEqual(parsedIds, ["startup-current"]);
				assert.equal(safetyScanIntervalMs, 60_000);

				writeResult("scan-current", "session-current");
				writeResult("scan-stale", "session-stale");
				safetyScan?.();
				assert.equal(await waitForPredicate(() => !fs.existsSync(path.join(resultsDir, "scan-current.json"))), true);
				assert.deepEqual(parsedIds, ["startup-current", "scan-current"]);

				const scansBeforeWatchEvents = observedRunIdScans;
				watchEvent?.("rename", "watch-current.json");
				writeResult("watch-current", "session-current");
				assert.equal(await waitForPredicate(() => !fs.existsSync(path.join(resultsDir, "watch-current.json"))), true);
				assert.equal(observedRunIdScans, scansBeforeWatchEvents);

				writeResult("watch-stale", "session-stale");
				watchEvent?.("rename", "watch-stale.json");
				assert.equal(await waitForPredicate(() => observedRunIdScans > scansBeforeWatchEvents), true);
				assert.deepEqual(parsedIds, ["startup-current", "scan-current", "watch-current"]);
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 3);
			assert.deepEqual(fs.readdirSync(resultsDir).filter((file) => file.endsWith(".json")).sort(), ["scan-stale.json", "startup-stale.json", "watch-stale.json"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("syncs mission workflow child completion before result cleanup", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-mission-"));
		const resultsDir = path.join(root, "results");
		const project = path.join(root, "project");
		const asyncDir = path.join(root, "async-child");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		try {
			const outputPath = path.join(asyncDir, "output.md");
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Workflow mission" }, task: "Run async child" },
				projectRoot: project,
				config: { directory: path.join(root, "missions"), globalIndexDir: path.join(root, "global-index") },
				ownerSessionId: "session-current",
			});
			assert.ok(binding);
			writeMissionAsyncBinding(asyncDir, binding);
			updateMission(binding.location, binding.missionId, {
				upsertWorkflowChildren: [{
					workflowRunId: "workflow-1",
					key: "background",
					runId: "async-child",
					status: "running",
					artifactPaths: [asyncDir],
					heartbeat: { status: "running" },
				}],
			});
			writeIndexedResult(path.join(resultsDir, "async-child.json"), {
				id: "async-child",
				runId: "async-child",
				sessionId: "session-current",
				asyncDir,
				mode: "single",
				state: "complete",
				success: true,
				summary: "Async child completed",
				parentWorkflowRunId: "workflow-1",
				workflowKey: "background",
				results: [{ agent: "worker", success: true, output: "done", artifactPaths: { outputPath } }],
			});
			const state = createState();
			state.currentSessionId = "session-current";
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				notifier: { deliver: async () => true },
			});
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			const mission = readMission(binding.location, binding.missionId);
			const child = mission.workflowChildren[0];
			assert.equal(fs.existsSync(path.join(resultsDir, "async-child.json")), false);
			assert.equal(child?.status, "completed");
			assert.equal(child?.runId, "async-child");
			assert.ok(child?.completedAt);
			assert.equal(child?.heartbeat?.status, "completed");
			assert.equal(child?.heartbeat?.message, "Async child completed");
			assert.ok(child?.artifactPaths.includes(outputPath));
			assert.ok(child?.artifactPaths.includes(path.join(asyncDir, "status.json")));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("observes a hash-only mission result once when its public alias is unaddressable", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-mission-enametoolong-"));
		const resultsDir = path.join(root, "results");
		const project = path.join(root, "project");
		const asyncDir = path.join(root, "async-child");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const originalError = console.error;
		const errors: unknown[][] = [];
		try {
			const runId = `mission-${"x".repeat(250)}`;
			const publicResultPath = path.join(resultsDir, `${runId}.json`);
			assert.ok(Buffer.byteLength(`${runId}.json`, "utf-8") > MAX_INDEX_SEGMENT_BYTES);
			const originalRenameSync = fsDefault.renameSync;
			const nameTooLong = new Error("public result alias is too long") as NodeJS.ErrnoException;
			nameTooLong.code = "ENAMETOOLONG";
			t.mock.method(fsDefault, "renameSync", ((source: fs.PathLike, destination: fs.PathLike) => {
				if (String(destination) === publicResultPath) throw nameTooLong;
				return originalRenameSync(source, destination);
			}) as typeof fsDefault.renameSync);
			syncBuiltinESMExports();
			const binding = prepareMissionLaunch({
				params: { mission: { title: "Long result mission" }, task: "Run async child" },
				projectRoot: project,
				config: { directory: path.join(root, "missions"), globalIndexDir: path.join(root, "global-index") },
				ownerSessionId: "session-owner",
			});
			assert.ok(binding);
			writeMissionAsyncBinding(asyncDir, binding);
			console.error = (...args: unknown[]) => { errors.push(args); };
			writeIndexedResult(publicResultPath, {
				id: runId,
				runId,
				sessionId: "session-owner",
				asyncDir,
				state: "complete",
				success: true,
				summary: "Long mission result completed",
			});
			const pendingPath = path.join(resultsDir, "result-pending", encodeIndexSegment("session-owner"), `${encodeIndexSegment(runId, MAX_INDEX_SEGMENT_BYTES - Buffer.byteLength(".json"))}.json`);
			assert.equal(fs.existsSync(pendingPath), true);
			const state = createState();
			state.currentSessionId = "different-session";
			let parsed = 0;
			let observed = 0;
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				parseResult(raw) {
					parsed += 1;
					return JSON.parse(raw);
				},
				observeCompletion() { observed += 1; },
			});
			try {
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => observed === 1), true);
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 25));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(parsed, 1);
			assert.equal(observed, 1);
			assert.equal(fs.existsSync(pendingPath), true);
			assert.equal((JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as { notificationDeliveredAt?: unknown }).notificationDeliveredAt, undefined);
			assert.equal(readMission(binding.location, binding.missionId).runs.some((run) => run.runId === runId), true);
			assert.equal(errors.some((entry) => /Failed to (?:promote|inspect|process).*result/i.test(String(entry[0] ?? ""))), false);
		} finally {
			console.error = originalError;
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps result files until failed completion observers retry successfully", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-observer-retry-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const resultPath = path.join(resultsDir, "observer-retry.json");
			writeIndexedResult(resultPath, { id: "observer-retry", runId: "observer-retry", sessionId: "session-current", success: true, summary: "done" });
			const state = createState();
			state.currentSessionId = "session-current";
			let observerCalls = 0;
			let deliveries = 0;
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				observeCompletion: () => {
					observerCalls += 1;
					if (observerCalls === 1) throw new Error("observer unavailable");
				},
				notifier: { deliver: async () => { deliveries += 1; return true; } },
			});
			try {
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(resultPath) && observerCalls >= 2), true);
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(observerCalls, 2);
			assert.equal(deliveries, 1);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("does not redeliver user notification after reload while observer retry is pending", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-observer-reload-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const resultPath = path.join(resultsDir, "observer-reload.json");
			writeIndexedResult(resultPath, { id: "observer-reload", runId: "observer-reload", sessionId: "session-current", success: true, summary: "done" });
			let observerCalls = 0;
			let deliveries = 0;
			let emitted = 0;
			const pi = { events: { on: () => () => {}, emit: () => { emitted += 1; } } };
			const firstState = createState();
			firstState.currentSessionId = "session-current";
			const firstWatcher = createResultWatcher(pi, firstState, resultsDir, 60_000, {
				observeCompletion: () => {
					observerCalls += 1;
					throw new Error("observer unavailable");
				},
				notifier: { deliver: async () => { deliveries += 1; return true; } },
			});
			try {
				firstWatcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => {
					if (deliveries !== 1 || !fs.existsSync(resultPath)) return false;
					return typeof (JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { notificationDeliveredAt?: unknown }).notificationDeliveredAt === "number";
				}), true);
			} finally {
				firstWatcher.stopResultWatcher();
			}

			const secondState = createState();
			secondState.currentSessionId = "session-current";
			const secondWatcher = createResultWatcher(pi, secondState, resultsDir, 60_000, {
				observeCompletion: () => { observerCalls += 1; },
				notifier: { deliver: async () => { deliveries += 1; return true; } },
			});
			try {
				secondWatcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(resultPath)), true);
			} finally {
				secondWatcher.stopResultWatcher();
			}

			assert.equal(observerCalls, 2);
			assert.equal(deliveries, 1);
			assert.equal(emitted, 1);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("observes retained-project completions without changing active-session delivery", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-scheduled-"));
		const resultsDir = path.join(root, "results");
		const project = path.join(root, "project-a");
		fs.mkdirSync(resultsDir);
		fs.mkdirSync(project);
		const ctx = {
			cwd: project,
			sessionManager: {
				getSessionId: () => "session-a",
				getSessionFile: () => path.join(project, "session-a.jsonl"),
			},
		} as unknown as ExtensionContext;
		const manager = createScheduledRunManager({
			config: { scheduledRuns: { enabled: true } },
			storeRoot: path.join(root, "stores"),
			launch: async () => ({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "scheduled-a" } }),
		});
		try {
			manager.bindSession(ctx);
			await manager.handleToolCall({ action: "schedule.create", id: "retained", every: "1h", workflowScript: "return runs.run('main', { agent: 'worker' })" }, ctx);
			await manager.handleToolCall({ action: "schedule.run", id: "retained" }, ctx);
			const scheduleDir = path.join(scheduledRunStorePath(project, undefined, path.join(root, "stores")), "retained");
			assert.equal(fs.existsSync(path.join(scheduleDir, "active.lock")), true);

			const emitted: Array<{ event: string; data: unknown }> = [];
			const state = createState();
			state.currentSessionId = "session-b";
			const resultPath = path.join(resultsDir, "scheduled-a.json");
			writeIndexedResult(resultPath, { id: "scheduled-a", sessionId: "session-a", success: true, summary: "done" });
			const watcher = createResultWatcher({
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			}, state, resultsDir, 60_000, {
				observeCompletion: (result) => manager.handleAsyncCompletion(result),
				observedCompletionRunIds: () => manager.observedCompletionRunIds(),
				notifier: { deliver: async () => assert.fail("inactive-session completion must not reach the live notifier") },
			});
			try {
				watcher.startResultWatcher();
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(state.currentSessionId, "session-b");
			assert.equal(emitted.length, 0);
			assert.equal(fs.existsSync(path.join(scheduleDir, "active.lock")), false);
			assert.match(fs.readFileSync(path.join(scheduleDir, "history.json"), "utf-8"), /"state": "completed"/);
			assert.equal(fs.existsSync(resultPath), true, "the owning session keeps delivery ownership of its result file");
		} finally {
			manager.stop();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("delivers indexed pending results during reload when public promotion is blocked", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-pending-index-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const emitted: Array<{ event: string; data: unknown }> = [];
			const delivered: unknown[] = [];
			const state = createState();
			state.currentSessionId = "session-current";
			const resultPath = path.join(resultsDir, "pending-run.json");
			fs.mkdirSync(resultPath, { recursive: true });
			writePendingAsyncResultFile(resultPath, {
				id: "pending-run",
				runId: "pending-run",
				sessionId: "session-current",
				completionOwnerId: COMPLETION_OWNER_ID,
				success: true,
				state: "complete",
				summary: "done from pending",
			});
			const watcher = createResultWatcher({
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			}, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				notifier: { deliver: async (result) => { delivered.push(result); return true; } },
			});
			try {
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => emitted.some((entry) => entry.event === "subagent:async-complete")), true);
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal((delivered[0] as { summary?: string } | undefined)?.summary, "done from pending");
			assert.equal(fs.existsSync(pendingResultPath(resultsDir, "session-current", "pending-run")), false);
			assert.equal(fs.statSync(resultPath).isDirectory(), true);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("uses indexed result files and ignores unindexed stale files during reload", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-index-"));
		try {
			for (let i = 0; i < 300; i += 1) {
				fs.writeFileSync(path.join(resultsDir, `stale-${i}.json`), JSON.stringify({ id: `stale-${i}`, sessionId: "session-stale", success: true, summary: "done" }), "utf-8");
			}
			writeIndexedResult(path.join(resultsDir, "current.json"), { id: "current", runId: "current", sessionId: "session-current", success: true, summary: "done" });
			const parsedIds: string[] = [];
			const state = createState();
			state.currentSessionId = "session-current";
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				parseResult(raw) {
					const parsed = JSON.parse(raw) as { id: string };
					parsedIds.push(parsed.id);
					return parsed;
				},
			});
			try {
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(path.join(resultsDir, "current.json"))), true);
			} finally {
				watcher.stopResultWatcher();
			}
			assert.deepEqual(parsedIds, ["current"]);
			assert.equal(fs.existsSync(path.join(resultsDir, "stale-0.json")), true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("includes observer-known run ids when current-session results are also indexed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-mixed-observer-"));
		try {
			const resultsDir = path.join(root, "results");
			writeIndexedResult(path.join(resultsDir, "current.json"), { id: "current", runId: "current", sessionId: "session-current", success: true, summary: "current" });
			writeIndexedResult(path.join(resultsDir, "scheduled-a.json"), { id: "scheduled-a", runId: "scheduled-a", sessionId: "session-a", success: true, summary: "scheduled" });
			let observations = 0;
			const state = createState();
			state.currentSessionId = "session-current";
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				observedCompletionRunIds: () => ["scheduled-a"],
				observeCompletion: (result) => { if (result.runId === "scheduled-a") observations += 1; },
				notifier: { deliver: async () => true },
			});
			try {
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => observations === 1), true);
				assert.equal(await waitForPredicate(() => !fs.existsSync(path.join(resultsDir, "current.json"))), true);
			} finally {
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("delivers observed indexed pending results when public promotion is blocked", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-observed-pending-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			for (let i = 0; i < 300; i += 1) {
				fs.writeFileSync(path.join(resultsDir, `stale-${i}.json`), JSON.stringify({ id: `stale-${i}`, sessionId: "session-stale", success: true, summary: "done" }), "utf-8");
			}
			const resultPath = path.join(resultsDir, "scheduled-pending.json");
			fs.mkdirSync(resultPath, { recursive: true });
			writePendingAsyncResultFile(resultPath, {
				id: "scheduled-pending",
				runId: "scheduled-pending",
				sessionId: "session-a",
				completionOwnerId: COMPLETION_OWNER_ID,
				success: true,
				state: "complete",
				summary: "scheduled pending done",
			});
			let observations = 0;
			const state = createState();
			state.currentSessionId = "session-b";
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				observedCompletionRunIds: () => ["scheduled-pending"],
				observeCompletion: (result) => {
					if (result.runId === "scheduled-pending") observations += 1;
				},
				notifier: { deliver: async () => assert.fail("observer-owned completion must not reach active delivery") },
			});
			try {
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => observations === 1), true);
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(pendingResultPath(resultsDir, "session-a", "scheduled-pending")), true);
			assert.equal(fs.statSync(resultPath).isDirectory(), true);
			assert.equal(fs.existsSync(path.join(resultsDir, "stale-0.json")), true);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("uses observed run ids directly without scanning a stale result pile", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-observed-index-"));
		try {
			for (let i = 0; i < 300; i += 1) {
				fs.writeFileSync(path.join(resultsDir, `stale-${i}.json`), JSON.stringify({ id: `stale-${i}`, sessionId: "session-stale", success: true, summary: "done" }), "utf-8");
			}
			const resultPath = path.join(resultsDir, "scheduled-a.json");
			writeIndexedResult(resultPath, { id: "scheduled-a", runId: "scheduled-a", sessionId: "session-a", success: true, summary: "done" });
			let observations = 0;
			let observed = true;
			const makeWatcher = () => {
				const state = createState();
				state.currentSessionId = "session-b";
				return createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
					observedCompletionRunIds: () => observed ? ["scheduled-a"] : [],
					observeCompletion: () => { observations += 1; observed = false; },
					notifier: { deliver: async () => assert.fail("observer-owned completion must not reach active delivery") },
				});
			};
			let watcher = makeWatcher();
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}
			watcher = makeWatcher();
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}
			assert.equal(observations, 1);
			assert.equal(fs.existsSync(resultPath), true);
			assert.equal(fs.existsSync(path.join(resultsDir, "stale-0.json")), true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("uses native completion delivery without attempting external grouped intercom when disabled", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-native-delivery-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const delivered: unknown[] = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			};
			const state = createState();
			state.currentSessionId = "session-native";
			const resultPath = path.join(resultsDir, "native-run.json");
			writeIndexedResult(resultPath, {
				id: "native-run",
				runId: "native-run",
				sessionId: "session-native",
				mode: "single",
				success: false,
				state: "failed",
				summary: "Subagent process terminated by signal SIGTERM.",
				results: [{ agent: "worker", output: "", success: false, exitCode: 1, processSignal: "SIGTERM" }],
				intercomTarget: "native-parent",
			});
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				notifier: { deliver: async (result) => { delivered.push(result); return true; } },
			});
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}
			assert.equal(emitted.some((entry) => entry.event === "subagent:result-intercom"), false);
			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			const notification = delivered[0] as { results?: Array<{ status?: string }> } | undefined;
			assert.equal(notification?.results?.[0]?.status, "stopped");
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("delivers result files only to the exact owning session when another watcher shares the same repo", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-scope-"));
		const createPi = () => {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			return { pi, emitted };
		};
		try {
			const owner = createPi();
			const other = createPi();
			const ownerState = createState();
			ownerState.currentSessionId = "session-owner";
			const otherState = createState();
			otherState.currentSessionId = "session-other";
			const ownerWatcher = createResultWatcher(owner.pi, ownerState, resultsDir, 60_000);
			const otherWatcher = createResultWatcher(other.pi, otherState, resultsDir, 60_000);
			const ownerResultPath = path.join(resultsDir, "owner-run.json");
			try {
				writeIndexedResult(ownerResultPath, {
					id: "owner-run",
					agent: "worker",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner output",
					results: [{ agent: "worker", output: "owner output", success: true }],
					sessionId: "session-owner",
					cwd: "/repo",
					intercomTarget: "owner-target",
				});

				otherWatcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
				ownerWatcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => owner.emitted.some((entry) => entry.event === "subagent:async-complete")), true);
			} finally {
				ownerWatcher.stopResultWatcher();
				otherWatcher.stopResultWatcher();
			}

			const ownerCompletions = owner.emitted.filter((entry) => entry.event === "subagent:async-complete");
			const ownerIntercom = owner.emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(ownerCompletions.length, 1);
			assert.equal((ownerCompletions[0]?.data as { id?: string } | undefined)?.id, "owner-run");
			assert.equal(ownerIntercom.length, 1);
			assert.equal(other.emitted.some((entry) => entry.event === "subagent:async-complete"), false);
			assert.equal(other.emitted.some((entry) => entry.event === "subagent:result-intercom"), false);
			assert.equal(fs.existsSync(ownerResultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("leaves same-session completions for the exact parent owner", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-owner-scope-"));
		try {
			const ownerState = createState();
			ownerState.currentSessionId = "shared-session";
			ownerState.completionOwnerId = "owner-a";
			const otherState = createState();
			otherState.currentSessionId = "shared-session";
			otherState.completionOwnerId = "owner-b";
			const resultPath = path.join(resultsDir, "owner-scoped.json");
			const missingOwnerPath = path.join(resultsDir, "missing-owner.json");
			writeAsyncResultFile(resultPath, {
				id: "owner-scoped",
				runId: "owner-scoped",
				sessionId: "shared-session",
				completionOwnerId: "owner-a",
				success: true,
				summary: "owned result",
			});
			writeAsyncResultFile(missingOwnerPath, {
				id: "missing-owner",
				runId: "missing-owner",
				sessionId: "shared-session",
				success: true,
				summary: "legacy result",
			});
			let otherDeliveries = 0;
			const otherWatcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, otherState, resultsDir, 60_000, {
				deliverIntercomResults: false,
				notifier: { deliver: async () => { otherDeliveries += 1; return true; } },
			});
			try {
				otherWatcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 25));
			} finally {
				otherWatcher.stopResultWatcher();
			}
			assert.equal(otherDeliveries, 0);
			assert.equal(fs.existsSync(resultPath), true);
			assert.equal(fs.existsSync(missingOwnerPath), true);
			assert.equal((JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { notificationDeliveredAt?: unknown }).notificationDeliveredAt, undefined);

			let ownerDeliveries = 0;
			const ownerWatcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, ownerState, resultsDir, 60_000, {
				deliverIntercomResults: false,
				notifier: { deliver: async () => { ownerDeliveries += 1; return true; } },
			});
			try {
				ownerWatcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(resultPath)), true);
				await new Promise((resolve) => setTimeout(resolve, 25));
			} finally {
				ownerWatcher.stopResultWatcher();
			}
			assert.equal(ownerDeliveries, 1);
			assert.equal(fs.existsSync(missingOwnerPath), true, "missing owner fails closed for every window");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("logs malformed result files instead of swallowing them silently", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			fs.writeFileSync(path.join(resultsDir, "bad.json"), "{bad-json", "utf-8");
			const emitted: unknown[] = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(_event: string, data: unknown) {
						emitted.push(data);
					},
				},
			};
			const state = createState();
			state.asyncJobs.set("bad", { asyncId: "bad", asyncDir: path.join(resultsDir, "bad"), status: "running", startedAt: Date.now(), updatedAt: Date.now() });
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.length, 0);
			assert.ok(
				logged.some((entry) => /Failed to process subagent result file/.test(String(entry[0] ?? ""))),
				"expected watcher error to be logged",
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("diagnoses non-filesystem ENAMETOOLONG from parser and notifier callbacks", async () => {
		for (const source of ["parser", "notifier"] as const) {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-result-watcher-${source}-enametoolong-`));
			const originalError = console.error;
			const logged: unknown[][] = [];
			try {
				const runId = `${source}-enametoolong`;
				const resultPath = path.join(resultsDir, `${runId}.json`);
				writeIndexedResult(resultPath, { id: runId, runId, sessionId: "session-current", success: true, summary: "done" });
				const state = createState();
				state.currentSessionId = "session-current";
				const failure = new Error(`${source} rejected payload`) as NodeJS.ErrnoException;
				failure.code = "ENAMETOOLONG";
				console.error = (...args: unknown[]) => { logged.push(args); };
				const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, source === "parser"
					? { parseResult: () => { throw failure; } }
					: { notifier: { deliver: async () => { throw failure; } } });
				try {
					watcher.primeExistingResults();
					assert.equal(await waitForPredicate(() => logged.some((entry) => entry[1] === failure)), true);
				} finally {
					watcher.stopResultWatcher();
				}

				assert.equal(fs.existsSync(resultPath), true);
				assert.equal(logged.some((entry) => entry[1] === failure && /Failed to process subagent result file/.test(String(entry[0] ?? ""))), true);
			} finally {
				console.error = originalError;
				fs.rmSync(resultsDir, { recursive: true, force: true });
			}
		}
	});

	it("normalizes the native fs.watch path before watching result files", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const nativeResultsDir = path.join(path.dirname(resultsDir), `${path.basename(resultsDir)}-native`);
			const pi = {
				events: {
					on: () => () => {},
					emit() {},
				},
			};
			const state = createState();
			let watchedDir: fs.PathLike | undefined;
			const fakeWatcher = {
				on() {
					return fakeWatcher;
				},
				close() {},
				unref() {},
			} as unknown as fs.FSWatcher;
			const realpathSync = ((target: fs.PathLike, options?: unknown) => fs.realpathSync(target, options as BufferEncoding)) as typeof fs.realpathSync;
			realpathSync.native = ((target: fs.PathLike) => target === resultsDir ? nativeResultsDir : fs.realpathSync.native(target)) as typeof fs.realpathSync.native;
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					realpathSync,
					watch(dir) {
						watchedDir = dir;
						return fakeWatcher;
					},
				},
			});
			try {
				watcher.startResultWatcher();
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(watchedDir, nativeResultsDir);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("drains durable results when an active fs.watch misses events", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let scan: (() => void) | undefined;
			const fakeWatcher = {
				on() {
					return fakeWatcher;
				},
				close() {},
				unref() {},
			} as unknown as fs.FSWatcher;
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: { ...fs, watch: () => fakeWatcher },
				deliverIntercomResults: false,
				timers: {
					setTimeout,
					clearTimeout,
					setInterval: ((handler: () => void) => {
						scan = handler;
						return { unref() {} } as NodeJS.Timeout;
					}) as typeof setInterval,
					clearInterval() {
						scan = undefined;
					},
				},
			});
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, fakeWatcher);
				for (const id of ["missed-a", "missed-b"]) {
					writeIndexedResult(path.join(resultsDir, `${id}.json`), {
						id,
						sessionId: "session-1",
						success: true,
						state: "complete",
						summary: "done",
					});
				}
				scan?.();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 2);
			assert.deepEqual(fs.readdirSync(resultsDir).filter((file) => file.endsWith(".json")), []);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling when fs.watch throws EMFILE and preserves grouped intercom delivery", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let poll: (() => void) | undefined;
			const emfile = new Error("too many open files") as NodeJS.ErrnoException;
			emfile.code = "EMFILE";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => {
						throw emfile;
					},
				},
				timers: {
					setTimeout,
					clearTimeout() {},
					setInterval(handler: () => void) {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval() {
						poll = undefined;
					},
				},
			});
			const originalError = console.error;
			const childSessionPath = path.join(resultsDir, "a-session.jsonl");
			const resultPath = path.join(resultsDir, "async-fallback.json");
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				fs.writeFileSync(childSessionPath, "", "utf-8");
				writeIndexedResult(resultPath, {
					id: "async-fallback",
					runId: "run-fallback",
					agent: "parallel:a+b",
					mode: "parallel",
					success: true,
					state: "complete",
					summary: "Combined summary",
					results: [
						{ agent: "a", output: "Result from a", success: true, sessionFile: childSessionPath, intercomTarget: "subagent-a-run-fallback-1" },
						{ agent: "b", output: "Result from b", success: false, error: "B failed", intercomTarget: "subagent-b-run-fallback-2" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				});
				poll?.();
				assert.equal(await waitForPredicate(() => emitted.some((entry) => entry.event === "subagent:async-complete") && !fs.existsSync(resultPath)), true);
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
			assert.equal(fs.existsSync(resultPath), false);
			const payload = intercomEvents[0]?.data as { mode?: string; status?: string; message?: string; children?: Array<{ status?: string; summary?: string; sessionPath?: string }> };
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { results?: Array<{ status?: string; summary?: string; sessionPath?: string }> } | undefined;
			assert.equal(payload.mode, "parallel");
			assert.equal(payload.status, "failed");
			assert.match(String(payload.message ?? ""), /Run: run-fallback/);
			assert.match(String(payload.message ?? ""), /Children: 1 completed, 1 failed/);
			assert.equal(payload.children?.[0]?.sessionPath, childSessionPath);
			assert.equal(completion?.results?.[0]?.sessionPath, childSessionPath);
			assert.equal(payload.children?.[1]?.status, "failed");
			assert.equal(completion?.results?.[1]?.status, "failed");
			assert.equal(payload.children?.[1]?.summary, "B failed\n\nOutput:\nResult from b");
			assert.equal(completion?.results?.[1]?.summary, "B failed\n\nOutput:\nResult from b");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling when an active fs.watch emits ENOSPC", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let poll: (() => void) | undefined;
			let emitWatcherError: ((error: NodeJS.ErrnoException) => void) | undefined;
			const fakeWatcher = {
				on(event: string, handler: (error: NodeJS.ErrnoException) => void) {
					if (event === "error") emitWatcherError = handler;
					return fakeWatcher;
				},
				close() {},
				unref() {},
			} as fs.FSWatcher;
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => fakeWatcher,
				},
				timers: {
					setTimeout,
					clearTimeout() {},
					setInterval(handler: () => void) {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval() {
						poll = undefined;
					},
				},
			});
			const originalError = console.error;
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, fakeWatcher);
				const enospc = new Error("inotify limit reached") as NodeJS.ErrnoException;
				enospc.code = "ENOSPC";
				emitWatcherError?.(enospc);
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				writeIndexedResult(path.join(resultsDir, "done.json"), { sessionId: "session-1", summary: "done" });
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(path.join(resultsDir, "done.json")), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("emits async completion plus one grouped intercom result event when an intercom target is present", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const firstSession = path.join(resultsDir, "a-session.jsonl");
			const missingSession = path.join(resultsDir, "b-session.jsonl");
			try {
				fs.writeFileSync(firstSession, "", "utf-8");
				writeIndexedResult(path.join(resultsDir, "async-1.json"), {
					id: "async-1",
					runId: "run-123",
					agent: "parallel:a+b",
					mode: "parallel",
					success: true,
					state: "complete",
					summary: "Combined summary",
					results: [
						{ agent: "a", output: "Result from a", outputState: "present", success: true, sessionFile: firstSession, artifactPaths: { outputPath: "/tmp/a-output.md" }, intercomTarget: "subagent-a-run-123-1" },
						{ agent: "b", output: "Result from b", outputState: "present", success: false, sessionFile: missingSession, artifactPaths: { outputPath: "/tmp/b-output.md" }, intercomTarget: "subagent-b-run-123-2" },
					],
					sessionId: "session-1",
					sessionFile: "/tmp/session.jsonl",
					asyncDir: "/tmp/async-1",
					parallelHandoff: { version: 1, path: "/tmp/async-1/handoff.json", groupCount: 1, childCount: 2, changedPatches: 1, cleanupState: "complete" },
					intercomTarget: "subagent-chat-main",
				});
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => emitted.some((entry) => entry.event === "subagent:async-complete") && emitted.some((entry) => entry.event === "subagent:result-intercom")), true);
			} finally {
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			const eventData = intercomEvents[0]?.data as { message?: string; mode?: string; status?: string; parallelHandoff?: { path?: string } };
			assert.equal(eventData.mode, "parallel");
			assert.equal(eventData.status, "failed");
			assert.equal(eventData.parallelHandoff?.path, "/tmp/async-1/handoff.json");
			const message = String(eventData.message ?? "");
			assert.match(message, /Revive child: subagent\(\{ action: "resume", id: "async-1", index: 0, message: "\.\.\." \}\)/);
			assert.ok(message.includes(`Session: ${firstSession}`));
			assert.match(message, /Parallel handoff: \/tmp\/async-1\/handoff\.json/);
			assert.match(message, /Outputs: 2 present \(semantic adequacy unassessed\)/);
			assert.match(message, /Inspect that output before retrying/);
			assert.equal(message.includes(missingSession), false);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { parallelHandoff?: { path?: string } } | undefined;
			assert.equal(completion?.parallelHandoff?.path, "/tmp/async-1/handoff.json");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("does not mark completed siblings as stopped when the overall async result is stopped", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stopped-siblings-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const set = listeners.get(event) ?? new Set();
						set.add(handler);
						listeners.set(event, set);
						return () => set.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				writeIndexedResult(path.join(resultsDir, "async-stopped.json"), {
					id: "async-stopped",
					runId: "async-stopped",
					agent: "parallel:a+b",
					mode: "parallel",
					success: false,
					state: "stopped",
					stopped: true,
					summary: "Stopped by user",
					results: [
						{ agent: "a", output: "Result from a", outputState: "present", success: true },
						{ agent: "b", output: "Subagent stopped by user.", outputState: "absent", success: false, stopped: true, state: "stopped" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				});
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			const eventData = intercomEvents[0]?.data as { message?: string; status?: string };
			assert.equal(eventData.status, "stopped");
			const message = String(eventData.message ?? "");
			assert.match(message, /Children: 1 completed, 1 stopped/);
			assert.match(message, /1\. a — process completed · output present/);
			assert.match(message, /2\. b — process stopped · output absent/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("enriches async completion and intercom payloads with nested registry children before deletion", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-"));
		const route = createNestedRoute("async-nested-root");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: Date.now(),
				parentRunId: "async-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-child",
					parentRunId: "async-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-root", stepIndex: 0 }],
					state: "complete",
					agent: "nested-reviewer",
					sessionFile: path.join(resultsDir, "nested-child.jsonl"),
				},
			});
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-root.json");
			try {
				writeIndexedResult(resultPath, {
					id: "async-nested-root",
					runId: "async-nested-root",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{ agent: "owner", output: "owner done", success: true }],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				});
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(resultPath) && emitted.some((entry) => entry.event === "subagent:async-complete") && emitted.some((entry) => entry.event === "subagent:result-intercom")), true);
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { children?: Array<{ children?: Array<{ id?: string; controlInbox?: string; capabilityToken?: string }> }>; message?: string } | undefined;
			assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.id, "nested-child");
			assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.controlInbox, undefined);
			assert.equal(intercomPayload?.children?.[0]?.children?.[0]?.capabilityToken, undefined);
			assert.match(String(intercomPayload?.message ?? ""), /Nested subagents:/);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }>; results?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			assert.equal(completion?.nestedChildren?.[0]?.id, "nested-child");
			assert.equal(completion?.results?.[0]?.children?.[0]?.id, "nested-child");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("filters malformed explicit nested children in result files before compacting", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-malformed-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-explicit-nested.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				writeIndexedResult(resultPath, {
					id: "async-explicit-nested",
					runId: "async-explicit-nested",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{
						agent: "owner",
						output: "owner done",
						success: true,
						children: [
							{ id: "child-explicit-good", parentRunId: "async-explicit-nested", depth: 1, path: [{ runId: "async-explicit-nested" }], state: "complete", agent: "child-good" },
							{ id: "child-explicit-bad", path: "not-an-array" },
						],
					}],
					nestedChildren: [
						{ id: "top-explicit-good", parentRunId: "async-explicit-nested", parentStepIndex: 0, depth: 1, path: [{ runId: "async-explicit-nested", stepIndex: 0 }], state: "complete", agent: "top-good" },
						{ id: "top-explicit-bad", path: "not-an-array" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				});
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(resultPath) && emitted.some((entry) => entry.event === "subagent:async-complete")), true);
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			assert.ok(logged.some((entry) => String(entry[0] ?? "").includes(resultPath) && /invalid nested child record/.test(String(entry[0] ?? ""))));
			const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { children?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			const intercomNestedIds = intercomPayload?.children?.[0]?.children?.map((child) => child.id) ?? [];
			assert.deepEqual(intercomNestedIds.sort(), ["child-explicit-good", "top-explicit-good"].sort());
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { results?: Array<{ children?: Array<{ id?: string }> }>; nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["top-explicit-good"]);
			assert.deepEqual(completion?.results?.[0]?.children?.map((child) => child.id)?.sort(), ["child-explicit-good", "top-explicit-good"].sort());
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("retries and delivers result files after nested registry enrichment recovers", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-retry-"));
		const route = createNestedRoute("async-nested-retry");
		try {
			const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
			fs.writeFileSync(registryPath, "{", "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: 100,
				parentRunId: "async-nested-retry",
				parentStepIndex: 0,
				child: {
					id: "nested-retry-child",
					parentRunId: "async-nested-retry",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-retry", stepIndex: 0 }],
					state: "complete",
					agent: "child",
				},
			});
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, listener: (payload: unknown) => void) {
						const set = listeners.get(event) ?? new Set();
						set.add(listener);
						listeners.set(event, set);
						return () => set.delete(listener);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const listener of listeners.get(event) ?? []) listener(data);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-retry.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				writeIndexedResult(resultPath, {
					id: "async-nested-retry",
					runId: "async-nested-retry",
					agent: "owner",
					success: true,
					state: "complete",
					summary: "owner done",
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				});
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.equal(fs.existsSync(resultPath), true);
				assert.equal(emitted.length, 0);
				assert.ok(
					logged.some((entry) => /will retry later/.test(String(entry[0] ?? ""))),
					"expected nested enrichment retry warning to be logged",
				);

				fs.rmSync(registryPath, { force: true });
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(resultPath) && emitted.some((entry) => entry.event === "subagent:async-complete")), true);
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["nested-retry-child"]);
			const intercomPayload = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { children?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			assert.deepEqual(intercomPayload?.children?.[0]?.children?.map((child) => child.id), ["nested-retry-child"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("does not advertise indexed revive from only a top-level async session file", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					emit: (event: string, data: unknown) => {
						emitted.push({ event, data });
						for (const listener of listeners.get(event) ?? []) listener(data);
						return true;
					},
					on: (event: string, listener: (payload: unknown) => void) => {
						const set = listeners.get(event) ?? new Set();
						set.add(listener);
						listeners.set(event, set);
						return () => set.delete(listener);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				writeIndexedResult(path.join(resultsDir, "async-top-session.json"), {
					id: "async-top-session",
					mode: "parallel",
					success: false,
					state: "failed",
					results: [
						{ agent: "a", output: "A", success: true },
						{ agent: "b", output: "B", success: false },
					],
					sessionId: "session-1",
					sessionFile: "/tmp/top-session.jsonl",
					intercomTarget: "subagent-chat-main",
				});
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			const eventData = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { message?: string } | undefined;
			assert.ok(eventData);
			assert.doesNotMatch(String(eventData.message ?? ""), /Revive child:/);
			assert.match(String(eventData.message ?? ""), /Resume: unavailable; no child session file was persisted/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("marks grouped async results as paused when the result file is paused", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				writeIndexedResult(path.join(resultsDir, "async-paused.json"), {
					id: "async-paused",
					runId: "run-paused",
					agent: "chain:a->b",
					mode: "chain",
					success: false,
					state: "paused",
					summary: "Paused after interrupt. Waiting for explicit next action.",
					results: [
						{ agent: "a", output: "Result from a", outputState: "present", success: true, intercomTarget: "subagent-a-run-paused-1" },
						{ agent: "b", output: "Paused after interrupt", outputState: "absent", success: false, intercomTarget: "subagent-b-run-paused-2" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				});
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			const payload = intercomEvents[0]?.data as { mode?: string; status?: string; message?: string; children?: Array<{ status?: string }> };
			assert.equal(payload.mode, "chain");
			assert.equal(payload.status, "paused");
			assert.equal(payload.children?.every((child) => child.status === "paused"), true);
			assert.match(String(payload.message ?? ""), /Process status: paused/);
			assert.match(String(payload.message ?? ""), /1\. a — process paused · output present/);
			assert.match(String(payload.message ?? ""), /2\. b — process paused · output absent/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("delivers a later terminal result after a paused payload for the same run", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-paused-then-complete-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on() { return () => {}; },
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let holdPaused: () => void = () => {};
			const pausedHeld = new Promise<void>((resolve) => { holdPaused = resolve; });
			let pausedDeliverStarted: () => void = () => {};
			const pausedStarted = new Promise<void>((resolve) => { pausedDeliverStarted = resolve; });
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				notifier: {
					async deliver(result) {
						if (result.state === "paused") {
							pausedDeliverStarted();
							await pausedHeld;
						}
						return true;
					},
				},
			});
			try {
				writeIndexedResult(path.join(resultsDir, "workflow-detach.json"), {
					id: "workflow-detach",
					runId: "workflow-detach",
					agent: "workflow",
					mode: "workflow",
					success: false,
					state: "paused",
					summary: "Workflow paused.",
					sessionId: "session-1",
					timestamp: 1,
					workflow: { trace: [{ type: "run", key: "detaches", state: "detached" }] },
				});
				watcher.primeExistingResults();
				await pausedStarted;
				writeIndexedResult(path.join(resultsDir, "workflow-detach.json"), {
					id: "workflow-detach",
					runId: "workflow-detach",
					agent: "workflow",
					mode: "workflow",
					success: true,
					state: "complete",
					summary: "Workflow completed after detached child finished.",
					sessionId: "session-1",
					timestamp: 2,
					workflow: { trace: [{ type: "run", key: "detaches", state: "completed" }] },
				});
				holdPaused();
				assert.equal(await waitForPredicate(() => state.completedResults?.get("workflow-detach")?.completion.state === "complete"), true);
				assert.equal(emitted.some((entry) => {
					const data = entry.data as { state?: string };
					return entry.event === "subagent:async-complete" && data.state === "complete";
				}), true);
			} finally {
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("keeps a same-state paused replacement written during paused delivery", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-paused-same-state-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on() { return () => {}; },
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let holdPaused: () => void = () => {};
			const pausedHeld = new Promise<void>((resolve) => { holdPaused = resolve; });
			let pausedDeliverStarted: () => void = () => {};
			const pausedStarted = new Promise<void>((resolve) => { pausedDeliverStarted = resolve; });
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				notifier: {
					async deliver(result) {
						if (result.state === "paused" && result.timestamp === 1) {
							pausedDeliverStarted();
							await pausedHeld;
						}
						return true;
					},
				},
			});
			try {
				const resultFile = path.join(resultsDir, "workflow-still-paused.json");
				writeIndexedResult(resultFile, {
					id: "workflow-still-paused",
					runId: "workflow-still-paused",
					agent: "workflow",
					mode: "workflow",
					success: false,
					state: "paused",
					summary: "Workflow paused.",
					sessionId: "session-1",
					timestamp: 1,
					results: [
						{ workflowKey: "first", runId: "child-1", success: false, detached: true, output: "", outputState: "absent" },
						{ workflowKey: "second", runId: "child-2", success: false, detached: true, output: "", outputState: "absent" },
					],
				});
				watcher.primeExistingResults();
				await pausedStarted;
				writeIndexedResult(resultFile, {
					id: "workflow-still-paused",
					runId: "workflow-still-paused",
					agent: "workflow",
					mode: "workflow",
					success: false,
					state: "paused",
					summary: "Workflow paused.",
					sessionId: "session-1",
					timestamp: 2,
					results: [
						{ workflowKey: "first", runId: "child-1", success: true, output: "first child done", outputState: "present" },
						{ workflowKey: "second", runId: "child-2", success: false, detached: true, output: "", outputState: "absent" },
					],
				});
				holdPaused();
				assert.equal(await waitForPredicate(() => {
					const recorded = state.completedResults?.get("workflow-still-paused")?.completion;
					return recorded?.results?.some((child) => child.runId === "child-1" && child.success === true && child.outputState === "present") === true;
				}), true);
			} finally {
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("delivers a terminal result after the paused file was already consumed", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-paused-consumed-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on() { return () => {}; },
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const resultFile = path.join(resultsDir, "workflow-consumed.json");
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, { deliverIntercomResults: false });
			try {
				writeIndexedResult(resultFile, {
					id: "workflow-consumed",
					runId: "workflow-consumed",
					agent: "workflow",
					mode: "workflow",
					success: false,
					state: "paused",
					summary: "Workflow paused.",
					sessionId: "session-1",
					workflow: { trace: [{ type: "run", key: "detaches", state: "detached" }] },
				});
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => !fs.existsSync(resultFile)), true);
				assert.equal(state.completedResults?.get("workflow-consumed")?.completion.state, "paused");
				writeIndexedResult(resultFile, {
					id: "workflow-consumed",
					runId: "workflow-consumed",
					agent: "workflow",
					mode: "workflow",
					success: true,
					state: "complete",
					summary: "Workflow completed after detached child finished.",
					sessionId: "session-1",
					workflow: { trace: [{ type: "run", key: "detaches", state: "completed" }] },
				});
				watcher.primeExistingResults();
				assert.equal(await waitForPredicate(() => state.completedResults?.get("workflow-consumed")?.completion.state === "complete"), true);
				assert.equal(emitted.filter((entry) => {
					const data = entry.data as { state?: string };
					return entry.event === "subagent:async-complete" && data.state === "complete";
				}).length > 0, true);
			} finally {
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("uses local completion fallback silently when no grouped-result listener is available", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on(_event: string, _handler: (payload: unknown) => void) {
						return () => {};
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, { deliverIntercomResults: false });
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				writeIndexedResult(path.join(resultsDir, "async-2.json"), {
					id: "async-2",
					runId: "run-456",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				});
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.some((entry) => entry.event === "subagent:result-intercom"), false);
			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
			assert.equal(logged.some((entry) => /Subagent async grouped result intercom delivery was not acknowledged/.test(String(entry[0] ?? ""))), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("warns when an available grouped-result listener does not acknowledge delivery", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-unacknowledged-listener-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => { logged.push(args); };
			const loggedWarning = () => logged.some((entry) => /Subagent async grouped result intercom delivery was not acknowledged/.test(String(entry[0] ?? "")));
			let warned = false;
			try {
				writeIndexedResult(path.join(resultsDir, "unacknowledged.json"), {
					id: "unacknowledged",
					runId: "run-unacknowledged",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				});
				watcher.primeExistingResults();
				warned = await waitForPredicate(loggedWarning);
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:result-intercom").length, 1);
			assert.equal(warned, true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("marks acknowledged grouped intercom results so local notification is suppressed", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-intercom-ack-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const delivered: Array<{ intercomDelivered?: boolean }> = [];
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				notifier: { async deliver(result) { delivered.push({ intercomDelivered: result.intercomDelivered }); return true; } },
			});
			try {
				writeIndexedResult(path.join(resultsDir, "acknowledged.json"), {
					id: "acknowledged",
					runId: "run-acknowledged",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				});
				watcher.primeExistingResults();
				await waitForPredicate(() => delivered.length === 1);
			} finally {
				watcher.stopResultWatcher();
			}

			assert.deepEqual(delivered, [{ intercomDelivered: true }]);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { intercomDelivered?: boolean } | undefined;
			assert.equal(completion?.intercomDelivered, true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("delivers a result when a previous duplicate key has expired", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-expired-"));
		try {
			const state = createState();
			state.currentSessionId = "session-1";
			const emitted: string[] = [];
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit(event) { emitted.push(event); } } }, state, resultsDir, 60_000);
			const resultFile = "expired.json";
			const result = { sessionId: "session-1", agent: "worker", success: true, summary: "new result", timestamp: 123 };
			const resultPath = path.join(resultsDir, resultFile);
			writeIndexedResult(resultPath, result);
			state.completionSeen.set(buildCompletionKey(result, `result:${resultFile}`), Date.now() - 61_000);
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			assert.deepEqual(emitted, ["subagent:async-complete"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("keeps an unaccepted result for retry and deletes it only after notifier acceptance", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-notifier-retry-"));
		try {
			const state = createState();
			state.currentSessionId = "session-1";
			const emitted: string[] = [];
			let attempts = 0;
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit(event) { emitted.push(event); } } }, state, resultsDir, 60_000, {
				notifier: { async deliver() { attempts += 1; return attempts > 1; } },
			});
			const resultPath = path.join(resultsDir, "retry.json");
			writeIndexedResult(resultPath, { id: "retry", sessionId: "session-1", agent: "worker", success: true, summary: "done", timestamp: 1 });
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 10));
				assert.equal(fs.existsSync(resultPath), true);
				await new Promise((resolve) => setTimeout(resolve, 180));
			} finally {
				watcher.stopResultWatcher();
			}
			assert.equal(attempts, 2);
			assert.equal(fs.existsSync(resultPath), false);
			assert.deepEqual(emitted, ["subagent:async-complete"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("retries delivery after a transient session index access denial", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-index-retry-"));
		const originalError = console.error;
		const originalReadFileSync = fsDefault.readFileSync;
		try {
			console.error = () => {};
			const state = createState();
			state.currentSessionId = "session-1";
			const emitted: string[] = [];
			const fakeWatcher = {
				on() { return fakeWatcher; },
				close() {},
				unref() {},
			} as unknown as fs.FSWatcher;
			let watchEvent: ((event: string, file: string | Buffer | null) => void) | undefined;
			const resultPath = path.join(resultsDir, "index-retry.json");
			writeIndexedResult(resultPath, { id: "index-retry", runId: "index-retry", sessionId: "session-1", agent: "worker", success: true, summary: "done", timestamp: 1 });
			let indexReads = 0;
			fsDefault.readFileSync = ((file, ...args) => {
				if (String(file).includes(`${path.sep}result-index${path.sep}`)) {
					indexReads += 1;
				}
				if (indexReads === 2 && String(file).includes(`${path.sep}result-index${path.sep}`)) {
					const error = new Error("permission denied") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return originalReadFileSync(file, ...args);
			}) as typeof fsDefault.readFileSync;
			syncBuiltinESMExports();

			const watcher = createResultWatcher({ events: { on: () => () => {}, emit(event) { emitted.push(event); } } }, state, resultsDir, 60_000, {
				fs: { ...fs, watch: (_path, callback) => { watchEvent = callback as typeof watchEvent; return fakeWatcher; } },
			});
			try {
				watcher.startResultWatcher();
				watchEvent?.("change", "index-retry.json");
				assert.equal(await waitForPredicate(() => emitted.includes("subagent:async-complete")), true);
			} finally {
				watcher.stopResultWatcher();
			}
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			console.error = originalError;
			fsDefault.readFileSync = originalReadFileSync;
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("drops stale watcher authority without emitting or deleting", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stale-"));
		try {
			const state = createState();
			state.currentSessionId = "session-1";
			const emitted: string[] = [];
			let accept!: (value: boolean) => void;
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit(event) { emitted.push(event); } } }, state, resultsDir, 60_000, {
				notifier: { deliver: () => new Promise<boolean>((resolve) => { accept = resolve; }) },
			});
			const resultPath = path.join(resultsDir, "stale.json");
			writeIndexedResult(resultPath, { id: "stale", sessionId: "session-1", agent: "worker", success: true, summary: "done", timestamp: 1 });
			watcher.primeExistingResults();
			await new Promise((resolve) => setTimeout(resolve, 10));
			watcher.stopResultWatcher();
			accept(true);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(fs.existsSync(resultPath), true);
			assert.deepEqual(emitted, []);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("marks reload backlog display-only", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-quiet-"));
		try {
			const state = createState();
			state.currentSessionId = "session-1";
			const delivered: Array<{ triggerTurn?: boolean }> = [];
			const emitted: string[] = [];
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit(event) { emitted.push(event); } } }, state, resultsDir, 60_000, {
				notifier: { async deliver(result) { delivered.push({ triggerTurn: result.triggerTurn }); return true; } },
			});
			writeIndexedResult(path.join(resultsDir, "quiet.json"), { id: "quiet", sessionId: "session-1", agent: "worker", success: true, summary: "done", timestamp: 1, intercomTarget: "host" });
			try {
				watcher.primeExistingResults({ triggerTurn: false });
				await new Promise((resolve) => setTimeout(resolve, 10));
			} finally {
				watcher.stopResultWatcher();
			}
			assert.deepEqual(delivered, [{ triggerTurn: false }]);
			assert.equal(emitted.includes("subagent:result-intercom"), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	describe("resultScanLogging", () => {
		const slowScan = () => {
			const deadline = Date.now() + 700;
			while (Date.now() < deadline) { /* busy-wait: force elapsed past 500ms threshold */ }
			return new Set<string>();
		};

		const captureScanErrors = (): { errors: string[]; restore: () => void } => {
			const errors: string[] = [];
			const originalError = console.error;
			console.error = (...args: unknown[]) => {
				const message = args.map(String).join(" ");
				if (message.includes("Subagent result scan")) errors.push(message);
			};
			return { errors, restore: () => { console.error = originalError; } };
		};

		const runScan = (deps: Record<string, unknown>) => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-scanlog-"));
			const state = createState();
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				observedCompletionRunIds: slowScan,
				...deps,
			} as Parameters<typeof createRawResultWatcher>[4]);
			try {
				watcher.primeExistingResults();
			} finally {
				watcher.stopResultWatcher();
				fs.rmSync(resultsDir, { recursive: true, force: true });
			}
		};

		it('silences empty slow scans with the default "activity" mode', () => {
			const { errors, restore } = captureScanErrors();
			try {
				runScan({});
				assert.equal(errors.length, 0);
			} finally {
				restore();
			}
		});

		it('logs empty slow scans under explicit "all" mode', () => {
			const { errors, restore } = captureScanErrors();
			try {
				runScan({ resultScanLogging: "all" });
				assert.equal(errors.length, 1);
				assert.match(errors[0], /inspected 0 indexed result file\(s\), scheduled 0/);
			} finally {
				restore();
			}
		});

		it('silences empty slow scans under "activity"', () => {
			const { errors, restore } = captureScanErrors();
			try {
				runScan({ resultScanLogging: "activity" });
				assert.equal(errors.length, 0);
			} finally {
				restore();
			}
		});

		it('keeps slow scans that found work under "activity"', () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-scanlog-work-"));
			const state = createState();
			state.currentSessionId = "session-current";
			writeIndexedResult(path.join(resultsDir, "activity-run.json"), { id: "activity-run", sessionId: "session-current", runId: "activity-run", success: true, summary: "done" });
			const { errors, restore } = captureScanErrors();
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				observedCompletionRunIds: slowScan,
				resultScanLogging: "activity",
			});
			try {
				watcher.primeExistingResults();
				assert.ok(errors.length >= 1, "expected a scan log for a scan that found work");
				assert.match(errors[0], /inspected [1-9]/);
			} finally {
				watcher.stopResultWatcher();
				restore();
				fs.rmSync(resultsDir, { recursive: true, force: true });
			}
		});

		it('silences all slow scans under "off"', () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-scanlog-off-"));
			const state = createState();
			state.currentSessionId = "session-current";
			writeIndexedResult(path.join(resultsDir, "off-run.json"), { id: "off-run", sessionId: "session-current", runId: "off-run", success: true, summary: "done" });
			const { errors, restore } = captureScanErrors();
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				observedCompletionRunIds: slowScan,
				resultScanLogging: "off",
			});
			try {
				watcher.primeExistingResults();
				assert.equal(errors.length, 0);
			} finally {
				watcher.stopResultWatcher();
				restore();
				fs.rmSync(resultsDir, { recursive: true, force: true });
			}
		});
	});

});
