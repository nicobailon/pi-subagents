import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { createScheduledRunManager, scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";

async function withSchedule(action: (h: { run: () => Promise<any>; lock: string; launches: () => number }) => Promise<void>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-claim-init-"));
	const project = path.join(root, "project");
	fs.mkdirSync(project);
	const storeRoot = path.join(root, "stores");
	const context = { cwd: project, sessionManager: { getSessionId: () => "owner", getSessionFile: () => path.join(project, "owner.jsonl") } } as any;
	let launches = 0;
	let id = 0;
	const manager = createScheduledRunManager({
		config: { scheduledRuns: { enabled: true } }, storeRoot, now: () => Date.parse("2030-01-01T00:00:00Z"),
		randomId: () => `run-${++id}`, timers: { setTimeout: () => 1 as any, clearTimeout: () => {} },
		launch: async () => { launches++; return { content: [], details: { asyncId: `async-${launches}` } }; },
	});
	manager.bindSession(context);
	const originalWrite = fs.writeFileSync;
	try {
		const created = await manager.handleToolCall({ action: "schedule.create", id: "check", every: "1h", workflowScript: "return 1" }, context);
		assert.equal(created.isError, undefined);
		const lock = path.join(scheduledRunStorePath(project, undefined, storeRoot), "check", "active.lock");
		await action({ run: () => manager.handleToolCall({ action: "schedule.run", id: "check" }, context), lock, launches: () => launches });
	} finally {
		fs.writeFileSync = originalWrite;
		syncBuiltinESMExports();
		manager.stop();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function failNextDescriptorWrite(before?: () => void): void {
	const originalWrite = fs.writeFileSync;
	fs.writeFileSync = function (file: any, ...args: any[]) {
		if (typeof file !== "number") return (originalWrite as any).call(fs, file, ...args);
		fs.writeFileSync = originalWrite;
		syncBuiltinESMExports();
		before?.();
		throw Object.assign(new Error("claim write ENOSPC"), { code: "ENOSPC" });
	} as typeof fs.writeFileSync;
	syncBuiltinESMExports();
}

it("removes a schedule claim whose run id could not be written, so the next run launches", () => withSchedule(async (h) => {
	failNextDescriptorWrite();
	const failed = await h.run();
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /claim write ENOSPC/);
	assert.equal(fs.existsSync(h.lock), false);
	assert.equal(h.launches(), 0);

	const retry = await h.run();
	assert.equal(retry.isError, undefined);
	assert.equal(retry.details.schedules.runs[0].state, "running");
	assert.equal(h.launches(), 1);
}));

it("keeps a replacement owner's lock when its own claim write fails", () => withSchedule(async (h) => {
	failNextDescriptorWrite(() => {
		fs.unlinkSync(h.lock);
		fs.writeFileSync(h.lock, "replacement");
	});
	const failed = await h.run();
	assert.equal(failed.isError, true);
	assert.equal(fs.readFileSync(h.lock, "utf-8"), "replacement");
}));
