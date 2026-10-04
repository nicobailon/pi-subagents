import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createScheduledRunManager, scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";

const fixture = fileURLToPath(new URL("../fixtures/schedule-history-writer.mjs", import.meta.url));

function setup(name: string, launch: () => Promise<unknown> = async () => ({ content: [], details: { asyncId: "attached" } })) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
	const project = path.join(root, "project"); fs.mkdirSync(project);
	const storeRoot = path.join(root, "stores");
	const ctx = { cwd: project, sessionManager: { getSessionId: () => "owner", getSessionFile: () => path.join(project, "owner.jsonl") } } as any;
	const timers: number[] = [];
	let n = 0;
	const create = () => createScheduledRunManager({ config: {}, storeRoot, randomId: () => `run-${++n}`,
		timers: { setTimeout: ((_: unknown, delay: number) => timers.push(delay)) as any, clearTimeout: () => {} }, launch: launch as any });
	const manager = create();
	manager.bindSession(ctx);
	const dir = path.join(scheduledRunStorePath(project, undefined, storeRoot), "check");
	const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
	return { root, ctx, manager, create, dir, read, timers };
}

function holdHistoryLease(dir: string): () => void {
	const lock = path.join(fs.realpathSync(dir), "history.json.write-lock");
	fs.mkdirSync(lock);
	fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "other-session", pid: process.pid, hostname: os.hostname() }));
	return () => fs.rmSync(lock, { recursive: true, force: true });
}

it("keeps concurrent skip and active receipts so completion still matches", { timeout: 15_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-history-transactions-"));
	const project = path.join(root, "project"); fs.mkdirSync(project);
	const storeRoot = path.join(root, "stores");
	const now = Date.parse("2030-01-01T00:00:00Z");
	const ctx = { cwd: project, sessionManager: { getSessionId: () => "observer", getSessionFile: () => path.join(project, "observer.jsonl") } } as any;
	const observer = createScheduledRunManager({ config: { scheduledRuns: { enabled: true } }, storeRoot, now: () => now,
		timers: { setTimeout: () => 1 as any, clearTimeout: () => {} }, launch: async () => ({ content: [], details: {} }) as any });
	observer.bindSession(ctx);
	const created = await observer.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
	assert.equal(created.isError, undefined);
	const dir = path.join(scheduledRunStorePath(project, undefined, storeRoot), "check");
	fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify({ schemaVersion: 1, runs: [] }));
	function writer(role: string) {
		const child = fork(fixture, [project, storeRoot, role, root, String(now)], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
		const seen = new Set<string>();
		const waiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
		child.on("message", (message: { type: string }) => { seen.add(message.type); for (const waiter of waiters.get(message.type) ?? []) waiter.resolve(); });
		const done = new Promise<void>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) resolve(); else {
					const error = new Error(stderr || `Schedule writer exited ${code}`); reject(error);
					for (const group of waiters.values()) for (const waiter of group) waiter.reject(error);
				}
			});
		});
		done.catch(() => {});
		return { child, done, wait: (type: string) => seen.has(type) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
			const group = waiters.get(type) ?? []; group.push({ resolve, reject }); waiters.set(type, group);
		}) };
	}
	const a = writer("owner"); const b = writer("contender");
	try {
		await Promise.all([a.wait("ready"), b.wait("ready")]);
		fs.writeFileSync(path.join(root, "owner.start"), "");
		await a.wait("barrier");
		fs.writeFileSync(path.join(root, "contender.start"), "");
		await Promise.race([b.wait("lock-attempt"), b.wait("result")]);
		fs.writeFileSync(path.join(root, "owner.release"), "");
		await Promise.all([a.done, b.done]);
		let history = JSON.parse(fs.readFileSync(path.join(dir, "history.json"), "utf-8")).runs;
		assert.deepEqual(history.map((run: any) => run.id).sort(), ["contender-1", "owner-1"]);
		assert.equal(history.find((run: any) => run.id === "owner-1").asyncId, "owner-async");
		observer.handleAsyncCompletion({ id: "owner-async", success: true });
		history = JSON.parse(fs.readFileSync(path.join(dir, "history.json"), "utf-8")).runs;
		assert.equal(history.find((run: any) => run.id === "owner-1").state, "completed");
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false);
		assert.equal(fs.existsSync(path.join(dir, "history.json.write-lock")), false);
	} finally {
		a.child.kill(); b.child.kill(); observer.stop(); fs.rmSync(root, { recursive: true, force: true });
	}
});

it("keeps and completes an active run that history.json no longer lists", async () => {
	const { root, ctx, manager, create, dir, read } = setup("schedule-receipt-proof-");
	const restored = create();
	try {
		await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
		await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify({ schemaVersion: 1, runs: [] }));
		restored.bindSession(ctx);
		assert.equal(read("schedule.json").activeRunId, "run-1", "restore keeps the running claim");
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), true);
		restored.handleAsyncCompletion({ id: "attached", success: true });
		assert.equal(read("schedule.json").activeRunId, undefined);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false);
		assert.equal(read(path.join("runs", "run-1.json")).state, "completed");
	} finally { manager.stop(); restored.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("releases an unlaunched claim but keeps a launched one when history.json stays locked", async () => {
	let release = () => {};
	let holdDuringLaunch = false;
	const { root, ctx, manager, dir, read, timers } = setup("schedule-history-timeout-", async () => {
		if (holdDuringLaunch) release = holdHistoryLease(dir);
		return { content: [], details: { asyncId: "attached" } };
	});
	try {
		await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
		release = holdHistoryLease(dir);
		const unlaunched = await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		assert.equal(unlaunched.isError, true);
		assert.equal(read("schedule.json").activeRunId, undefined);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false);
		release();

		holdDuringLaunch = true;
		const launched = await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		assert.equal(launched.isError, true);
		assert.match(launched.content[0]!.type === "text" ? launched.content[0]!.text : "", /attached to async run 'attached'/);
		assert.equal(read("schedule.json").activeRunId, "run-2");
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), true);

		const armed = timers.length;
		manager.handleAsyncCompletion({ id: "attached", success: true });
		assert.equal(read("schedule.json").activeRunId, undefined);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false);
		assert.equal(read(path.join("runs", "run-2.json")).state, "completed");
		assert.equal(timers.length, armed + 1, "the released schedule is armed again");
	} finally { release(); manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("never strands or steals a claim when history.json times out", async () => {
	let launches = 0;
	let release = () => {};
	let failLaunch = false;
	const { root, ctx, manager, dir, read } = setup("schedule-history-claims-", async () => {
		if (failLaunch) { release = holdHistoryLease(dir); throw new Error("launcher failed"); }
		return { content: [], details: { asyncId: `async-${++launches}` } };
	});
	try {
		await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
		await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		release = holdHistoryLease(dir);
		manager.handleAsyncCompletion({ id: "async-1", success: true });
		release();
		await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		manager.handleAsyncCompletion({ id: "async-1", success: true });
		assert.equal(read("schedule.json").activeRunId, "run-2", "a repeated old completion leaves the new claim alone");
		assert.equal(read("history.json").runs.find((run: { id: string }) => run.id === "run-1").state, "completed", "the next history update replaces the stale running entry");
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), true);
		manager.handleAsyncCompletion({ id: "async-2", success: true });

		failLaunch = true;
		const failed = await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		assert.equal(failed.isError, true);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false, "a failed launch releases its lock");
		release();
		failLaunch = false;
		const retried = await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		assert.match(retried.content[0]!.type === "text" ? retried.content[0]!.text : "", /: running/);
	} finally { release(); manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("does not release a replacement owner's claim when an unlaunched claim is cleaned up", async () => {
	const { root, ctx, manager, create, dir, read } = setup("schedule-history-owner-");
	const replacement = create();
	const mkdir = nodeFs.mkdirSync;
	let release = () => {};
	let replacementRun: Promise<unknown> | undefined;
	try {
		await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
		nodeFs.mkdirSync = ((file: nodeFs.PathLike, ...args: unknown[]) => {
			// After run-1's claim is saved and before its receipt exists, another session
			// restores the claim as abandoned and launches run-2.
			if (!replacementRun && String(file) === path.join(dir, "runs") && read("schedule.json").activeRunId === "run-1") {
				replacement.bindSession(ctx);
				replacementRun = replacement.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
				release = holdHistoryLease(dir);
			}
			return (mkdir as Function).call(nodeFs, file, ...args);
		}) as typeof nodeFs.mkdirSync;
		syncBuiltinESMExports();
		const first = await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		await replacementRun;
		assert.equal(first.isError, true);
		assert.equal(read("schedule.json").activeRunId, "run-2");
		assert.equal(fs.readFileSync(path.join(dir, "active.lock"), "utf-8"), "run-2");
	} finally {
		nodeFs.mkdirSync = mkdir; syncBuiltinESMExports();
		release(); manager.stop(); replacement.stop(); fs.rmSync(root, { recursive: true, force: true });
	}
});
