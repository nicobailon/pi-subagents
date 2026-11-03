import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeAtomicJson, writePrivateAtomicJson } from "../../src/shared/atomic-json.ts";
import { closeSteerInbox, interruptRequestPath, steerRequestsDir, type SteerRequest } from "../../src/runs/background/control-channel.ts";
import { steerAsyncRun } from "../../src/runs/foreground/async-steering-action.ts";
import { createSteeringStatus, recordSteeringRequest, updateSteeringTarget } from "../../src/runs/background/steering.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";
import { ASYNC_DIR, type AsyncStatus, type Details, type SteeringRecoveryDescriptor, type SteeringTargetState, type SubagentState } from "../../src/shared/types.ts";
import { runChildSession, type StepSteerHandler } from "../../src/runs/background/run-child-session.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { recoveryDescriptorPath } from "../../src/runs/shared/run-launch-folder.ts";

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

it("does not acknowledge queued steering when the child transport rejects it", async () => {
	let register!: (handler: StepSteerHandler) => void;
	const registered = new Promise<StepSteerHandler>((resolve) => { register = resolve; });
	let releasePrompt!: () => void;
	const promptBlocked = new Promise<void>((resolve) => { releasePrompt = resolve; });
	const outcomes: unknown[] = [];
	let stop: (() => void) | undefined;
	let listener: ((event: any) => void) | undefined;
	const session: ChildSession = {
		subscribe(callback) { listener = callback; return () => {}; },
		async prompt() {
			await promptBlocked;
			listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "mock/model" } });
			listener?.({ type: "agent_end", messages: [], willRetry: false });
			listener?.({ type: "agent_settled" });
		},
		async steer() { throw new Error("transport rejected steer"); },
		async followUp() {}, async abort() {}, async dispose() {},
		messages: [], sessionId: "rejected-steer", modelId: "mock/model",
	};
	const factory: ChildSessionFactory = { async create() { return session; }, async dispose() {} };
	const run = runChildSession({
		factory,
		launch: { session: {
			cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
			hooks: [], noSkills: true, noContextFiles: true,
			runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } },
		} } as InProcessChildLaunch,
		prompt: "wait",
		appendChildEvent() {}, writeOutputLine() {},
		registerStop(handler) { stop = handler; },
		registerSteer(handler) { if (handler) register(handler); },
		onSteerOutcome(_request, outcome) { outcomes.push(outcome); },
	});
	const steer = await registered;
	const result = await steer({ type: "steer", id: "rejected", ts: Date.now(), message: "new direction" });
	assert.deepEqual(result, { state: "failed", message: "transport rejected steer" });
	assert.deepEqual(outcomes, []);
	stop?.();
	releasePrompt();
	await run;
});

let statusWriteMtimeMs = Date.now();
const budgetDirectories: string[] = [];

afterEach(() => {
	for (const directory of budgetDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function writeStatus(asyncDir: string, status: AsyncStatus): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	const statusPath = path.join(asyncDir, "status.json");
	writeAtomicJson(statusPath, status);
	// readStatus is metadata-cached. Keep fast test rewrites monotonic.
	statusWriteMtimeMs = Math.max(statusWriteMtimeMs + 1, Date.now());
	const mtime = new Date(statusWriteMtimeMs);
	fs.utimesSync(statusPath, mtime, mtime);
}

function removeAsyncDir(asyncDir: string): void {
	fs.rmSync(asyncDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
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

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
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

function recoveryDescriptor(runId: string, sessionFile?: string): SteeringRecoveryDescriptor {
	const runFanoutBudget = createRunFanoutBudget(runId, 64);
	budgetDirectories.push(runFanoutBudget.directory);
	return {
		version: 1,
		runFanoutBudget,
		sourceRunId: runId,
		sessionId: "session",
		agent: "worker-0",
		...(sessionFile ? { sessionFile } : {}),
		cwd: os.tmpdir(),
		systemPromptMode: "replace",
		inheritGlobalContext: false,
		inheritProjectContext: false,
		inheritSkills: false,
		outputMode: "inline",
		absoluteDeadlineAt: Date.now() + 10_000,
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
			assert.match(result.content[0]!.text, /Message sent:\n```text\ncorrect course\n```/);
		} finally {
			removeAsyncDir(asyncDir);
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
			removeAsyncDir(asyncDir);
		}
	});

	it("queues follow-up as the next revival brief for a completed retained child", async () => {
		const runId = `steer-retained-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(asyncDir, "child.jsonl");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
		writeStatus(asyncDir, {
			...runningStatus(runId),
			state: "complete",
			parentWorkflowRunId: "workflow",
			endedAt: Date.now(),
			sessionFile,
			steps: [{ agent: "worker-0", status: "complete", sessionFile }],
		});
		try {
			const result = await steerAsyncRun({ state: createState(), runId, message: "Review the docs", mode: "follow_up", location: { asyncDir } });
			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.deliveryStatus, "queued");
			assert.match(result.content[0]!.text, /next resume/);
			const queueDir = path.join(asyncDir, "control", "revival-briefs");
			const queued = JSON.parse(fs.readFileSync(path.join(queueDir, fs.readdirSync(queueDir)[0]!), "utf-8")) as SteerRequest;
			assert.equal(queued.message, "Review the docs");
			assert.equal(queued.mode, "follow_up");
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("names the terminal state and the resume path when steering a completed run", async () => {
		const runId = `steer-terminal-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(asyncDir, "child.jsonl");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
		writeStatus(asyncDir, { ...runningStatus(runId), state: "complete", endedAt: Date.now(), sessionFile, steps: [{ agent: "worker-0", status: "complete", sessionFile }] });
		try {
			const result = await steerAsyncRun({ state: createState(), runId, message: "too late", location: { asyncDir } });
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /is complete and cannot be steered/);
			assert.match(result.content[0]!.text, /steering requires state "running" or "queued"/);
			assert.match(result.content[0]!.text, /Continue it with action "resume"/);
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("names why resume is unavailable instead of offering it", async () => {
		for (const [label, status, reason] of [
			["stopped", { ...runningStatus("stopped"), state: "stopped" }, /was stopped and cannot be resumed\. Start a new run instead/],
			["several children", { ...runningStatus("several", "parallel", 2), state: "partial" }, /has 2 children\. Provide index to choose one/],
		] as const) {
			const runId = `steer-unresumable-${label.replace(" ", "-")}-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, runId);
			writeStatus(asyncDir, { ...status, runId, endedAt: Date.now() });
			try {
				const result = await steerAsyncRun({ state: createState(), runId, message: "too late", location: { asyncDir } });
				assert.equal(result.isError, true, label);
				assert.match(result.content[0]!.text, new RegExp(`is ${status.state} and cannot be steered`), label);
				assert.match(result.content[0]!.text, /action "resume" is not available either/, label);
				assert.match(result.content[0]!.text, reason, label);
				assert.doesNotMatch(result.content[0]!.text, /Continue it with action "resume"/, label);
			} finally {
				removeAsyncDir(asyncDir);
			}
		}
	});

	it("points a default steer on a completed retained child at mode follow_up", async () => {
		const runId = `steer-terminal-retained-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(asyncDir, "child.jsonl");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
		writeStatus(asyncDir, {
			...runningStatus(runId),
			state: "complete",
			parentWorkflowRunId: "workflow",
			endedAt: Date.now(),
			sessionFile,
			steps: [{ agent: "worker-0", status: "complete", sessionFile }],
		});
		try {
			const result = await steerAsyncRun({ state: createState(), runId, message: "too late", location: { asyncDir } });
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /mode "follow_up"/);
			assert.match(result.content[0]!.text, /action "resume"/);
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("explains why mode follow_up was rejected for a non-retained completed run", async () => {
		const runId = `steer-terminal-followup-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, { ...runningStatus(runId), state: "complete", endedAt: Date.now() });
		try {
			const result = await steerAsyncRun({ state: createState(), runId, message: "too late", mode: "follow_up", location: { asyncDir } });
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /mode "follow_up" requires a completed single-child workflow run/);
			// Resume revives a completed run without a saved session, so it is still offered.
			assert.match(result.content[0]!.text, /Continue it with action "resume"/);
		} finally {
			removeAsyncDir(asyncDir);
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
			removeAsyncDir(asyncDir);
		}
	});

	it("does not recover after the runner records queued acceptance", async () => {
		const runId = `steer-queued-ack-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		let request: SteerRequest | undefined;
		let interrupted = false;
		let recovered = false;
		let attemptedRecovery = false;
		try {
			const result = await steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 25,
				kill: (_pid, signal) => { if (signal !== 0) interrupted = true; return true; },
				onRequestQueued: (requestPath) => {
					request = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as SteerRequest;
					const acknowledged = runningStatus(runId);
					projectRequest(acknowledged, request, ["routed"]);
					updateSteeringTarget(acknowledged.steering!, request.id, 0, "queued", Date.now());
					updateSteeringTarget(acknowledged.steps![0]!.steering!, request.id, 0, "queued", Date.now());
					writeStatus(asyncDir, acknowledged);
				},
				onBeforeRecoveryClaim: () => { attemptedRecovery = true; },
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.deliveryStatus, "queued");
			assert.match(result.content[0]!.text, /Steering queued/);
			assert.equal(interrupted, false);
			assert.equal(recovered, false);
			assert.equal(attemptedRecovery, false);
			assert.ok(request);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", `${Buffer.from(request.id).toString("base64url")}.json`)), false);
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("cancels in-claim recovery when queued acceptance arrives before the claim", async () => {
		const runId = `steer-queued-before-claim-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		let request: SteerRequest | undefined;
		let interrupted = false;
		let recovered = false;
		let attemptedRecovery = false;
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
				onBeforeRecoveryClaim: () => {
					attemptedRecovery = true;
					assert.ok(request);
					const accepted = runningStatus(runId);
					projectRequest(accepted, request, ["routed"]);
					updateSteeringTarget(accepted.steering!, request.id, 0, "queued", Date.now());
					updateSteeringTarget(accepted.steps![0]!.steering!, request.id, 0, "queued", Date.now());
					writeStatus(asyncDir, accepted);
				},
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.deliveryStatus, "queued");
			assert.match(result.content[0]!.text, /Steering queued/);
			assert.equal(interrupted, false);
			assert.equal(recovered, false);
			assert.equal(attemptedRecovery, true);
			assert.ok(request);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", "claim.json")), false);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", `${Buffer.from(request.id).toString("base64url")}.json`)), false);
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("cancels in-claim recovery when queued acceptance arrives after the claim", async () => {
		const runId = `steer-queued-after-claim-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		let request: SteerRequest | undefined;
		let interrupted = false;
		let recovered = false;
		let claimed = false;
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
				onRecoveryCommitted: () => {
					claimed = true;
					assert.ok(request);
					const accepted = runningStatus(runId);
					projectRequest(accepted, request, ["routed"]);
					updateSteeringTarget(accepted.steering!, request.id, 0, "queued", Date.now());
					updateSteeringTarget(accepted.steps![0]!.steering!, request.id, 0, "queued", Date.now());
					writeStatus(asyncDir, accepted);
				},
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.deliveryStatus, "queued");
			assert.match(result.content[0]!.text, /Steering queued/);
			assert.equal(interrupted, false);
			assert.equal(recovered, false);
			assert.equal(claimed, true);
			assert.ok(request);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", "claim.json")), false);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", `${Buffer.from(request.id).toString("base64url")}.json`)), false);
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("honors an acknowledgment persisted before recovery commit without interrupting", async () => {
		const runId = `steer-final-ack-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		let request: SteerRequest | undefined;
		let interrupted = false;
		let recovered = false;
		let attemptedRecovery = false;
		try {
			const result = await steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 25,
				kill: (_pid, signal) => { if (signal !== 0) interrupted = true; return true; },
				onRequestQueued: (requestPath) => {
					request = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as SteerRequest;
					const acknowledged = runningStatus(runId);
					projectRequest(acknowledged, request, ["routed"]);
					updateSteeringTarget(acknowledged.steering!, request.id, 0, "delivered", Date.now());
					updateSteeringTarget(acknowledged.steps![0]!.steering!, request.id, 0, "delivered", Date.now());
					writeStatus(asyncDir, acknowledged);
				},
				onBeforeRecoveryClaim: () => { attemptedRecovery = true; },
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			assert.equal(result.details.steering?.state, "delivered");
			assert.equal(interrupted, false);
			assert.equal(recovered, false);
			assert.equal(attemptedRecovery, false);
			assert.ok(request);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", `${Buffer.from(request.id).toString("base64url")}.json`)), false);
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("releases the claim but launches no replacement after an unconfirmed pause", async () => {
		const runId = `steer-pause-unconfirmed-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
		let claimed = false;
		let recovered = false;
		let request: SteerRequest | undefined;
		try {
			const action = steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir },
				ackTimeoutMs: 25,
				recoveryTimeoutMs: 50,
				kill: (pid, signal) => { kills.push({ pid, signal }); return true; },
				onRequestQueued: (requestPath) => {
					request = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as SteerRequest;
					const routed = runningStatus(runId);
					projectRequest(routed, request, ["routed"]);
					writeStatus(asyncDir, routed);
				},
				onRecoveryCommitted: () => { claimed = true; },
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			const result = await action;
			assert.equal(claimed, true);
			assert.equal(result.isError, true);
			assert.equal(recovered, false);
			assert.match(result.content[0]!.text, /did not confirm a paused state within 0\.05 seconds/);
			assert.match(result.content[0]!.text, /last observed state: running/);
			assert.match(result.content[0]!.text, /No replacement was launched and the steering message was not applied/);
			assert.match(result.content[0]!.text, new RegExp(`action "resume" and id "${runId}"`));
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
			assert.deepEqual(kills, [{ pid: 12345, signal: 0 }]);
			assert.ok(request);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", "claim.json")), false);
			assert.equal(fs.existsSync(path.join(asyncDir, "control", "steer-recovery", `${Buffer.from(request.id).toString("base64url")}.json`)), true);
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("recovers on a later steer after an earlier attempt timed out waiting for the pause", async () => {
		const runId = `steer-pause-retry-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(asyncDir, "child.jsonl");
		writeStatus(asyncDir, runningStatus(runId));
		fs.writeFileSync(sessionFile, "", "utf-8");
		writePrivateAtomicJson(recoveryDescriptorPath(path.dirname(asyncDir), path.basename(asyncDir)), recoveryDescriptor(runId, sessionFile));
		const routeOnly = (requestPath: string): AsyncStatus => {
			const request = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as SteerRequest;
			const routed = runningStatus(runId);
			projectRequest(routed, request, ["routed"]);
			writeStatus(asyncDir, routed);
			return routed;
		};
		try {
			const first = await steerAsyncRun({
				state: createState(), runId, message: "first", location: { asyncDir },
				ackTimeoutMs: 25, recoveryTimeoutMs: 50, kill: () => true,
				onRequestQueued: routeOnly,
				recover: async () => successResult("unexpected"),
			});
			assert.equal(first.isError, true);

			let routed: AsyncStatus | undefined;
			const second = await steerAsyncRun({
				state: createState(), runId, message: "second", location: { asyncDir },
				ackTimeoutMs: 25, recoveryTimeoutMs: 1_000, kill: () => true,
				onRequestQueued: (requestPath) => { routed = routeOnly(requestPath); },
				onRecoveryCommitted: () => {
					assert.ok(routed);
					writeStatus(asyncDir, { ...routed, state: "paused", endedAt: Date.now(), steps: [{ ...routed.steps![0]!, status: "paused", sessionFile }] });
				},
				recover: async () => successResult("replacement"),
			});
			assert.equal(second.isError, undefined, second.content[0]?.type === "text" ? second.content[0].text : undefined);
			assert.equal(second.details.steering?.state, "recovered");
			assert.equal(second.details.steering?.replacementRunId, "replacement");
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("pauses and revives a single run with only its remaining budgets", async () => {
		const runId = `steer-recover-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(asyncDir, "child.jsonl");
		writeStatus(asyncDir, runningStatus(runId));
		fs.writeFileSync(sessionFile, "", "utf-8");
		const descriptorPath = recoveryDescriptorPath(path.dirname(asyncDir), path.basename(asyncDir));
		writePrivateAtomicJson(descriptorPath, recoveryDescriptor(runId, sessionFile));
		if (process.platform !== "win32") assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o600);
		let receivedLimits: unknown;
		let recoveryStarted = false;
		let recoveryCommitted = false;
		let request: SteerRequest | undefined;
		let routed: AsyncStatus | undefined;
		try {
			const action = steerAsyncRun({
				state: createState(),
				runId,
				message: "correct course",
				location: { asyncDir },
				ackTimeoutMs: 250,
				recoveryTimeoutMs: 1_000,
				kill: () => true,
				onRequestQueued: (requestPath) => {
					request = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as SteerRequest;
					routed = runningStatus(runId);
					projectRequest(routed, request, ["routed"]);
					writeStatus(asyncDir, routed);
				},
				onRecoveryCommitted: () => {
					recoveryCommitted = true;
					assert.ok(request);
					assert.ok(routed);
					writeStatus(asyncDir, {
						...routed,
						state: "paused",
						endedAt: Date.now(),
						toolBudget: { soft: 8, hard: 12, block: ["read"], toolCount: 9, outcome: "soft-reached" },
						steps: [{ ...routed.steps![0]!, status: "paused", sessionFile }],
					});
				},
				recover: async (limits) => {
					recoveryStarted = true;
					const paused = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatus;
					assert.equal(paused.state, "paused");
					assert.equal(typeof paused.endedAt, "number");
					receivedLimits = limits;
					return successResult("replacement");
				},
			});
			const result = await action;
			assert.equal(result.isError, undefined);
			assert.equal(result.details.steering?.state, "recovered");
			assert.match(result.content[0]!.text, /Message sent:\n```text\ncorrect course\n```/);
			assert.equal(result.details.steering?.replacementRunId, "replacement");
			const limits = receivedLimits as { timeoutMs: number; absoluteDeadlineAt: number; toolBudget: unknown };
			assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 10_000);
			assert.ok(limits.absoluteDeadlineAt >= Date.now());
			assert.deepEqual({ toolBudget: limits.toolBudget }, {
				toolBudget: { hard: 3, block: ["read"] },
			});
			const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatus;
			assert.equal(persisted.steering?.recent[0]?.targets[0]?.state, "recovered");
			assert.equal(persisted.steps?.[0]?.steering?.recent[0]?.targets[0]?.state, "recovered");
		} finally {
			removeAsyncDir(asyncDir);
		}
	});

	it("leaves a single run paused when no session can be revived", async () => {
		const runId = `steer-no-session-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		writeStatus(asyncDir, runningStatus(runId));
		writePrivateAtomicJson(recoveryDescriptorPath(path.dirname(asyncDir), path.basename(asyncDir)), recoveryDescriptor(runId));
		let recovered = false;
		let recoveryCommitted = false;
		let routed: AsyncStatus | undefined;
		try {
			const action = steerAsyncRun({
				state: createState(), runId, message: "correct course", location: { asyncDir }, ackTimeoutMs: 250, recoveryTimeoutMs: 1_000, kill: () => true,
				onRequestQueued: (requestPath) => {
					const request = JSON.parse(fs.readFileSync(requestPath, "utf-8")) as SteerRequest;
					routed = runningStatus(runId);
					projectRequest(routed, request, ["failed"]);
					writeStatus(asyncDir, routed);
				},
				onRecoveryCommitted: () => {
					recoveryCommitted = true;
					if (routed) writeStatus(asyncDir, { ...routed, state: "paused", endedAt: Date.now(), steps: [{ ...routed.steps![0]!, status: "paused" }] });
				},
				recover: async () => { recovered = true; return successResult("replacement"); },
			});
			const result = await action;
			assert.ok(recoveryCommitted);
			assert.ok(routed);
			assert.equal(result.isError, true);
			assert.equal(recovered, false);
			assert.match(result.content[0]!.text, /no persisted child session|does not have a persisted session file/i);
		} finally {
			removeAsyncDir(asyncDir);
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
			removeAsyncDir(asyncDir);
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
			removeAsyncDir(asyncDir);
		}
	});
});
