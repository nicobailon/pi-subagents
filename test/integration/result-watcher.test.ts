import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../result-watcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../types.ts";

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("result watcher", () => {
	it("logs malformed result files instead of swallowing them silently", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			fs.writeFileSync(path.join(resultsDir, "bad.json"), "{bad-json", "utf-8");
			const emitted: unknown[] = [];
			const pi = {
				events: {
					emit(_event: string, data: unknown) {
						emitted.push(data);
					},
				},
			};
			const state = createState();
			const watcher = createResultWatcher(pi as never, state as never, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.length, 0);
			assert.ok(
				logged.some((entry) => /Failed to process subagent result file/.test(String(entry[0] ?? ""))),
				"expected watcher error to be logged",
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling result files when fs.watch hits EMFILE", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const state = createState();
			state.currentSessionId = "session-1";
			const events = new EventEmitter();
			const emitted: unknown[] = [];
			events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => emitted.push(data));

			let poll: (() => void) | undefined;
			const emfile = new Error("too many open files") as NodeJS.ErrnoException;
			emfile.code = "EMFILE";
			const watcher = createResultWatcher({ events } as never, state as never, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => {
						throw emfile;
					},
				},
				timers: {
					...globalThis,
					setInterval: (handler: () => void) => {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval: () => {},
				},
			});

			const originalError = console.error;
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				const resultPath = path.join(resultsDir, "done.json");
				fs.writeFileSync(resultPath, JSON.stringify({ sessionId: "session-1", summary: "done" }));
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 75));

				assert.equal(emitted.length, 1);
				assert.deepEqual(emitted[0], { sessionId: "session-1", summary: "done" });
				assert.equal(fs.existsSync(resultPath), false);
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});
});
