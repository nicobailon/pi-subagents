import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";

interface AsyncJobTrackerModule {
	createAsyncJobTracker(
		state: Record<string, unknown>,
		asyncDirRoot: string,
		options?: { completionRetentionMs?: number; pollIntervalMs?: number },
	): {
		resetJobs(ctx?: unknown): void;
		handleStarted(data: unknown): void;
		handleComplete(data: unknown): void;
	};
}

const trackerMod = await tryImport<AsyncJobTrackerModule>("./async-job-tracker.ts");
const available = !!trackerMod;

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

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_theme: string, text: string) => text,
			},
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		get widgets() {
			return widgets;
		},
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("async job tracker", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("removes completed jobs after retention and requests a rerender", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const ui = createUiContext();
			const tracker = trackerMod!.createAsyncJobTracker(state as never, asyncRoot, {
				completionRetentionMs: 5,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-1", asyncDir: path.join(asyncRoot, "run-1"), agent: "worker" });
			tracker.handleComplete({ id: "run-1", success: true });

			assert.equal(state.asyncJobs.size, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected widget cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("schedules cleanup when polling observes a completed status without a completion event", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-2");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-2",
				mode: "single",
				state: "complete",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const tracker = trackerMod!.createAsyncJobTracker(state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-2", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected polling cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
