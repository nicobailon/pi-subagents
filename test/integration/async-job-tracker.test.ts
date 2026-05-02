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
		resetJobs(ctx?: unknown): void;
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

			await new Promise((resolve) => setTimeout(resolve, 80));

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
