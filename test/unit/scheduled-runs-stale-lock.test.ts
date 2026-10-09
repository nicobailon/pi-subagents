import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createScheduledRunManager,
	scheduledRunStorePath,
	type ScheduledRunManager,
} from "../../src/runs/background/scheduled-runs.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";

type Timer = { callback: () => void; delay: number };
class FakeTimers {
	readonly values = new Map<number, Timer>();
	private id = 0;
	setTimeout = (callback: () => void, delay: number) => {
		const id = ++this.id;
		this.values.set(id, { callback, delay });
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	clearTimeout = (id: ReturnType<typeof setTimeout>) => void this.values.delete(id as unknown as number);
	fireAll(): void {
		const pending = [...this.values.entries()];
		for (const [id, timer] of pending) {
			this.values.delete(id);
			timer.callback();
		}
	}
}

type Launch = {
	params: Record<string, unknown>;
	ctx: ExtensionContext;
	resolve(result: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }): void;
};

type Harness = {
	manager: ScheduledRunManager;
	ctx: ExtensionContext;
	clock: { now: number };
	timers: FakeTimers;
	launches: Launch[];
	root: string;
};

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function context(cwd: string, sessionId = "session-a"): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(cwd, `${sessionId}.jsonl`),
		},
	} as unknown as ExtensionContext;
}

function harness(options: { cwd?: string; sessionId?: string; now?: number; config?: ExtensionConfig; randomId?: () => string } = {}): Harness {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-schedule-stale-lock-"));
	roots.push(root);
	const project = options.cwd ?? path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	const ctx = context(project, options.sessionId);
	const clock = { now: options.now ?? Date.parse("2030-01-01T00:00:00Z") };
	const timers = new FakeTimers();
	const launches: Launch[] = [];
	let id = 0;
	const manager = createScheduledRunManager({
		config: options.config ?? { scheduledRuns: { enabled: true } },
		storeRoot: path.join(root, "stores"),
		now: () => clock.now,
		randomId: options.randomId ?? (() => `id-${++id}`),
		timers,
		launch: (params, launchCtx) => new Promise((resolve) => launches.push({ params: params as Record<string, unknown>, ctx: launchCtx, resolve: resolve as Launch["resolve"] })) as never,
	});
	manager.bindSession(ctx);
	return { manager, ctx, clock, timers, launches, root };
}

function text(result: Awaited<ReturnType<ScheduledRunManager["handleToolCall"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

const DAY = 24 * 60 * 60 * 1000;
const STALE_RECOVERY_ERROR = "Recovered a stale attached run: the async run never reached a terminal state within the 24h stale budget.";

async function intervalSchedule(h: Harness, id = "monitor"): Promise<void> {
	const created = await h.manager.handleToolCall({ action: "schedule.create", id, every: "1h", workflowScript: "return runs.run('main', { agent: 'monitor', task: 'Check the fleet' })" }, h.ctx);
	assert.equal(created.isError, undefined, text(created));
}

async function runEvents(h: Harness, scheduleId: string): Promise<Array<{ event: string; state?: string; runId?: string }>> {
	const file = path.join(scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores")), scheduleId, "events.jsonl");
	return fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("stale attached run and orphaned active.lock recovery", () => {
	it("T1: recovers a stale attached run on the next timer fire and relaunches instead of skipping", async () => {
		const h = harness();
		await intervalSchedule(h);
		const dir = path.join(scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores")), "monitor");

		h.clock.now += 3_600_000;
		h.timers.fireAll();
		const asyncDir = path.join(h.root, "async-dead");
		fs.mkdirSync(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "dead-1", mode: "single", state: "running", startedAt: h.clock.now }), "utf-8");
		h.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "dead-1", asyncDir } });
		await flush();
		const originalRunId = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8")).activeRunId;
		assert.ok(originalRunId);
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8").trim(), originalRunId, "the dead runner left its lock behind");

		// The detached runner died at startup: the clock moves past the 24h budget with no terminal status.
		h.clock.now += DAY + 60_000;
		h.timers.fireAll();
		await flush();

		const original = JSON.parse(fs.readFileSync(path.join(dir, "runs", `${originalRunId}.json`), "utf-8"));
		assert.equal(original.state, "failed_run");
		assert.equal(original.error, STALE_RECOVERY_ERROR);

		// Recovery removed the dead run's lock; the same fire then relaunches and the fresh
		// run reclaims it, so the on-disk lock must now be owned by the new run, not the dead one.
		const recovered = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8"));
		assert.notEqual(recovered.activeRunId, originalRunId);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), true);
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8").trim(), recovered.activeRunId, "the lock is no longer the dead run's");

		assert.equal(h.launches.length, 2, "the next due fire launches a fresh run instead of skipping");
		const fresh = JSON.parse(fs.readFileSync(path.join(dir, "runs", `${recovered.activeRunId}.json`), "utf-8"));
		assert.equal(fresh.state, "running");

		const events = await runEvents(h, "monitor");
		assert.ok(events.some((event) => event.runId === originalRunId && event.event === "schedule.run.failed"), "the stale run's terminal event is a failure, not a skip");
		assert.ok(!events.some((event) => event.runId === originalRunId && event.event === "schedule.skipped_overlap"));
	});

	it("T2: restores a stuck attached run when a second manager binds after the stale budget", async () => {
		const h = harness();
		await intervalSchedule(h);
		const dir = path.join(scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores")), "monitor");

		h.clock.now += 3_600_000;
		h.timers.fireAll();
		const asyncDir = path.join(h.root, "async-dead-restore");
		fs.mkdirSync(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "dead-2", mode: "single", state: "running", startedAt: h.clock.now }), "utf-8");
		h.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "dead-2", asyncDir } });
		await flush();
		const originalRunId = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8")).activeRunId;
		assert.ok(originalRunId);
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8").trim(), originalRunId);
		h.manager.stop();

		// A restart past the 24h budget must recover the stuck state during restore.
		h.clock.now += DAY + 60_000;
		const secondTimers = new FakeTimers();
		const secondLaunches: Launch[] = [];
		const second = createScheduledRunManager({
			config: { scheduledRuns: { enabled: true } },
			storeRoot: path.join(h.root, "stores"),
			now: () => h.clock.now,
			timers: secondTimers,
			launch: (params, launchCtx) => new Promise((resolve) => secondLaunches.push({ params: params as Record<string, unknown>, ctx: launchCtx, resolve: resolve as Launch["resolve"] })) as never,
		});
		second.bindSession(h.ctx);

		const restored = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8"));
		assert.equal(restored.activeRunId, undefined, "restore clears the dead claim");
		const original = JSON.parse(fs.readFileSync(path.join(dir, "runs", `${originalRunId}.json`), "utf-8"));
		assert.equal(original.state, "failed_run");
		assert.equal(original.error, STALE_RECOVERY_ERROR);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false, "restore removed the orphaned lock");

		// The restored manager must launch a fresh run instead of skipping forever.
		h.clock.now += 3_600_000;
		secondTimers.fireAll();
		await flush();
		assert.equal(secondLaunches.length, 1, "the timer fire after recovery launches a fresh run");
		const afterFire = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8"));
		const fresh = JSON.parse(fs.readFileSync(path.join(dir, "runs", `${afterFire.activeRunId}.json`), "utf-8"));
		assert.equal(fresh.state, "running");
		const events = await runEvents(h, "monitor");
		assert.ok(!events.some((event) => event.runId === originalRunId && event.event === "schedule.skipped_overlap"));
	});

	it("T3(a): reclaims an orphaned active.lock whose holder is a known terminal run", async () => {
		const h = harness();
		await intervalSchedule(h, "orphan-terminal");
		const dir = path.join(scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores")), "orphan-terminal");

		// A run receipt that already reached a terminal state, plus a lock still referencing it:
		// the owner died after the run finished but before cleaning up the claim.
		const terminalRun = { schemaVersion: 1, id: "old-run", scheduleId: "orphan-terminal", plannedAt: new Date(h.clock.now - 3_600_000).toISOString(), dueReason: "timer", state: "completed", completedAt: new Date(h.clock.now - 3_000_000).toISOString() };
		fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "runs", `${terminalRun.id}.json`), JSON.stringify(terminalRun), "utf-8");
		fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify({ schemaVersion: 1, runs: [terminalRun] }), "utf-8");
		fs.writeFileSync(path.join(dir, "active.lock"), terminalRun.id, "utf-8");

		h.clock.now += 3_600_000;
		h.timers.fireAll();
		await flush();

		assert.equal(h.launches.length, 1, "the orphaned lock is reclaimed and the fire launches");
		const holder = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8")).activeRunId;
		assert.ok(holder);
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8").trim(), holder, "the reclaimed lock is owned by the new run");
	});

	it("T3(b): never reclaims a lock with an unknown or foreign holder id", async () => {
		// Complements schedule-claim-preservation.test.ts, which pins the same invariant on the
		// persistence path: an unknown holder id is indistinguishable from a live process's
		// not-yet-persisted claim, so the fire must skip and the lock must stay byte-identical.
		const h = harness();
		await intervalSchedule(h, "orphan-foreign");
		const dir = path.join(scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores")), "orphan-foreign");
		fs.writeFileSync(path.join(dir, "active.lock"), "foreign-claim-id", "utf-8");

		h.clock.now += 3_600_000;
		h.timers.fireAll();
		await flush();

		assert.equal(h.launches.length, 0, "no launch for a foreign holder");
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8"), "foreign-claim-id", "the foreign lock is left untouched");
		const history = await h.manager.handleToolCall({ action: "schedule.history", id: "orphan-foreign" }, h.ctx);
		assert.match(text(history), /skipped/);
	});

	it("T3(c): never reclaims a lock whose holder is a fresh running run", async () => {
		const h = harness();
		await intervalSchedule(h, "orphan-running");
		const dir = path.join(scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores")), "orphan-running");

		// A run receipt that is still running (well within the 24h budget) with a live status.
		const runningRun = { schemaVersion: 1, id: "live-run", scheduleId: "orphan-running", plannedAt: new Date(h.clock.now - 60_000).toISOString(), dueReason: "timer", state: "running", startedAt: new Date(h.clock.now - 60_000).toISOString() };
		const asyncDir = path.join(h.root, "async-orphan-running");
		fs.mkdirSync(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "live-async", mode: "single", state: "running", startedAt: h.clock.now }), "utf-8");
		runningRun.asyncId = "live-async";
		runningRun.asyncDir = asyncDir;
		fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "runs", `${runningRun.id}.json`), JSON.stringify(runningRun), "utf-8");
		fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify({ schemaVersion: 1, runs: [runningRun] }), "utf-8");
		fs.writeFileSync(path.join(dir, "active.lock"), runningRun.id, "utf-8");

		h.clock.now += 3_600_000;
		h.timers.fireAll();
		await flush();

		assert.equal(h.launches.length, 0, "no launch while a fresh run holds the lock");
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8"), runningRun.id, "the live lock is left untouched");
		const history = await h.manager.handleToolCall({ action: "schedule.history", id: "orphan-running" }, h.ctx);
		assert.match(text(history), /skipped/);
	});

	it("T4: keeps a fresh attached run overlapping instead of recovering it", async () => {
		const h = harness();
		await intervalSchedule(h);
		const dir = path.join(scheduledRunStorePath(h.ctx.cwd, undefined, path.join(h.root, "stores")), "monitor");

		h.clock.now += 3_600_000;
		h.timers.fireAll();
		const asyncDir = path.join(h.root, "async-live");
		fs.mkdirSync(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "live-1", mode: "single", state: "running", startedAt: h.clock.now }), "utf-8");
		h.launches[0]!.resolve({ content: [{ type: "text", text: "Async" }], details: { mode: "single", results: [], asyncId: "live-1", asyncDir } });
		await flush();
		const activeRunId = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8")).activeRunId;
		assert.ok(activeRunId);

		// Well inside the 24h budget: the next fire must skip and touch nothing.
		h.clock.now += 3 * 3_600_000;
		h.timers.fireAll();
		await flush();
		assert.equal(h.launches.length, 1, "no second launch while the fresh run is active");
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), true, "the lock is left untouched");
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8").trim(), activeRunId);
		const active = JSON.parse(fs.readFileSync(path.join(dir, "runs", `${activeRunId}.json`), "utf-8"));
		assert.equal(active.state, "running");
		const shown = JSON.parse(fs.readFileSync(path.join(dir, "schedule.json"), "utf-8"));
		assert.equal(shown.activeRunId, activeRunId);
		const history = await h.manager.handleToolCall({ action: "schedule.history", id: "monitor" }, h.ctx);
		assert.match(text(history), /skipped/);
	});
});
