import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writePrivateAtomicJson } from "../../src/shared/atomic-json.ts";
import { closeSteerInbox, interruptRequestPath, steerRequestsDir, writeSteerAck, type SteerRequest } from "../../src/runs/background/control-channel.ts";
import { steerAsyncRun } from "../../src/runs/foreground/async-steering-action.ts";
import { createSteeringStatus, recordSteeringRequest, updateSteeringTarget } from "../../src/runs/background/steering.ts";
import { ASYNC_DIR, type AsyncStatus, type Details, type SteeringRecoveryDescriptor, type SteeringTargetState, type SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: "session",
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

function writeStatus(asyncDir: string, status: AsyncStatus): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function runningStatus(runId: string, mode: AsyncStatus["mode"] = "single", count = 1): AsyncStatus {
	return {
		runId,
		sessionId: "session",
		mode,
		state: "running",
		pid: 12345,
		cwd: os.tmpdir(),
		startedAt: Date.now(),
		lastUpdate: Date.now(),
		steps: Array.from({ length: count }, (_, index) => ({ agent: `worker-${index}`, status: "running" as const, startedAt: Date.now() })),
		steering: createSteeringStatus(),
	};
}

function projectRequest(status: AsyncStatus, request: SteerRequest, states: SteeringTargetState[]): void {
	const targets = states.map((state, index) => ({ index, state }));
	status.steering ??= createSteeringStatus();
	recordSteeringRequest(status.steering, { id: request.id, requestedAt: request.ts, source: request.source, message: request.message, targets });
	for (const target of targets) {
		const step = status.steps?.[target.index];
		if (!step) continue;
		step.steering = createSteeringStatus();
		recordSteeringRequest(step.steering, { id: request.id, requestedAt: request.ts, source: request.source, message: request.message, targets: [target] });
	}
}

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error("Timed out waiting for steering test condition.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function readRequest(asyncDir: string): Promise<SteerRequest> {
	return waitUntil(() => {
		const dir = steerRequestsDir(asyncDir);
		if (!fs.existsSync(dir)) return undefined;
		const file = fs.readdirSync(dir).find((entry) => entry.endsWith(".json"));
		return file ? JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as SteerRequest : undefined;
	});
}

function recoveryDescriptor(runId: string): SteeringRecoveryDescriptor {
	return {
		version: 1,
		sourceRunId: runId,
		agent: "worker-0",
		cwd: os.tmpdir(),
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		outputMode: "inline",
		absoluteDeadlineAt: Date.now() + 10_000,
		initialTurnBudget: { maxTurns: 10, graceTurns: 2 },
		initialToolBudget: { soft: 8, hard: 12, block: ["read"] },
		maxSubagentDepth: 2,
		share: false,
	};
}

function successResult(asyncId: string): { content: [{ type: "text"; text: string }]; details: Details } {
	return { content: [{ type: "text", text: "started" }], details: { mode: "single", results: [], asyncId } };
}

describe("acknowledged steering action", () => {
	it("returns delivered only after the runner records child-session acceptance", async () => {
		const runId = `steer-delivered-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		try {
			const action = steerAsyncRun({ state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 500, kill: () => true });
			const request = await readRequest(asyncDir);
			assert.deepEqual(request.targetIndexes, [0]);
			const status = runningStatus(runId);
			projectRequest(status, request, ["routed"]);
			updateSteeringTarget(status.steering!, request.id, 0, "delivered", Date.now());
			updateSteeringTarget(status.steps![0]!.steering!, request.id, 0, "delivered", Date.now());
			writeStatus(asyncDir, status);
			const result = await action;
			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.state, "delivered");
			assert.match(result.content[0]!.text, /Steering delivered/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("returns a tool error when the runner has closed its steering inbox", async () => {
		const runId = `steer-closed-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		closeSteerInbox(asyncDir, "complete");
		try {
			const result = await steerAsyncRun({ state: createState(), runId, message: "too late", location: { asyncDir }, kill: () => true });
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /no longer accepts steering requests/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("does not commit recovery when the caller aborts the acknowledgment wait", async () => {
		const runId = `steer-abort-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		const controller = new AbortController();
		controller.abort();
		let interrupted = false;
		let recovered = false;
		try {
			const result = await steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir }, signal: controller.signal,
				kill: (_pid, signal) => { if (signal !== 0) interrupted = true; return true; },
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			assert.equal(result.details.steering?.state, "pending");
			assert.equal(interrupted, false);
			assert.equal(recovered, false);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery")), false);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("honors an acknowledgment persisted before recovery commit without interrupting", async () => {
		const runId = `steer-final-ack-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		let request: SteerRequest | undefined;
		let interrupted = false;
		let recovered = false;
		try {
			const result = await steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 25,
				kill: (_pid, signal) => { if (signal !== 0) interrupted = true; return true; },
				onRequestQueued: (requestPath) => {
					request = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as SteerRequest;
					const routed = runningStatus(runId);
					projectRequest(routed, request, ["routed"]);
					writeStatus(asyncDir, routed);
				},
				onBeforeRecoveryClaim: (_requestId, committedAt) => {
					assert.ok(request);
					const recoveryDir = path.join(asyncDir, "control", "steer-recovery");
					assert.equal(fs.existsSync(path.join(recoveryDir, "claim.json")), false);
					assert.equal(fs.existsSync(path.join(recoveryDir, `${Buffer.from(request.id).toString("base64url")}.json`)), false);
					const acknowledged = runningStatus(runId);
					projectRequest(acknowledged, request, ["routed"]);
					updateSteeringTarget(acknowledged.steering!, request.id, 0, "delivered", committedAt);
					updateSteeringTarget(acknowledged.steps![0]!.steering!, request.id, 0, "delivered", committedAt);
					writeStatus(asyncDir, acknowledged);
				},
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			assert.equal(result.details.steering?.state, "delivered");
			assert.equal(interrupted, false);
			assert.equal(recovered, false);
			assert.ok(request);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", `${Buffer.from(request.id).toString("base64url")}.json`)), false);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("releases the recovery claim when interrupt delivery definitively fails", async () => {
		const runId = `steer-interrupt-failed-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		try {
			const action = steerAsyncRun({
				state: createState(),
				runId,
				message: "correct course",
				location: { asyncDir },
				ackTimeoutMs: 25,
				kill: (_pid, signal) => {
					if (signal === 0) return true;
					const error = new Error("runner disappeared") as NodeJS.ErrnoException;
					error.code = "ESRCH";
					throw error;
				},
				recover: async () => successResult("replacement"),
			});
			const request = await readRequest(asyncDir);
			const routed = runningStatus(runId);
			projectRequest(routed, request, ["routed"]);
			writeStatus(asyncDir, routed);
			const result = await action;
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /Failed to commit steering recovery interrupt/);
			const recoveryDir = path.join(asyncDir, "control", "steer-recovery");
			assert.equal(fs.existsSync(path.join(recoveryDir, "claim.json")), false);
			assert.equal(fs.existsSync(path.join(recoveryDir, `${Buffer.from(request.id).toString("base64url")}.json`)), false);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("keeps the claim after an unconfirmed pause to prevent delayed duplicate recovery", async () => {
		const runId = `steer-pause-unconfirmed-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		try {
			const action = steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir },
				ackTimeoutMs: 25, recoveryTimeoutMs: 50, kill: () => true,
				recover: async () => successResult("replacement"),
			});
			const request = await readRequest(asyncDir);
			const routed = runningStatus(runId);
			projectRequest(routed, request, ["routed"]);
			writeStatus(asyncDir, routed);
			const result = await action;
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /claim remains committed to prevent a delayed duplicate/);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", "claim.json")), true);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("pauses and revives a single run with only its remaining budgets", async () => {
		const runId = `steer-recover-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(asyncDir, "child.jsonl");
		writeStatus(asyncDir, runningStatus(runId));
		fs.writeFileSync(sessionFile, "", "utf-8");
		const descriptorPath = path.join(asyncDir, "recovery-descriptor.json");
		writePrivateAtomicJson(descriptorPath, recoveryDescriptor(runId));
		if (process.platform !== "win32") assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o600);
		let receivedLimits: unknown;
		let recoveryStarted = false;
		try {
			const action = steerAsyncRun({
				state: createState(),
				runId,
				message: "correct course",
				location: { asyncDir },
				ackTimeoutMs: 25,
				recoveryTimeoutMs: 500,
				kill: () => true,
				recover: async (limits) => { recoveryStarted = true; receivedLimits = limits; return successResult("replacement"); },
			});
			const request = await readRequest(asyncDir);
			const routed = runningStatus(runId);
			projectRequest(routed, request, ["routed"]);
			writeStatus(asyncDir, routed);
			await waitUntil(() => fs.existsSync(interruptRequestPath(asyncDir)) ? true : undefined);
			writeSteerAck(asyncDir, { requestId: request.id, index: 0, ts: Date.now(), state: "delivered", message: "accepted after runner pause" });
			const paused: AsyncStatus = {
				...routed,
				state: "paused",
				turnBudget: { maxTurns: 10, graceTurns: 2, turnCount: 7, outcome: "within-budget" },
				toolBudget: { soft: 8, hard: 12, block: ["read"], toolCount: 9, outcome: "soft-reached" },
				steps: [{ ...routed.steps![0]!, status: "paused", sessionFile }],
			};
			writeStatus(asyncDir, paused);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recoveryStarted, false, "recovery must wait for final paused persistence");
			writeStatus(asyncDir, { ...paused, endedAt: Date.now() });
			const result = await action;
			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.state, "recovered");
			assert.equal(result.details.steering?.replacementRunId, "replacement");
			assert.ok(result.details.steering?.targets[0]?.lateDeliveredAt);
			const limits = receivedLimits as { timeoutMs: number; absoluteDeadlineAt: number; turnBudget: unknown; toolBudget: unknown };
			assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 10_000);
			assert.ok(limits.absoluteDeadlineAt >= Date.now());
			assert.deepEqual({ turnBudget: limits.turnBudget, toolBudget: limits.toolBudget }, {
				turnBudget: { maxTurns: 3, graceTurns: 2 },
				toolBudget: { hard: 3, block: ["read"] },
			});
			const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatus;
			assert.equal(persisted.steering?.recent[0]?.targets[0]?.state, "recovered");
			assert.ok(persisted.steering?.recent[0]?.targets[0]?.lateDeliveredAt);
			assert.equal(persisted.steps?.[0]?.steering?.recent[0]?.targets[0]?.state, "recovered");
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("leaves an unacknowledged single run paused when no session can be revived", async () => {
		const runId = `steer-no-session-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		writePrivateAtomicJson(path.join(asyncDir, "recovery-descriptor.json"), recoveryDescriptor(runId));
		let recovered = false;
		try {
			const action = steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 25, recoveryTimeoutMs: 500, kill: () => true,
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			const request = await readRequest(asyncDir);
			const routed = runningStatus(runId);
			projectRequest(routed, request, ["routed"]);
			writeStatus(asyncDir, routed);
			await waitUntil(() => fs.existsSync(interruptRequestPath(asyncDir)) ? true : undefined);
			writeStatus(asyncDir, { ...routed, state: "paused", endedAt: Date.now(), steps: [{ ...routed.steps![0]!, status: "paused" }] });
			const result = await action;
			assert.equal(result.isError, true);
			assert.equal(recovered, false);
			assert.match(result.content[0]!.text, /no persisted child session|does not have a persisted session file/i);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("never auto-interrupts a nested single run", async () => {
		const runId = `steer-nested-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const initial = runningStatus(runId);
		initial.isNested = true;
		writeStatus(asyncDir, initial);
		let interrupted = false;
		let recovered = false;
		try {
			const action = steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 25,
				kill: (_pid, signal) => { if (signal !== 0) interrupted = true; return true; },
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			const request = await readRequest(asyncDir);
			const routed = runningStatus(runId);
			routed.isNested = true;
			projectRequest(routed, request, ["routed"]);
			writeStatus(asyncDir, routed);
			const result = await action;
			assert.equal(result.details.steering?.state, "pending");
			assert.equal(interrupted, false);
			assert.equal(recovered, false);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("reports partial multi-child delivery without interrupting the run", async () => {
		const runId = `steer-partial-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId, "parallel", 2));
		let killed = false;
		try {
			const action = steerAsyncRun({ state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 500, kill: (_pid, signal) => { if (signal !== 0) killed = true; return true; } });
			const request = await readRequest(asyncDir);
			assert.deepEqual(request.targetIndexes, [0, 1]);
			const status = runningStatus(runId, "parallel", 2);
			projectRequest(status, request, ["delivered", "failed"]);
			writeStatus(asyncDir, status);
			const result = await action;
			assert.equal(result.isError, true);
			assert.equal(result.details.steering?.state, "partial");
			assert.equal(killed, false);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});
});
