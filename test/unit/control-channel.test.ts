import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	closeSteerInbox,
	consumeInterruptRequest,
	consumeSteerRequests,
	consumeStopRequest,
	consumeStopRequestPayload,
	consumeStopRequestPayloads,
	deliverInterruptRequest,
	interruptRequestPath,
	MAX_STEER_QUEUE_SIZE,
	queueRevivalBrief,
	readRevivalBriefs,
	requestAsyncInterrupt,
	requestAsyncSteer,
	requestAsyncStop,
	steerInboxClosedPath,
	stopRequestsDir,
	stopRequestPath,
	steerRequestsDir,
	watchAsyncControlInbox,
	watchAsyncSteerInbox,
} from "../../src/runs/background/control-channel.ts";

function tmpAsyncDir(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
	return path.join(root, "run");
}

function cleanup(asyncDir: string): void {
	fs.rmSync(path.dirname(asyncDir), { recursive: true, force: true });
}

describe("control channel: request file", () => {
	it("writes a parseable interrupt request, creating the inbox dir", () => {
		const asyncDir = tmpAsyncDir("pi-control-write-");
		try {
			const requestPath = requestAsyncInterrupt(asyncDir, { source: "test" }, { now: () => 999 });
			assert.equal(requestPath, interruptRequestPath(asyncDir));
			const data = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
			assert.equal(data.type, "interrupt");
			assert.equal(data.ts, 999);
			assert.equal(data.source, "test");
		} finally {
			cleanup(asyncDir);
		}
	});

	it("writes and consumes a stop request", () => {
		const asyncDir = tmpAsyncDir("pi-control-stop-");
		try {
			const requestPath = requestAsyncStop(asyncDir, { source: "test" }, { now: () => 1234 });
			assert.equal(path.dirname(requestPath), stopRequestsDir(asyncDir));
			const data = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
			assert.equal(data.type, "stop");
			assert.equal(data.ts, 1234);
			assert.equal(data.source, "test");
			assert.equal(consumeStopRequest(asyncDir), true);
			assert.equal(fs.existsSync(requestPath), false);
			assert.equal(consumeStopRequest(asyncDir), false);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("keeps concurrent stop requests instead of replacing the first one", () => {
		const asyncDir = tmpAsyncDir("pi-control-stop-queue-");
		try {
			requestAsyncStop(asyncDir, { source: "test", targetIndex: 1, childId: "slow" }, { now: () => 1234 });
			requestAsyncStop(asyncDir, { source: "test", targetIndex: 2, childId: "review" }, { now: () => 1235 });

			assert.deepEqual(consumeStopRequestPayloads(asyncDir), [
				{ type: "stop", ts: 1234, source: "test", targetIndex: 1, childId: "slow" },
				{ type: "stop", ts: 1235, source: "test", targetIndex: 2, childId: "review" },
			]);
			assert.deepEqual(consumeStopRequestPayloads(asyncDir), []);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("writes and consumes a child-scoped stop request", () => {
		const asyncDir = tmpAsyncDir("pi-control-child-stop-");
		try {
			requestAsyncStop(asyncDir, { source: "test", targetIndex: 2, childId: "review" }, { now: () => 1234 });

			assert.deepEqual(consumeStopRequestPayload(asyncDir), {
				type: "stop",
				ts: 1234,
				source: "test",
				targetIndex: 2,
				childId: "review",
			});
			assert.deepEqual(consumeStopRequestPayloads(asyncDir), []);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("drops malformed stop files instead of widening them to run-level stops", () => {
		const asyncDir = tmpAsyncDir("pi-control-stop-malformed-");
		try {
			fs.mkdirSync(stopRequestsDir(asyncDir), { recursive: true });
			const requestPath = path.join(stopRequestsDir(asyncDir), "0000000001234-bad.json");
			fs.writeFileSync(requestPath, "{ not json", "utf-8");

			assert.deepEqual(consumeStopRequestPayloads(asyncDir), []);
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("drops invalid child-scoped stop fields instead of widening to a run stop", () => {
		const asyncDir = tmpAsyncDir("pi-control-stop-invalid-child-");
		try {
			fs.mkdirSync(stopRequestsDir(asyncDir), { recursive: true });
			const requestPath = path.join(stopRequestsDir(asyncDir), "0000000001234-bad-child.json");
			fs.writeFileSync(requestPath, JSON.stringify({ type: "stop", targetIndex: -1, childId: "bad\nchild" }), "utf-8");

			assert.deepEqual(consumeStopRequestPayloads(asyncDir), []);
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("keeps the request type authoritative even for untyped callers", () => {
		const asyncDir = tmpAsyncDir("pi-control-write-type-");
		try {
			const requestPath = requestAsyncInterrupt(asyncDir, { type: "not-interrupt", source: "test" } as any, { now: () => 999 });
			const data = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
			assert.equal(data.type, "interrupt");
			assert.equal(data.source, "test");
		} finally {
			cleanup(asyncDir);
		}
	});

	it("consumes a pending request exactly once and removes the file", () => {
		const asyncDir = tmpAsyncDir("pi-control-consume-");
		try {
			requestAsyncInterrupt(asyncDir);
			assert.equal(consumeInterruptRequest(asyncDir), true);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
			assert.equal(consumeInterruptRequest(asyncDir), false);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("removes a malformed request directory instead of firing forever", () => {
		const asyncDir = tmpAsyncDir("pi-control-consume-dir-");
		try {
			fs.mkdirSync(interruptRequestPath(asyncDir), { recursive: true });
			assert.equal(consumeInterruptRequest(asyncDir), true);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
			assert.equal(consumeInterruptRequest(asyncDir), false);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("writes and consumes ordered steer requests", () => {
		const asyncDir = tmpAsyncDir("pi-control-steer-");
		try {
			requestAsyncSteer(asyncDir, { message: "  later guidance  ", mode: "follow_up", targetIndex: 1, id: "b", ts: 200, source: "test" });
			requestAsyncSteer(asyncDir, { message: "first guidance", targetIndexes: [0, 2], id: "a", ts: 100 });
			assert.equal(fs.readdirSync(steerRequestsDir(asyncDir)).length, 2);

			assert.deepEqual(consumeSteerRequests(asyncDir), [
				{ type: "steer", id: "a", ts: 100, message: "first guidance", targetIndexes: [0, 2] },
				{ type: "steer", id: "b", ts: 200, message: "later guidance", mode: "follow_up", targetIndex: 1, source: "test" },
			]);
			assert.deepEqual(consumeSteerRequests(asyncDir), []);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("rejects requests after the runner closes the steering inbox", () => {
		const asyncDir = tmpAsyncDir("pi-control-steer-closed-");
		try {
			closeSteerInbox(asyncDir, "complete");
			assert.equal(fs.existsSync(steerInboxClosedPath(asyncDir)), true);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "too late", targetIndexes: [0] }), /no longer accepts steering/);
			assert.equal(fs.existsSync(steerRequestsDir(asyncDir)), false);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("keeps steer request ids out of filesystem paths", () => {
		const asyncDir = tmpAsyncDir("pi-control-steer-safe-name-");
		try {
			const requestPath = requestAsyncSteer(asyncDir, { message: "safe", id: "../outside\\bad:thing", ts: 1 });
			assert.equal(path.dirname(requestPath), steerRequestsDir(asyncDir));
			assert.equal(path.basename(requestPath), `0000000000001-${Buffer.from("../outside\\bad:thing").toString("base64url")}.json`);
			assert.deepEqual(consumeSteerRequests(asyncDir), [
				{ type: "steer", id: "../outside\\bad:thing", ts: 1, message: "safe" },
			]);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("keeps steer requests for retry when the inbox cannot be scanned", () => {
		const asyncDir = tmpAsyncDir("pi-control-steer-scan-retry-");
		try {
			requestAsyncSteer(asyncDir, { message: "retry me", id: "retry", ts: 1 });
			let failScan = true;
			const fsImpl = {
				existsSync: fs.existsSync,
				readdirSync: ((target: fs.PathLike) => {
					if (failScan) {
						failScan = false;
						throw Object.assign(new Error("file table overflow"), { code: "ENFILE" });
					}
					return fs.readdirSync(target);
				}) as typeof fs.readdirSync,
				readFileSync: fs.readFileSync,
				rmSync: fs.rmSync,
			};

			assert.deepEqual(consumeSteerRequests(asyncDir, fsImpl), []);
			assert.deepEqual(consumeSteerRequests(asyncDir, fsImpl), [
				{ type: "steer", id: "retry", ts: 1, message: "retry me" },
			]);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("does not deliver a steer request if another consumer removed it first", () => {
		const asyncDir = tmpAsyncDir("pi-control-steer-concurrent-");
		try {
			requestAsyncSteer(asyncDir, { message: "already taken", id: "s", ts: 1 });
			const fsImpl = {
				existsSync: fs.existsSync,
				readdirSync: fs.readdirSync,
				readFileSync: fs.readFileSync,
				rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
					fs.rmSync(target, options);
					const error = new Error("already removed") as NodeJS.ErrnoException;
					error.code = "ENOENT";
					throw error;
				},
			};
			assert.deepEqual(consumeSteerRequests(asyncDir, fsImpl), []);
			assert.deepEqual(consumeSteerRequests(asyncDir), []);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("bounds retained revival briefs and keeps them FIFO", () => {
		const asyncDir = tmpAsyncDir("pi-control-revival-brief-");
		try {
			for (let index = 0; index < MAX_STEER_QUEUE_SIZE; index++) {
				queueRevivalBrief(asyncDir, { type: "steer", id: `brief-${index}`, ts: index + 1, message: `brief ${index}`, mode: "follow_up" });
			}
			assert.deepEqual(readRevivalBriefs(asyncDir).map(({ request }) => request.id), Array.from({ length: MAX_STEER_QUEUE_SIZE }, (_, index) => `brief-${index}`));
			assert.throws(() => queueRevivalBrief(asyncDir, { type: "steer", id: "full", ts: 99, message: "too much", mode: "follow_up" }), /queue is full/);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("rejects empty steer messages and invalid target indexes", () => {
		const asyncDir = tmpAsyncDir("pi-control-steer-invalid-");
		try {
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "   " }), /steer message must not be empty/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", targetIndex: -1 }), /targetIndex/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", targetIndex: 1_000_001 }), /targetIndex/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", targetIndexes: [] }), /targetIndexes/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", targetIndexes: [0, 0] }), /targetIndexes/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", targetIndex: 0, targetIndexes: [0] }), /targetIndexes/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", targetIndexes: "bad" as unknown as number[] }), /targetIndexes/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "x".repeat(128 * 1024 + 1) }), /exceeds/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", id: "contains whitespace" }), /malformed/);
		} finally {
			cleanup(asyncDir);
		}
	});

});

describe("control channel: deliverInterruptRequest", () => {
	it("writes the portable request without signaling an unverified pid", () => {
		const asyncDir = tmpAsyncDir("pi-control-deliver-file-only-");
		try {
			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			const unverifiedInput = {
				asyncDir,
				pid: 4242,
				signal: "SIGUSR2" as NodeJS.Signals,
				kill: (pid: number, signal?: NodeJS.Signals | 0) => {
					kills.push({ pid, signal });
					return true;
				},
			};
			deliverInterruptRequest(unverifiedInput);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
			assert.deepEqual(kills, []);
		} finally {
			cleanup(asyncDir);
		}
	});
});

describe("control channel: watchAsyncControlInbox", () => {
	type WatchHarness = {
		fsImpl: import("../../src/runs/background/control-channel.ts").ControlChannelFs;
		timers: import("../../src/runs/background/control-channel.ts").ControlChannelTimers;
		trigger: (dir?: string) => void;
		triggerError: (dir?: string) => void;
		closed: () => boolean;
		intervalCount: () => number;
		intervalDelays: () => number[];
		watchedDir: () => string | undefined;
	};

	function harness(nativeDir?: string): WatchHarness {
		const listeners = new Map<string, () => void>();
		const errorListeners = new Map<string, () => void>();
		let closed = false;
		const intervalDelays: number[] = [];
		let watchedDir: string | undefined;
		const realpathSync = ((target: fs.PathLike, options?: unknown) => fs.realpathSync(target, options as BufferEncoding)) as typeof fs.realpathSync;
		realpathSync.native = ((target: fs.PathLike) => nativeDir ?? fs.realpathSync.native(target)) as typeof fs.realpathSync.native;
		const fsImpl = {
			mkdirSync: fs.mkdirSync,
			existsSync: fs.existsSync,
			rmSync: fs.rmSync,
			readdirSync: fs.readdirSync,
			readFileSync: fs.readFileSync,
			realpathSync,
			watch: ((dir: string, cb: () => void) => {
				watchedDir = dir;
				listeners.set(dir, cb);
				return {
					close: () => { closed = true; },
					on: (event: string, handler: () => void) => {
						if (event === "error") errorListeners.set(dir, handler);
					},
				};
			}),
		} as unknown as WatchHarness["fsImpl"];
		const timers = {
			setInterval: ((_handler: Parameters<typeof setInterval>[0], delay?: number) => {
				intervalDelays.push(delay ?? 0);
				return { unref() {} };
			}) as unknown as typeof setInterval,
			clearInterval: (() => {}) as unknown as typeof clearInterval,
		};
		return {
			fsImpl,
			timers,
			trigger: (dir?: string) => {
				if (dir) listeners.get(dir)?.();
				else for (const listener of listeners.values()) listener();
			},
			triggerError: (dir?: string) => {
				if (dir) errorListeners.get(dir)?.();
				else for (const listener of errorListeners.values()) listener();
			},
			closed: () => closed,
			intervalCount: () => intervalDelays.length,
			intervalDelays: () => [...intervalDelays],
			watchedDir: () => watchedDir,
		};
	}

	it("registers the native canonical control inbox path", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-native-");
		try {
			const nativeDir = path.join(path.dirname(asyncDir), "native-control-path");
			const h = harness(nativeDir);
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt() {}, fs: h.fsImpl, timers: h.timers, platform: "linux" });
			assert.equal(h.watchedDir(), nativeDir);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("does not start fast polling when native watch is available", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-no-poll-");
		try {
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt() {}, fs: h.fsImpl, timers: h.timers, platform: "linux" });
			assert.deepEqual(h.intervalDelays(), [5000]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("starts portable polling once when the native watcher fails", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-fallback-");
		try {
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt() {}, fs: h.fsImpl, timers: h.timers, platform: "linux" });
			h.triggerError();
			h.triggerError();
			assert.deepEqual(h.intervalDelays(), [5000, 250]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("uses portable polling without native watchers on Darwin", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-darwin-");
		try {
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt() {}, fs: h.fsImpl, timers: h.timers, platform: "darwin" });
			assert.equal(h.watchedDir(), undefined);
			assert.deepEqual(h.intervalDelays(), [250]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("fires on a request that arrived before the watcher started", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-early-");
		try {
			requestAsyncInterrupt(asyncDir);
			let fired = 0;
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt: () => fired++, fs: h.fsImpl, timers: h.timers, platform: "linux" });
			assert.equal(fired, 1);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("fires once per request via the watch event and stops after dispose", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-event-");
		try {
			let fired = 0;
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt: () => fired++, fs: h.fsImpl, timers: h.timers, platform: "linux" });
			assert.equal(fired, 0);

			requestAsyncInterrupt(asyncDir);
			h.trigger();
			assert.equal(fired, 1);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);

			// No pending request → spurious event is a no-op.
			h.trigger();
			assert.equal(fired, 1);

			dispose();
			assert.equal(h.closed(), true);

			// After dispose, even a fresh request is ignored.
			requestAsyncInterrupt(asyncDir);
			h.trigger();
			assert.equal(fired, 1);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("delivers stop requests before interrupt requests", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-stop-early-");
		try {
			requestAsyncStop(asyncDir);
			requestAsyncInterrupt(asyncDir);
			const events: string[] = [];
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, {
				onInterrupt: () => events.push("interrupt"),
				onStop: () => events.push("stop"),
				fs: h.fsImpl,
				timers: h.timers,
				platform: "linux",
			});

			assert.deepEqual(events, ["stop", "interrupt"]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("delivers stop payloads to the watcher", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-child-stop-");
		try {
			requestAsyncStop(asyncDir, { targetIndex: 1, childId: "slow" });
			const stops: Array<{ targetIndex?: number; childId?: string }> = [];
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, {
				onInterrupt() {},
				onStop: (request) => stops.push({ targetIndex: request.targetIndex, childId: request.childId }),
				fs: h.fsImpl,
				timers: h.timers,
				platform: "linux",
			});

			assert.deepEqual(stops, [{ targetIndex: 1, childId: "slow" }]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("delivers steer requests without firing interrupt", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-steer-");
		try {
			let interrupted = 0;
			const steers: Array<{ message: string; targetIndex?: number }> = [];
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, {
				onInterrupt: () => interrupted++,
				onSteer: (request) => steers.push({ message: request.message, targetIndex: request.targetIndex }),
				fs: h.fsImpl,
				timers: h.timers,
				platform: "linux",
			});

			requestAsyncSteer(asyncDir, { message: "go narrower", targetIndex: 0, id: "s", ts: 1 });
			h.trigger();

			assert.equal(interrupted, 0);
			assert.deepEqual(steers, [{ message: "go narrower", targetIndex: 0 }]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("delivers later steer files from the watched request directory without polling", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-steer-nested-");
		try {
			const steers: string[] = [];
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, {
				onInterrupt() {},
				onSteer: (request) => steers.push(request.message),
				fs: h.fsImpl,
				timers: h.timers,
				platform: "linux",
			});

			const watchedSteerDir = fs.realpathSync.native(steerRequestsDir(asyncDir));
			requestAsyncSteer(asyncDir, { message: "first", id: "s1", ts: 1 });
			h.trigger(watchedSteerDir);
			requestAsyncSteer(asyncDir, { message: "second", id: "s2", ts: 2 });
			h.trigger(watchedSteerDir);

			assert.deepEqual(steers, ["first", "second"]);
			assert.deepEqual(h.intervalDelays(), [5000]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});
});

describe("control channel: watchAsyncSteerInbox", () => {
	type SteerWatchHarness = {
		fsImpl: import("../../src/runs/background/control-channel.ts").ControlChannelFs;
		timers: import("../../src/runs/background/control-channel.ts").ControlChannelTimers;
		trigger: () => void;
		triggerError: () => void;
		closed: () => boolean;
		intervalDelays: () => number[];
		watchedDir: () => string | undefined;
	};

	function steerHarness(): SteerWatchHarness {
		const listeners = new Map<string, () => void>();
		const errorListeners = new Map<string, () => void>();
		let closed = false;
		const intervalDelays: number[] = [];
		let watchedDir: string | undefined;
		const realpathSync = ((target: fs.PathLike, options?: unknown) => fs.realpathSync(target, options as BufferEncoding)) as typeof fs.realpathSync;
		realpathSync.native = ((target: fs.PathLike) => fs.realpathSync.native(target)) as typeof fs.realpathSync.native;
		const fsImpl = {
			mkdirSync: fs.mkdirSync,
			existsSync: fs.existsSync,
			rmSync: fs.rmSync,
			readdirSync: fs.readdirSync,
			readFileSync: fs.readFileSync,
			realpathSync,
			watch: ((dir: string, cb: () => void) => {
				watchedDir = dir;
				listeners.set(dir, cb);
				return {
					close: () => { closed = true; },
					on: (event: string, handler: () => void) => {
						if (event === "error") errorListeners.set(dir, handler);
					},
				};
			}),
		} as unknown as SteerWatchHarness["fsImpl"];
		const timers = {
			setInterval: ((_handler: Parameters<typeof setInterval>[0], delay?: number) => {
				intervalDelays.push(delay ?? 0);
				return { unref() {} };
			}) as unknown as typeof setInterval,
			clearInterval: (() => {}) as unknown as typeof clearInterval,
		};
		return {
			fsImpl,
			timers,
			trigger: () => { for (const listener of listeners.values()) listener(); },
			triggerError: () => { for (const listener of errorListeners.values()) listener(); },
			closed: () => closed,
			intervalDelays: () => [...intervalDelays],
			watchedDir: () => watchedDir,
		};
	}

	it("consumes a steer request that arrived before the watcher started", () => {
		const asyncDir = tmpAsyncDir("pi-steer-watch-early-");
		try {
			requestAsyncSteer(asyncDir, { message: "queued before install", id: "s1", ts: 1 });
			const steers: string[] = [];
			const h = steerHarness();
			const dispose = watchAsyncSteerInbox(asyncDir, { onSteer: (request) => steers.push(request.message), fs: h.fsImpl, timers: h.timers, platform: "linux" });
			assert.deepEqual(steers, ["queued before install"]);
			assert.deepEqual(fs.readdirSync(steerRequestsDir(asyncDir)), []);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("consumes later requests via the watch event and stops after dispose", () => {
		const asyncDir = tmpAsyncDir("pi-steer-watch-event-");
		try {
			const steers: string[] = [];
			const h = steerHarness();
			const dispose = watchAsyncSteerInbox(asyncDir, { onSteer: (request) => steers.push(request.message), fs: h.fsImpl, timers: h.timers, platform: "linux" });
			assert.deepEqual(steers, []);

			requestAsyncSteer(asyncDir, { message: "first", id: "s1", ts: 1 });
			h.trigger();
			assert.deepEqual(steers, ["first"]);

			// A spurious event with nothing queued is a no-op.
			h.trigger();
			assert.deepEqual(steers, ["first"]);

			dispose();
			assert.equal(h.closed(), true);

			requestAsyncSteer(asyncDir, { message: "after dispose", id: "s2", ts: 2 });
			h.trigger();
			assert.deepEqual(steers, ["first"], "a disposed watcher must not consume further requests");
		} finally {
			cleanup(asyncDir);
		}
	});

	it("watches only the steer directory, so a stop request stays for its own consumer", () => {
		const asyncDir = tmpAsyncDir("pi-steer-watch-scope-");
		try {
			requestAsyncStop(asyncDir, { source: "test" });
			const steers: string[] = [];
			const h = steerHarness();
			const dispose = watchAsyncSteerInbox(asyncDir, { onSteer: (request) => steers.push(request.message), fs: h.fsImpl, timers: h.timers, platform: "linux" });
			h.trigger();
			assert.deepEqual(steers, []);
			assert.equal(h.watchedDir(), fs.realpathSync.native(steerRequestsDir(asyncDir)));
			assert.equal(fs.readdirSync(stopRequestsDir(asyncDir)).length, 1, "a stop request must not be consumed by the steer watcher");
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("uses portable polling without native watchers on Darwin", () => {
		const asyncDir = tmpAsyncDir("pi-steer-watch-darwin-");
		try {
			const h = steerHarness();
			const dispose = watchAsyncSteerInbox(asyncDir, { onSteer() {}, fs: h.fsImpl, timers: h.timers, platform: "darwin" });
			assert.equal(h.watchedDir(), undefined);
			assert.deepEqual(h.intervalDelays(), [250]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("starts portable polling once when the native watcher fails", () => {
		const asyncDir = tmpAsyncDir("pi-steer-watch-fallback-");
		try {
			const h = steerHarness();
			const dispose = watchAsyncSteerInbox(asyncDir, { onSteer() {}, fs: h.fsImpl, timers: h.timers, platform: "linux" });
			assert.deepEqual(h.intervalDelays(), [5000], "the native path installs only the safety poll");
			h.triggerError();
			h.triggerError();
			assert.deepEqual(h.intervalDelays(), [5000, 250], "polling starts once, not per error");
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("reports an inbox error that escapes the shared consumer instead of looking idle", () => {
		const asyncDir = tmpAsyncDir("pi-steer-watch-unavailable-");
		try {
			const h = steerHarness();
			let failProbe = true;
			// `consumeSteerRequests` deliberately swallows a readdir failure and retains the requests for
			// the next tick, which its own test asserts. An error that escapes it, though, previously
			// vanished: the watcher caught everything and returned as if the inbox were empty.
			const failingFs = {
				...h.fsImpl,
				existsSync: ((target: fs.PathLike) => {
					if (failProbe) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
					return fs.existsSync(target);
				}) as typeof fs.existsSync,
			} as SteerWatchHarness["fsImpl"];
			const steers: string[] = [];
			const unavailable: string[] = [];
			const dispose = watchAsyncSteerInbox(asyncDir, {
				onSteer: (request) => steers.push(request.message),
				onUnavailable: (error) => unavailable.push(error instanceof Error ? error.message : String(error)),
				fs: failingFs,
				timers: h.timers,
				platform: "linux",
			});

			assert.deepEqual(steers, []);
			assert.deepEqual(unavailable, ["permission denied"], "the caller must be told, not left to assume idle");

			// An unbroken run of failures reports once, not once per tick.
			h.trigger();
			assert.deepEqual(unavailable, ["permission denied"]);

			// Recovery still delivers, and the report re-arms for the next unbroken run of failures.
			failProbe = false;
			requestAsyncSteer(asyncDir, { message: "after recovery", id: "s1", ts: 1 });
			h.trigger();
			assert.deepEqual(steers, ["after recovery"]);
			failProbe = true;
			h.trigger();
			assert.deepEqual(unavailable, ["permission denied", "permission denied"]);
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});

	it("keeps watching when a consumer throws, and does not strand its batch siblings", () => {
		const asyncDir = tmpAsyncDir("pi-steer-watch-throws-");
		try {
			const seen: string[] = [];
			const unavailable: string[] = [];
			const h = steerHarness();
			const dispose = watchAsyncSteerInbox(asyncDir, {
				onSteer: (request) => {
					seen.push(request.message);
					if (request.message === "boom") throw new Error("consumer failed");
				},
				onUnavailable: (error) => unavailable.push(error instanceof Error ? error.message : String(error)),
				fs: h.fsImpl,
				timers: h.timers,
				platform: "linux",
			});

			// Both are consumed off disk in one scan, so a throw on the first must not swallow the second.
			requestAsyncSteer(asyncDir, { message: "boom", id: "s1", ts: 1 });
			requestAsyncSteer(asyncDir, { message: "sibling in same batch", id: "s2", ts: 2 });
			h.trigger();
			assert.deepEqual(seen, ["boom", "sibling in same batch"]);
			assert.deepEqual(unavailable, ["consumer failed"], "a failed delivery must be reported, not silent");

			requestAsyncSteer(asyncDir, { message: "still delivered", id: "s3", ts: 3 });
			h.trigger();
			assert.deepEqual(seen, ["boom", "sibling in same batch", "still delivered"], "a throwing consumer must not kill the watcher");
			dispose();
		} finally {
			cleanup(asyncDir);
		}
	});
});
