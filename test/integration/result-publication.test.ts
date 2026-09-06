import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../src/shared/types.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { makeAgent } from "../support/helpers.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, executeAsyncSingle,
	ASYNC_DIR, RESULTS_DIR, tempDir, mockPi,
} from "../support/async-execution-fixture.ts";

function fileBarrier(file: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// libuv on Windows compares long event paths against this watch path; expand TEMP's 8.3 aliases.
		const watcher = fs.watch(fs.realpathSync.native(path.dirname(file)), check);
		const deadline = setTimeout(() => { watcher.close(); reject(new Error(`Missing barrier: ${file}`)); }, 15_000);
		function check() {
			if (!fs.existsSync(file)) return;
			clearTimeout(deadline);
			watcher.close();
			resolve();
		}
		check();
	});
}

describe("native runner result publication", { skip: !available ? "pi packages unavailable" : undefined }, () => {
	installAsyncExecutionHooks();
	it("watches the canonical barrier directory through a path alias", async (t) => {
		const directory = path.join(tempDir, "barrier-directory");
		const alias = path.join(tempDir, "barrier-alias");
		fs.mkdirSync(directory);
		fs.symlinkSync(directory, alias, "junction");
		const watch = fs.watch;
		t.mock.method(fs, "watch", ((watched, ...args) => {
			assert.equal(watched, fs.realpathSync.native(directory));
			return Reflect.apply(watch, fs, [watched, ...args]);
		}) as typeof fs.watch);
		const file = path.join(alias, "ready");
		const ready = fileBarrier(file);
		fs.writeFileSync(file, "");
		await ready;
	});
	for (const outcome of ["recovered", "retry-error"] as const) {
		it(`keeps Darwin delivery demand until deferred indexed final result publication settles (${outcome})`, { skip: !isAsyncAvailable() ? "jiti unavailable" : undefined }, async () => {
			const root = path.join(tempDir, "publication-barriers");
			fs.mkdirSync(root);
			if (outcome === "retry-error") fs.writeFileSync(path.join(root, "fail-on-recovery"), "");
			const id = "publication-capacity";
			const sessionId = "publication-session";
			const owner = "publication-owner";
			const asyncDir = path.join(ASYNC_DIR, id);
			const resultPath = path.join(RESULTS_DIR, `${id}.json`);
			const state: SubagentState = {
				baseCwd: tempDir, currentSessionId: sessionId, completionOwnerId: owner,
				asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
				cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
				watcher: null, watcherRestartTimer: null,
				resultFileCoalescer: { schedule: () => false, clear() {} },
			};
			let poll: ReturnType<typeof setInterval> | undefined;
			let delivered = 0;
			let complete!: () => void;
			let deliveryDeadline: ReturnType<typeof setTimeout> | undefined;
			const completion = new Promise<void>((resolve) => { complete = resolve; });
			const pi = {
				events: { on: () => () => {}, emit(event: string, data: unknown) {
					if (event !== SUBAGENT_ASYNC_COMPLETE_EVENT) return;
					assert.equal((data as { completionOwnerId?: string }).completionOwnerId, owner);
					complete();
				} },
				sendMessage() { delivered++; },
			};
			const notifier = registerSubagentNotify(pi, state, { batchConfig: { enabled: false } });
			const watcher = createResultWatcher(pi, state, RESULTS_DIR, 60_000, {
				platform: "darwin", coalesceDelayMs: 0,
				hasDeliveryDemand: () => {
					const statusPath = path.join(asyncDir, "status.json");
					if (!fs.existsSync(statusPath)) return true;
					const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
					return status.state === "running" || status.state === "queued";
				},
				notifier,
				timers: {
					setTimeout, clearTimeout,
					setInterval: ((handler: () => void, delay: number) => {
						assert.equal(delay, 3000);
						poll = setInterval(() => {
							handler();
							if (fs.existsSync(path.join(root, "blocked.json"))) fs.writeFileSync(path.join(root, "polled"), "");
						}, delay);
						return poll;
					}) as typeof setInterval,
					clearInterval: ((handle: ReturnType<typeof setInterval>) => { clearInterval(handle); poll = undefined; }) as typeof clearInterval,
				},
			});
			const oldOptions = process.env.NODE_OPTIONS;
			const oldRoot = process.env.RESULT_PUBLICATION_TEST_ROOT;
			try {
				process.env.NODE_OPTIONS = `${oldOptions ?? ""} --import=${new URL("../support/result-publication-capacity-preload.mjs", import.meta.url).href}`;
				process.env.RESULT_PUBLICATION_TEST_ROOT = root;
				mockPi.onCall({ output: "Indexed completion after capacity recovery" });
				const receipt = executeAsyncSingle(id, {
					agent: "worker", task: "Complete without a provider", agentConfig: makeAgent("worker", { completionGuard: false }),
					ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: sessionId, completionOwnerId: owner },
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2, acceptance: false,
				});
				assert.notEqual(receipt.isError, true);
				watcher.startResultWatcher();
				await fileBarrier(path.join(root, "blocked.json"));
				const blocked = JSON.parse(fs.readFileSync(path.join(root, "blocked.json"), "utf8"));
				assert.equal(blocked.statusDeferred, true, "exercise an older deferred status write too");
				await fileBarrier(path.join(root, "polled")); // A real demand-interval tick while capacity is held.
				assert.equal(blocked.state, "running", "terminal status must not precede indexed final result publication");
				assert.equal(blocked.active, true, "older status retry must not remove the active index");
				const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
				assert.ok(events.some((event) => event.type === "subagent.steer.failed" && event.requestId === "publication-steer"), "exercise incidental status writing during finalization");
				assert.ok(poll, "the demand interval must remain installed before recovery");
				assert.equal(fs.existsSync(resultPath), false);
				assert.equal(delivered, 0);
				fs.writeFileSync(path.join(root, "release"), "");
				await fileBarrier(path.join(root, "terminal.json"));
				const terminal = JSON.parse(fs.readFileSync(path.join(root, "terminal.json"), "utf8"));
				assert.equal(terminal.state, outcome === "recovered" ? "complete" : "failed");
				if (outcome === "retry-error") assert.match(terminal.error, /injected non-capacity publication failure/);
				const publishedPath = outcome === "recovered" ? resultPath : path.join(RESULTS_DIR, "result-pending", sessionId, `${id}.json`);
				// An automatic tick may already have accepted and cleaned the indexed result.
				assert.ok(fs.existsSync(publishedPath) || delivered === 1, "terminal result must be published or already delivered");
				if (fs.existsSync(publishedPath)) assert.equal(JSON.parse(fs.readFileSync(publishedPath, "utf8")).completionOwnerId, owner);
				await Promise.race([completion, new Promise((_, reject) => {
					deliveryDeadline = setTimeout(() => reject(new Error("completion not delivered")), 5000);
				})]);
				clearTimeout(deliveryDeadline);
				assert.equal(delivered, 1);
				assert.equal(fs.existsSync(resultPath), false);
				assert.equal(poll, undefined);
				assert.equal(state.watcherRestartTimer, null);
				await fileBarrier(path.join(asyncDir, "process-terminal-candidate.json"));
			} finally {
				clearTimeout(deliveryDeadline);
				fs.writeFileSync(path.join(root, "release"), "");
				watcher.stopResultWatcher();
				notifier.dispose();
				if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
				if (oldRoot === undefined) delete process.env.RESULT_PUBLICATION_TEST_ROOT; else process.env.RESULT_PUBLICATION_TEST_ROOT = oldRoot;
			}
		});
	}
});
