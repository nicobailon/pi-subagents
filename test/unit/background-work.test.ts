import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	BACKGROUND_WORK_REGISTRY_KEY,
	listBackgroundWorkProviders,
	listBackgroundWorkWakeChannels,
	registerBackgroundWorkProvider,
	snapshotBackgroundWork,
	type BackgroundWorkSnapshot,
} from "../../src/api/background-work.ts";
import { waitForSubagents, type SubagentWaitDeps } from "../../src/runs/background/subagent-wait.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function clearRegistry(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)];
}

afterEach(clearRegistry);

function makeState(sessionId = "session-a"): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function writeStatus(root: string, id: string, state: string, sessionId = "session-a"): void {
	const dir = path.join(root, id);
	fs.mkdirSync(dir, { recursive: true });
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		runId: id,
		mode: "single",
		state,
		sessionId,
		startedAt: now,
		lastUpdate: now,
		pid: 999999,
		steps: [{ agent: "worker", status: state }],
	}));
}

function waitDeps(root: string, state: SubagentState, backgroundWork: SubagentWaitDeps["backgroundWork"], sleep: () => Promise<void>): SubagentWaitDeps {
	return {
		state,
		backgroundWork,
		sleep,
		pollIntervalMs: 250,
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		kill: () => true,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

function snapshot(providers: string[], items: BackgroundWorkSnapshot["items"]): BackgroundWorkSnapshot {
	return { providers, items };
}

describe("background-work provider protocol", () => {
	it("replaces registrations safely across reloads and scopes snapshots to one session", () => {
		let context: { sessionId: string; nowMs: number } | undefined;
		const disposeOld = registerBackgroundWorkProvider({
			name: "patty",
			listActiveWork: () => [{ id: "old", sessionId: "session-a" }],
		});
		const replacement = {
			name: "patty",
			wakeChannels: ["patty:finished"],
			reconcile: (value: { sessionId: string; nowMs: number }) => { context = value; },
			listActiveWork: () => [
				{ id: "mine", sessionId: "session-a" },
				{ id: "theirs", sessionId: "session-b" },
			],
		};
		const disposeReplacement = registerBackgroundWorkProvider(replacement);
		disposeOld();

		assert.deepEqual(listBackgroundWorkProviders(), [replacement]);
		assert.deepEqual(listBackgroundWorkWakeChannels(), ["patty:finished"]);
		assert.deepEqual(snapshotBackgroundWork("session-a", 42), {
			providers: ["patty"],
			items: [{ provider: "patty", id: "mine", sessionId: "session-a" }],
		});
		assert.deepEqual(context, { sessionId: "session-a", nowMs: 42 });

		disposeReplacement();
		assert.deepEqual(listBackgroundWorkProviders(), []);
	});

	it("validates provider metadata and work items strictly", () => {
		assert.throws(() => registerBackgroundWorkProvider({ name: " patty", listActiveWork: () => [] }), /leading or trailing/);
		assert.throws(() => registerBackgroundWorkProvider({ name: "patty", listActiveWork: () => [], wakeChannels: ["done", "done"] }), /duplicates/);

		registerBackgroundWorkProvider({
			name: "patty",
			listActiveWork: () => [{ id: "job", sessionId: "session-a", extra: true } as never],
		});
		assert.throws(() => snapshotBackgroundWork("session-a"), /unknown fields: extra/);
		clearRegistry();

		registerBackgroundWorkProvider({
			name: "patty",
			listActiveWork: () => [
				{ id: "job", sessionId: "session-a" },
				{ id: "job", sessionId: "session-a" },
			],
		});
		assert.throws(() => snapshotBackgroundWork("session-a"), /duplicate item 'job'/);
	});

	it("preserves list and reconcile errors with provider context", () => {
		registerBackgroundWorkProvider({
			name: "broken-reconcile",
			reconcile: () => { throw new Error("pid probe failed"); },
			listActiveWork: () => [],
		});
		assert.throws(() => snapshotBackgroundWork("session-a"), /broken-reconcile.*pid probe failed/);
		clearRegistry();

		registerBackgroundWorkProvider({
			name: "broken-list",
			listActiveWork: () => { throw new Error("registry unavailable"); },
		});
		assert.throws(() => snapshotBackgroundWork("session-a"), /broken-list.*registry unavailable/);
	});

	it("discovers wake channels without reconciling or listing work", () => {
		let called = false;
		registerBackgroundWorkProvider({
			name: "patty",
			wakeChannels: ["patty:finished"],
			reconcile: () => { called = true; },
			listActiveWork: () => { called = true; return []; },
		});
		assert.deepEqual(listBackgroundWorkWakeChannels(), ["patty:finished"]);
		assert.equal(called, false);
	});
});

describe("subagent_wait with background-work providers", () => {
	it("detects completion when another item replaces it at the same count", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-replace-"));
		try {
			let stage = 0;
			const backgroundWork = {
				wakeChannels: () => [],
				snapshot: () => stage === 0
					? snapshot(["patty"], [{ provider: "patty", id: "job-a", sessionId: "session-a" }])
					: snapshot(["patty"], [{ provider: "patty", id: "job-b", sessionId: "session-a" }]),
			};
			const result = await waitForSubagents({}, undefined, waitDeps(root, makeState(), backgroundWork, async () => { stage = 1; }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /1 of 1 item\(s\) finished/);
			assert.match(textOf(result), /provider item\(s\) finished/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits for both initial async and provider identities in all mode", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-mixed-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeStatus(asyncRoot, "run-a", "running");
			let stage = 0;
			const backgroundWork = {
				wakeChannels: () => [],
				snapshot: () => snapshot(["patty"], stage < 2 ? [{ provider: "patty", id: "job-a", sessionId: "session-a" }] : []),
			};
			const result = await waitForSubagents({ all: true }, undefined, waitDeps(root, makeState(), backgroundWork, async () => {
				stage += 1;
				if (stage === 1) writeStatus(asyncRoot, "run-a", "complete");
			}));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /1 async run\(s\) and 1 provider item\(s\).*done/s);
			assert.equal(stage, 2);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a provider disappears or its snapshot throws", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-missing-"));
		try {
			let calls = 0;
			const disappeared = await waitForSubagents({}, undefined, waitDeps(root, makeState(), {
				wakeChannels: () => [],
				snapshot: () => calls++ === 0
					? snapshot(["patty"], [{ provider: "patty", id: "job-a", sessionId: "session-a" }])
					: snapshot([], []),
			}, async () => {}));
			assert.equal(disappeared.isError, true);
			assert.match(textOf(disappeared), /provider 'patty' disappeared/);

			const failed = await waitForSubagents({}, undefined, waitDeps(root, makeState(), {
				wakeChannels: () => [],
				snapshot: () => { throw new Error("provider registry failed"); },
			}, async () => {}));
			assert.equal(failed.isError, true);
			assert.match(textOf(failed), /provider registry failed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("can continue through needs-attention while draining", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-attention-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeStatus(asyncRoot, "run-a", "running");
			const statusPath = path.join(asyncRoot, "run-a", "status.json");
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			fs.writeFileSync(statusPath, JSON.stringify({ ...status, activityState: "needs_attention" }));
			let polls = 0;
			const result = await waitForSubagents({ all: true }, undefined, {
				...waitDeps(root, makeState(), { wakeChannels: () => [], snapshot: () => snapshot([], []) }, async () => {
					polls += 1;
					writeStatus(asyncRoot, "run-a", "complete");
				}),
				stopOnAttention: false,
			});
			assert.equal(result.isError, undefined);
			assert.equal(polls, 1);
			assert.match(textOf(result), /done/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes on a provider channel instead of the poll interval", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-event-"));
		try {
			let active = true;
			const handlers = new Map<string, Array<(data: unknown) => void>>();
			const events = {
				on(channel: string, handler: (data: unknown) => void) {
					const channelHandlers = handlers.get(channel) ?? [];
					channelHandlers.push(handler);
					handlers.set(channel, channelHandlers);
					return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
				},
				emit(channel: string) {
					for (const handler of handlers.get(channel) ?? []) handler(undefined);
				},
			};
			const backgroundWork = {
				wakeChannels: () => ["patty:finished"],
				snapshot: () => snapshot(["patty"], active ? [{ provider: "patty", id: "job-a", sessionId: "session-a" }] : []),
			};
			const promise = waitForSubagents({}, undefined, {
				...waitDeps(root, makeState(), backgroundWork, async (ms?: number, signal?: AbortSignal) => {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, ms ?? 10_000);
						signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
					});
				}),
				events,
				pollIntervalMs: 10_000,
			});
			setTimeout(() => { active = false; events.emit("patty:finished"); }, 15);
			const result = await promise;
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /provider item\(s\) finished/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
