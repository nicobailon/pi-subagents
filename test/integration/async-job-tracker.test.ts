import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { getArtifactsDir } from "../../src/shared/artifacts.ts";
import { SUBAGENT_CHILD_STATUS_EVENT } from "../../src/shared/types.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { SubagentFleetComponent } from "../../src/tui/fleet.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
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
			widgetEnabled?: boolean;
			platform?: NodeJS.Platform;
			onJobTerminal?: () => void;
			watch?: typeof fs.watch;
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

type AsyncJobTracker = ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]>;
const activeTrackers = new Set<AsyncJobTracker>();

function createTracker(...args: Parameters<AsyncJobTrackerModule["createAsyncJobTracker"]>): AsyncJobTracker {
	args[3] = { platform: "linux", ...(args[3] ?? {}) };
	const tracker = trackerMod!.createAsyncJobTracker(...args);
	activeTrackers.add(tracker);
	return tracker;
}

afterEach(() => {
	for (const tracker of activeTrackers) tracker.resetJobs();
	activeTrackers.clear();
});

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
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
				bold: (text: string) => text,
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
	it("drops stale captured extension contexts instead of crashing background timers", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-stale-context-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot);
			(state as { lastUiContext: unknown }).lastUiContext = {
				get hasUI() {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				},
			};

			tracker.handleStarted({ id: "run-stale-context", asyncDir: path.join(asyncRoot, "run-stale-context"), agent: "worker" });

			assert.equal(state.lastUiContext, null);
			if (state.poller) clearInterval(state.poller);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("stores only parent-registered session roots from async start events", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-session-root-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot);
			const sessionRoot = path.join(asyncRoot, "custom-sessions");
			state.liveAsyncSessionRoots = new Map([["run-custom-session", sessionRoot]]);

			tracker.handleStarted({ id: "run-custom-session", asyncDir: path.join(asyncRoot, "run-custom-session"), agent: "worker", sessionRoot: path.join(asyncRoot, "forged") });

			assert.equal(state.asyncJobs.get("run-custom-session")?.sessionRoot, sessionRoot);
			assert.equal(state.liveAsyncSessionRoots.has("run-custom-session"), false);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("ignores unregistered session roots from async start events", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-forged-session-root-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot);

			tracker.handleStarted({ id: "run-forged-session", asyncDir: path.join(asyncRoot, "run-forged-session"), agent: "worker", sessionRoot: path.join(asyncRoot, "forged") });

			assert.equal(state.asyncJobs.get("run-forged-session")?.sessionRoot, undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("clears pending live session roots on reset", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-reset-session-root-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot);
			state.liveAsyncSessionRoots = new Map([["run-pending", path.join(asyncRoot, "sessions")]]);

			tracker.resetJobs();

			assert.equal(state.liveAsyncSessionRoots.size, 0);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("removes completed jobs after retention and requests a rerender", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-1", asyncDir: path.join(asyncRoot, "run-1"), agent: "worker" });
			tracker.handleComplete({ id: "run-1", success: true });

			assert.equal(state.asyncJobs.size, 1);
			assert.equal(state.fleetJobs.size, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));

			assert.equal(state.asyncJobs.size, 0);
			assert.equal(state.fleetJobs.get("run-1")?.status, "complete", "fleet history should outlive widget cleanup");
			assert.ok(ui.renderRequests > 0, "expected widget cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("keeps the async widget cleared when it is disabled", () => {
		const asyncRoot = createTempDir("pi-async-job-widget-disabled-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
				widgetEnabled: false,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-hidden", asyncDir: path.join(asyncRoot, "run-hidden"), agent: "worker" });

			assert.equal(state.asyncJobs.size, 1, "disabled rendering must not disable lifecycle tracking");
			assert.ok(ui.widgets.length > 0, "expected widget clear calls");
			assert.ok(ui.widgets.every((widget) => widget === undefined), "disabled widget must stay cleared");
			tracker.resetJobs(ui.ctx as never);
			assert.equal(state.fleetJobs.size, 0, "session reset should clear fleet history");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("rebuilds the async widget on quiet animation ticks without a UI requestRender bridge", async () => {
		const asyncRoot = createTempDir("pi-async-job-widget-animation-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, { pollIntervalMs: 10 });
			const ctx = {
				...ui.ctx,
				ui: {
					...ui.ctx.ui,
					requestRender: undefined,
				},
			};

			tracker.resetJobs(ctx as never);
			tracker.handleStarted({ id: "run-animating", asyncDir: path.join(asyncRoot, "run-animating"), agent: "worker" });
			await waitForCondition(() => state.asyncJobs.get("run-animating")?.status === "running", "initial running status refresh");
			const widgetCount = ui.widgets.length;

			await waitForCondition(() => ui.widgets.length > widgetCount, "animation tick widget rebuild", 1300);
			assert.equal(ui.renderRequests, 0, "test fixture requestRender bridge must stay unavailable");
			assert.notEqual(ui.widgets.at(-1), undefined, "running widget should be rebuilt, not cleared");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("restores active async runs into the widget after reset", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-");
		try {
			const runDir = path.join(asyncRoot, "run-restored");
			const customCwd = path.join(asyncRoot, "custom-cwd");
			const sessionFile = path.join(asyncRoot, "sessions", "session-restored.jsonl");
			const artifactsRoot = getArtifactsDir(sessionFile, customCwd);
			const transcriptPath = path.join(artifactsRoot, "run-restored_reviewer_transcript.jsonl");
			fs.mkdirSync(runDir, { recursive: true });
			fs.mkdirSync(artifactsRoot, { recursive: true });
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: "message", role: "assistant", text: "Restored custom cwd transcript" })}\n`, "utf-8");
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-restored",
				mode: "chain",
				state: "running",
				sessionId: "session-restored",
				cwd: customCwd,
				sessionFile,
				startedAt: 1000,
				lastUpdate: 2000,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{ agent: "reviewer", status: "running", currentTool: "read", transcriptPath },
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
			updateActiveRunIndex(runDir, "running");

			const state = createState();
			state.currentSessionId = "session-restored";
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.restoreActiveJobs(ui.ctx as never);

			const job = state.asyncJobs.get("run-restored");
			assert.ok(job);
			assert.equal(job.status, "running");
			assert.equal(job.sessionId, "session-restored");
			assert.equal(job.cwd, customCwd);
			assert.deepEqual(job.agents, ["reviewer", "worker"]);
			assert.deepEqual(job.steps?.map((step: { index?: number }) => step.index), [1, 2]);
			assert.equal(job.stepsTotal, 2);
			assert.equal(job.runningSteps, 2);
			assert.equal(job.completedSteps, 0);
			assert.equal(job.activeParallelGroup, true);
			assert.ok(state.poller, "expected restored active jobs to start polling");
			assert.ok(ui.renderRequests >= 2, "expected reset and restore to request widget renders");
			assert.equal(typeof ui.widgets.at(-1), "function", "expected restored jobs to render the widget");

			const component = new SubagentFleetComponent(
				{ terminal: { rows: 28, columns: 100 }, requestRender() {} } as never,
				ui.ctx.ui.theme as never,
				state as never,
				() => {},
				{ refreshMs: 60_000 },
			);
			try {
				assert.ok(component.render(100).some((line) => line.includes("Restored custom cwd transcript")));
			} finally {
				component.dispose();
			}

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 0, "historical control events should not be replayed during restore");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("refreshes restored nested async children from event files before the liveness sweep", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-nested-events-");
		const nestedRoute = createNestedRoute("run-restored-nested");
		const routeRoot = path.dirname(nestedRoute.eventSink);
		try {
			const runDir = path.join(asyncRoot, "run-restored-nested");
			const statusPath = path.join(runDir, "status.json");
			fs.mkdirSync(runDir, { recursive: true });
			const statusPayload = {
				runId: "run-restored-nested",
				mode: "single",
				state: "running",
				sessionId: "session-restored-nested",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "running" }],
			};
			fs.writeFileSync(statusPath, JSON.stringify(statusPayload), "utf-8");
			updateActiveRunIndex(runDir, "running");
			const state = createState();
			state.currentSessionId = "session-restored-nested";
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, { pollIntervalMs: 60_000 });
			tracker.restoreActiveJobs();
			assert.equal(state.asyncJobs.get("run-restored-nested")?.nestedRoute?.eventSink, nestedRoute.eventSink);

			await new Promise((resolve) => setTimeout(resolve, 150));
			fs.writeFileSync(path.join(nestedRoute.eventSink, "0000000003000-child.json"), JSON.stringify({
				type: "subagent.nested.started",
				ts: 3000,
				rootRunId: nestedRoute.rootRunId,
				parentRunId: "run-restored-nested",
				parentStepIndex: 0,
				capabilityToken: nestedRoute.capabilityToken,
				child: {
					id: "nested-child",
					parentRunId: "run-restored-nested",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-restored-nested", stepIndex: 0 }],
					state: "running",
					agent: "nested-worker",
				},
			}), "utf-8");
			fs.writeFileSync(statusPath, JSON.stringify({ ...statusPayload, lastUpdate: 3001 }), "utf-8");

			await waitForCondition(() => state.asyncJobs.get("run-restored-nested")?.nestedChildren?.[0]?.id === "nested-child", "restored evented nested child refresh", 3000);
			assert.equal(state.asyncJobs.get("run-restored-nested")?.steps?.[0]?.children?.[0]?.id, "nested-child");
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
			removeTempDir(routeRoot);
		}
	});

	it("refreshes restored workflow status from filesystem events before the liveness sweep", async () => {
		const asyncRoot = createTempDir("pi-async-job-restore-workflow-");
		try {
			const runDir = path.join(asyncRoot, "workflow-run");
			fs.mkdirSync(runDir, { recursive: true });
			const statusPath = path.join(runDir, "status.json");
			fs.writeFileSync(statusPath, JSON.stringify({
				runId: "workflow-run",
				mode: "workflow",
				state: "running",
				sessionId: "session-workflow",
				sessionRoot: "/trusted/workflow-sessions",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "scan", label: "scan", status: "running" }],
				workflow: { trace: [{ operation: "run", key: "scan", state: "started" }], emits: [{ stage: "scan" }], console: [] },
			}), "utf-8");
			updateActiveRunIndex(runDir, "running");
			const state = createState();
			state.currentSessionId = "session-workflow";
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, { pollIntervalMs: 60_000 });
			tracker.restoreActiveJobs();
			assert.deepEqual(state.asyncJobs.get("workflow-run")?.workflow?.emits, [{ stage: "scan" }]);
			assert.equal(state.asyncJobs.get("workflow-run")?.sessionRoot, "/trusted/workflow-sessions");

			fs.writeFileSync(statusPath, JSON.stringify({
				runId: "workflow-run",
				mode: "workflow",
				state: "running",
				sessionId: "session-workflow",
				startedAt: 1000,
				lastUpdate: 3000,
				steps: [{ agent: "scan", label: "scan", status: "complete" }, { agent: "review", label: "review", status: "running" }],
				workflow: { trace: [{ operation: "run", key: "review", state: "started" }], emits: [{ stage: "review" }], console: [] },
			}), "utf-8");
			await waitForCondition(() => JSON.stringify(state.asyncJobs.get("workflow-run")?.workflow?.emits) === JSON.stringify([{ stage: "review" }]), "evented workflow refresh", 1000);
			assert.equal(state.asyncJobs.get("workflow-run")?.workflow?.trace[0]?.key, "review");
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("refreshes newly started runs when status appears after the run directory", async () => {
		const asyncRoot = createTempDir("pi-async-job-late-status-");
		try {
			const runDir = path.join(asyncRoot, "late-status-run");
			fs.mkdirSync(runDir, { recursive: true });
			const state = createState();
			state.currentSessionId = "session-late-status";
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, { pollIntervalMs: 60_000 });
			tracker.handleStarted({ id: "late-status-run", asyncDir: runDir, sessionId: "session-late-status", agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 150));
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "late-status-run",
				mode: "single",
				state: "running",
				sessionId: "session-late-status",
				startedAt: 1000,
				lastUpdate: 3000,
				steps: [{ agent: "worker", status: "running", currentTool: "read" }],
			}), "utf-8");

			await waitForCondition(() => state.asyncJobs.get("late-status-run")?.steps?.[0]?.currentTool === "read", "late status refresh before liveness", 1000);
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not request quiet running widget renders on every liveness tick", async () => {
		const asyncRoot = createTempDir("pi-async-job-quiet-widget-");
		try {
			const runDir = path.join(asyncRoot, "quiet-run");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "quiet-run",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const state = createState();
			const ui = createUiContext();
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, { pollIntervalMs: 10 });
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "quiet-run", asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.get("quiet-run")?.status === "running", "quiet running job refresh");
			const renderRequests = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 120));

			assert.equal(ui.renderRequests, renderRequests);
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("uses polling without native watchers on Darwin and fires terminal delivery hooks once", async () => {
		const asyncRoot = createTempDir("pi-async-job-darwin-poll-");
		try {
			const runDir = path.join(asyncRoot, "darwin-run");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "darwin-run",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const state = createState();
			let nativeWatchCalls = 0;
			let terminalHooks = 0;
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, {
				platform: "darwin",
				pollIntervalMs: 10,
				onJobTerminal: () => terminalHooks++,
				watch: (() => {
					nativeWatchCalls++;
					throw new Error("Darwin tracker must not create native watchers");
				}) as typeof fs.watch,
			});
			tracker.handleStarted({ id: "darwin-run", asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.get("darwin-run")?.status === "running", "darwin polling started");
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "darwin-run",
				mode: "single",
				state: "complete",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			await waitForCondition(() => state.asyncJobs.get("darwin-run")?.status === "complete", "darwin terminal refresh");
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(nativeWatchCalls, 0);
			assert.equal(terminalHooks, 1);
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("refreshes nested async children from event files before the liveness sweep", async () => {
		const asyncRoot = createTempDir("pi-async-job-nested-events-");
		const nestedRoute = createNestedRoute("run-nested-events");
		const routeRoot = path.dirname(nestedRoute.eventSink);
		try {
			const runDir = path.join(asyncRoot, "run-nested-events");
			fs.mkdirSync(runDir, { recursive: true });
			const statusPath = path.join(runDir, "status.json");
			const statusPayload = {
				runId: "run-nested-events",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate: 2000,
				steps: [{ agent: "worker", status: "running" }],
			};
			fs.writeFileSync(statusPath, JSON.stringify(statusPayload), "utf-8");
			const state = createState();
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, { pollIntervalMs: 60_000 });
			tracker.handleStarted({ id: "run-nested-events", asyncDir: runDir, agent: "worker", nestedRoute });

			await new Promise((resolve) => setTimeout(resolve, 150));
			fs.writeFileSync(path.join(nestedRoute.eventSink, "0000000003000-child.json"), JSON.stringify({
				type: "subagent.nested.started",
				ts: 3000,
				rootRunId: nestedRoute.rootRunId,
				parentRunId: "run-nested-events",
				parentStepIndex: 0,
				capabilityToken: nestedRoute.capabilityToken,
				child: {
					id: "nested-child",
					parentRunId: "run-nested-events",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "run-nested-events", stepIndex: 0 }],
					state: "running",
					agent: "nested-worker",
				},
			}), "utf-8");
			fs.writeFileSync(statusPath, JSON.stringify({ ...statusPayload, lastUpdate: 3000 }), "utf-8");

			await waitForCondition(() => state.asyncJobs.get("run-nested-events")?.nestedChildren?.[0]?.id === "nested-child", "evented nested child refresh", 3000);
			assert.equal(state.asyncJobs.get("run-nested-events")?.steps?.[0]?.children?.[0]?.id, "nested-child");
			tracker.resetJobs();
		} finally {
			removeTempDir(asyncRoot);
			removeTempDir(routeRoot);
		}
	});

	it("restores async workflow child ownership after reload", () => {
		const asyncRoot = createTempDir("pi-async-job-restore-workflow-child-");
		try {
			const runDir = path.join(asyncRoot, "workflow-child");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "workflow-child",
				mode: "single",
				state: "running",
				sessionId: "session-workflow",
				startedAt: 1000,
				parentWorkflowRunId: "workflow-parent",
				workflowKey: "review",
				steps: [{ agent: "reviewer", status: "running" }],
			}), "utf-8");
			updateActiveRunIndex(runDir, "running");
			const state = createState();
			state.currentSessionId = "session-workflow";
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, { pollIntervalMs: 10 });
			tracker.restoreActiveJobs();
			assert.equal(state.asyncJobs.get("workflow-child")?.parentWorkflowRunId, "workflow-parent");
			assert.equal(state.asyncJobs.get("workflow-child")?.workflowKey, "review");
			tracker.resetJobs();
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
			updateActiveRunIndex(ownerDir, "running");
			updateActiveRunIndex(otherDir, "running");

			const state = createState();
			state.currentSessionId = "session-owner";
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, {
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
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, {
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
			updateActiveRunIndex(runDir, "running");

			const state = createState();
			state.currentSessionId = "session-bad";
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const errors: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				errors.push(args);
			};

			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot);

			tracker.handleStarted({
				id: "run-parallel-start",
				asyncDir: path.join(asyncRoot, "run-parallel-start"),
				cwd: path.join(asyncRoot, "custom-cwd"),
				agent: "scout",
				agents: ["scout", "reviewer", "worker", "writer"],
				chain: ["[scout+reviewer+worker]", "writer"],
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			const job = state.asyncJobs.get("run-parallel-start");
			assert.deepEqual(job?.agents, ["scout", "reviewer", "worker"]);
			assert.equal(job?.cwd, path.join(asyncRoot, "custom-cwd"));
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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

	it("rebuilds unchanged running widgets for quiet animation ticks and stops at terminal status", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		try {
			const runDir = path.join(asyncRoot, "run-unchanged");
			fs.mkdirSync(runDir, { recursive: true });
			const writeStatus = (lastUpdate: number, toolCount?: number, state = "running") => fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-unchanged",
				mode: "single",
				state,
				startedAt: 1000,
				lastUpdate,
				...(toolCount !== undefined ? { toolCount } : {}),
				steps: [{ agent: "worker", status: state === "running" ? "running" : "complete", startedAt: 1000 }],
			}), "utf-8");
			writeStatus(2000);

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			tracker = createTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-unchanged", asyncDir: runDir, agent: "worker" });

			const requestsAfterStart = ui.renderRequests;
			await waitForCondition(() => state.asyncJobs.get("run-unchanged")?.updatedAt === 2000, "first status load");
			assert.ok(ui.renderRequests > requestsAfterStart, "first status load should redraw the widget");

			const requestsAfterStatusLoaded = ui.renderRequests;
			const widgetsAfterStatusLoaded = ui.widgets.length;
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
			await waitForCondition(() => recorder.events.some((event) => event.channel === "subagent:control-event"), "control event delivery");
			await waitForCondition(() => ui.widgets.length > widgetsAfterStatusLoaded, "running widget cadence rebuild");
			assert.ok(ui.renderRequests > requestsAfterStatusLoaded, "running widget cadence rebuild should request a repaint when the bridge supports it");

			writeStatus(3000, 1);
			await waitForCondition(() => state.asyncJobs.get("run-unchanged")?.toolCount === 1, "changed status load");
			assert.ok(ui.widgets.length > widgetsAfterStatusLoaded, "changed status should replace the widget component");

			writeStatus(4000, 1, "complete");
			await waitForCondition(() => state.asyncJobs.get("run-unchanged")?.status === "complete", "terminal status load");
			const widgetsAfterTerminal = ui.widgets.length;
			const requestsAfterTerminal = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.equal(ui.widgets.length, widgetsAfterTerminal, "terminal-only jobs must not rebuild on the cadence");
			assert.equal(ui.renderRequests, requestsAfterTerminal, "terminal-only jobs must not request cadence repaints");
		} finally {
			tracker?.resetJobs();
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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

	it("watches run directories created after the start event", async () => {
		const asyncRoot = createTempDir("pi-async-job-late-dir-");
		try {
			const runDir = path.join(asyncRoot, "run-late-dir");
			const state = createState();
			const tracker = createTracker(createEventRecorder().pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 60_000,
			});
			tracker.handleStarted({ id: "run-late-dir", asyncDir: runDir, agent: "worker" });
			await waitForCondition(() => state.asyncJobs.get("run-late-dir")?.status === "running", "initial event refresh");

			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-late-dir",
				mode: "single",
				state: "complete",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			await waitForCondition(() => !state.asyncJobs.has("run-late-dir"), "evented terminal cleanup");
			tracker.resetJobs();
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
				sessionId: "session-stale",
				pid: 12345,
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now() - 1000,
				steps: [{ agent: "worker", status: "running", startedAt: Date.now() - 1000 }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now(),
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-stale", asyncDir: runDir, agent: "worker", sessionId: "session-stale" });

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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
				completionOwnerId: "owner-current",
				mode: "parallel",
				agents: ["scout", "reviewer", "worker"],
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			await waitForCondition(() => state.asyncJobs.size === 0, "startup-crash repair cleanup");

			assert.equal(state.asyncJobs.size, 0);
			const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
			const result = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-no-status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.completionOwnerId, "owner-current");
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
			assert.equal(result.completionOwnerId, "owner-current");
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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

	it("resynchronizes when a saved cursor resumes inside an oversized JSONL record", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		const originalError = console.error;
		const errors: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		try {
			const runDir = path.join(asyncRoot, "run-midline-oversized-control");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-midline-oversized-control",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const largeDiagnostic = JSON.stringify({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2_500_000) }] },
			});
			const controlEvent = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-midline-oversized-control",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${largeDiagnostic}\n${controlEvent}\n`, "utf-8");

			const state = createState();
			state.asyncJobs.set("run-midline-oversized-control", {
				asyncId: "run-midline-oversized-control",
				asyncDir: runDir,
				status: "running",
				agents: ["worker"],
				startedAt: Date.now() - 1000,
				updatedAt: Date.now(),
				controlEventCursor: 0,
			});
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.ensurePoller();

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === "subagent:control-event"),
				"control event after oversized diagnostic",
			);
			assert.equal(errors.some((args) => String(args[0]).includes("Ignoring malformed async control event")), false);
		} finally {
			console.error = originalError;
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
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

	it("bridges async child status events from events.jsonl to the parent event bus", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-child-status");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-child-status",
				mode: "parallel",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", workflowKey: "slow" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.child-status",
				version: 1,
				runId: "run-child-status",
				childId: "slow",
				status: "stopped",
				ts: 123,
				reason: "user",
				stepIndex: 0,
				agent: "worker",
				workflowKey: "slow",
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = createTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-child-status", asyncDir: runDir, agent: "workflow" });

			await waitForCondition(
				() => recorder.events.some((event) => event.channel === SUBAGENT_CHILD_STATUS_EVENT),
				"child status event",
			);

			const event = recorder.events.find((entry) => entry.channel === SUBAGENT_CHILD_STATUS_EVENT)!;
			assert.deepEqual(event.data, {
				type: "subagent.child-status",
				version: 1,
				runId: "run-child-status",
				childId: "slow",
				status: "stopped",
				ts: 123,
				reason: "user",
				source: "async",
				asyncDir: runDir,
				stepIndex: 0,
				agent: "worker",
				workflowKey: "slow",
			});
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
