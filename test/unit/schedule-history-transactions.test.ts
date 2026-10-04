import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createScheduledRunManager, scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";

const fixture = fileURLToPath(new URL("../fixtures/schedule-history-writer.mjs", import.meta.url));

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
		assert.equal(fs.existsSync(path.join(dir, "history.json.lock")), false);
	} finally {
		a.child.kill(); b.child.kill(); observer.stop(); fs.rmSync(root, { recursive: true, force: true });
	}
});

it("matches completion from the durable receipt when history has no async ID", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-receipt-proof-"));
	const project = path.join(root, "project"); fs.mkdirSync(project);
	const storeRoot = path.join(root, "stores");
	const ctx = { cwd: project, sessionManager: { getSessionId: () => "owner", getSessionFile: () => path.join(project, "owner.jsonl") } } as any;
	const manager = createScheduledRunManager({ config: {}, storeRoot, randomId: () => "owner-run",
		timers: { setTimeout: () => 1 as any, clearTimeout: () => {} }, launch: async () => ({ content: [], details: { asyncId: "attached" } }) as any });
	try {
		manager.bindSession(ctx);
		await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
		await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		const dir = path.join(scheduledRunStorePath(project, undefined, storeRoot), "check");
		const cached = JSON.parse(fs.readFileSync(path.join(dir, "history.json"), "utf-8"));
		delete cached.runs[0].asyncId;
		fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify(cached));
		manager.handleAsyncCompletion({ id: "attached", success: true });
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false);
		assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "runs", "owner-run.json"), "utf-8")).state, "completed");
	} finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
