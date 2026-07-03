import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	SCHEDULED_RUNS_DIR,
	ScheduledRunManager,
	createScheduledRunManager,
	isScheduledRunAction,
	parseScheduledRunTime,
	scheduledRunStorePath,
	scheduledRunsEnabled,
} from "../../src/runs/background/scheduled-runs.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type TimerHandle = number;

class FakeTimers {
	readonly scheduled = new Map<TimerHandle, { cb: () => void; delay: number }>();
	private nextHandle = 1;

	setTimeout = (cb: () => void, delay: number): TimerHandle => {
		const handle = this.nextHandle++;
		this.scheduled.set(handle, { cb, delay });
		return handle;
	};

	clearTimeout = (handle: TimerHandle): void => {
		this.scheduled.delete(handle);
	};

	fireAll(): void {
		// Snapshot first: fire() re-arms by clearing the fired handle and adding a new one.
		const entries = [...this.scheduled.values()];
		for (const entry of entries) entry.cb();
	}

	pendingCount(): number {
		return this.scheduled.size;
	}
}

type LaunchRecord = {
	params: Record<string, unknown>;
	ctx: ExtensionContext;
	signal: AbortSignal;
	resolve: (result: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }) => void;
	promise: Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
};

type TestHarness = {
	manager: ScheduledRunManager;
	timers: FakeTimers;
	launches: LaunchRecord[];
	clock: { now: number };
	storeRoot: string;
	ctx: ExtensionContext;
};

function makeCtx(cwd = "/project", sessionFile = "/sessions/abc.jsonl"): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => path.basename(sessionFile, ".jsonl"),
		},
	} as unknown as ExtensionContext;
}

function makeConfig(overrides: Partial<ExtensionConfig["scheduledRuns"]> = {}): ExtensionConfig {
	return { scheduledRuns: { enabled: true, ...overrides } };
}

async function flushMicrotasks(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

function createHarness(options: { config?: ExtensionConfig; storeRoot?: string; now?: number } = {}): TestHarness {
	const timers = new FakeTimers();
	const launches: LaunchRecord[] = [];
	const clock = { now: options.now ?? 1_000_000 };
	const storeRoot = options.storeRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "sched-test-"));
	const manager = createScheduledRunManager({
		config: options.config ?? makeConfig(),
		storeRoot,
		now: () => clock.now,
		randomId: () => "id-" + randomUUID().slice(0, 4),
		timers,
		launch: (params, ctx, signal) => {
			let resolve!: LaunchRecord["resolve"];
			const promise = new Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>((res) => {
				resolve = res;
			});
			launches.push({ params: params as unknown as Record<string, unknown>, ctx, signal, resolve, promise });
			return promise as ReturnType<TestHarness["manager"]["handleToolCall"]>;
		},
	});
	const ctx = makeCtx();
	return { manager, timers, launches, clock, storeRoot, ctx };
}

function extractId(result: { content: Array<{ type: "text"; text: string }> }): string {
	const text = result.content[0]!.text;
	const match = text.match(/Scheduled subagent run (id-[a-z0-9]+)/);
	assert.ok(match, `expected scheduled run id in: ${text}`);
	return match[1]!;
}

function isError(result: { isError?: boolean }): boolean {
	return result.isError === true;
}

describe("scheduled-runs helpers", () => {
	it("isScheduledRunAction narrows the four actions", () => {
		assert.equal(isScheduledRunAction("schedule"), true);
		assert.equal(isScheduledRunAction("schedule-cancel"), true);
		assert.equal(isScheduledRunAction("status"), false);
		assert.equal(isScheduledRunAction(undefined), false);
	});

	it("scheduledRunsEnabled is true only when explicitly enabled", () => {
		assert.equal(scheduledRunsEnabled({}), false);
		assert.equal(scheduledRunsEnabled({ scheduledRuns: {} }), false);
		assert.equal(scheduledRunsEnabled({ scheduledRuns: { enabled: false } }), false);
		assert.equal(scheduledRunsEnabled({ scheduledRuns: { enabled: true } }), true);
	});

	it("scheduledRunStorePath is stable per cwd+session and distinct otherwise", () => {
		const root = path.join("tmp", "sched-root");
		const project = path.join("project");
		const other = path.join("other");
		const a = scheduledRunStorePath(project, "sess1", root);
		const aAgain = scheduledRunStorePath(project, "sess1", root);
		const b = scheduledRunStorePath(project, "sess2", root);
		const c = scheduledRunStorePath(other, "sess1", root);
		assert.equal(a, aAgain);
		assert.notEqual(a, b);
		assert.notEqual(a, c);
		assert.ok(a.startsWith(root));
		assert.ok(a.endsWith(".json"));
	});

	it("parseScheduledRunTime handles relative delays and ISO timestamps", () => {
		const base = 1_000_000;
		assert.equal(parseScheduledRunTime("+10m", base), base + 10 * 60_000);
		assert.equal(parseScheduledRunTime("+1h", base), base + 3_600_000);
		assert.equal(parseScheduledRunTime("+2d", base), base + 2 * 86_400_000);
		assert.equal(parseScheduledRunTime("+30s", base), base + 30_000);
		assert.equal(parseScheduledRunTime("2030-01-01T00:00:00Z", base), new Date("2030-01-01T00:00:00Z").getTime());
		assert.equal(parseScheduledRunTime("2030-01-01T09:00:00+05:30", base), new Date("2030-01-01T09:00:00+05:30").getTime());
	});

	it("parseScheduledRunTime rejects past, zero, malformed, and ambiguous schedules", () => {
		assert.throws(() => parseScheduledRunTime("+0m", 1_000_000), /positive/);
		assert.throws(() => parseScheduledRunTime("+9000000000000d", 1_000_000), /too large/);
		assert.throws(() => parseScheduledRunTime("2020-01-01T00:00:00Z", Date.now() + 60_000), /in the past/);
		assert.throws(() => parseScheduledRunTime("2030-01-01T00:00:00", 1_000_000), /must include a timezone/);
		assert.throws(() => parseScheduledRunTime("2030-02-30T00:00:00Z", 1_000_000), /valid future ISO/);
		assert.throws(() => parseScheduledRunTime("next tuesday", 1_000_000), /Invalid schedule/);
		assert.throws(() => parseScheduledRunTime("+5w", 1_000_000), /Invalid schedule/);
	});
});

describe("ScheduledRunManager create/list/status/cancel", () => {
	let storeRoots: string[] = [];
	after(() => {
		for (const root of storeRoots) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// best-effort cleanup of temp test dirs
			}
		}
	});

	function freshHarness(options: { config?: ExtensionConfig; now?: number } = {}): TestHarness {
		const harness = createHarness(options);
		storeRoots.push(harness.storeRoot);
		return harness;
	}

	it("rejects schedule actions when the feature is disabled", async () => {
		const harness = freshHarness({ config: makeConfig({ enabled: false }) });
		const result = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m" }, harness.ctx);
		assert.equal(isError(result), true);
		assert.match(result.content[0]!.text, /disabled/);
		assert.equal(harness.timers.pendingCount(), 0);
	});

	it("creates a scheduled job and arms a timer", async () => {
		const harness = freshHarness();
		const result = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "review later", schedule: "+10m", scheduleName: "nightly review" }, harness.ctx);
		assert.equal(isError(result), false);
		assert.match(result.content[0]!.text, /Scheduled subagent run id-/);
		assert.match(result.content[0]!.text, /nightly review/);
		assert.equal(harness.timers.pendingCount(), 1);
		const list = await harness.manager.handleToolCall({ action: "schedule-list" }, harness.ctx);
		assert.match(list.content[0]!.text, /nightly review/);
	});

	it("requires exactly one execution mode", async () => {
		const harness = freshHarness();
		// tasks + chain is genuinely ambiguous (both are execution arrays)
		const chainAndTasks = await harness.manager.handleToolCall({ action: "schedule", tasks: [{ agent: "scout", task: "x" }], chain: [{ agent: "scout", task: "y" }], schedule: "+10m" }, harness.ctx);
		assert.match(chainAndTasks.content[0]!.text, /exactly one execution mode/);
		// no execution mode at all
		const none = await harness.manager.handleToolCall({ action: "schedule", schedule: "+10m" }, harness.ctx);
		assert.match(none.content[0]!.text, /exactly one execution mode/);
	});

	it("requires a schedule and rejects fork/async-false/clarify-true", async () => {
		const harness = freshHarness();
		const noSchedule = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x" }, harness.ctx);
		assert.match(noSchedule.content[0]!.text, /requires schedule/);
		const fork = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m", context: "fork" }, harness.ctx);
		assert.match(fork.content[0]!.text, /fresh context/);
		const sync = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m", async: false }, harness.ctx);
		assert.match(sync.content[0]!.text, /always async/);
		const clarify = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m", clarify: true }, harness.ctx);
		assert.match(clarify.content[0]!.text, /clarify/);
	});

	it("rejects a past schedule time", async () => {
		const harness = freshHarness({ now: Date.now() + 60_000 });
		const result = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "2020-01-01T00:00:00Z" }, harness.ctx);
		assert.match(result.content[0]!.text, /in the past/);
	});

	it("enforces maxPending", async () => {
		const harness = freshHarness({ config: makeConfig({ maxPending: 1 }) });
		const first = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m" }, harness.ctx);
		assert.equal(isError(first), false);
		const second = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "y", schedule: "+20m" }, harness.ctx);
		assert.match(second.content[0]!.text, /limit reached/);
	});

	it("status resolves by exact id and prefix, and rejects ambiguous/missing", async () => {
		const harness = freshHarness();
		const created = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m" }, harness.ctx);
		const id = extractId(created);
		const status = await harness.manager.handleToolCall({ action: "schedule-status", id }, harness.ctx);
		assert.match(status.content[0]!.text, /State: scheduled/);
		assert.match(status.content[0]!.text, /Cancel: subagent/);
		const byPrefix = await harness.manager.handleToolCall({ action: "schedule-status", id: id.slice(0, 4) }, harness.ctx);
		assert.match(byPrefix.content[0]!.text, /State: scheduled/);
		const missing = await harness.manager.handleToolCall({ action: "schedule-status", id: "nope" }, harness.ctx);
		assert.match(missing.content[0]!.text, /not found/);
		const noId = await harness.manager.handleToolCall({ action: "schedule-status" }, harness.ctx);
		assert.match(noId.content[0]!.text, /requires id/);
	});

	it("cancel clears the timer and marks the job canceled", async () => {
		const harness = freshHarness();
		const created = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m" }, harness.ctx);
		const id = extractId(created);
		assert.equal(harness.timers.pendingCount(), 1);
		const canceled = await harness.manager.handleToolCall({ action: "schedule-cancel", id }, harness.ctx);
		assert.match(canceled.content[0]!.text, /Canceled scheduled subagent run/);
		assert.equal(harness.timers.pendingCount(), 0);
		const status = await harness.manager.handleToolCall({ action: "schedule-status", id }, harness.ctx);
		assert.match(status.content[0]!.text, /State: canceled/);
	});

	it("cancel refuses a terminal job", async () => {
		const harness = freshHarness();
		const created = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m" }, harness.ctx);
		const id = extractId(created);
		await harness.manager.handleToolCall({ action: "schedule-cancel", id }, harness.ctx);
		const again = await harness.manager.handleToolCall({ action: "schedule-cancel", id }, harness.ctx);
		assert.match(again.content[0]!.text, /already canceled/);
	});

	it("reports malformed persisted job records instead of dropping them", async () => {
		const harness = freshHarness();
		const sessionId = harness.ctx.sessionManager.getSessionFile()!;
		const storePath = scheduledRunStorePath(harness.ctx.cwd, sessionId, harness.storeRoot);
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, JSON.stringify({ version: 1, cwd: harness.ctx.cwd, sessionId, jobs: [{ id: "bad" }] }), "utf-8");
		const result = await harness.manager.handleToolCall({ action: "schedule-list" }, harness.ctx);
		assert.equal(isError(result), true);
		assert.match(result.content[0]!.text, /job 0 has invalid string fields/);
	});

	it("reports JSON parse errors from a corrupted persisted store", async () => {
		const harness = freshHarness();
		const sessionId = harness.ctx.sessionManager.getSessionFile()!;
		const storePath = scheduledRunStorePath(harness.ctx.cwd, sessionId, harness.storeRoot);
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, "{ not-json", "utf-8");
		const result = await harness.manager.handleToolCall({ action: "schedule-list" }, harness.ctx);
		assert.equal(isError(result), true);
		assert.match(result.content[0]!.text, /Failed to parse scheduled subagent store/);
		assert.match(result.content[0]!.text, /JSON/);
	});
});

describe("ScheduledRunManager firing", () => {
	let storeRoots: string[] = [];
	after(() => {
		for (const root of storeRoots) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// best-effort cleanup of temp test dirs
			}
		}
	});

	function freshHarness(options: { config?: ExtensionConfig; now?: number } = {}): TestHarness {
		const harness = createHarness(options);
		storeRoots.push(harness.storeRoot);
		return harness;
	}

	it("launches the sanitized async run when the timer fires", async () => {
		const harness = freshHarness();
		const created = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "review", schedule: "+10m", scheduleName: "rev" }, harness.ctx);
		const id = extractId(created);
		harness.clock.now += 10 * 60_000; // advance to runAt so fire() launches instead of re-arming
		harness.timers.fireAll();
		assert.equal(harness.launches.length, 1, "launch should be invoked once when the timer fires");
		const launch = harness.launches[0]!;
		assert.equal(launch.params.async, true);
		assert.equal(launch.params.clarify, false);
		assert.equal(launch.params.context, "fresh");
		assert.equal(launch.params.agent, "scout");
		assert.equal(launch.params.task, "review");
		assert.equal((launch.params as { action?: string }).action, undefined, "action must be stripped before launch");
		assert.equal((launch.params as { schedule?: string }).schedule, undefined, "schedule must be stripped before launch");

		launch.resolve({
			content: [{ type: "text", text: "Async: scout [run-xyz]" }],
			details: { mode: "single", runId: "run-xyz", asyncId: "run-xyz", asyncDir: "/tmp/async-xyz", results: [] },
		});
		await flushMicrotasks();

		const status = await harness.manager.handleToolCall({ action: "schedule-status", id }, harness.ctx);
		assert.match(status.content[0]!.text, /State: fired/);
		assert.match(status.content[0]!.text, /Launched async run: run-xyz/);
		assert.match(status.content[0]!.text, /Async dir: \/tmp\/async-xyz/);
	});

	it("marks the job failed when launch returns an error result", async () => {
		const harness = freshHarness();
		const created = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+1m" }, harness.ctx);
		const id = extractId(created);
		harness.clock.now += 60_000; // advance to runAt
		harness.timers.fireAll();
		assert.equal(harness.launches.length, 1);
		harness.launches[0]!.resolve({
			content: [{ type: "text", text: "Async mode requires jiti" }],
			details: { mode: "single", results: [] },
			isError: true,
		});
		await flushMicrotasks();
		const status = await harness.manager.handleToolCall({ action: "schedule-status", id }, harness.ctx);
		assert.match(status.content[0]!.text, /State: failed/);
		assert.match(status.content[0]!.text, /Async mode requires jiti/);
	});

	it("marks the job failed when launch throws", async () => {
		const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-throw-"));
		storeRoots.push(storeRoot);
		const ctx = makeCtx();
		const timers = new FakeTimers();
		const clock = { now: 1_000_000 };
		const throwingManager = createScheduledRunManager({
			config: makeConfig(),
			storeRoot,
			now: () => clock.now,
			randomId: () => "id-" + randomUUID().slice(0, 4),
			timers,
			launch: () => Promise.reject(new Error("spawn ENOENT")),
		});
		throwingManager.bindSession(ctx);
		const created = await throwingManager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+1m" }, ctx);
		const id = extractId(created);
		clock.now += 60_000; // advance to runAt
		timers.fireAll();
		await flushMicrotasks();
		const status = await throwingManager.handleToolCall({ action: "schedule-status", id }, ctx);
		assert.match(status.content[0]!.text, /State: failed/);
		assert.match(status.content[0]!.text, /spawn ENOENT/);
	});

	it("re-arms instead of launching when a capped timer fires before runAt", async () => {
		const harness = freshHarness({ now: 1_000_000 });
		// +25d exceeds MAX_TIMER_DELAY_MS so the armed timer is capped and would fire "early" in fake time.
		const created = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+25d" }, harness.ctx);
		const id = extractId(created);
		harness.timers.fireAll();
		assert.equal(harness.launches.length, 0, "must not launch before runAt");
		assert.equal(harness.timers.pendingCount(), 1, "must re-arm a new timer");
		// Advance time to runAt and fire again -> now it launches.
		harness.clock.now = 1_000_000 + 25 * 86_400_000;
		harness.timers.fireAll();
		assert.equal(harness.launches.length, 1, "must launch once runAt is reached");
		harness.launches[0]!.resolve({
			content: [{ type: "text", text: "Async: scout [run-1]" }],
			details: { mode: "single", runId: "run-1", asyncId: "run-1", results: [] },
		});
		await flushMicrotasks();
		const status = await harness.manager.handleToolCall({ action: "schedule-status", id }, harness.ctx);
		assert.match(status.content[0]!.text, /State: fired/);
	});

	it("cancel before fire prevents the launch", async () => {
		const harness = freshHarness();
		const created = await harness.manager.handleToolCall({ action: "schedule", agent: "scout", task: "x", schedule: "+10m" }, harness.ctx);
		const id = extractId(created);
		await harness.manager.handleToolCall({ action: "schedule-cancel", id }, harness.ctx);
		harness.timers.fireAll();
		assert.equal(harness.launches.length, 0, "a canceled job must not launch");
	});
});

describe("ScheduledRunManager restart restore", () => {
	let storeRoots: string[] = [];
	after(() => {
		for (const root of storeRoots) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// best-effort cleanup of temp test dirs
			}
		}
	});

	it("re-arms pending jobs and marks stale jobs missed after a restart", async () => {
		const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-restore-"));
		storeRoots.push(storeRoot);
		const ctx = makeCtx();
		const clock = { now: 1_000_000 };
		const timersA = new FakeTimers();
		const managerA = createScheduledRunManager({
			config: makeConfig({ maxLatenessMs: 60_000 }),
			storeRoot,
			now: () => clock.now,
			randomId: () => "id-" + randomUUID().slice(0, 4),
			timers: timersA,
			launch: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [] } }),
		});
		managerA.bindSession(ctx);
		const soon = await managerA.handleToolCall({ action: "schedule", agent: "scout", task: "soon", schedule: "+10m" }, ctx);
		const later = await managerA.handleToolCall({ action: "schedule", agent: "scout", task: "later", schedule: "+1h" }, ctx);
		const soonId = extractId(soon);
		const laterId = extractId(later);
		assert.equal(timersA.pendingCount(), 2);
		managerA.stop();

		// Simulate Pi being offline past the first job's window but before the second fires.
		clock.now = 1_000_000 + 20 * 60_000; // +20m: soon is 10m overdue (> maxLateness 1m), later is still 40m out.
		const timersB = new FakeTimers();
		const managerB = createScheduledRunManager({
			config: makeConfig({ maxLatenessMs: 60_000 }),
			storeRoot,
			now: () => clock.now,
			randomId: () => "id-" + randomUUID().slice(0, 4),
			timers: timersB,
			launch: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [] } }),
		});
		managerB.bindSession(ctx);
		const soonStatus = await managerB.handleToolCall({ action: "schedule-status", id: soonId }, ctx);
		assert.match(soonStatus.content[0]!.text, /State: missed/);
		const laterStatus = await managerB.handleToolCall({ action: "schedule-status", id: laterId }, ctx);
		assert.match(laterStatus.content[0]!.text, /State: scheduled/);
		assert.equal(timersB.pendingCount(), 1, "only the still-future job should be re-armed");
		managerB.stop();
	});

	it("store path lives under the scheduled runs dir by default", () => {
		const p = scheduledRunStorePath("/project", "sess1");
		assert.ok(p.startsWith(SCHEDULED_RUNS_DIR), `${p} should be under ${SCHEDULED_RUNS_DIR}`);
	});
});
