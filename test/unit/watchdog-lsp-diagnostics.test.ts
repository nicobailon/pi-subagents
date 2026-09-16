import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
	WatchdogLspDiagnosticsLedger,
	collectWatchdogLspDiagnostics,
	formatWatchdogLspDiagnosticsBlock,
	watchdogWarningFromLspDiagnostics,
} from "../../src/watchdog/lsp-diagnostics.ts";
import type { WatchdogLspResult } from "../../src/watchdog/types.ts";

function result(diagnostics: WatchdogLspResult["diagnostics"]): WatchdogLspResult {
	return {
		status: "ok",
		provider: "stub-lsp",
		checkedPaths: ["src/file.ts"],
		skippedPaths: [],
		diagnostics,
	};
}

describe("watchdog LSP diagnostics", () => {
	it("formats diagnostics for watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "error",
			source: "typescript",
			code: "TS2322",
			message: "Type mismatch.",
		}]));

		assert.match(block, /^LSP diagnostics:/);
		assert.match(block, /src\/file\.ts:2:3 error TS2322 typescript: Type mismatch\./);
	});

	it("omits info and hints from watchdog review input", () => {
		const block = formatWatchdogLspDiagnosticsBlock(result([{
			path: "src/file.ts",
			line: 2,
			column: 3,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}, {
			path: "src/file.ts",
			line: 3,
			column: 4,
			severity: "hint",
			source: "typescript",
			message: "Suggestion.",
		}]));

		assert.equal(block, "");
	});

	it("maps errors to blockers and warnings to concerns", () => {
		const blocker = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "error",
			source: "typescript",
			message: "Cannot find name 'x'.",
		}]));
		assert.equal(blocker?.severity, "blocker");
		assert.equal(blocker?.source, "lsp");

		const concern = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning",
			source: "typescript",
			message: "Unused value.",
		}]));
		assert.equal(concern?.severity, "concern");

		const info = watchdogWarningFromLspDiagnostics(result([{
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "info",
			source: "typescript",
			message: "Helpful note.",
		}]));
		assert.equal(info, undefined);
	});

	for (const delivery of ["complete", "split", "late"] as const) {
		it(`classifies ${delivery} malformed language-server JSON against the 500ms deadline`, async (t) => {
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-watchdog-lsp-"));
			const originalSpawn = childProcess.spawn;
			const originalSetTimeout = globalThis.setTimeout;
			const originalClearTimeout = globalThis.clearTimeout;
			const originalNow = Date.now;
			const child = Object.assign(new EventEmitter(), {
				stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
				kill: (signal: string) => { kills.push(signal); return true; },
			});
			const kills: string[] = [];
			const requests: string[] = [];
			const timers = new Map<object, { callback: () => void; delay: number }>();
			const signal = new AbortController().signal;
			let now = 0;
			let settled = false;
			// One event-loop turn drains promise reactions without advancing the controlled clock.
			const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
			try {
				const binDir = path.join(temp, "node_modules", ".bin");
				fs.mkdirSync(path.join(temp, "src"), { recursive: true });
				fs.mkdirSync(binDir, { recursive: true });
				fs.writeFileSync(path.join(temp, "src", "file.ts"), "export const value = 1;\n", "utf-8");
				const commandPath = path.join(binDir, process.platform === "win32"
					? "typescript-language-server.cmd" : "typescript-language-server");
				// Discovery still checks a real platform-appropriate executable; spawn must intercept it.
				fs.writeFileSync(commandPath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
				t.mock.method(childProcess, "spawn", (command, args, options) => {
					assert.equal(command, commandPath);
					assert.deepEqual(args, ["--stdio"]);
					assert.equal(options.cwd, temp);
					assert.equal(options.stdio, "pipe");
					assert.equal(options.shell, process.platform === "win32");
					return child;
				});
				syncBuiltinESMExports();
				t.mock.method(Date, "now", () => now);
				// These paths use only callback/delay and opaque clearTimeout handles, not unref.
				t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
					const handle = {};
					timers.set(handle, { callback, delay });
					return handle;
				});
				t.mock.method(globalThis, "clearTimeout", (handle: object) => { timers.delete(handle); });
				child.stdin.on("data", (chunk: Buffer) => {
					const frame = chunk.toString("utf-8");
					const [header, body] = frame.split("\r\n\r\n");
					assert.equal(header, `Content-Length: ${Buffer.byteLength(body)}`);
					requests.push(JSON.parse(body).method);
				});
				const pending = collectWatchdogLspDiagnostics({
					cwd: temp, root: temp, changedPaths: ["src/file.ts"], signal,
					config: { enabled: true, timeoutMs: 500, maxFiles: 10, maxDiagnostics: 10 },
				});
				void pending.then(() => { settled = true; });
				assert.deepEqual(requests, ["initialize"]);
				assert.deepEqual([...timers.values()].map((timer) => timer.delay), [500]);
				if (delivery === "split") child.stdout.write("Content-Length: 8\r\n\r\nnot-");
				now = 499;
				await drain();
				assert.equal(settled, false);
				assert.deepEqual(kills, []);
				assert.equal(timers.size, 1);
				if (delivery === "late") {
					now = 500;
					const [handle, timer] = [...timers][0];
					timers.delete(handle);
					timer.callback();
					await drain();
					assert.deepEqual(requests, ["initialize", "shutdown"]);
					assert.equal(settled, false, "collector still awaits shutdown");
					assert.deepEqual(kills, []);
				}
				child.stdout.write(delivery === "split" ? "json" : "Content-Length: 8\r\n\r\nnot-json");
				await drain();
				assert.ok(kills.includes("SIGTERM"), "protocol failure requests termination");
				assert.equal(settled, false, "kill request alone is not process exit");
				assert.deepEqual([...timers.values()].map((timer) => timer.delay), [250]);
				// SIGTERM completes asynchronously. Exit rejects pending RPCs and clears the exit wait.
				child.emit("exit", null, "SIGTERM");
				const diagnostics = await pending;
				if (delivery === "late") {
					assert.equal(diagnostics.status, "timeout");
					assert.match(diagnostics.message ?? "", /initialize timed out/);
				} else {
					assert.equal(diagnostics.status, "failed");
					assert.match(diagnostics.message ?? "", /Invalid LSP JSON-RPC response/);
					assert.deepEqual(requests, ["initialize"]);
				}
				const snapshot = structuredClone(diagnostics);
				child.stdout.write("Content-Length: 8\r\n\r\nnot-json");
				child.stdin.end();
				child.stdout.end();
				child.stderr.end();
				await drain();
				child.emit("close", null, "SIGTERM");
				assert.deepEqual(diagnostics, snapshot, "late input cannot change the result");
				assert.equal(timers.size, 0);
				assert.equal(getEventListeners(signal, "abort").length, 0);
				assert.equal((childProcess.spawn as typeof childProcess.spawn & { mock: { callCount(): number } }).mock.callCount(), 1);
			} finally {
				t.mock.restoreAll();
				syncBuiltinESMExports();
				assert.equal(childProcess.spawn, originalSpawn);
				assert.equal(spawn, originalSpawn);
				assert.equal(globalThis.setTimeout, originalSetTimeout);
				assert.equal(globalThis.clearTimeout, originalClearTimeout);
				assert.equal(Date.now, originalNow);
				timers.clear();
				// Production retains listeners on its private child; dispose only these test-owned objects.
				for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
					emitter.removeAllListeners();
					assert.deepEqual(emitter.eventNames(), []);
				}
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
				fs.rmSync(temp, { recursive: true, force: true });
			}
		});
	}

	it("suppresses repeated diagnostic identities until the file clears", () => {
		const ledger = new WatchdogLspDiagnosticsLedger();
		const diagnostic = {
			path: "src/file.ts",
			line: 1,
			column: 1,
			severity: "warning" as const,
			source: "typescript",
			code: "TS6133",
			message: "Unused value.",
		};

		assert.equal(ledger.reduce(result([diagnostic])).diagnostics.length, 1);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 4, column: 9 }])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([])).diagnostics.length, 0);
		assert.equal(ledger.reduce(result([{ ...diagnostic, line: 8 }])).diagnostics.length, 1);
	});
});
