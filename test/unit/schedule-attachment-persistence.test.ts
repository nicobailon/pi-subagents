import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { createScheduledRunManager, scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";

async function fixture(failure: "index" | "receipt", action: (h: any) => Promise<void>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-attachment-"));
	const project = path.join(root, "project"); fs.mkdirSync(project);
	const storeRoot = path.join(root, "stores");
	const dir = path.join(scheduledRunStorePath(project, undefined, storeRoot), "check");
	const now = Date.parse("2030-01-01T00:00:00Z");
	const ctx = { cwd: project, sessionManager: { getSessionId: () => "owner", getSessionFile: () => path.join(project, "owner.jsonl") } } as any;
	const originalRename = fs.renameSync;
	let id = 0;
	const timers = { setTimeout: () => 1 as any, clearTimeout: () => {} };
	const manager = createScheduledRunManager({ config: {}, storeRoot, now: () => now, randomId: () => `run-${++id}`, timers,
		launch: async () => {
			if (failure === "index") fs.mkdirSync(path.join(dir, "history.json.lock"));
			else {
				fs.renameSync = function (source, target) {
					if (target === path.join(dir, "runs", "run-1.json")) throw Object.assign(new Error("attached receipt EIO"), { code: "EIO" });
					return originalRename.call(fs, source, target);
				}; syncBuiltinESMExports();
			}
			return { content: [], details: { asyncId: "attached" } } as any;
		} });
	const observers: ReturnType<typeof createScheduledRunManager>[] = [];
	const observer = () => {
		const other = createScheduledRunManager({ config: {}, storeRoot, now: () => now, timers, launch: async () => { throw new Error("Unexpected second launch"); } });
		observers.push(other); other.bindSession(ctx); return other;
	};
	const recover = () => { fs.renameSync = originalRename; syncBuiltinESMExports(); fs.rmSync(path.join(dir, "history.json.lock"), { recursive: true, force: true }); };
	try {
		manager.bindSession(ctx);
		await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
		const result = await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		await action({ manager, observer, result, dir, now, ctx, recover });
	} finally { recover(); manager.stop(); for (const other of observers) other.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}

it("keeps a launched task running when attachment history contention exhausts the retry budget", async () => fixture("index", async h => {
	assert.equal(h.result.isError, true); assert.match(h.result.content[0].text, /Lock file is already being held/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "schedule.json"), "utf-8")).activeRunId, "run-1");
	assert.equal(fs.readFileSync(path.join(h.dir, "active.lock"), "utf-8"), "run-1");
	const receipt = JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "run-1.json"), "utf-8"));
	assert.equal(receipt.state, "running"); assert.equal(receipt.asyncId, "attached");
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "schedule.json"), "utf-8")).trigger.nextRunAt, new Date(h.now + 3_600_000).toISOString());
	h.recover(); h.observer().handleAsyncCompletion({ id: "attached", success: true });
	assert.equal(fs.existsSync(path.join(h.dir, "active.lock")), false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "run-1.json"), "utf-8")).state, "completed");
}));

it("matches completion using the launcher's attachment proof when the individual receipt save failed", async () => fixture("receipt", async h => {
	assert.equal(h.result.isError, true); assert.match(h.result.content[0].text, /attached receipt EIO/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "run-1.json"), "utf-8")).asyncId, undefined);
	h.recover(); h.manager.handleAsyncCompletion({ id: "attached", success: true });
	assert.equal(fs.existsSync(path.join(h.dir, "active.lock")), false);
	const run = JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "run-1.json"), "utf-8"));
	assert.equal(run.state, "completed"); assert.equal(run.asyncId, "attached");
}));

it("repairs a pending attached receipt for another session after storage recovers", async () => fixture("receipt", async h => {
	h.recover();
	assert.equal((await h.manager.handleToolCall({ action: "schedule.show", id: "check" }, h.ctx)).isError, undefined);
	h.observer().handleAsyncCompletion({ id: "attached", success: true });
	assert.equal(fs.existsSync(path.join(h.dir, "active.lock")), false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "run-1.json"), "utf-8")).state, "completed");
}));

it("does not replay pending running state over completion saved by another session", async () => fixture("index", async h => {
	h.recover(); h.observer().handleAsyncCompletion({ id: "attached", success: true });
	assert.equal((await h.manager.handleToolCall({ action: "schedule.show", id: "check" }, h.ctx)).isError, undefined);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "run-1.json"), "utf-8")).state, "completed");
	assert.equal(h.manager.observedCompletionRunIds().has("attached"), false);
}));

it("retains known completion for retry when clearing its schedule claim fails", async () => fixture("receipt", async h => {
	h.recover();
	const original = fs.renameSync;
	fs.renameSync = function (source, destination) {
		if (destination === path.join(h.dir, "schedule.json")) throw Object.assign(new Error("completion schedule EIO"), { code: "EIO" });
		return original.call(fs, source, destination);
	}; syncBuiltinESMExports();
	h.manager.handleAsyncCompletion({ id: "attached", success: true });
	h.recover();
	assert.equal((await h.manager.handleToolCall({ action: "schedule.show", id: "check" }, h.ctx)).isError, undefined);
	assert.equal(fs.existsSync(path.join(h.dir, "active.lock")), false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "run-1.json"), "utf-8")).state, "completed");
}));

it("releases its claim when history contention fails before the child is launched", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-prelaunch-history-"));
	const project = path.join(root, "project"); fs.mkdirSync(project);
	const storeRoot = path.join(root, "stores");
	const ctx = { cwd: project, sessionManager: { getSessionId: () => "owner", getSessionFile: () => path.join(project, "owner.jsonl") } } as any;
	let launches = 0; let id = 0;
	const manager = createScheduledRunManager({ config: {}, storeRoot, randomId: () => `run-${++id}`,
		timers: { setTimeout: () => 1 as any, clearTimeout: () => {} },
		launch: async () => { launches++; return { content: [], details: { asyncId: "attached" } } as any; } });
	try {
		manager.bindSession(ctx);
		await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, ctx);
		const dir = path.join(scheduledRunStorePath(project, undefined, storeRoot), "check");
		fs.mkdirSync(path.join(dir, "history.json.lock"));
		const failed = await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx);
		assert.equal(failed.isError, true); assert.equal(launches, 0);
		assert.equal(fs.existsSync(path.join(dir, "active.lock")), false);
		assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "runs", "run-1.json"), "utf-8")).state, "failed_launch");
		fs.rmSync(path.join(dir, "history.json.lock"), { recursive: true });
		assert.equal((await manager.handleToolCall({ action: "schedule.run", id: "check" }, ctx)).isError, undefined);
		assert.equal(launches, 1);
	} finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
