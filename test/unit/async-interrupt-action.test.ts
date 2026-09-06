import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { acquireActiveAsyncCapacity } from "../../src/runs/background/active-async-capacity.ts";
import { consumeSteerRequests, consumeStopRequestPayload } from "../../src/runs/background/control-channel.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { createSubagentExecutor, steerWorkflowChildByKey } from "../../src/runs/foreground/subagent-executor.ts";
import { resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { steerWorkflowForegroundTarget } from "../../src/runs/foreground/workflow-foreground-steering.ts";
import { ASYNC_DIR, RESULTS_DIR, type ForegroundChildControl, type ForegroundSteerInput, type SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function writeJson(filePath: string, value: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function createRunningAsync(state: SubagentState, runId: string, options: { track?: boolean; sessionId?: string; state?: "queued" | "running"; pid?: number; mode?: "single" | "workflow" } = {}): string {
	const asyncDir = path.join(ASYNC_DIR, runId);
	const runState = options.state ?? "running";
	writeJson(path.join(asyncDir, "status.json"), {
		runId,
		mode: options.mode ?? "single",
		state: runState,
		sessionId: options.sessionId ?? "session",
		...(options.pid !== undefined ? { pid: options.pid } : runState === "running" ? { pid: 12345 } : {}),
		cwd: os.tmpdir(),
		startedAt: 100,
		lastUpdate: Date.now(),
		steps: [{ agent: "worker", status: "running", startedAt: 100 }],
	});
	if (options.track !== false) {
		state.asyncJobs.set(runId, {
			asyncId: runId,
			asyncDir,
			status: "running",
			pid: 12345,
			agents: ["worker"],
			updatedAt: 100,
		});
	}
	return asyncDir;
}

function cleanup(runId: string, asyncDir: string): void {
	fs.rmSync(asyncDir, { recursive: true, force: true });
	fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
}

interface RecordedSteer {
	message: string;
	mode?: string;
}

function createWorkflowForegroundControl(
	state: SubagentState,
	workflowRunId: string,
	childRunId: string,
	options: { steer?: ForegroundChildControl["steer"] | null } = {},
): RecordedSteer[] {
	const steers: RecordedSteer[] = [];
	const steer = options.steer === null
		? undefined
		: options.steer ?? (async (input: ForegroundSteerInput) => {
			steers.push({ message: input.message, ...(input.mode ? { mode: input.mode } : {}) });
			return { state: input.mode === "follow_up" ? "queued" as const : "delivered" as const };
		});
	state.workflowControllers ??= new Map();
	state.workflowControllers.set(workflowRunId, new AbortController());
	state.foregroundControls.set(childRunId, {
		runId: childRunId,
		parentWorkflowRunId: workflowRunId,
		workflowKey: childRunId,
		sessionId: "session",
		mode: "single",
		startedAt: 100,
		updatedAt: 100,
		activeChildren: new Map([[0, { index: 0, agent: "worker", startedAt: 100, updatedAt: 100, ...(steer ? { steer } : {}) }]]),
		schedulingOwners: 1,
	});
	return steers;
}

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for async control test condition.");
}

function executorWithKill(state: SubagentState, kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean, options: { allowMutatingManagementActions?: boolean } = {}) {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [] }),
		kill,
		...options,
	});
}

function ctx() {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return null; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
}

describe("async interrupt action", () => {
	it("routes debug.run to async lifecycle debug, not live foreground status", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `debug-foreground-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session" });
		state.foregroundControls.set(runId, {
			runId,
			sessionId: "session",
			mode: "single",
			startedAt: 100,
			updatedAt: 100,
			cwd: os.tmpdir(),
			agent: "worker",
			status: "running",
			controller: new AbortController(),
		});
		try {
			const result = await executorWithKill(state, () => true)
				.execute("debug.run", { action: "debug.run", id: runId }, new AbortController().signal, undefined, ctx());
			const output = text(result);

			assert.equal(result.isError, undefined);
			assert.match(output, /Run lifecycle debug/);
			assert.doesNotMatch(output, /Live foreground/);
		} finally {
			state.foregroundControls.delete(runId);
			cleanup(runId, asyncDir);
		}
	});

	it("renders run lifecycle debug without transcript content", () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `debug-run-${Date.now().toString(36)}`;
		const activeCapacityRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-debug-capacity-"));
		const asyncDir = path.join(ASYNC_DIR, runId);
		try {
			const capacity = acquireActiveAsyncCapacity({ sessionId: "session", limit: 1, runId, kind: "workflow", asyncDir }, { rootDir: activeCapacityRoot });
			assert.ok(capacity);
			capacity.markWorkflowStarted();
			writeJson(path.join(asyncDir, "status.json"), {
				runId,
				sessionId: "session",
				mode: "workflow",
				state: "complete",
				startedAt: 100,
				processTerminal: { version: 1, state: "pending", runId, runnerProcessInstanceId: "workflow-runner" },
				steps: [{ agent: "worker", workflowKey: "review", status: "completed", async: false }],
			});
			fs.writeFileSync(path.join(asyncDir, "output-0.log"), "SECRET_TRANSCRIPT_TEXT", "utf-8");

			const result = inspectSubagentStatus({ action: "debug.run", id: runId }, { state, activeCapacityRoot });
			const output = text(result);

			assert.match(output, /Run lifecycle debug/);
			assert.match(output, new RegExp(`Run: ${runId}`));
			assert.match(output, /Status process terminal: pending · runner workflow-runner/);
			assert.match(output, /Sidecar process terminal: missing/);
			assert.match(output, /Active capacity: releasable/);
			assert.match(output, /Workflow children: 1/);
			assert.match(output, /key review · worker · completed · async no/);
			assert.doesNotMatch(output, /SECRET_TRANSCRIPT_TEXT/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(activeCapacityRoot, { recursive: true, force: true });
		}
	});

	it("steers a live workflow-owned foreground child by child id", async () => {
		const state = createState();
		const workflowRunId = `workflow-child-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const steers = createWorkflowForegroundControl(state, workflowRunId, childRunId);
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: childRunId, message: "Focus on the failing test." }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.state, "delivered");
			assert.equal(result.details.steering?.sourceRunId, childRunId);
			assert.deepEqual(steers, [{ message: "Focus on the failing test." }]);
			assert.match(text(result), /Message sent:\n```text\nFocus on the failing test\.\n```/);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("steers a foreground workflow child by stable key", async () => {
		const state = createState();
		const workflowRunId = `workflow-key-foreground-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-writer`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const steers = createWorkflowForegroundControl(state, workflowRunId, childRunId);
		try {
			const action = await steerWorkflowChildByKey({ state, workflowRunId, key: childRunId, message: "Focus on the contract.", options: { ackTimeoutMs: 500 } });
			assert.equal(action.state, "delivered");
			assert.deepEqual(steers, [{ message: "Focus on the contract." }]);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("retries a foreground workflow-key steer until the child session is running", async () => {
		const state = createState();
		const workflowRunId = `workflow-key-early-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-writer`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		let attempts = 0;
		createWorkflowForegroundControl(state, workflowRunId, childRunId, { steer: async () => ++attempts < 3 ? { state: "failed" as const, reason: "Child session is not running yet." } : { state: "delivered" as const } });
		try {
			const action = await steerWorkflowChildByKey({ state, workflowRunId, key: childRunId, message: "Early.", options: { ackTimeoutMs: 500 } });
			assert.equal(action.state, "delivered");
			assert.equal(attempts, 3);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("routes a stable key to async steering without recovery", async () => {
		const state = createState();
		const workflowRunId = `workflow-key-async-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const workflowDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const childDir = createRunningAsync(state, childRunId, { track: false });
		const childStatus = JSON.parse(fs.readFileSync(path.join(childDir, "status.json"), "utf-8"));
		childStatus.pid = process.pid;
		writeJson(path.join(childDir, "status.json"), childStatus);
		const workflowStatus = JSON.parse(fs.readFileSync(path.join(workflowDir, "status.json"), "utf-8"));
		workflowStatus.steps = [];
		writeJson(path.join(workflowDir, "status.json"), workflowStatus);
		const controller = new AbortController();
		try {
			const action = steerWorkflowChildByKey({ state, workflowRunId, key: "writer", message: "Use the new API.", options: { ackTimeoutMs: 500 }, signal: controller.signal, resolveRunId: () => childRunId });
			await waitUntil(() => consumeSteerRequests(childDir)[0] ? true : undefined);
			controller.abort();
			assert.equal((await action).state, "queued");
			assert.equal(fs.existsSync(path.join(childDir, "control", "steer-recovery")), false);
		} finally {
			cleanup(workflowRunId, workflowDir);
			cleanup(childRunId, childDir);
		}
	});

	it("rejects workflow-key steering for a one-shot external CLI child", async () => {
		const state = createState();
		const workflowRunId = `workflow-key-external-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const workflowDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const childDir = createRunningAsync(state, childRunId, { track: false });
		const workflowStatus = JSON.parse(fs.readFileSync(path.join(workflowDir, "status.json"), "utf-8"));
		workflowStatus.steps = [{ agent: "external", status: "running", workflowKey: "external", runId: childRunId, async: true }];
		writeJson(path.join(workflowDir, "status.json"), workflowStatus);
		const childStatus = JSON.parse(fs.readFileSync(path.join(childDir, "status.json"), "utf-8"));
		childStatus.pid = process.pid;
		childStatus.steps[0].runner = resolveExternalCliRunnerStatus({ command: "review-cli" });
		writeJson(path.join(childDir, "status.json"), childStatus);
		try {
			const result = await steerWorkflowChildByKey({ state, workflowRunId, key: "external", message: "Do not deliver.", options: { ackTimeoutMs: 20 } });
			assert.equal(result.state, "failed");
			assert.match(result.error ?? "", /External adapter 'external-cli' does not support runs\.steer/);
			assert.equal(consumeSteerRequests(childDir).length, 0);
		} finally {
			cleanup(workflowRunId, workflowDir);
			cleanup(childRunId, childDir);
		}
	});

	it("returns missed when a terminal keyed child cannot accept a retained follow-up", async () => {
		const state = createState();
		const workflowRunId = `workflow-key-terminal-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const workflowDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const childDir = createRunningAsync(state, childRunId, { track: false });
		const workflowStatus = JSON.parse(fs.readFileSync(path.join(workflowDir, "status.json"), "utf-8"));
		workflowStatus.steps = [{ agent: "worker", status: "completed", workflowKey: "writer", runId: childRunId, async: true }];
		writeJson(path.join(workflowDir, "status.json"), workflowStatus);
		const sessionFile = path.join(childDir, "child.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		const childStatus = JSON.parse(fs.readFileSync(path.join(childDir, "status.json"), "utf-8"));
		childStatus.state = "complete";
		childStatus.parentWorkflowRunId = workflowRunId;
		childStatus.steps = [{ agent: "worker", status: "complete", sessionFile }];
		writeJson(path.join(childDir, "status.json"), childStatus);
		try {
			const result = await steerWorkflowChildByKey({ state, workflowRunId, key: "writer", message: "Too late.", options: { mode: "follow_up", index: 1, ackTimeoutMs: 20 } });
			assert.equal(result.state, "missed");
			assert.match(result.error ?? "", /is complete/);
			assert.doesNotMatch(JSON.stringify(result), new RegExp(childRunId));
			assert.equal(consumeSteerRequests(childDir).length, 0);
			assert.equal(fs.existsSync(path.join(childDir, "control", "revival-briefs")), false);
		} finally {
			cleanup(workflowRunId, workflowDir);
			cleanup(childRunId, childDir);
		}
	});

	it("returns missed when a keyed child's raw running status reconciles terminal", async () => {
		const state = createState();
		const workflowRunId = `workflow-key-reconciled-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const workflowDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const childDir = createRunningAsync(state, childRunId, { track: false });
		const workflowStatus = JSON.parse(fs.readFileSync(path.join(workflowDir, "status.json"), "utf-8"));
		workflowStatus.steps = [{ agent: "worker", status: "completed", workflowKey: "writer", runId: childRunId, async: true }];
		writeJson(path.join(workflowDir, "status.json"), workflowStatus);
		writeJson(path.join(RESULTS_DIR, `${childRunId}.json`), { runId: childRunId, mode: "single", success: false, error: "terminal", results: [] });
		try {
			const result = await steerWorkflowChildByKey({ state, workflowRunId, key: "writer", message: "Too late.", options: { ackTimeoutMs: 20 } });
			assert.equal(result.state, "missed");
			assert.match(result.error ?? "", /is failed/);
			assert.doesNotMatch(JSON.stringify(result), new RegExp(childRunId));
			assert.equal(consumeSteerRequests(childDir).length, 0);
		} finally {
			cleanup(workflowRunId, workflowDir);
			cleanup(childRunId, childDir);
		}
	});

	it("reports a failed steer when the child session rejects it", async () => {
		const state = createState();
		const workflowRunId = `workflow-steer-failed-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		createWorkflowForegroundControl(state, workflowRunId, childRunId, { steer: async () => ({ state: "failed", reason: "session is settling" }) });
		try {
			const control = state.foregroundControls.get(childRunId)!;
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: childRunId },
				message: "Focus on the failing test.",
			});

			assert.equal(result.isError, true);
			assert.match(text(result), /Steering failed .*session is settling/);
			assert.equal(result.details.steering?.state, "failed");
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("rejects a steer request when the child session is not steerable", async () => {
		const state = createState();
		const workflowRunId = `workflow-no-steer-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		createWorkflowForegroundControl(state, workflowRunId, childRunId, { steer: null });
		try {
			const control = state.foregroundControls.get(childRunId)!;
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: childRunId },
				message: "Focus on the failing test.",
			});

			assert.equal(result.isError, true);
			assert.match(text(result), /does not support steering/);
			assert.equal(result.details.steering, undefined);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("queues follow-up steering through the child session", async () => {
		const state = createState();
		const workflowRunId = `workflow-follow-up-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const steers = createWorkflowForegroundControl(state, workflowRunId, childRunId);
		try {
			const control = state.foregroundControls.get(childRunId)!;
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: childRunId },
				message: "After this, update the docs.",
				mode: "follow_up",
			});

			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.deliveryStatus, "queued");
			assert.deepEqual(steers, [{ message: "After this, update the docs.", mode: "follow_up" }]);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("steers the unique live foreground child by workflow id and directory", async () => {
		for (const target of ["id", "dir"] as const) {
			const state = createState();
			const workflowRunId = `workflow-${target}-${Date.now().toString(36)}`;
			const childRunId = `${workflowRunId}-child`;
			const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
			const steers = createWorkflowForegroundControl(state, workflowRunId, childRunId);
			try {
				const params = target === "id"
					? { action: "steer", id: workflowRunId, message: "Review the contract." }
					: { action: "steer", dir: asyncDir, message: "Review the contract." };
				const result = await executorWithKill(state, () => true)
					.execute("steer", params, new AbortController().signal, undefined, ctx());

				assert.equal(result.isError, undefined);
				assert.equal(result.details.steering?.sourceRunId, workflowRunId);
				assert.deepEqual(steers, [{ message: "Review the contract." }]);
			} finally {
				cleanup(workflowRunId, asyncDir);
			}
		}
	});

	it("rejects ambiguous workflow steering without choosing a foreground child", async () => {
		const state = createState();
		const workflowRunId = `workflow-ambiguous-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const firstSteers = createWorkflowForegroundControl(state, workflowRunId, `${workflowRunId}-one`);
		const secondSteers = createWorkflowForegroundControl(state, workflowRunId, `${workflowRunId}-two`);
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: workflowRunId, message: "Do not guess." }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /2 live foreground children/);
			assert.equal(firstSteers.length, 0);
			assert.equal(secondSteers.length, 0);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("rejects a terminal workflow instead of queuing to its outer inbox", async () => {
		const state = createState();
		const workflowRunId = `workflow-terminal-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		createWorkflowForegroundControl(state, workflowRunId, `${workflowRunId}-child`);
		const statusPath = path.join(asyncDir, "status.json");
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		status.state = "complete";
		status.endedAt = Date.now();
		fs.writeFileSync(statusPath, JSON.stringify(status), "utf-8");
		state.workflowControllers?.delete(workflowRunId);
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", dir: asyncDir, message: "Too late." }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /not running or queued/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-requests")), false);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("queues steering for a running async child", async () => {
		const state = createState();
		const runId = `steer-disk-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 10);
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, message: "Focus on tests." }, controller.signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Steering pending for async run ${runId}`));
			const requests = consumeSteerRequests(asyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.message, "Focus on tests.");
			assert.equal(requests[0]?.source, "steer-action");
			assert.equal(requests[0]?.targetIndex, undefined);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("queues steering for a running async child by directory", async () => {
		const state = createState();
		const runId = `steer-dir-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 10);
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", dir: asyncDir, message: "Focus on validation." }, controller.signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Steering pending for async run ${runId}`));
			const requests = consumeSteerRequests(asyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.message, "Focus on validation.");
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("queues steering for a pending indexed async child", async () => {
		const state = createState();
		const runId = `steer-pending-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeJson(path.join(asyncDir, "status.json"), {
			runId,
			sessionId: "session",
			mode: "chain",
			state: "running",
			pid: 12345,
			cwd: os.tmpdir(),
			startedAt: 100,
			lastUpdate: Date.now(),
			steps: [
				{ agent: "done", status: "complete", startedAt: 100 },
				{ agent: "later", status: "pending" },
			],
		});
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, index: 1, message: "Use the new API." }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			const requests = consumeSteerRequests(asyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.message, "Use the new API.");
			assert.equal(requests[0]?.targetIndex, 1);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects steering async runs outside the active session", async () => {
		const state = createState();
		const runId = `steer-other-session-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "other-session" });
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, message: "do not deliver" }, new AbortController().signal, undefined, ctx());
			assert.equal(result.isError, true);
			assert.match(text(result), /active session/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-requests")), false);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects runs.steer for the one-shot external CLI with its adapter reason", async () => {
		const state = createState();
		const runId = `steer-external-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		const statusPath = path.join(asyncDir, "status.json");
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { steps: Array<Record<string, unknown>> };
		status.steps[0]!.runner = resolveExternalCliRunnerStatus({ command: "review-cli" });
		writeJson(statusPath, status);
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, message: "Do not deliver" }, new AbortController().signal, undefined, ctx());
			assert.equal(result.isError, true);
			assert.match(text(result), /External adapter 'external-cli' does not support runs\.steer: The one-shot stdin adapter closes input/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-requests")), false);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects runs.steer for an old persisted external CLI status shape", async () => {
		const state = createState();
		const runId = `steer-old-external-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		const statusPath = path.join(asyncDir, "status.json");
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { steps: Array<Record<string, unknown>> };
		status.steps[0]!.runner = { type: "external-cli", command: "review-cli", args: [], promptDelivery: "stdin", capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false } };
		writeJson(statusPath, status);
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: runId, message: "Do not deliver" }, new AbortController().signal, undefined, ctx());
			assert.equal(result.isError, true);
			assert.match(text(result), /External adapter 'external-cli' does not support runs\.steer/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-requests")), false);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("requests an interrupt without signaling a running async runner", async () => {
		const state = createState();
		const runId = `interrupt-disk-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		try {
			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			const result = await executorWithKill(state, (pid, signal) => {
				kills.push({ pid, signal });
				return true;
			}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Interrupt requested for async run ${runId}`));
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), true);
			assert.deepEqual(kills, [{ pid: 12345, signal: 0 }]);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects workflow interrupt instead of signaling a shared host pid", async () => {
		const state = createState();
		const runId = `interrupt-workflow-host-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, mode: "workflow", pid: process.pid });
		try {
			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			const result = await executorWithKill(state, (pid, signal) => {
				kills.push({ pid, signal });
				return true;
			}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), new RegExp(`Interrupt is unsupported for async workflow ${runId}; use stop instead\\.`));
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
			assert.deepEqual(kills, [{ pid: process.pid, signal: 0 }]);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects interrupt for a running external runner without writing a pause request", async () => {
		for (const runner of [{ type: "external-cli" }, { type: "external-job", provider: "surf-oracle", options: {} }]) {
			const state = createState();
			const runId = `interrupt-external-${runner.type}-${Date.now().toString(36)}`;
			const asyncDir = createRunningAsync(state, runId, { track: false });
			const statusPath = path.join(asyncDir, "status.json");
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			status.steps[0].runner = runner;
			fs.writeFileSync(statusPath, JSON.stringify(status), "utf-8");
			try {
				const result = await executorWithKill(state, () => {
					throw new Error("external interrupt should not signal the runner");
				}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

				assert.equal(result.isError, true);
				assert.match(text(result), new RegExp(`Interrupt is unsupported for external async run ${runId}; use stop instead\\.`));
				assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
				assert.equal(JSON.parse(fs.readFileSync(statusPath, "utf-8")).state, "running");
			} finally {
				cleanup(runId, asyncDir);
			}
		}
	});

	it("stops a running async run resolved from disk", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `stop-disk-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session" });
		try {
			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			const result = await executorWithKill(state, (pid, signal) => {
				kills.push({ pid, signal });
				return true;
			}).execute("stop", { action: "stop", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Stop requested for async run ${runId}`));
			assert.equal(consumeStopRequestPayload(asyncDir)?.type, "stop");
			assert.deepEqual(kills, [{ pid: 12345, signal: 0 }]);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("stops a reload-recovered workflow through the durable control channel", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `stop-recovered-workflow-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session", mode: "workflow" });
		try {
			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			const result = await executorWithKill(state, (pid, signal) => {
				kills.push({ pid, signal });
				return true;
			}).execute("stop-recovered-workflow", { action: "stop", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Stop requested for async run ${runId}`));
			assert.equal(consumeStopRequestPayload(asyncDir)?.type, "stop");
			assert.deepEqual(kills, [{ pid: 12345, signal: 0 }]);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("writes child-scoped stop requests for a running async run", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `stop-child-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session" });
		try {
			const statusPath = path.join(asyncDir, "status.json");
			writeJson(statusPath, {
				...JSON.parse(fs.readFileSync(statusPath, "utf-8")),
				steps: [
					{ agent: "first", status: "running", runId: "child-a", startedAt: 100 },
					{ agent: "second", status: "running", workflowKey: "review", startedAt: 100 },
				],
			});

			const result = await executorWithKill(state, () => true)
				.execute("stop-child", { action: "stop", id: runId, childId: "review" }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Stop requested for child review/);
			const request = consumeStopRequestPayload(asyncDir);
			assert.equal(request?.type, "stop");
			assert.equal(request?.source, "stop-action");
			assert.equal(request?.targetIndex, 1);
			assert.equal(request?.childId, "review");
			assert.equal(typeof request?.ts, "number");
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("/subagents-stop rejects a nested-only child without writing a parent target request", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `stop-nested-${Date.now().toString(36)}`;
		const nestedChildId = `${runId}-nested`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session" });
		try {
			const statusPath = path.join(asyncDir, "status.json");
			writeJson(statusPath, {
				...JSON.parse(fs.readFileSync(statusPath, "utf-8")),
				steps: [{
					agent: "wrapper",
					status: "running",
					startedAt: 100,
					children: [{
						id: nestedChildId,
						parentRunId: runId,
						parentStepIndex: 0,
						depth: 1,
						path: [{ runId, stepIndex: 0 }],
						state: "running",
					}],
				}],
			});

			const result = await executorWithKill(state, () => {
				throw new Error("nested-only child stop must not signal the parent runner");
			}).execute("stop-nested", { action: "stop", id: runId, childId: nestedChildId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), new RegExp(`Child '${nestedChildId}' was not found under async run '${runId}'`));
			assert.equal(consumeStopRequestPayload(asyncDir), undefined);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("dismisses only a reload-recovered running workflow without terminating work", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `dismiss-workflow-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session", mode: "workflow" });
		try {
			const result = await executorWithKill(state, () => {
				throw new Error("dismiss must not inspect or signal the workflow pid");
			}).execute("dismiss", { action: "dismiss", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Dismissed recovered workflow/);
			assert.match(text(result), /No running work was terminated/);
			const dismissed = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(dismissed.state, "running");
			assert.equal(typeof dismissed.displayDismissedAt, "number");
			assert.equal(listAsyncRuns(ASYNC_DIR, { states: ["running"], sessionId: "session", kill: () => {
				throw new Error("dismissed workflow listing must not inspect the pid");
			} }).some((run) => run.id === runId), false);
			const statusResult = inspectSubagentStatus({ action: "status", id: runId }, { state, kill: () => {
				throw new Error("dismissed workflow status must not inspect the pid");
			} });
			const statusText = text(statusResult);
			assert.match(statusText, /State: display-dismissed/);
			assert.match(statusText, /No running work was terminated/);
			assert.doesNotMatch(statusText, /Steer/);
			const debugResult = inspectSubagentStatus({ action: "debug.run", id: runId }, { state, kill: () => {
				throw new Error("dismissed workflow debug must not inspect the pid");
			} });
			const debugText = text(debugResult);
			assert.match(debugText, /Run lifecycle debug/);
			assert.match(debugText, /State: running/);
			assert.match(debugText, /Active capacity: not-owned/);
			const transcriptResult = inspectSubagentStatus({ action: "status", id: runId, view: "transcript" }, { state, kill: () => {
				throw new Error("dismissed workflow transcript must not inspect the pid");
			} });
			assert.doesNotMatch(text(transcriptResult), /Status file not found/);
			const stopResult = await executorWithKill(state, () => {
				throw new Error("dismissed workflow stop must not inspect or signal the pid");
			}).execute("stop-dismissed", { action: "stop", id: runId }, new AbortController().signal, undefined, ctx());
			assert.equal(stopResult.isError, true);
			assert.doesNotMatch(text(stopResult), /Stop requested/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "stop.json")), false);
			const stopDirResult = await executorWithKill(state, () => {
				throw new Error("dismissed workflow stop by dir must not inspect or signal the pid");
			}).execute("stop-dismissed-dir", { action: "stop", dir: asyncDir }, new AbortController().signal, undefined, ctx());
			assert.equal(stopDirResult.isError, true);
			assert.doesNotMatch(text(stopDirResult), /Stop requested/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "stop.json")), false);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects transcript view for display-dismissed workflows from another session", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `dismiss-other-session-transcript-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "other-session", mode: "workflow" });
		try {
			const statusPath = path.join(asyncDir, "status.json");
			writeJson(statusPath, { ...JSON.parse(fs.readFileSync(statusPath, "utf-8")), displayDismissedAt: Date.now() });
			fs.writeFileSync(path.join(asyncDir, "output-0.log"), "SECRET_OTHER_SESSION_OUTPUT", "utf-8");

			const result = inspectSubagentStatus({ action: "status", id: runId, view: "transcript", index: 0 }, { state, kill: () => true });

			assert.equal(result.isError, true);
			assert.match(text(result), /owned by the current session/);
			assert.doesNotMatch(text(result), /SECRET_OTHER_SESSION_OUTPUT/);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("shows terminal status when a result appears after display dismissal", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `dismiss-then-complete-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session", mode: "workflow" });
		try {
			const dismissResult = await executorWithKill(state, () => true).execute("dismiss", { action: "dismiss", id: runId }, new AbortController().signal, undefined, ctx());
			assert.equal(dismissResult.isError, undefined);
			writeJson(path.join(RESULTS_DIR, `${runId}.json`), { runId, mode: "workflow", success: true, results: [] });

			const statusResult = inspectSubagentStatus({ action: "status", id: runId }, { state, kill: () => true });
			const statusText = text(statusResult);
			assert.match(statusText, /State: complete/);
			assert.doesNotMatch(statusText, /State: display-dismissed/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "complete");
			assert.equal(status.displayDismissedAt, undefined);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects dismiss when a stale running workflow has a terminal result", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `dismiss-terminal-result-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session", mode: "workflow" });
		writeJson(path.join(RESULTS_DIR, `${runId}.json`), { runId, mode: "workflow", success: true, results: [] });
		try {
			const result = await executorWithKill(state, () => {
				throw new Error("terminal workflow dismiss must not inspect or signal the pid");
			}).execute("dismiss-terminal-result", { action: "dismiss", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /complete, not running/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "complete");
			assert.equal(status.displayDismissedAt, undefined);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects dismiss from child-safe fanout mode", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `dismiss-child-safe-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session", mode: "workflow" });
		try {
			const result = await executorWithKill(state, () => true, { allowMutatingManagementActions: false })
				.execute("dismiss-child-safe", { action: "dismiss", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /child-safe subagent fanout mode/);
			assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).displayDismissedAt, undefined);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects dismiss for live-controller, non-workflow, terminal, and other-session runs", async () => {
		const cases = [
			{ name: "live", mode: "workflow" as const, sessionId: "session", state: "running" as const, controller: true, pattern: /live controller/ },
			{ name: "non-workflow", mode: "single" as const, sessionId: "session", state: "running" as const, pattern: /not a recovered workflow/ },
			{ name: "terminal", mode: "workflow" as const, sessionId: "session", state: "running" as const, terminal: true, pattern: /complete, not running/ },
			{ name: "other-session", mode: "workflow" as const, sessionId: "other", state: "running" as const, pattern: /active session/ },
		];
		for (const candidate of cases) {
			const state = createState();
			state.currentSessionId = "session";
			const runId = `dismiss-${candidate.name}-${Date.now().toString(36)}`;
			const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: candidate.sessionId, mode: candidate.mode });
			if (candidate.controller) state.workflowControllers = new Map([[runId, new AbortController()]]);
			if (candidate.terminal) {
				const statusPath = path.join(asyncDir, "status.json");
				writeJson(statusPath, { ...JSON.parse(fs.readFileSync(statusPath, "utf-8")), state: "complete" });
			}
			try {
				const result = await executorWithKill(state, () => {
					throw new Error("dismiss rejection must not inspect or signal pids");
				}).execute("dismiss", { action: "dismiss", id: runId }, new AbortController().signal, undefined, ctx());
				assert.equal(result.isError, true, candidate.name);
				assert.match(text(result), candidate.pattern, candidate.name);
				assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")).displayDismissedAt, undefined, candidate.name);
			} finally {
				cleanup(runId, asyncDir);
			}
		}
	});

	it("does not stop a different async run when the requested id is missing", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `stop-existing-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { sessionId: "session" });
		try {
			const result = await executorWithKill(state, () => true)
				.execute("stop", { action: "stop", id: "missing-run" }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /Run not found|No stoppable async run found in this session/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "stop.json")), false);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("stops a queued async run by writing the portable request", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `stop-queued-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "session", state: "queued" });
		try {
			const result = await executorWithKill(state, () => {
				throw new Error("queued stop should not signal a process");
			}).execute("stop", { action: "stop", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, undefined);
			assert.match(text(result), new RegExp(`Stop requested for async run ${runId}`));
			assert.equal(consumeStopRequestPayload(asyncDir)?.type, "stop");
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("rejects stop for async runs outside the active session", async () => {
		const state = createState();
		state.currentSessionId = "session";
		const runId = `stop-other-session-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false, sessionId: "other-session" });
		try {
			const result = await executorWithKill(state, () => true)
				.execute("stop", { action: "stop", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /active session/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "stop.json")), false);
		} finally {
			cleanup(runId, asyncDir);
		}
	});

	it("does not report success for stale running status with a dead pid", async () => {
		const state = createState();
		const runId = `interrupt-esrch-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId);
		try {
			const result = await executorWithKill(state, () => {
				const error = new Error("missing process") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /No running async run with an interrupt-capable pid/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
		} finally {
			cleanup(runId, asyncDir);
		}
	});
});
