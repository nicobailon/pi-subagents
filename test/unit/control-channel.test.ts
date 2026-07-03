import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	consumeInterruptRequest,
	consumeSteerRequests,
	deliverInterruptRequest,
	enqueueStepSteer,
	interruptRequestPath,
	requestAsyncInterrupt,
	requestAsyncSteer,
	steerRequestsDir,
	stepSteerInboxDir,
	watchAsyncControlInbox,
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
			requestAsyncSteer(asyncDir, { message: "  later guidance  ", targetIndex: 1, id: "b", ts: 200, source: "test" });
			requestAsyncSteer(asyncDir, { message: "first guidance", id: "a", ts: 100 });
			assert.equal(fs.readdirSync(steerRequestsDir(asyncDir)).length, 2);

			assert.deepEqual(consumeSteerRequests(asyncDir), [
				{ type: "steer", id: "a", ts: 100, message: "first guidance" },
				{ type: "steer", id: "b", ts: 200, message: "later guidance", targetIndex: 1, source: "test" },
			]);
			assert.deepEqual(consumeSteerRequests(asyncDir), []);
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

	it("enqueues a steer request for a specific child inbox", () => {
		const asyncDir = tmpAsyncDir("pi-control-step-steer-");
		try {
			enqueueStepSteer(asyncDir, 2, { type: "steer", id: "s1", ts: 300, message: "focus", targetIndex: 0 });
			const request = JSON.parse(fs.readFileSync(path.join(stepSteerInboxDir(asyncDir, 2), fs.readdirSync(stepSteerInboxDir(asyncDir, 2))[0]!), "utf-8"));
			assert.equal(request.targetIndex, 2);
			assert.equal(request.message, "focus");
		} finally {
			cleanup(asyncDir);
		}
	});

	it("rejects empty steer messages and invalid target indexes", () => {
		const asyncDir = tmpAsyncDir("pi-control-steer-invalid-");
		try {
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "   " }), /steer message must not be empty/);
			assert.throws(() => requestAsyncSteer(asyncDir, { message: "ok", targetIndex: -1 }), /targetIndex/);
		} finally {
			cleanup(asyncDir);
		}
	});
});

describe("control channel: deliverInterruptRequest", () => {
	it("writes the portable request and signals best-effort when kill succeeds", () => {
		const asyncDir = tmpAsyncDir("pi-control-deliver-ok-");
		try {
			const kills: Array<{ pid: number; signal?: NodeJS.Signals | 0 }> = [];
			deliverInterruptRequest({
				asyncDir,
				pid: 4242,
				signal: "SIGUSR2",
				kill: (pid, signal) => {
					kills.push({ pid, signal });
					return true;
				},
			});
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
			assert.deepEqual(kills, [{ pid: 4242, signal: "SIGUSR2" }]);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("still writes the request when the OS signal throws ENOSYS (Windows)", () => {
		const asyncDir = tmpAsyncDir("pi-control-deliver-enosys-");
		try {
			assert.doesNotThrow(() =>
				deliverInterruptRequest({
					asyncDir,
					pid: 4242,
					kill: () => {
						const error = new Error("kill ENOSYS") as NodeJS.ErrnoException;
						error.code = "ENOSYS";
						throw error;
					},
				}),
			);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("surfaces non-portability signal failures and removes the stale request", () => {
		const asyncDir = tmpAsyncDir("pi-control-deliver-esrch-");
		try {
			assert.throws(
				() =>
					deliverInterruptRequest({
						asyncDir,
						pid: 4242,
						kill: () => {
							const error = new Error("missing process") as NodeJS.ErrnoException;
							error.code = "ESRCH";
							throw error;
						},
					}),
				/missing process/,
			);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), false);
		} finally {
			cleanup(asyncDir);
		}
	});

	it("skips signalling when no live pid is provided", () => {
		const asyncDir = tmpAsyncDir("pi-control-deliver-nopid-");
		try {
			let killed = false;
			deliverInterruptRequest({ asyncDir, kill: () => { killed = true; return true; } });
			assert.equal(killed, false);
			assert.equal(fs.existsSync(interruptRequestPath(asyncDir)), true);
		} finally {
			cleanup(asyncDir);
		}
	});
});

describe("control channel: watchAsyncControlInbox", () => {
	type WatchHarness = {
		fsImpl: import("../../src/runs/background/control-channel.ts").ControlChannelFs;
		timers: import("../../src/runs/background/control-channel.ts").ControlChannelTimers;
		trigger: () => void;
		closed: () => boolean;
	};

	function harness(): WatchHarness {
		let listener: (() => void) | undefined;
		let closed = false;
		const fsImpl = {
			mkdirSync: fs.mkdirSync,
			existsSync: fs.existsSync,
			rmSync: fs.rmSync,
			readdirSync: fs.readdirSync,
			readFileSync: fs.readFileSync,
			watch: ((_dir: string, cb: () => void) => {
				listener = cb;
				return { close: () => { closed = true; }, on: () => {} };
			}),
		} as unknown as WatchHarness["fsImpl"];
		const timers = {
			setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
			clearInterval: (() => {}) as unknown as typeof clearInterval,
		};
		return { fsImpl, timers, trigger: () => listener?.(), closed: () => closed };
	}

	it("fires on a request that arrived before the watcher started", () => {
		const asyncDir = tmpAsyncDir("pi-control-watch-early-");
		try {
			requestAsyncInterrupt(asyncDir);
			let fired = 0;
			const h = harness();
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt: () => fired++, fs: h.fsImpl, timers: h.timers });
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
			const dispose = watchAsyncControlInbox(asyncDir, { onInterrupt: () => fired++, fs: h.fsImpl, timers: h.timers });
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
});
