import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../src/shared/types.ts";
import { makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, ASYNC_DIR, RESULTS_DIR, tempDir } from "../support/async-execution-fixture.ts";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
async function bounded(promise: Promise<unknown>) {
	let timer: ReturnType<typeof setTimeout>;
	try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("publication barrier timed out")), 12000); })]); }
	finally { clearTimeout(timer!); }
}

describe("host workflow result publication", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const outcome of ["complete", "failed", "stopped", "index-error", "retry-error", "replacement-error"] as const) {
	it(`retains real Darwin demand until deferred indexed workflow publication settles (${outcome})`, async () => {
		const polled = barrier(), published = barrier(), delivered = barrier(), retired = barrier(), failed = barrier(), emitted = barrier();
		let held = true, attempted = false, indexFailureInjected = false, notifications = 0, refreshes = 0, notificationContent = "";
		const notificationTypes: string[] = [];
		let statusWrites = 0, statusDeferred = false, statusRecovered = false;
		let poll: ReturnType<typeof setInterval> | undefined;
		const sessionId = "workflow-publication-session", owner = "workflow-publication-owner";
		const state: SubagentState = { baseCwd: tempDir, currentSessionId: sessionId, completionOwnerId: owner,
			asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
			cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
			watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
		};
		const pi = { getSessionName: () => undefined, events: { on: () => () => {}, emit(event: string, data: unknown) {
			if (event === SUBAGENT_ASYNC_COMPLETE_EVENT) { assert.equal((data as { completionOwnerId: string }).completionOwnerId, owner); delivered.resolve(); }
		} }, sendMessage(message: { customType?: string; content?: string }) { notifications++; notificationContent = message.content ?? ""; if (message.customType) notificationTypes.push(message.customType); } };
		const notifier = registerSubagentNotify(pi, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, RESULTS_DIR, 60000, { platform: "darwin", coalesceDelayMs: 0, notifier,
			hasDeliveryDemand: () => [...state.asyncJobs.values()].some((job) => job.status === "running" || job.status === "queued"),
			timers: { setTimeout, clearTimeout, setInterval: ((handler: () => void, delay: number) => {
				assert.equal(delay, 3000);
				poll = setInterval(() => { handler(); if (attempted) polled.resolve(); }, delay); return poll;
			}) as typeof setInterval, clearInterval: ((handle: ReturnType<typeof setInterval>) => { clearInterval(handle); poll = undefined; retired.resolve(); }) as typeof clearInterval },
		});
		const originalWrite = fs.writeFileSync, originalRename = fs.renameSync, originalAppend = fs.appendFileSync;
		fs.writeFileSync = ((file, ...args) => {
			if (String(file).includes(`${path.sep}result-pending${path.sep}`)) {
				attempted = true;
				if (held) throw Object.assign(new Error("injected workflow capacity failure"), { code: "ENOSPC" });
				if (outcome === "retry-error" || outcome === "replacement-error") throw Object.assign(new Error("injected workflow retry EIO"), { code: "EIO" });
			}
			return originalWrite(file, ...args);
		}) as typeof fs.writeFileSync;
		fs.renameSync = ((from, to) => {
			if (outcome === "index-error" && !held && !indexFailureInjected && String(to).includes(`${path.sep}result-index${path.sep}sessions${path.sep}`)) {
				indexFailureInjected = true;
				throw Object.assign(new Error("injected workflow index EIO"), { code: "EIO" });
			}
			if (path.basename(String(to)) === "status.json") {
				if (++statusWrites > 1 && !attempted) { statusDeferred = true; throw Object.assign(new Error("injected running status capacity failure"), { code: "ENOSPC" }); }
				if (statusDeferred && held && attempted) statusRecovered = true;
			}
			originalRename(from, to); if (path.dirname(String(to)) === RESULTS_DIR) published.resolve();
		}) as typeof fs.renameSync;
		fs.appendFileSync = ((file, data, ...args) => {
			originalAppend(file, data, ...args);
			if (String(data).includes('"type":"subagent.workflow.result_write_failed"')) failed.resolve();
			if (String(data).includes('"type":"subagent.workflow.emit"')) emitted.resolve();
		}) as typeof fs.appendFileSync;
		syncBuiltinESMExports();
		try {
			const executor = createSubagentExecutor!({ pi, state, config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p, discoverAgents: () => ({ agents: [] }),
				refreshResultDelivery: () => { refreshes++; watcher.refreshResultDelivery(); },
			});
			const ctx = makeMinimalCtx(tempDir); ctx.sessionManager.getSessionId = () => sessionId;
			const script = outcome === "stopped" ? "await new Promise(() => {})" : outcome === "failed" ? "throw new Error('workflow script failed')" : "return 'done'";
			const launch = await executor.execute("workflow-publication", { workflowScript: `emit('progress'); ${script}`, async: true }, new AbortController().signal, undefined, ctx);
			assert.notEqual(launch.isError, true);
			const id = launch.details.asyncId!;
			watcher.startResultWatcher();
			if (outcome === "stopped") {
				await bounded(emitted.promise);
				const stop = await executor.execute("workflow-stop", { action: "stop", id }, new AbortController().signal, undefined, ctx);
				assert.notEqual(stop.isError, true);
				assert.match(stop.content[0]?.text ?? "", /Stop requested/);
				assert.equal(state.workflowControllers?.get(id)?.signal.aborted, true);
			}
			await bounded(polled.promise);
			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
			assert.equal(status.state, "running", "terminal status must not precede indexed workflow result publication");
			assert.equal(state.asyncJobs.get(id)?.status, "running");
			assert.equal(statusDeferred, true); assert.equal(statusRecovered, true);
			assert.equal(fs.existsSync(path.join(ASYNC_DIR, ".active-runs", id)), true);
			assert.ok(poll); assert.equal(notifications, 0); assert.equal(refreshes, 0);
			if (outcome === "replacement-error") {
				state.currentSessionId = "replacement-session";
				state.completionOwnerId = "replacement-owner";
			}
			held = false;
			if (outcome === "retry-error" || outcome === "replacement-error") {
				await bounded(failed.promise);
				// Allow the awaited failure callback to finish its existing cleanup.
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(state.workflowControllers?.has(id), false);
				assert.equal(state.asyncJobs.get(id)?.status, "running");
				if (outcome === "retry-error") {
					// A failed publication must wake its owner: without the terminal
					// result file the watcher can never deliver the completion wake.
					assert.equal(notifications, 1); assert.equal(refreshes, 1);
					assert.match(notificationContent, /Failed to write async workflow result/);
				} else {
					assert.equal(notifications, 0, "an old workflow failure must not enter the replacement session");
					assert.equal(refreshes, 0);
				}
				assert.match(fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf8"), /injected workflow retry EIO/);
				assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)), false);
				return;
			}
			await bounded(Promise.all([published.promise, delivered.promise]));
			const expectedState = outcome === "index-error" ? "complete" : outcome;
			assert.equal(state.asyncJobs.get(id)?.status, expectedState);
			const terminalStatus = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
			assert.equal(terminalStatus.state, expectedState);
			if (outcome === "stopped") assert.equal(terminalStatus.stopped, true);
			assert.equal(notifications, 1); assert.equal(refreshes, 1);
			if (outcome === "index-error") {
				assert.deepEqual(notificationTypes, ["subagent-notify"]);
				assert.doesNotMatch(fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf8"), /subagent\.workflow\.result_write_failed/);
			}
			assert.ok(notificationContent.includes(`Retention-managed async directory: ${path.join(ASYNC_DIR, id)}`));
			assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)), false);
			// The existing demand timer retires itself after terminal publication.
			await bounded(retired.promise);
			assert.equal(poll, undefined);
		} finally {
			held = false;
			try { await bounded(outcome === "retry-error" || outcome === "replacement-error" ? failed.promise : published.promise); }
			finally {
				watcher.stopResultWatcher(); notifier.dispose();
				fs.writeFileSync = originalWrite; fs.renameSync = originalRename; fs.appendFileSync = originalAppend; syncBuiltinESMExports();
			}
		}
	});
	}
});
