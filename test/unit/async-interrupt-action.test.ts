import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { consumeSteerRequests, consumeSteerRequestsFromDir, stepSteerInboxDir, writeSteerAck } from "../../src/runs/background/control-channel.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { steerWorkflowForegroundTarget, workflowForegroundSteeringDir } from "../../src/runs/foreground/workflow-foreground-steering.ts";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../src/shared/types.ts";

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

function createWorkflowForegroundControl(state: SubagentState, workflowRunId: string, childRunId: string): string {
	const routeDir = workflowForegroundSteeringDir(ASYNC_DIR, workflowRunId, childRunId);
	state.workflowControllers ??= new Map();
	state.workflowControllers.set(workflowRunId, new AbortController());
	state.foregroundControls.set(childRunId, {
		runId: childRunId,
		parentWorkflowRunId: workflowRunId,
		workflowKey: childRunId,
		workflowSteeringDir: routeDir,
		sessionId: "session",
		mode: "single",
		startedAt: 100,
		updatedAt: 100,
		activeChildren: new Map([[0, { index: 0, agent: "worker", startedAt: 100, updatedAt: 100 }]]),
		schedulingOwners: 1,
	});
	fs.mkdirSync(stepSteerInboxDir(routeDir, 0), { recursive: true });
	return routeDir;
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

function executorWithKill(state: SubagentState, kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean) {
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

function text(result: Awaited<ReturnType<ReturnType<typeof executorWithKill>["execute"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("async interrupt action", () => {
	it("steers a live workflow-owned foreground child by child id", async () => {
		const state = createState();
		const workflowRunId = `workflow-child-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const routeDir = createWorkflowForegroundControl(state, workflowRunId, childRunId);
		try {
			const action = executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: childRunId, message: "Focus on the failing test." }, new AbortController().signal, undefined, ctx());
			const request = await waitUntil(() => {
				const inbox = stepSteerInboxDir(routeDir, 0);
				const entry = fs.existsSync(inbox) ? fs.readdirSync(inbox).find((name) => name.endsWith(".json")) : undefined;
				return entry ? JSON.parse(fs.readFileSync(path.join(inbox, entry), "utf-8")) as { id: string; message: string } : undefined;
			});
			writeSteerAck(routeDir, { requestId: request.id, index: 0, ts: Date.now(), state: "delivered", message: "accepted" });
			const result = await action;

			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.state, "delivered");
			assert.equal(result.details.steering?.sourceRunId, childRunId);
			assert.equal(request.message, "Focus on the failing test.");
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("rejects a steer request when its workflow foreground route is already removed", async () => {
		const state = createState();
		const workflowRunId = `workflow-missing-route-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const routeDir = createWorkflowForegroundControl(state, workflowRunId, childRunId);
		try {
			const control = state.foregroundControls.get(childRunId)!;
			fs.rmSync(routeDir, { recursive: true, force: true });
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: childRunId },
				message: "Focus on the failing test.",
				ackTimeoutMs: 40,
			});

			assert.equal(result.isError, true);
			assert.match(text(result), /no live workflow steering route/);
			assert.equal(result.details.steering, undefined);
			assert.equal(fs.existsSync(routeDir), false);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("rejects a steer request when its workflow foreground child inbox is missing", async () => {
		const state = createState();
		const workflowRunId = `workflow-missing-inbox-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const routeDir = createWorkflowForegroundControl(state, workflowRunId, childRunId);
		try {
			const control = state.foregroundControls.get(childRunId)!;
			fs.rmSync(stepSteerInboxDir(routeDir, 0), { recursive: true, force: true });
			const result = await steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: childRunId },
				message: "Focus on the failing test.",
				ackTimeoutMs: 40,
			});

			assert.equal(result.isError, true);
			assert.match(text(result), /no live workflow steering route/);
			assert.equal(result.details.steering, undefined);
			assert.equal(fs.existsSync(stepSteerInboxDir(routeDir, 0)), false);
		} finally {
			cleanup(workflowRunId, asyncDir);
		}
	});

	it("rejects a steer request when its workflow foreground route is removed during the final acknowledgment wait", async () => {
		const state = createState();
		const workflowRunId = `workflow-removed-route-${Date.now().toString(36)}`;
		const childRunId = `${workflowRunId}-child`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const routeDir = createWorkflowForegroundControl(state, workflowRunId, childRunId);
		try {
			const control = state.foregroundControls.get(childRunId)!;
			const action = steerWorkflowForegroundTarget({
				target: { control, workflowRunId, sourceRunId: childRunId },
				message: "Focus on the failing test.",
				ackTimeoutMs: 40,
			});
			await waitUntil(() => fs.existsSync(stepSteerInboxDir(routeDir, 0)) ? true : undefined);
			fs.rmSync(routeDir, { recursive: true, force: true });
			const result = await action;

			assert.equal(result.isError, true);
			assert.match(text(result), /no live child session/);
			assert.equal(result.details.steering, undefined);
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
			const routeDir = createWorkflowForegroundControl(state, workflowRunId, childRunId);
			try {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 10);
				const params = target === "id"
					? { action: "steer", id: workflowRunId, message: "Review the contract." }
					: { action: "steer", dir: asyncDir, message: "Review the contract." };
				const result = await executorWithKill(state, () => true)
					.execute("steer", params, controller.signal, undefined, ctx());

				assert.equal(result.isError, undefined);
				assert.equal(result.details.steering?.sourceRunId, workflowRunId);
				assert.equal(consumeSteerRequestsFromDir(stepSteerInboxDir(routeDir, 0))[0]?.message, "Review the contract.");
			} finally {
				cleanup(workflowRunId, asyncDir);
			}
		}
	});

	it("rejects ambiguous workflow steering without choosing a foreground child", async () => {
		const state = createState();
		const workflowRunId = `workflow-ambiguous-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, workflowRunId, { track: false, mode: "workflow" });
		const firstRoute = createWorkflowForegroundControl(state, workflowRunId, `${workflowRunId}-one`);
		const secondRoute = createWorkflowForegroundControl(state, workflowRunId, `${workflowRunId}-two`);
		try {
			const result = await executorWithKill(state, () => true)
				.execute("steer", { action: "steer", id: workflowRunId, message: "Do not guess." }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /2 live foreground children/);
			assert.equal(consumeSteerRequestsFromDir(stepSteerInboxDir(firstRoute, 0)).length, 0);
			assert.equal(consumeSteerRequestsFromDir(stepSteerInboxDir(secondRoute, 0)).length, 0);
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
			assert.match(text(result), /no live foreground child/);
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

	it("rejects interrupt for a running external CLI run without writing a pause request", async () => {
		const state = createState();
		const runId = `interrupt-external-${Date.now().toString(36)}`;
		const asyncDir = createRunningAsync(state, runId, { track: false });
		const statusPath = path.join(asyncDir, "status.json");
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		status.steps[0].runner = { type: "external-cli" };
		fs.writeFileSync(statusPath, JSON.stringify(status), "utf-8");
		try {
			const result = await executorWithKill(state, () => {
				throw new Error("external interrupt should not signal the runner");
			}).execute("interrupt", { action: "interrupt", id: runId }, new AbortController().signal, undefined, ctx());

			assert.equal(result.isError, true);
			assert.match(text(result), /Interrupt is unsupported for one-shot external CLI async run/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
			assert.equal(JSON.parse(fs.readFileSync(statusPath, "utf-8")).state, "running");
		} finally {
			cleanup(runId, asyncDir);
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
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "stop.json")), true);
			assert.deepEqual(kills, [{ pid: 12345, signal: 0 }]);
		} finally {
			cleanup(runId, asyncDir);
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
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "stop.json")), true);
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
