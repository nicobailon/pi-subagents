import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";

interface AsyncJobTrackerModule {
	createAsyncJobTracker(
		pi: { events: { emit(channel: string, data: unknown): void } },
		state: Record<string, unknown>,
		asyncDirRoot: string,
		options?: {
			completionRetentionMs?: number;
			pollIntervalMs?: number;
			resultsDir?: string;
			kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
			now?: () => number;
		},
	): {
		ensurePoller(): void;
		resetJobs(ctx?: unknown): void;
		restoreActiveJobs(ctx?: unknown): void;
		handleStarted(data: unknown): void;
		handleComplete(data: unknown): void;
	};
}

const trackerMod = await tryImport<AsyncJobTrackerModule>("./src/runs/background/async-job-tracker.ts");
const available = !!trackerMod;

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
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

function createEventRecorder() {
	const events: Array<{ channel: string; data: unknown }> = [];
	return {
		pi: {
			events: {
				emit: (channel: string, data: unknown) => {
					events.push({ channel, data });
				},
			},
		},
		events,
	};
}

function pidGone(): never {
	const error = new Error("missing") as NodeJS.ErrnoException;
	error.code = "ESRCH";
	throw error;
}

async function waitForCondition(
	condition: () => boolean,
	description: string,
	timeoutMs = 1000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_theme: string, text: string) => text,
			},
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		get widgets() {
			return widgets;
		},
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("async job tracker", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("removes completed jobs after retention and requests a rerender", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-1", asyncDir: path.join(asyncRoot, "run-1"), agent: "worker" });
			tracker.handleComplete({ id: "run-1", success: true });

			assert.equal(state.asyncJobs.size, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected widget cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("restores active async runs into the widget after reset", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-");
		try {
			const runDir = path.join(asyncRoot, "run-restored");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-restored",
				mode: "chain",
				state: "running",
				sessionId: "session-restored",
				startedAt: 1000,
				lastUpdate: 2000,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{ agent: "reviewer", status: "running", currentTool: "read" },
					{ agent: "worker", status: "running" },
					{ agent: "writer", status: "pending" },
				],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-restored",
					agent: "reviewer",
					message: "old notice",
				},
			})}\n`, "utf-8");

			const state = createState();
			state.currentSessionId = "session-restored";
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.restoreActiveJobs(ui.ctx as never);

			const job = state.asyncJobs.get("run-restored");
			assert.ok(job);
			assert.equal(job.status, "running");
			assert.equal(job.sessionId, "session-restored");
			assert.deepEqual(job.agents, ["reviewer", "worker"]);
			assert.deepEqual(job.steps?.map((step: { index?: number }) => step.index), [1, 2]);
			assert.equal(job.stepsTotal, 2);
			assert.equal(job.runningSteps, 2);
			assert.equal(job.completedSteps, 0);
			assert.equal(job.activeParallelGroup, true);
			assert.ok(state.poller, "expected restored active jobs to start polling");
			assert.ok(ui.renderRequests >= 2, "expected reset and restore to request widget renders");
			assert.equal(typeof ui.widgets.at(-1), "function", "expected restored jobs to render the widget");

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 0, "historical control events should not be replayed during restore");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("restores only active async runs for the current session", () => {
		const asyncRoot = createTempDir("pi-async-job-restore-scope-");
		try {
			const ownerDir = path.join(asyncRoot, "run-owner");
			const otherDir = path.join(asyncRoot, "run-other");
			fs.mkdirSync(ownerDir, { recursive: true });
			fs.mkdirSync(otherDir, { recursive: true });
			fs.writeFileSync(path.join(ownerDir, "status.json"), JSON.stringify({
				runId: "run-owner",
				mode: "single",
				state: "running",
				sessionId: "session-owner",
				startedAt: 1000,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(otherDir, "status.json"), JSON.stringify({
				runId: "run-other",
				mode: "single",
				state: "running",
				sessionId: "session-other",
				startedAt: 1000,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			state.currentSessionId = "session-owner";
			const tracker = trackerMod!.createAsyncJobTracker(createEventRecorder().pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.restoreActiveJobs();

			assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("ignores started and complete events without the current session id", async () => {
		const asyncRoot = createTempDir("pi-async-job-event-scope-");
		try {
			const state = createState();
			state.currentSessionId = "session-owner";
			const tracker = trackerMod!.createAsyncJobTracker(createEventRecorder().pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});

			tracker.handleStarted({ id: "run-sessionless", asyncDir: path.join(asyncRoot, "run-sessionless"), agent: "worker" });
			tracker.handleStarted({ id: "run-other", asyncDir: path.join(asyncRoot, "run-other"), agent: "worker", sessionId: "session-other" });
			tracker.handleStarted({ id: "run-owner", asyncDir: path.join(asyncRoot, "run-owner"), agent: "worker", sessionId: "session-owner" });

			assert.deepEqual([...state.asyncJobs.keys()], ["run-owner"]);

			tracker.handleComplete({ id: "run-owner", success: true });
			tracker.handleComplete({ id: "run-owner", success: true, sessionId: "session-other" });
			assert.equal(state.asyncJobs.get("run-owner")?.status, "queued");

			tracker.handleComplete({ id: "run-owner", success: true, sessionId: "session-owner" });
			await waitForCondition(() => !state.asyncJobs.has("run-owner"), "owned job cleanup after matching completion", 1000);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not throw during restore when a persisted async status is malformed", () => {
		const asyncRoot = createTempDir("pi-async-job-restore-bad-status-");
		const originalError = console.error;
		try {
			const runDir = path.join(asyncRoot, "run-bad-status");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{bad json", "utf-8");

			const state = createState();
			state.currentSessionId = "session-bad";
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const errors: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				errors.push(args);
			};

			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			assert.doesNotThrow(() => tracker.restoreActiveJobs(ui.ctx as never));
			assert.equal(state.asyncJobs.size, 0);
			assert.equal(state.poller, null);
			assert.match(String(errors[0]?.[0] ?? ""), /Failed to restore active async jobs/);
		} finally {
			console.error = originalError;
			removeTempDir(asyncRoot);
		}
	});

	it("uses flattened async-start agents for initial parallel group widget state", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot);

			tracker.handleStarted({
				id: "run-parallel-start",
				asyncDir: path.join(asyncRoot, "run-parallel-start"),
				agent: "scout",
				agents: ["scout", "reviewer", "worker", "writer"],
				chain: ["[scout+reviewer+worker]", "writer"],
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			const job = state.asyncJobs.get("run-parallel-start");
			assert.deepEqual(job?.agents, ["scout", "reviewer", "worker"]);
			assert.equal(job?.chainStepCount, 2);
			assert.deepEqual(job?.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.equal(job?.stepsTotal, 3);
			assert.equal(job?.activeParallelGroup, true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("adds flat step indexes to polled active parallel group steps", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-chain");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-chain",
				mode: "chain",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{
						agent: "reviewer",
						status: "running",
						currentTool: "read",
						currentToolArgs: "src/tui/render.ts",
						recentTools: [{ tool: "grep", args: "async widget", endMs: Date.now() - 100 }],
						recentOutput: ["reviewer line"],
					},
					{ agent: "auditor", status: "running" },
					{ agent: "writer", status: "pending" },
				],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-chain", asyncDir: runDir, mode: "chain", agents: ["scout", "reviewer", "auditor", "writer"] });

			await new Promise((resolve) => setTimeout(resolve, 50));

			const job = state.asyncJobs.get("run-chain");
			assert.deepEqual(job?.steps?.map((step: { index?: number }) => step.index), [1, 2]);
			assert.deepEqual(job?.agents, ["reviewer", "auditor"]);
			assert.equal(job?.steps?.[0]?.currentTool, "read");
			assert.equal(job?.steps?.[0]?.currentToolArgs, "src/tui/render.ts");
			assert.deepEqual(job?.steps?.[0]?.recentTools?.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "grep", args: "async widget" }]);
			assert.deepEqual(job?.steps?.[0]?.recentOutput, ["reviewer line"]);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("rerenders changed polled status but not unchanged bookkeeping", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-unchanged");
			fs.mkdirSync(runDir, { recursive: true });
			const writeStatus = (lastUpdate: number, toolCount?: number) => fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-unchanged",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate,
				...(toolCount !== undefined ? { toolCount } : {}),
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			}), "utf-8");
			writeStatus(2000);

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-unchanged", asyncDir: runDir, agent: "worker" });

			const requestsAfterStart = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.ok(ui.renderRequests > requestsAfterStart, "first status load should redraw the widget");

			const requestsAfterStatusLoaded = ui.renderRequests;
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-unchanged",
					agent: "worker",
					message: "worker needs attention",
				},
			})}\n`, "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
			assert.equal(ui.renderRequests, requestsAfterStatusLoaded, "unchanged status and control cursors should not request widget redraws");

			writeStatus(3000, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.ok(ui.renderRequests > requestsAfterStatusLoaded, "changed non-terminal status should redraw the widget");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("schedules cleanup when polling observes a completed status without a completion event", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-2");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-2",
				mode: "single",
				state: "complete",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-2", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected polling cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("repairs stale running jobs during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-stale-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-stale");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now() - 1000,
				steps: [{ agent: "worker", status: "running", startedAt: Date.now() - 1000 }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now(),
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-stale", asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.size === 0, "stale async job cleanup");

			assert.equal(state.asyncJobs.size, 0);
			assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8")).state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8")).success, false);
			assert.ok(ui.renderRequests > 0, "expected stale repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("repairs started jobs whose runner dies before writing status", async () => {
		const asyncRoot = createTempDir("pi-async-job-no-status-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-no-status");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now() + 2000,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({
				id: "run-no-status",
				asyncDir: runDir,
				pid: 12345,
				sessionId: "session-current",
				mode: "parallel",
				agents: ["scout", "reviewer", "worker"],
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
			const result = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-no-status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.mode, "parallel");
			assert.equal(status.currentStep, 0);
			assert.equal(status.chainStepCount, 1);
			assert.deepEqual(status.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.deepEqual(status.steps.map((step: { agent: string; status: string }) => [step.agent, step.status]), [
				["scout", "failed"],
				["reviewer", "failed"],
				["worker", "failed"],
			]);
			assert.equal(result.success, false);
			assert.equal(result.sessionId, "session-current");
			assert.ok(ui.renderRequests > 0, "expected startup-crash repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("cleans up jobs when status polling hits a terminal read error", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-");
		try {
			const runDir = path.join(asyncRoot, "run-bad-status");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-bad-status", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected malformed status cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not clean up a status-read failure while nested descendants are live", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-nested-");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-bad-status-nested");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-bad-status-nested", asyncDir: runDir, agent: "worker" });
			const job = state.asyncJobs.get("run-bad-status-nested");
			assert.ok(job);
			job.nestedChildren = [{
				id: "nested-live",
				parentRunId: "run-bad-status-nested",
				depth: 1,
				path: [{ runId: "run-bad-status-nested" }],
				state: "running",
				agent: "nested-worker",
			}];

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.has("run-bad-status-nested"), true);
			assert.equal(state.asyncJobs.get("run-bad-status-nested")?.status, "failed");
			assert.equal(state.cleanupTimers.has("run-bad-status-nested"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps root jobs running when nested refresh fails during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-nested-refresh-um");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-nested-refresh");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-nested-refresh",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({
				id: "run-nested-refresh",
				asyncDir: runDir,
				agent: "worker",
				nestedRoute: {
					rootRunId: "run-nested-refresh",
					eventSink: path.join(asyncRoot, "not-contained-events"),
					controlInbox: path.join(asyncRoot, "not-contained-controls"),
					capabilityToken: "bad-token",
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(state.asyncJobs.get("run-nested-refresh")?.status, "running");
			assert.equal(state.cleanupTimers.has("run-nested-refresh"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("cancels cleanup timers when polling observes a non-terminal status", async () => {
		const asyncRoot = createTempDir("pi-async-job-cleanup-cancel-");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		try {
			const runDir = path.join(asyncRoot, "run-recovered");
			fs.mkdirSync(runDir, { recursive: true });
			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 1_000,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-recovered", asyncDir: runDir, agent: "worker" });
			tracker.handleComplete({ id: "run-recovered", success: true });
			assert.equal(state.cleanupTimers.has("run-recovered"), true);

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-recovered",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const deadline = Date.now() + 200;
			while (Date.now() < deadline && state.cleanupTimers.has("run-recovered")) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			assert.equal(state.cleanupTimers.has("run-recovered"), false);
			assert.equal(state.asyncJobs.get("run-recovered")?.status, "running");
		} finally {
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps incomplete async control event lines for the next poll", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-partial");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-partial",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const eventPath = path.join(runDir, "events.jsonl");
			const partialRecord = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-partial",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			fs.writeFileSync(eventPath, partialRecord, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-partial", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 0);

			fs.appendFileSync(eventPath, "\n", "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("scans async control events in bounded chunks", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		const originalAlloc = Buffer.alloc;
		const allocationSizes: number[] = [];
		try {
			const runDir = path.join(asyncRoot, "run-chunked-control");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-chunked-control",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const largeDiagnostic = JSON.stringify({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200_000) }] },
			});
			const controlEvent = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-chunked-control",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${largeDiagnostic}\n${controlEvent}\n`, "utf-8");

			Buffer.alloc = ((size: number, fill?: string | Buffer | number, encoding?: BufferEncoding) => {
				allocationSizes.push(size);
				return originalAlloc(size, fill as never, encoding);
			}) as typeof Buffer.alloc;

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-chunked-control", asyncDir: runDir, agent: "worker" });

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === "subagent:control-event"),
				"chunked control event",
			);
			assert.ok(allocationSizes.length > 0, "expected the tracker to allocate read buffers");
			assert.equal(Math.max(...allocationSizes) <= 64 * 1024, true);
		} finally {
			Buffer.alloc = originalAlloc;
			removeTempDir(asyncRoot);
		}
	});

	it("does not tail-skip control events for newly tracked large logs", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-new-large-control");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-new-large-control",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const controlEvent = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-new-large-control",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			const diagnosticLine = JSON.stringify({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] },
			}) + "\n";
			const eventsPath = path.join(runDir, "events.jsonl");
			fs.writeFileSync(eventsPath, controlEvent + "\n" + diagnosticLine.repeat(900), "utf-8");
			assert.ok(fs.statSync(eventsPath).size > 2 * 1024 * 1024, "test fixture should exceed the legacy scan window");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-new-large-control", asyncDir: runDir, agent: "worker" });

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === "subagent:control-event"),
				"new large log control event",
			);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("starts large legacy control-event scans from a bounded tail window", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		const originalAlloc = Buffer.alloc;
		const originalError = console.error;
		const allocationSizes: number[] = [];
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-large-legacy-control");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-large-legacy-control",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const diagnosticLine = JSON.stringify({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] },
			}) + "\n";
			const controlEvent = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-large-legacy-control",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			const eventsPath = path.join(runDir, "events.jsonl");
			fs.writeFileSync(eventsPath, diagnosticLine.repeat(900) + controlEvent + "\n", "utf-8");
			const eventLogBytes = fs.statSync(eventsPath).size;
			assert.ok(eventLogBytes > 2 * 1024 * 1024, "test fixture should exceed the scan window");

			Buffer.alloc = ((size: number, fill?: string | Buffer | number, encoding?: BufferEncoding) => {
				allocationSizes.push(size);
				return originalAlloc(size, fill as never, encoding);
			}) as typeof Buffer.alloc;

			const state = createState();
			state.asyncJobs.set("run-large-legacy-control", {
				asyncId: "run-large-legacy-control",
				asyncDir: runDir,
				status: "running",
				agents: ["worker"],
				startedAt: Date.now() - 1000,
				updatedAt: Date.now(),
			});
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.ensurePoller();

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === "subagent:control-event"),
				"tail-window control event",
			);
			assert.ok(allocationSizes.length > 0, "expected the tracker to allocate read buffers");
			assert.equal(Math.max(...allocationSizes) <= 64 * 1024, true);
			const totalAllocated = allocationSizes.reduce((sum, size) => sum + size, 0);
			assert.ok(totalAllocated < eventLogBytes, "scan should not read the full legacy event log");
			assert.ok(totalAllocated <= 2 * 1024 * 1024 + 64 * 1024, "scan should stay within the bounded tail window");
		} finally {
			Buffer.alloc = originalAlloc;
			console.error = originalError;
			removeTempDir(asyncRoot);
		}
	});

	it("clears transient current tool fields when status clears them", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-clear-tool");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentTool: "edit",
				currentToolStartedAt: Date.now() - 100,
				currentPath: "src/runs/background/subagent-runner.ts",
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-clear-tool", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			let job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, "edit");
			assert.equal(job?.currentPath, "src/runs/background/subagent-runner.ts");

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			await new Promise((resolve) => setTimeout(resolve, 30));
			job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, undefined);
			assert.equal(job?.currentToolStartedAt, undefined);
			assert.equal(job?.currentPath, undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("honors async control notification channels", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-channels");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-channels",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["intercom"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-channels",
					agent: "worker",
					message: "worker needs attention",
				},
				intercom: { to: "main", message: "SUBAGENT NEEDS ATTENTION: worker in run run-channels." },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-channels", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), false);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not bridge active-long-running records to intercom", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-active-intercom");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-active-intercom",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event", "intercom"],
				event: {
					type: "active_long_running",
					to: "active_long_running",
					ts: 123,
					runId: "run-active-intercom",
					agent: "worker",
					message: "worker is still active but long-running",
				},
				intercom: { to: "main", message: "stale active notice" },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-active-intercom", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), false);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("bridges async control events from events.jsonl to the parent event bus", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-3");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-3",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event", "intercom"],
				childIntercomTarget: "subagent-worker-run-3-1",
				noticeText: "Subagent needs attention: worker\nNudge: intercom({ action: \"send\", to: \"subagent-worker-run-3-1\", message: \"<message>\" })",
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-3",
					agent: "worker",
					message: "worker needs attention",
				},
				intercom: { to: "main", message: "SUBAGENT NEEDS ATTENTION: worker in run run-3." },
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-3", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 40));

			const controlEvent = recorder.events.find((event) => event.channel === "subagent:control-event");
			assert.ok(controlEvent);
			assert.match((controlEvent.data as { noticeText?: string }).noticeText ?? "", /subagent-worker-run-3-1/);
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-intercom"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
