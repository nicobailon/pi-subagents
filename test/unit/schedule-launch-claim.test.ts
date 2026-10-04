import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { createScheduledRunManager, scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";

async function setup(action: (h: any) => Promise<void>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-launch-claim-"));
	const project = path.join(root, "project"); fs.mkdirSync(project);
	const storeRoot = path.join(root, "stores");
	const clock = { now: Date.parse("2030-01-01T00:00:00Z") };
	const context = (role: string) => ({ cwd: project, sessionManager: { getSessionId: () => role, getSessionFile: () => path.join(project, `${role}.jsonl`) } }) as any;
	let launches = 0;
	const managers: ReturnType<typeof createScheduledRunManager>[] = [];
	const make = (role: string, launch?: () => Promise<any>) => {
		let id = 0;
		const manager = createScheduledRunManager({ config: { scheduledRuns: { enabled: true } }, storeRoot, now: () => clock.now,
			randomId: () => `${role}-${++id}`, timers: { setTimeout: () => 1 as any, clearTimeout: () => {} },
			launch: async () => { launches++; return launch ? launch() : { content: [], details: { asyncId: `${role}-async` } }; },
		});
		managers.push(manager); manager.bindSession(context(role)); return manager;
	};
	const owner = make("owner");
	const created = await owner.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, context("owner"));
	assert.equal(created.isError, undefined);
	const dir = path.join(scheduledRunStorePath(project, undefined, storeRoot), "check");
	const originalRename = fs.renameSync; const originalWrite = fs.writeFileSync;
	try { await action({ owner, make, context, dir, clock, launches: () => launches, originalRename, originalWrite }); }
	finally { fs.renameSync = originalRename; fs.writeFileSync = originalWrite; syncBuiltinESMExports(); for (const manager of managers) manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}

for (const file of ["schedule.json", "history.json"]) it(`cleans up its claim after ${file} persistence fails`, async () => setup(async h => {
	let injected = false;
	fs.renameSync = function (source, target) {
		if (!injected && target === path.join(h.dir, file)) {
			injected = true; throw Object.assign(new Error("claim persistence EIO"), { code: "EIO" });
		}
		return h.originalRename.call(fs, source, target);
	}; syncBuiltinESMExports();
	const failed = await h.owner.handleToolCall({ action: "schedule.run", id: "check" }, h.context("owner"));
	fs.renameSync = h.originalRename; syncBuiltinESMExports();
	assert.equal(failed.isError, true); assert.match(failed.content[0].text, /claim persistence EIO/);
	assert.equal(fs.existsSync(path.join(h.dir, "active.lock")), false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "schedule.json"), "utf-8")).activeRunId, undefined);
	assert.equal(h.launches(), 0);
	const retry = h.make("retry");
	const result = await retry.handleToolCall({ action: "schedule.run", id: "check" }, h.context("retry"));
	assert.equal(result.isError, undefined); assert.equal(h.launches(), 1);
}));

it("closes and removes its newly created lock when initialization fails", async () => setup(async h => {
	let descriptor: number | undefined;
	fs.writeFileSync = function (file, ...args) {
		if (typeof file === "number") { descriptor = file; throw Object.assign(new Error("claim initialization EIO"), { code: "EIO" }); }
		return h.originalWrite.call(fs, file, ...args);
	}; syncBuiltinESMExports();
	const failed = await h.owner.handleToolCall({ action: "schedule.run", id: "check" }, h.context("owner"));
	fs.writeFileSync = h.originalWrite; syncBuiltinESMExports();
	assert.equal(failed.isError, true); assert.match(failed.content[0].text, /claim initialization EIO/);
	assert.notEqual(descriptor, undefined);
	try { assert.throws(() => fs.fstatSync(descriptor!), (error: any) => error.code === "EBADF"); }
	finally { try { fs.closeSync(descriptor!); } catch {} }
	assert.equal(fs.existsSync(path.join(h.dir, "active.lock")), false);
}));

it("does not remove a replacement lock after initialization fails", async () => setup(async h => {
	fs.writeFileSync = function (file, ...args) {
		if (typeof file === "number") {
			fs.unlinkSync(path.join(h.dir, "active.lock"));
			h.originalWrite.call(fs, path.join(h.dir, "active.lock"), "replacement");
			throw Object.assign(new Error("claim initialization EIO"), { code: "EIO" });
		}
		return h.originalWrite.call(fs, file, ...args);
	}; syncBuiltinESMExports();
	const failed = await h.owner.handleToolCall({ action: "schedule.run", id: "check" }, h.context("owner"));
	fs.writeFileSync = h.originalWrite; syncBuiltinESMExports();
	assert.equal(failed.isError, true);
	assert.equal(fs.readFileSync(path.join(h.dir, "active.lock"), "utf-8"), "replacement");
}));

it("does not clear another owner while handling a persistence failure", async () => setup(async h => {
	let injected = false;
	fs.renameSync = function (source, target) {
		if (!injected && target === path.join(h.dir, "schedule.json")) {
			injected = true;
			const saved = JSON.parse(fs.readFileSync(target, "utf-8")); saved.activeRunId = "replacement";
			fs.writeFileSync(target, JSON.stringify(saved));
			fs.writeFileSync(path.join(h.dir, "active.lock"), "replacement");
			throw Object.assign(new Error("claim persistence EIO"), { code: "EIO" });
		}
		return h.originalRename.call(fs, source, target);
	}; syncBuiltinESMExports();
	const failed = await h.owner.handleToolCall({ action: "schedule.run", id: "check" }, h.context("owner"));
	fs.renameSync = h.originalRename; syncBuiltinESMExports();
	assert.equal(failed.isError, true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "schedule.json"), "utf-8")).activeRunId, "replacement");
	assert.equal(fs.readFileSync(path.join(h.dir, "active.lock"), "utf-8"), "replacement");
}));

it("does not reclaim a live pending launch merely because five minutes elapsed", async () => setup(async h => {
	let resolve!: (value: any) => void;
	const live = h.make("live", () => new Promise(done => { resolve = done; }));
	const pending = live.handleToolCall({ action: "schedule.run", id: "check" }, h.context("live"));
	for (let i = 0; i < 8; i++) await Promise.resolve();
	h.clock.now += 5 * 60_000 + 1;
	const observer = h.make("observer");
	const skipped = await observer.handleToolCall({ action: "schedule.run", id: "check" }, h.context("observer"));
	assert.equal(skipped.details.schedules.runs[0].state, "skipped");
	assert.equal(h.launches(), 1);
	assert.equal(fs.readFileSync(path.join(h.dir, "active.lock"), "utf-8"), "live-1");
	resolve({ content: [], details: { asyncId: "live-async" } });
	assert.equal((await pending).details.schedules.runs[0].state, "running");
}));

it("keeps an active claim when its history entry is missing", async () => setup(async h => {
	let resolve!: (value: any) => void;
	const live = h.make("live", () => new Promise(done => { resolve = done; }));
	const pending = live.handleToolCall({ action: "schedule.run", id: "check" }, h.context("live"));
	for (let i = 0; i < 8; i++) await Promise.resolve();
	fs.writeFileSync(path.join(h.dir, "history.json"), JSON.stringify({ schemaVersion: 1, runs: [] }));
	const observer = h.make("observer");
	const skipped = await observer.handleToolCall({ action: "schedule.run", id: "check" }, h.context("observer"));
	assert.equal(skipped.details.schedules.runs[0].state, "skipped"); assert.equal(h.launches(), 1);
	assert.equal(fs.readFileSync(path.join(h.dir, "active.lock"), "utf-8"), "live-1");
	resolve({ content: [], details: { asyncId: "live-async" } }); await pending;
}));

it("retains an attached child's claim when its receipt cannot be saved", async () => setup(async h => {
	h.clock.now += 5 * 60_000;
	const live = h.make("live", async () => {
		fs.renameSync = function (source, target) {
			if (target === path.join(h.dir, "history.json")) throw Object.assign(new Error("attached receipt EIO"), { code: "EIO" });
			return h.originalRename.call(fs, source, target);
		}; syncBuiltinESMExports();
		return { content: [], details: { asyncId: "live-async" } };
	});
	const result = await live.handleToolCall({ action: "schedule.run", id: "check" }, h.context("live"));
	fs.renameSync = h.originalRename; syncBuiltinESMExports();
	assert.equal(result.isError, true); assert.match(result.content[0].text, /attached receipt EIO/);
	assert.equal(h.launches(), 1);
	assert.equal(fs.readFileSync(path.join(h.dir, "active.lock"), "utf-8"), "live-1");
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "schedule.json"), "utf-8")).activeRunId, "live-1");
	const receipt = JSON.parse(fs.readFileSync(path.join(h.dir, "runs", "live-1.json"), "utf-8"));
	assert.equal(receipt.state, "running"); assert.equal(receipt.asyncId, "live-async");
	assert.match(result.content[0].text, /live-async/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "schedule.json"), "utf-8")).trigger.nextRunAt, new Date(h.clock.now + 3_600_000).toISOString());
}));
