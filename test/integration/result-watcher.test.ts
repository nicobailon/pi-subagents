import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey } from "../../src/runs/background/completion-dedupe.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createScheduledRunManager, scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";
import { prepareMissionLaunch, writeMissionAsyncBinding } from "../../src/missions/lifecycle.ts";
import { readMission, updateMission } from "../../src/missions/store.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
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

describe("result watcher", () => {
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
			const resultPath = path.join(resultsDir, "session-run.json");
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "session-run",
				sessionId: "session-current",
				success: true,
				summary: "done",
			}), "utf-8");

			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(emitted.length, 0);
				assert.equal(fs.existsSync(resultPath), true);

				state.currentSessionId = "session-current";
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(resultPath), false);
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
				config: { globalIndexDir: path.join(root, "global-index") },
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
			fs.writeFileSync(path.join(resultsDir, "async-child.json"), JSON.stringify({
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
			}), "utf-8");
			const state = createState();
			state.currentSessionId = "session-current";
			const watcher = createResultWatcher({ events: { on: () => () => {}, emit() {} } }, state, resultsDir, 60_000, {
				notifier: { deliver: async () => true },
			});
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
			fs.writeFileSync(resultPath, JSON.stringify({ id: "scheduled-a", sessionId: "session-a", success: true, summary: "done" }), "utf-8");
			const watcher = createResultWatcher({
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) { emitted.push({ event, data }); },
				},
			}, state, resultsDir, 60_000, {
				observeCompletion: (result) => manager.handleAsyncCompletion(result),
				notifier: { deliver: async () => assert.fail("inactive-session completion must not reach the live notifier") },
			});
			try {
				watcher.startResultWatcher();
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "native-run",
				runId: "native-run",
				sessionId: "session-native",
				mode: "single",
				success: false,
				state: "failed",
				summary: "Subagent process terminated by signal SIGTERM.",
				results: [{ agent: "worker", output: "", success: false, exitCode: 1, processSignal: "SIGTERM" }],
				intercomTarget: "native-parent",
			}), "utf-8");
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				deliverIntercomResults: false,
				notifier: { deliver: async (result) => { delivered.push(result); return true; } },
			});
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
			const sessionlessResultPath = path.join(resultsDir, "sessionless-run.json");
			try {
				fs.writeFileSync(ownerResultPath, JSON.stringify({
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
				}), "utf-8");
				fs.writeFileSync(sessionlessResultPath, JSON.stringify({
					id: "sessionless-run",
					agent: "worker",
					mode: "single",
					success: true,
					state: "complete",
					summary: "legacy cwd-scoped output",
					results: [{ agent: "worker", output: "legacy cwd-scoped output", success: true }],
					cwd: "/repo",
					intercomTarget: "sessionless-target",
				}), "utf-8");

				otherWatcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
				ownerWatcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
			assert.equal(fs.existsSync(sessionlessResultPath), true);
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
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
			} as fs.FSWatcher;
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
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				fs.writeFileSync(childSessionPath, "", "utf-8");
				fs.writeFileSync(path.join(resultsDir, "async-fallback.json"), JSON.stringify({
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
				}), "utf-8");
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
			assert.equal(fs.existsSync(path.join(resultsDir, "async-fallback.json")), false);
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

				fs.writeFileSync(path.join(resultsDir, "done.json"), JSON.stringify({ sessionId: "session-1", summary: "done" }), "utf-8");
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 75));
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
				fs.writeFileSync(path.join(resultsDir, "async-1.json"), JSON.stringify({
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
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
				fs.writeFileSync(path.join(resultsDir, "async-stopped.json"), JSON.stringify({
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
				}, null, 2), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
				fs.writeFileSync(resultPath, JSON.stringify({
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
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
				fs.writeFileSync(resultPath, JSON.stringify({
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
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-nested-retry",
					runId: "async-nested-retry",
					agent: "owner",
					success: true,
					state: "complete",
					summary: "owner done",
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));

				assert.equal(fs.existsSync(resultPath), true);
				assert.equal(emitted.length, 0);
				assert.ok(
					logged.some((entry) => /will retry later/.test(String(entry[0] ?? ""))),
					"expected nested enrichment retry warning to be logged",
				);

				fs.rmSync(registryPath, { force: true });
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 650));
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
				fs.writeFileSync(path.join(resultsDir, "async-top-session.json"), JSON.stringify({
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
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
				fs.writeFileSync(path.join(resultsDir, "async-paused.json"), JSON.stringify({
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
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
				fs.writeFileSync(path.join(resultsDir, "async-2.json"), JSON.stringify({
					id: "async-2",
					runId: "run-456",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
			try {
				fs.writeFileSync(path.join(resultsDir, "unacknowledged.json"), JSON.stringify({
					id: "unacknowledged",
					runId: "run-unacknowledged",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 600));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:result-intercom").length, 1);
			assert.equal(logged.some((entry) => /Subagent async grouped result intercom delivery was not acknowledged/.test(String(entry[0] ?? ""))), true);
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
				fs.writeFileSync(path.join(resultsDir, "acknowledged.json"), JSON.stringify({
					id: "acknowledged",
					runId: "run-acknowledged",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
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
			fs.writeFileSync(resultPath, JSON.stringify(result), "utf-8");
			state.completionSeen.set(buildCompletionKey(result, `result:${resultFile}`), Date.now() - 61_000);
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 75));
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
			fs.writeFileSync(resultPath, JSON.stringify({ id: "retry", sessionId: "session-1", agent: "worker", success: true, summary: "done", timestamp: 1 }), "utf-8");
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 50));
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
			fs.writeFileSync(resultPath, JSON.stringify({ id: "stale", sessionId: "session-1", agent: "worker", success: true, summary: "done", timestamp: 1 }), "utf-8");
			watcher.primeExistingResults();
			await new Promise((resolve) => setTimeout(resolve, 50));
			watcher.stopResultWatcher();
			accept(true);
			await new Promise((resolve) => setTimeout(resolve, 50));
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
			fs.writeFileSync(path.join(resultsDir, "quiet.json"), JSON.stringify({ id: "quiet", sessionId: "session-1", agent: "worker", success: true, summary: "done", timestamp: 1, intercomTarget: "host" }), "utf-8");
			try {
				watcher.primeExistingResults({ triggerTurn: false });
				await new Promise((resolve) => setTimeout(resolve, 75));
			} finally {
				watcher.stopResultWatcher();
			}
			assert.deepEqual(delivered, [{ triggerTurn: false }]);
			assert.equal(emitted.includes("subagent:result-intercom"), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

});
