import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	HERDR_FOREGROUND_CONTROL_CHANGED_EVENT,
	registerHerdrStatusBridge,
	type HerdrStatusBridgeEvents,
	type HerdrStatusRun,
} from "../../src/integrations/herdr-status.ts";
import { projectActiveHerdrRuns } from "../../src/extension/index.ts";
import { beginForegroundChild, finishForegroundChild } from "../../src/runs/foreground/foreground-control.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
} from "../../src/shared/types.ts";

class FakeIntervals {
	private callbacks = new Map<object, () => void>();

	readonly timers = {
		setInterval: ((callback: () => void) => {
			const handle = { unref() {} };
			this.callbacks.set(handle, callback);
			return handle;
		}) as unknown as typeof setInterval,
		clearInterval: ((handle: object) => {
			this.callbacks.delete(handle);
		}) as unknown as typeof clearInterval,
	};

	fireAll(): void {
		for (const callback of [...this.callbacks.values()]) callback();
	}

	pendingCount(): number {
		return this.callbacks.size;
	}
}

class FakeEvents implements HerdrStatusBridgeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => {
			const current = this.handlers.get(event) ?? [];
			this.handlers.set(event, current.filter((candidate) => candidate !== handler));
		};
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function stateForTest(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

describe("Herdr status bridge", () => {
	it("projects foreground workflow children onto the parent run without a shell duplicate", () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			status: "running",
			mode: "workflow",
			agents: ["workflow"],
			steps: [{ agent: "reviewer", status: "running", label: "Review auth" }],
		});
		state.foregroundControls.set("child-1", {
			runId: "child-1",
			parentWorkflowRunId: "workflow-1",
			workflowKey: "review",
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			activeChildren: new Map([[0, {
				index: 0,
				agent: "reviewer",
				startedAt: 10,
				updatedAt: 20,
				currentActivityState: "needs_attention",
			}]]),
		});

		assert.deepEqual(projectActiveHerdrRuns(state), [{
			id: "workflow-1",
			coordinator: true,
			agents: ["reviewer"],
			taskLabel: "Review auth",
			needsAttention: true,
		}]);
	});

	it("counts a workflow async child once instead of also counting the coordinator", () => {
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1",
			asyncDir: "/tmp/workflow-1",
			status: "running",
			mode: "workflow",
			agents: ["workflow"],
			steps: [],
		});
		state.asyncJobs.set("child-1", {
			asyncId: "child-1",
			asyncDir: "/tmp/child-1",
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			parentWorkflowRunId: "workflow-1",
		});

		assert.deepEqual(projectActiveHerdrRuns(state), [
			{ id: "workflow-1", coordinator: true, agents: [], needsAttention: false },
			{ id: "child-1", agents: ["reviewer"], needsAttention: false },
		]);
	});

	it("publishes foreground workflow child start and finish without the periodic refresh", async () => {
		// Covers the bridge subscription only; the event is emitted by hand here.
		const state = stateForTest();
		state.asyncJobs.set("workflow-1", {
			asyncId: "workflow-1", asyncDir: "/tmp/workflow-1", status: "running",
			mode: "workflow", agents: ["workflow"],
		});
		const events = new FakeEvents();
		const commands: string[][] = [];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getRuns: () => projectActiveHerdrRuns(state),
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: projectActiveHerdrRuns(state) });
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 0 subagents"));

		state.foregroundControls.set("child-1", {
			runId: "child-1", parentWorkflowRunId: "workflow-1", mode: "single",
			startedAt: 10, updatedAt: 10,
		});
		const control = state.foregroundControls.get("child-1")!;
		beginForegroundChild(control, { index: 0, agent: "reviewer", authoredTask: "review", effectivePrompt: "review", interrupt: () => true });
		events.emit(HERDR_FOREGROUND_CONTROL_CHANGED_EVENT, { runId: "workflow-1" });
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (reviewer)"));

		finishForegroundChild(control, 0);
		events.emit(HERDR_FOREGROUND_CONTROL_CHANGED_EVENT, { runId: "workflow-1" });
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 0 subagents"));
		bridge.dispose();
	});

	it("keeps child IDs live for attention and completion after a workflow refresh", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const coordinator = { id: "workflow-1", coordinator: true as const, agents: [] };
		const child = { id: "child-1", agents: ["reviewer"] };
		let authoritativeRuns: HerdrStatusRun[] = [coordinator];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getRuns: () => authoritativeRuns,
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [coordinator] });
		authoritativeRuns = [coordinator, child];
		bridge.syncRuns();
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (reviewer)"));
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async", noticeText: "reviewer needs attention",
			event: { type: "needs_attention", runId: "child-1" },
		});
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (reviewer) ⚠"));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "child-1" });
		authoritativeRuns = [coordinator];
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 0 subagents"));
		bridge.dispose();
	});

	it("synchronizes runs discovered outside lifecycle events", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getRuns: () => [{ id: "restored-run", agent: "worker" }],
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		bridge.syncRuns();
		await bridge.flush();

		assert.equal(commands.length, 1);
		assert.ok(commands[0]?.includes("summary=⏳ 1 subagent (worker)"));

		bridge.dispose();
	});

	it("does not count the workflow coordinator's own start event as a running leaf", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const busyEvents: unknown[] = [];
		events.on("herdr:busy", (payload) => busyEvents.push(payload));
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "workflow-1", mode: "workflow", agent: "workflow" });
		await bridge.flush();

		// The coordinator is active (busy stays raised) but contributes zero leaves.
		assert.deepEqual(busyEvents, [{ active: true, label: "⏳ 0 subagents" }]);
		assert.ok(commands[0]?.includes("summary=⏳ 0 subagents"));
		assert.ok(!commands[0]?.join(" ").includes("workflow"));

		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "child-1", agent: "reviewer" });
		await bridge.flush();

		assert.deepEqual(busyEvents.at(-1), { active: true, label: "⏳ 1 subagent (reviewer)" });
		assert.ok(commands[1]?.includes("summary=⏳ 1 subagent (reviewer)"));

		bridge.dispose();
	});

	it("reports an async run as visible and semantically busy", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const busyEvents: unknown[] = [];
		events.on("herdr:busy", (payload) => busyEvents.push(payload));
		const bridge = registerHerdrStatusBridge({
			events,
			env: {
				HERDR_ENV: "1",
				HERDR_PANE_ID: "w1:p1",
			},
			runHerdr: (args) => {
				commands.push([...args]);
			},
			refreshMs: 0,
		});

		bridge.sessionStarted({ hasUI: true, runs: [] });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id: "run-1",
			agent: "worker",
		});
		await bridge.flush();

		assert.deepEqual(busyEvents, [{
			active: true,
			label: "⏳ 1 subagent (worker)",
		}]);
		assert.equal(commands.length, 1);
		assert.deepEqual(commands[0]?.slice(0, 8), [
			"pane",
			"report-metadata",
			"w1:p1",
			"--source",
			"pi-subagents:herdr",
			"--agent",
			"pi",
			"--applies-to-source",
		]);
		assert.ok(commands[0]?.includes("herdr:pi"));
		assert.ok(commands[0]?.includes("--state-label"));
		assert.ok(commands[0]?.includes("working=⏳ 1 subagent (worker)"));
		assert.ok(commands[0]?.includes("idle=⏳ 1 subagent (worker)"));
		assert.ok(commands[0]?.includes("done=⏳ 1 subagent (worker)"));
		assert.ok(commands[0]?.includes("summary=⏳ 1 subagent (worker)"));
		assert.ok(commands[0]?.includes("--ttl-ms"));
		assert.ok(commands[0]?.includes("--seq"));

		bridge.dispose();
	});

	it("updates the aggregate label and clears status after the final run completes", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const busyEvents: unknown[] = [];
		events.on("herdr:busy", (payload) => busyEvents.push(payload));
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		await bridge.flush();
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-2", agent: "reviewer" });
		await bridge.flush();
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-1" });
		await bridge.flush();
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "run-2" });
		await bridge.flush();

		assert.deepEqual(busyEvents, [
			{ active: true, label: "⏳ 1 subagent (worker)" },
			{ active: false },
			{ active: true, label: "⏳ 2 subagents (worker, reviewer)" },
			{ active: false },
			{ active: true, label: "⏳ 1 subagent (reviewer)" },
			{ active: false },
		]);
		assert.equal(commands.length, 4);
		assert.ok(commands[1]?.includes("summary=⏳ 2 subagents (worker, reviewer)"));
		assert.ok(commands[2]?.includes("summary=⏳ 1 subagent (reviewer)"));
		assert.ok(commands[3]?.includes("--clear-state-labels"));
		assert.ok(commands[3]?.includes("--clear-token"));

		bridge.dispose();
	});

	it("never raises Herdr's human-blocked state for child attention", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const blockedEvents: unknown[] = [];
		events.on("herdr:blocked", (payload) => blockedEvents.push(payload));
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [{ id: "run-restored", agent: "reviewer", needsAttention: true }] });
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (reviewer) ⚠"));

		bridge.agentStarted();
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async",
			noticeText: "Worker is waiting for a supervisor reply",
			event: { type: "needs_attention", runId: "run-1", reason: "supervisor_request" },
		});
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 2 subagents (reviewer, worker) ⚠"));
		assert.deepEqual(blockedEvents, []);

		bridge.dispose();
	});

	it("marks attention in the label until the parent agent wakes", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async",
			event: { type: "active_long_running", runId: "run-1" },
		});
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "foreground",
			event: { type: "needs_attention", runId: "run-1" },
		});
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (worker)"));
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async",
			event: { type: "needs_attention", runId: "run-1" },
		});
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (worker) ⚠"));
		bridge.agentStarted();
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (worker)"));

		bridge.dispose();
	});

	it("does not resurrect acknowledged attention during TTL reconciliation", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const intervals = new FakeIntervals();
		let authoritativeRuns = [{ id: "run-1", agent: "worker", needsAttention: false }];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getRuns: () => authoritativeRuns,
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 45_000,
			timers: intervals.timers,
		});
		bridge.sessionStarted({ hasUI: true, runs: authoritativeRuns });
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async",
			event: { type: "needs_attention", runId: "run-1" },
		});
		authoritativeRuns = [{ id: "run-1", agent: "worker", needsAttention: true }];
		bridge.agentStarted();

		intervals.fireAll();
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (worker)"));

		// A new explicit control event is a new attention transition even if
		// the tracker flag never dropped.
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async",
			event: { type: "needs_attention", runId: "run-1" },
		});
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (worker) ⚠"));

		bridge.dispose();
	});

	it("keeps the attention mark while any run still needs attention", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-2", agent: "reviewer" });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-3", agent: "scout" });

		events.emit(SUBAGENT_CONTROL_EVENT, { source: "async", event: { type: "needs_attention", runId: "run-1" } });
		events.emit(SUBAGENT_CONTROL_EVENT, { source: "async", event: { type: "needs_attention", runId: "run-2" } });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-2" });
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 2 subagents (worker, scout) ⚠"));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-1" });
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("summary=⏳ 1 subagent (scout)"));

		bridge.dispose();
	});

	it("restores active runs and clears overlays on disposal", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const busyEvents: unknown[] = [];
		events.on("herdr:busy", (payload) => busyEvents.push(payload));
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});

		bridge.sessionStarted({
			hasUI: true,
			runs: [{
				id: "run-restored",
				agents: ["worker", "reviewer"],
				needsAttention: true,
			}],
		});
		await bridge.flush();

		assert.deepEqual(busyEvents, [{
			active: true,
			label: "⏳ 2 subagents (worker, reviewer)",
		}]);
		assert.ok(commands[0]?.includes("summary=⏳ 2 subagents (worker, reviewer) ⚠"));

		bridge.dispose();
		await bridge.flush();

		assert.deepEqual(busyEvents.at(-1), { active: false });
		assert.ok(commands.at(-1)?.includes("--clear-state-labels"));
	});

	it("reports project pane counts and compact title suffixes", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		let paneCount = 1;
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getProjectPaneCount: () => paneCount,
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		await bridge.flush();
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-2", agent: "reviewer" });
		await bridge.flush();
		events.emit(SUBAGENT_CONTROL_EVENT, {
			source: "async",
			noticeText: "worker needs attention",
			event: { type: "needs_attention", runId: "run-1" },
		});
		await bridge.flush();
		paneCount = 0;
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-1" });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-2" });
		await bridge.flush();

		assert.ok(commands[0]?.includes("summary=⏳ 1 subagent (worker) · 1 pane"));
		assert.ok(commands[0]?.includes("title-suffix=⏳worker"));
		assert.ok(commands[1]?.includes("summary=⏳ 2 subagents (worker, reviewer) · 1 pane"));
		assert.ok(commands[1]?.includes("title-suffix=⏳2"));
		assert.ok(commands[2]?.includes("title-suffix=⏳2⚠"));
		assert.ok(commands.at(-1)?.includes("--clear-token"));
		assert.ok(commands.at(-1)?.includes("title-suffix"));

		bridge.dispose();
	});

	it("publishes bounded workflow labels without leaking raw prompts and restores the previous overlapping task", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id: "run-1",
			agent: "worker",
			goal: "raw secret prompt",
			workflowGraph: {
				currentNodeId: "build",
				nodes: [{ id: "build", status: "running", label: "Build auth\nflow\u001b[31m" }],
			},
		});
		await bridge.flush();
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id: "run-2",
			agent: "reviewer",
			task: "another raw prompt",
			workflowGraph: {
				nodes: [{ id: "review", status: "pending", label: `Review ${"x".repeat(120)}` }],
			},
		});
		await bridge.flush();
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-2" });
		await bridge.flush();
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-1" });
		await bridge.flush();

		assert.ok(commands[0]?.includes("summary=⏳ 1 subagent (worker) · Build auth flow"));
		assert.ok(commands[0]?.includes("title-suffix=⏳Build auth flow"));
		assert.ok(commands[1]?.some((argument) => argument.startsWith("summary=⏳ 2 subagents") && argument.length < 180));
		assert.ok(commands[1]?.some((argument) => argument.startsWith("title-suffix=⏳Review ") && argument.length < 70));
		assert.ok(commands[2]?.includes("title-suffix=⏳Build auth flow"));
		assert.ok(commands[3]?.includes("--clear-state-labels"));
		assert.doesNotMatch(commands.flat().join("\n"), /raw secret prompt|another raw prompt/);

		bridge.dispose();
	});

	it("omits refreshed task labels when sanitization removes all content", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});

		bridge.sessionStarted({ hasUI: true, runs: [{ id: "run-1", agent: "worker", taskLabel: "\u001b[31m" }] });
		await bridge.flush();

		assert.ok(commands[0]?.includes("summary=⏳ 1 subagent (worker)"));
		assert.ok(commands[0]?.includes("title-suffix=⏳worker"));
		assert.doesNotMatch(commands.flat().join("\n"), /\u001b\[31m/);

		bridge.dispose();
	});

	it("clears a completed step label when the authoritative active step is unlabeled", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const intervals = new FakeIntervals();
		let authoritativeRuns: HerdrStatusRun[] = [{ id: "run-1", agent: "worker", taskLabel: "Build auth" }];
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getRuns: () => authoritativeRuns,
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 45_000,
			timers: intervals.timers,
		});
		bridge.sessionStarted({ hasUI: true, runs: authoritativeRuns });
		await bridge.flush();

		authoritativeRuns = [{ id: "run-1", agent: "worker" }];
		intervals.fireAll();
		await bridge.flush();

		assert.ok(commands[0]?.includes("title-suffix=⏳Build auth"));
		assert.ok(commands[1]?.includes("summary=⏳ 1 subagent (worker)"));
		assert.ok(commands[1]?.includes("title-suffix=⏳worker"));
		assert.doesNotMatch(commands[1]?.join("\n") ?? "", /Build auth/);

		bridge.dispose();
	});

	it("refreshes metadata only while runs are active", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const intervals = new FakeIntervals();
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 45_000,
			timers: intervals.timers,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		assert.equal(intervals.pendingCount(), 0);
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		assert.equal(intervals.pendingCount(), 1);
		await bridge.flush();
		intervals.fireAll();
		await bridge.flush();
		assert.equal(commands.length, 2);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-1" });
		assert.equal(intervals.pendingCount(), 0);
		await bridge.flush();
		assert.ok(commands.at(-1)?.includes("--clear-state-labels"));

		bridge.dispose();
	});

	it("reconciles missed completion events before refreshing metadata", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const busyEvents: unknown[] = [];
		const intervals = new FakeIntervals();
		let authoritativeRuns = [{ id: "run-1", agent: "worker" }];
		events.on("herdr:busy", (payload) => busyEvents.push(payload));
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getRuns: () => authoritativeRuns,
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 45_000,
			timers: intervals.timers,
		});
		bridge.sessionStarted({ hasUI: true, runs: authoritativeRuns });
		await bridge.flush();
		assert.equal(intervals.pendingCount(), 1);

		// Simulate the tracker reaching terminal state while the bridge misses
		// the completion event. The refresh must clear instead of extending TTL.
		authoritativeRuns = [];
		intervals.fireAll();
		await bridge.flush();

		assert.deepEqual(busyEvents, [
			{ active: true, label: "⏳ 1 subagent (worker)" },
			{ active: false },
		]);
		assert.equal(intervals.pendingCount(), 0);
		assert.ok(commands.at(-1)?.includes("--clear-state-labels"));

		bridge.dispose();
	});

	it("coalesces queued metadata reports to the latest desired state", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		let releaseFirst: (() => void) | undefined;
		const firstPending = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			runHerdr: (args) => {
				commands.push([...args]);
				if (commands.length === 1) return firstPending;
			},
			refreshMs: 0,
		});
		bridge.sessionStarted({ hasUI: true, runs: [] });

		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		await Promise.resolve();
		assert.equal(commands.length, 1);

		// These snapshots all arrive while the first CLI call is blocked. Only
		// the final clear matters once that call returns.
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-2", agent: "reviewer" });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-1" });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "run-2" });
		releaseFirst?.();
		await bridge.flush();

		assert.equal(commands.length, 2);
		assert.ok(commands[0]?.includes("summary=⏳ 1 subagent (worker)"));
		assert.ok(commands[1]?.includes("--clear-state-labels"));

		bridge.dispose();
	});

	it("stays inert until a root interactive session starts", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		const busyEvents: unknown[] = [];
		let getRunsCalls = 0;
		events.on("herdr:busy", (payload) => busyEvents.push(payload));
		const bridge = registerHerdrStatusBridge({
			events,
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			getRuns: () => {
				getRunsCalls += 1;
				return [{ id: "run-authoritative", agent: "worker" }];
			},
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});

		// Before any session_start, the pane owner is unknown.
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-early", agent: "worker" });
		await bridge.flush();
		assert.deepEqual(commands, []);
		assert.deepEqual(busyEvents, []);

		// A headless parent (print/json mode, or a test harness) must never publish.
		bridge.sessionStarted({ hasUI: false, runs: [{ id: "run-headless", agent: "worker" }] });
		bridge.syncRuns();
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		await bridge.flush();
		assert.deepEqual(commands, []);
		assert.deepEqual(busyEvents, []);
		assert.equal(getRunsCalls, 0);

		// Only the root interactive session owns the pane.
		bridge.sessionStarted({ hasUI: true, runs: [] });
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-2", agent: "reviewer" });
		await bridge.flush();
		assert.equal(commands.length, 1);
		assert.ok(commands[0]?.includes("summary=⏳ 1 subagent (reviewer)"));
		assert.deepEqual(busyEvents, [{ active: true, label: "⏳ 1 subagent (reviewer)" }]);

		bridge.dispose();
	});

	it("stays inert outside a Herdr pane", async () => {
		const events = new FakeEvents();
		const commands: string[][] = [];
		let getRunsCalls = 0;
		const bridge = registerHerdrStatusBridge({
			events,
			env: {},
			getRuns: () => {
				getRunsCalls += 1;
				return [{ id: "run-2", agent: "reviewer" }];
			},
			runHerdr: (args) => commands.push([...args]),
			refreshMs: 0,
		});

		bridge.sessionStarted({ hasUI: true, runs: [{ id: "run-2", agent: "reviewer" }] });
		bridge.syncRuns();
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "run-1", agent: "worker" });
		bridge.agentStarted();
		bridge.dispose();
		await bridge.flush();

		assert.deepEqual(commands, []);
		assert.equal(getRunsCalls, 0);
	});
});
