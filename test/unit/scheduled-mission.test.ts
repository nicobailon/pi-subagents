import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";
import {
	ASYNC_DIR,
	available,
	createSubagentExecutor,
	installAsyncExecutionHooks,
	isAsyncAvailable,
	readAsyncPayload,
	tempDir,
} from "../support/async-execution-fixture.ts";
import { createMission, resolveMissionStoreLocation, readMission, missionRecordPath } from "../../src/missions/store.ts";
import { createMissionWorkflowState, missionStatePath } from "../../src/missions/workflow-state.ts";
import { createScheduledRunManager } from "../../src/runs/background/scheduled-runs.ts";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";

type WorkflowStatus = {
	state?: string;
	workflow?: { value?: unknown };
};

type TestClock = { now: number };

class FakeTimers {
	readonly values = new Map<number, () => void>();
	private nextId = 0;
	setTimeout = (callback: () => void) => {
		const id = ++this.nextId;
		this.values.set(id, callback);
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	clearTimeout = (handle: ReturnType<typeof setTimeout>) => {
		this.values.delete(handle as unknown as number);
	};
	fireAll(): void {
		const pending = [...this.values.entries()];
		for (const [id, callback] of pending) {
			this.values.delete(id);
			callback();
		}
	}
}

function createRuntime(projectDir: string, missionDir: string, schedulesDir: string, options: { disabledMissions?: boolean; missionsEnabled?: boolean; sessionId?: string; clock?: TestClock } = {}) {
	const clock = options.clock ?? { now: Date.parse("2030-01-01T00:00:00.000Z") };
	const timers = new FakeTimers();
	const config = {
		maxSubagentDepth: 2,
		missions: { directory: missionDir, globalIndex: false, ...(options.missionsEnabled === false ? { enabled: false } : {}) },
		scheduledRuns: { enabled: true },
		...(options.disabledMissions ? { disabledFeatures: ["missions"] } : {}),
	} as ExtensionConfig;
	const ctx = {
		...makeMinimalCtx(projectDir),
		sessionManager: {
			getSessionId: () => options.sessionId ?? "scheduled-mission-session",
			getSessionFile: () => path.join(projectDir, `${options.sessionId ?? "scheduled-mission-session"}.jsonl`),
		},
	} as unknown as ExtensionContext;
	const state = {
		baseCwd: projectDir,
		currentSessionId: null,
		supervisorOwnerSessionId: options.sessionId ?? "scheduled-mission-session",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear() {} },
	} as unknown as SubagentState;
	const pi = {
		events: createEventBus(),
		getSessionName: () => "scheduled mission test",
		sendMessage() {},
	};
	const executor = createSubagentExecutor({
		pi: pi as never,
		state,
		config,
		asyncByDefault: false,
		tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => tempDir,
		expandTilde: value => value,
		discoverAgents: () => ({ agents: [] }),
	});
	const makeManager = () => createScheduledRunManager({
		config,
		storeRoot: schedulesDir,
		now: () => clock.now,
		timers: timers as never,
		launch: (params, launchCtx, signal) => executor.executeScheduled(randomUUID(), params, signal, launchCtx),
	});
	return { config, ctx, clock, timers, executor, makeManager };
}

function workflowValue(asyncId: string): unknown {
	const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
	const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as WorkflowStatus;
	assert.equal(status.state, "complete", `expected terminal async workflow at ${statusPath}`);
	return status.workflow?.value;
}

type TestManager = ReturnType<ReturnType<typeof createRuntime>["makeManager"]>;

async function readAsyncRun(manager: TestManager, asyncId: string): Promise<{ asyncId: string; value: unknown }> {
	const payload = await readAsyncPayload(asyncId);
	assert.equal(payload.success, true, payload.error ?? `async workflow ${asyncId} failed`);
	const value = workflowValue(asyncId);
	manager.handleAsyncCompletion({ runId: asyncId, success: payload.success, summary: payload.summary });
	return { asyncId, value };
}

async function waitForLatestRun(manager: TestManager, ctx: ExtensionContext, scheduleId: string): Promise<{ state?: string; asyncId?: string }> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const history = await manager.handleToolCall({ action: "schedule.history", id: scheduleId }, ctx);
		const runs = (history.details?.schedules as { runs?: Array<{ state?: string; asyncId?: string }> } | undefined)?.runs;
		const latest = runs?.[0];
		if (latest?.asyncId || latest?.state === "failed_launch") return latest;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail(`Timed out waiting for scheduled run '${scheduleId}' to attach an async execution or fail launch.`);
}

async function fireNextTimer(manager: TestManager, runtime: ReturnType<typeof createRuntime>, scheduleId: string): Promise<{ state?: string; asyncId?: string }> {
	const shown = await manager.handleToolCall({ action: "schedule.show", id: scheduleId }, runtime.ctx);
	const schedules = (shown.details?.schedules as { records?: Array<{ trigger?: { nextRunAt?: string } }> } | undefined)?.records;
	const nextRunAt = schedules?.[0]?.trigger?.nextRunAt;
	assert.ok(nextRunAt, `schedule '${scheduleId}' has no timer deadline`);
	assert.ok(runtime.timers.values.size > 0, `schedule '${scheduleId}' should have an armed timer`);
	runtime.clock.now = Date.parse(nextRunAt);
	runtime.timers.fireAll();
	return waitForLatestRun(manager, runtime.ctx, scheduleId);
}

async function runManuallyAndReadValue(manager: TestManager, ctx: ExtensionContext, scheduleId: string): Promise<{ asyncId: string; value: unknown }> {
	const launched = await manager.handleToolCall({ action: "schedule.run", id: scheduleId }, ctx);
	assert.equal(launched.isError, undefined, launched.content[0]?.text);
	const runs = (launched.details?.schedules as { runs?: Array<{ state?: string; asyncId?: string }> } | undefined)?.runs;
	const run = runs?.[0];
	assert.equal(run?.state, "running", launched.content[0]?.text);
	assert.ok(run?.asyncId, launched.content[0]?.text);
	return readAsyncRun(manager, run.asyncId);
}

describe("scheduled workflows attached to an existing mission", { skip: !available || !isAsyncAvailable() ? "async workflow runner dependencies unavailable" : undefined }, () => {
	installAsyncExecutionHooks();

	it("persists state across schedule fires and a manager restart", async () => {
		const projectDir = path.join(tempDir, "project");
		const missionDir = path.join(tempDir, "missions");
		const schedulesDir = path.join(tempDir, "schedules");
		fs.mkdirSync(projectDir, { recursive: true });
		const config = { directory: missionDir, globalIndex: false };
		const location = resolveMissionStoreLocation({ projectRoot: projectDir, config });
		const mission = createMission(location, { title: "Scheduled cursor", objective: "Advance a persisted workflow cursor", status: "active" });
		const clock = { now: Date.parse("2030-01-01T00:00:00.000Z") };
		const runtime = createRuntime(projectDir, missionDir, schedulesDir, { clock, sessionId: "scheduled-mission-session-a", missionsEnabled: false });
		let manager = runtime.makeManager();
		manager.bindSession(runtime.ctx);
		const scheduleId = "mission-cursor";
		const created = await manager.handleToolCall({
			action: "schedule.create",
			id: scheduleId,
			every: "1h",
			cwd: projectDir,
			missionId: mission.id,
			workflowScript: `const cursor = (await state.get("cursor")) ?? 0; await state.set("cursor", cursor + 1); return cursor;`,
		}, runtime.ctx);
		assert.equal(created.isError, undefined, created.content[0]?.text);
		assert.match(created.content[0]?.text ?? "", new RegExp(`Mission: ${mission.id}`));

		try {
			const firstRun = await fireNextTimer(manager, runtime, scheduleId);
			assert.equal(firstRun.state, "running");
			assert.ok(firstRun.asyncId);
			const first = await readAsyncRun(manager, firstRun.asyncId);
			assert.equal(first.value, 0, "first scheduled workflow sees an unset mission cursor");
			assert.deepEqual(JSON.parse(fs.readFileSync(missionStatePath(location, mission.id), "utf-8")), { cursor: 1 });

			const secondRun = await fireNextTimer(manager, runtime, scheduleId);
			assert.equal(secondRun.state, "running");
			assert.ok(secondRun.asyncId);
			const second = await readAsyncRun(manager, secondRun.asyncId);
			assert.equal(second.value, 1, "second scheduled workflow reads the first run's durable cursor");
			assert.deepEqual(JSON.parse(fs.readFileSync(missionStatePath(location, mission.id), "utf-8")), { cursor: 2 });

			manager.stop();
			const restarted = createRuntime(projectDir, missionDir, schedulesDir, { clock, sessionId: "scheduled-mission-session-b", missionsEnabled: false });
			assert.notEqual(restarted.ctx.sessionManager.getSessionId(), runtime.ctx.sessionManager.getSessionId());
			manager = restarted.makeManager();
			manager.bindSession(restarted.ctx);
			const third = await runManuallyAndReadValue(manager, restarted.ctx, scheduleId);
			assert.equal(third.value, 2, "restored schedule reads mission state persisted before manager restart");
			assert.deepEqual(JSON.parse(fs.readFileSync(missionStatePath(location, mission.id), "utf-8")), { cursor: 3 });
			assert.equal(readMission(location, mission.id).id, mission.id);
		} finally {
			manager.stop();
		}
	});

	it("keeps mission state unavailable when a schedule has no mission", async () => {
		const projectDir = path.join(tempDir, "project-without-mission");
		const missionDir = path.join(tempDir, "missions-without-target");
		const schedulesDir = path.join(tempDir, "schedules-without-mission");
		fs.mkdirSync(projectDir, { recursive: true });
		const runtime = createRuntime(projectDir, missionDir, schedulesDir);
		const manager = runtime.makeManager();
		manager.bindSession(runtime.ctx);
		try {
			const created = await manager.handleToolCall({
				action: "schedule.create",
				id: "no-mission",
				every: "1h",
				cwd: projectDir,
				workflowScript: `return typeof state;`,
			}, runtime.ctx);
			assert.equal(created.isError, undefined, created.content[0]?.text);
			const result = await runManuallyAndReadValue(manager, runtime.ctx, "no-mission");
			assert.equal(result.value, "undefined");
			assert.equal(fs.existsSync(missionDir), false, "mission:false on scheduled execution must not create a mission store");
		} finally {
			manager.stop();
		}
	});

	it("records failed_launch if an attached mission disappears before a timer fire", async () => {
		const projectDir = path.join(tempDir, "project-with-missing-mission");
		const missionDir = path.join(tempDir, "missions-missing-target");
		const schedulesDir = path.join(tempDir, "schedules-missing-mission");
		fs.mkdirSync(projectDir, { recursive: true });
		const location = resolveMissionStoreLocation({ projectRoot: projectDir, config: { directory: missionDir, globalIndex: false } });
		const mission = createMission(location, { title: "Removed mission", objective: "Must not be recreated by its schedule", status: "active" });
		const runtime = createRuntime(projectDir, missionDir, schedulesDir);
		const manager = runtime.makeManager();
		manager.bindSession(runtime.ctx);
		try {
			const created = await manager.handleToolCall({
				action: "schedule.create",
				id: "deleted-mission-target",
				every: "1h",
				cwd: projectDir,
				missionId: mission.id,
				workflowScript: `const cursor = (await state.get("cursor")) ?? 0; await state.set("cursor", cursor + 1); return cursor;`,
			}, runtime.ctx);
			assert.equal(created.isError, undefined, created.content[0]?.text);
			fs.rmSync(missionRecordPath(location, mission.id));
			assert.equal(fs.existsSync(missionStatePath(location, mission.id)), false);
			const failedRun = await fireNextTimer(manager, runtime, "deleted-mission-target");
			assert.equal(failedRun.state, "failed_launch");
			assert.equal(failedRun.asyncId, undefined, "the executor rejects the missing mission before starting an async workflow");
			const history = await manager.handleToolCall({ action: "schedule.history", id: "deleted-mission-target" }, runtime.ctx);
			const historyRuns = (history.details?.schedules as { runs?: Array<{ error?: string }> } | undefined)?.runs;
			assert.match(historyRuns?.[0]?.error ?? "", /was not found/u);
			assert.equal(fs.existsSync(missionRecordPath(location, mission.id)), false, "the schedule must not create a replacement mission record");
			assert.equal(fs.existsSync(missionStatePath(location, mission.id)), false, "failed launch must not create mission state");
		} finally {
			manager.stop();
		}
	});

	it("fails a restored mission-bound schedule before workflow execution when missions are disabled", async () => {
		const projectDir = path.join(tempDir, "project-disabled-after-restore");
		const missionDir = path.join(tempDir, "missions-disabled-after-restore");
		const schedulesDir = path.join(tempDir, "schedules-disabled-after-restore");
		fs.mkdirSync(projectDir, { recursive: true });
		const location = resolveMissionStoreLocation({ projectRoot: projectDir, config: { directory: missionDir, globalIndex: false } });
		const mission = createMission(location, { title: "Disabled after restore", objective: "Do not run after policy changes", status: "active" });
		createMissionWorkflowState(location, mission.id).set("cursor", 7);
		const recordPath = missionRecordPath(location, mission.id);
		const recordBefore = fs.readFileSync(recordPath, "utf-8");
		const statePath = missionStatePath(location, mission.id);
		const stateBefore = fs.readFileSync(statePath, "utf-8");
		const initial = createRuntime(projectDir, missionDir, schedulesDir);
		const initialManager = initial.makeManager();
		initialManager.bindSession(initial.ctx);
		const created = await initialManager.handleToolCall({
			action: "schedule.create",
			id: "mission-disabled-restore",
			every: "1h",
			cwd: projectDir,
			missionId: mission.id,
			workflowScript: `const cursor = await state.get("cursor"); await state.set("cursor", cursor + 1); return cursor;`,
		}, initial.ctx);
		assert.equal(created.isError, undefined, created.content[0]?.text);
		initialManager.stop();

		const disabled = createRuntime(projectDir, missionDir, schedulesDir, { disabledMissions: true, sessionId: "scheduled-mission-session-disabled" });
		const restoredManager = disabled.makeManager();
		restoredManager.bindSession(disabled.ctx);
		try {
			const createRejected = await disabled.executor.executePublic(randomUUID(), { action: "schedule.create", id: "disabled-create", every: "1h", workflowScript: "return 1", missionId: mission.id }, new AbortController().signal, undefined, disabled.ctx);
			assert.equal(createRejected.isError, true);
			assert.match(createRejected.content[0]?.text ?? "", /missionId.*disabled/u);
			const failedRun = await fireNextTimer(restoredManager, disabled, "mission-disabled-restore");
			assert.equal(failedRun.state, "failed_launch");
			assert.equal(failedRun.asyncId, undefined, "policy rejection occurs before starting an async workflow or child");
			const history = await restoredManager.handleToolCall({ action: "schedule.history", id: "mission-disabled-restore" }, disabled.ctx);
			const runs = (history.details?.schedules as { runs?: Array<{ state?: string; asyncId?: string; error?: string }> } | undefined)?.runs;
			assert.equal(runs?.[0]?.state, "failed_launch");
			assert.match(runs?.[0]?.error ?? "", /missionId.*disabled/u);
			assert.equal(fs.readFileSync(recordPath, "utf-8"), recordBefore, "failed launch must not change mission lifecycle metadata");
			assert.equal(fs.readFileSync(statePath, "utf-8"), stateBefore, "failed launch must not mutate durable workflow state");
		} finally {
			restoredManager.stop();
		}
	});

});
