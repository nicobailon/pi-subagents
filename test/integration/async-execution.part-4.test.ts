/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import { createEventBus, createTempDir, events, makeAgent, removeTempDir } from "../support/helpers.ts";
import { deliverInterruptRequest, deliverStopRequest } from "../../src/runs/background/control-channel.ts";
import { SUBAGENT_PROCESS_TERMINAL_EVENT } from "../../src/shared/types.ts";
import { waitForSubagents } from "../../src/runs/background/subagent-wait.ts";
import type { AsyncResultPayload, AsyncStatusPayload } from "../support/async-execution-fixture.ts";
import {
	installAsyncExecutionHooks, writeWatchdogSettings, withIsolatedWatchdogSettings,
	childWatchdogStatus, available, isAsyncAvailable, executeAsyncSingle,
	executeAsyncChain, ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, escapeRegExp,
	createRepo, waitForAsyncResultFile, waitForAsyncState, tempDir, mockPi,
	readAsyncPayload, waitForMockPiCall,
} from "../support/async-execution-fixture.ts";

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("coalesces ordinary background status while publishing per-child activity transitions", { timeout: 30_000, skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async (t) => {
		const id = `async-coalescing-${Date.now().toString(36)}`;
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		const reportPath = path.join(tempDir, `${id}-report.json`);
		const factoryPath = path.join(tempDir, `${id}-factory.mjs`);
		// Exercise the detached production runner through its child-session boundary.
		// Only external time and successful filesystem publications are instrumented.
		fs.writeFileSync(factoryPath, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
const statusPath = ${JSON.stringify(statusPath)};
const reportPath = ${JSON.stringify(reportPath)};
const children = [];
const report = { samples: [], transitions: [], terminal: [] };
process.once("exit", () => {
  fs.writeFileSync(reportPath + ".tmp", JSON.stringify(report));
  fs.renameSync(reportPath + ".tmp", reportPath);
});
let writes = 0, bytes = 0, replayed = false, finished = false;
const read = () => JSON.parse(fs.readFileSync(statusPath, "utf8"));
const rename = fs.renameSync;
fs.renameSync = function(source, target) {
  rename.call(this, source, target);
  if (target === statusPath) {
    writes++;
    bytes += fs.statSync(target).size;
    if (replayed && !finished && read().state !== "running") {
      finished = true;
      queueMicrotask(() => {
        report.terminal.push(read());
        mock.timers.tick(100);
        report.terminal.push(read());
        mock.timers.reset();
      });
    }
  }
};
syncBuiltinESMExports();
function replay() {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const emit = (index, event) => children[index].listener(event);
  const stream = () => emit(1, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  const transition = (index, event) => {
    const before = writes;
    emit(index, event);
    report.transitions.push({ writes: writes - before, status: read() });
  };
  const sample = (state) => {
    const beforeWrites = writes, beforeBytes = bytes;
    for (let i = 0; i < 1000; i++) { stream(); mock.timers.tick(10); }
    mock.timers.tick(100);
    report.samples.push({ state, writes: writes - beforeWrites, bytes: bytes - beforeBytes, now: Date.now(), status: read() });
  };
  const start = { type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: "decision", args: { reason: "need_decision", message: "Choose" } };
  const end = { type: "tool_execution_end", toolName: "contact_supervisor", toolCallId: "decision" };
  sample("unset");
  transition(1, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "tool_use" } });
  sample("active_long_running");
  transition(0, start);
  sample("needs_attention");
  transition(1, start); // Aggregate attention is unchanged by either sibling transition.
  transition(1, end);
  transition(0, end);
  const beforePending = writes;
  stream(); // Leave an ordinary update pending when both children fail.
  report.pendingWrites = writes - beforePending;
  replayed = true;
  for (const child of children) child.reject(new Error("scripted terminal failure"));
}
export default function() {
  return {
    async create() {
      const child = {};
      children.push(child);
      return {
        sessionId: "coalescing-" + children.length, sessionFile: undefined, modelId: undefined, messages: [],
        subscribe(listener) { child.listener = listener; return () => {}; },
        prompt() { return new Promise((resolve, reject) => { child.reject = reject; if (children.length === 2 && children.every(c => c.reject)) replay(); }); },
        async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
      };
    },
    async dispose() {},
  };
}
`);
		const reportReady = new Promise<void>((resolve) => {
			// libuv compares expanded event paths against the watched directory (Windows 8.3 aliases differ).
			const watcher = fs.watch(fs.realpathSync.native(tempDir), () => {
				if (fs.existsSync(reportPath)) resolve();
			});
			t.after(() => watcher.close());
		});
		setChildSessionFactoryModule(factoryPath);
		t.after(() => setChildSessionFactoryModule(fileURLToPath(new URL("../support/runner-child-session-factory.ts", import.meta.url))));
		const launched = executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "worker", task: "A" }, { agent: "worker", task: "B" }] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: { enabled: true, needsAttentionAfterMs: 999_999, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"], notifyChannels: ["event", "async"] },
		});
		assert.notEqual(launched.isError, true);
		await reportReady;
		const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
		t.diagnostic(JSON.stringify(report.samples.map(({ state, writes, bytes }: { state: string; writes: number; bytes: number }) => ({ state, writes, bytes }))));
		assert.deepEqual(report.samples.map((sample: { writes: number }) => sample.writes), [100, 100, 100]);
		for (const sample of report.samples) {
			assert.equal(sample.status.lastActivityAt, sample.now - 110);
			assert.equal(sample.status.steps[1].lastActivityAt, sample.now - 110);
		}
		assert.deepEqual(report.transitions.map((entry: { writes: number }) => entry.writes), [1, 1, 1, 1, 1]);
		assert.deepEqual(report.transitions.map((entry: { status: AsyncStatusPayload }) => entry.status.steps?.map(step => step.activityState)), [
			[undefined, "active_long_running"], ["needs_attention", "active_long_running"],
			["needs_attention", "needs_attention"], ["needs_attention", "active_long_running"], [undefined, "active_long_running"],
		]);
		assert.equal(report.samples[2].status.steps[1].turnCount, 1);
		assert.equal(report.transitions[2].status.activityState, "needs_attention");
		assert.equal(report.transitions[3].status.activityState, "needs_attention");
		assert.equal(report.pendingWrites, 0);
		assert.equal(report.terminal[0].state, "failed");
		assert.deepEqual(report.terminal[1], report.terminal[0]);
	});

	for (const mode of ["success", "stop", "pause", "deadline", "failure-before-JSON"] as const) {
		it(`background setup lifecycle: ${mode}`, { skip: !isAsyncAvailable() || process.platform === "win32" ? "requires real POSIX setup executable" : undefined, timeout: 25_000 }, async (t) => {
			const repo = createRepo("pi-background-setup-");
			const baseDir = createTempDir();
			const id = `async-setup-${mode}-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, id);
			const marker = path.join(repo, ".git", "child-launched");
			const allocatorFailure = mode === "failure-before-JSON";
			const oldPath = process.env.PATH;
			const server = createServer();
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const { port } = server.address() as { port: number };
			const hook = path.join(baseDir, allocatorFailure ? "wt" : "setup-hook.cjs");
			fs.writeFileSync(hook, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('wt v0.75.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--create --base --no-cd --no-hooks --format'); process.exit(0); }
if (${allocatorFailure}) require('node:child_process').execFileSync('git', ['branch', args[args.indexOf('--create') + 1]], { cwd: ${JSON.stringify(repo)} });
const socket = require('node:net').connect(${port}, '127.0.0.1', () => socket.write('ready'));
socket.on('data', data => {
 if (data.toString() === 'release') { socket.end(); if (${allocatorFailure}) process.exitCode = 1; else console.log('{}'); }
});
setTimeout(() => process.exit(90), 15000).unref();
`, { mode: 0o755 });
			if (allocatorFailure) process.env.PATH = `${baseDir}${path.delimiter}${oldPath}`;
			const bus = createEventBus();
			let closed = false;
			const terminal = new Promise<unknown>((resolve) => bus.on(SUBAGENT_PROCESS_TERMINAL_EVENT, (proof) => { closed = true; resolve(proof); }));
			let socket: Socket | undefined;
			let started = false;
			try {
				mockPi.onCall({ output: "finite setup completed", writeFiles: [{ path: marker, content: "launched" }] });
				const connection = once(server, "connection", { signal: AbortSignal.timeout(20_000) });
				const receipt = executeAsyncChain(id, {
					chain: [{ agent: "worker", task: "Do work", worktree: true }],
					agents: [makeAgent("worker", { completionGuard: false })],
					ctx: { pi: { events: bus }, cwd: repo, currentSessionId: "session-1" },
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2, acceptance: false,
					...(allocatorFailure ? { worktreeProvider: "worktrunk" } : { worktreeProvider: "native", worktreeBaseDir: path.join(baseDir, "trees"), worktreeSetupHook: hook }),
					...(mode === "deadline" ? { timeoutMs: 4_000 } : {}),
				});
				assert.equal(receipt.isError, undefined, receipt.content[0]?.text);
				started = true;
				[socket] = await Promise.race([connection, terminal.then((proof) => { throw new Error(`Runner closed before setup ready: ${JSON.stringify(proof)}`); })]) as [Socket];
				assert.equal((await once(socket, "data"))[0].toString(), "ready");
				const held = await waitForAsyncState(id, (status) => Boolean(status.parallelHandoff));
				assert.equal(closed, false);
				assert.equal(mockPi.callCount(), 0);
				assert.equal(fs.existsSync(marker), false);
				if (mode === "stop") deliverStopRequest({ asyncDir, source: "test" });
				else if (mode === "pause") deliverInterruptRequest({ asyncDir, source: "test" });
				else if (mode !== "deadline") socket.write("release");
				const payload = await readAsyncPayload(id);
				const proof = await terminal;
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
				const expected = mode === "success" ? "complete" : mode === "stop" ? "stopped" : mode === "pause" ? "paused" : "failed";
				if (payload.state !== expected || status.state !== expected || status.steps?.[0]?.status !== expected) {
					// Failure-only, bounded projections: never print prompts, output, paths or raw stderr.
					const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
					const token = (value: unknown) => typeof value === "string" && /^[a-z_-]{1,64}$/i.test(value) ? value : undefined;
					const errors = (value: unknown) => {
						const text = typeof value === "string" ? value.slice(0, 8192) : "";
						return { present: Boolean(text), kinds: [
							"EPIPE", "ENOENT", "EACCES", "ENOSPC", "ETIMEDOUT", "ABORT_ERR", "ENOBUFS",
							"setup aborted", "setup deadline", "setup settlement unknown", "process tree settlement",
							"empty stdout", "invalid JSON", "hook failed", "manual reconciliation required",
							"not a git repository", "index.lock", "already exists", "Failed to write result",
							"No model", "model not found", "completion", "acceptance",
						].filter((kind) => text.toLowerCase().includes(kind.toLowerCase())), exitCode: text.match(/exit (?:code |status )?(-?\d+)/i)?.[1] };
					};
					const project = (value: unknown) => {
						const item = record(value);
						return { state: token(item.state), status: token(item.status), reason: token(item.reason),
							exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
							success: typeof item.success === "boolean" ? item.success : undefined,
							timedOut: item.timedOut === true, stopped: item.stopped === true, error: errors(item.error) };
					};
					let cleanup: unknown;
					try {
						const handoffPath = held.parallelHandoff?.path;
						if (handoffPath && fs.statSync(handoffPath).size <= 65_536) {
							const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
							cleanup = (handoff.groups ?? []).slice(0, 2).map((group: { cleanup?: { state?: string; pruned?: boolean; tasks?: unknown[]; errors?: string[] } }) => ({
								state: token(group.cleanup?.state), pruned: group.cleanup?.pruned,
								taskCount: group.cleanup?.tasks?.length, errors: group.cleanup?.errors?.slice(0, 4).map(errors),
							}));
						}
					} catch (error) { cleanup = { readError: token(record(error).code) }; }
					t.diagnostic(JSON.stringify({ mode, expected, mockCalls: mockPi.callCount(), markerPresent: fs.existsSync(marker),
						result: project(payload), status: project(status), steps: (status.steps ?? []).slice(0, 2).map(project),
						children: (payload.results ?? []).slice(0, 2).map(project), cleanup, processTerminal: project(proof) }));
				}
				assert.equal(payload.state, expected);
				assert.equal(status.state, expected);
				assert.equal(status.steps[0].status, expected);
				assert.equal(payload.success, mode === "success");
				assert.equal(mockPi.callCount(), mode === "success" ? 1 : 0);
				assert.equal(fs.existsSync(marker), mode === "success");
				assert.ok(held.parallelHandoff?.path);
				const handoff = JSON.parse(fs.readFileSync(held.parallelHandoff.path, "utf8"));
				const group = handoff.groups[0];
				if (allocatorFailure) {
					assert.equal(status.steps[0].worktreePath, undefined);
					assert.equal(status.steps[0].branch, undefined);
					assert.deepEqual(group.cleanup.tasks, []);
					assert.deepEqual(group.children, []);
					assert.equal(group.cleanup.state, "partial");
					assert.equal(group.cleanup.pruned, false);
					assert.match(group.cleanup.errors.join("\n"), /manual reconciliation required/);
					const attempt = group.cleanup.errors.find((entry: string) => entry.startsWith("Allocation attempt "));
					const evidence = JSON.parse(attempt.slice("Allocation attempt ".length));
					assert.equal(evidence.path, null);
					assert.equal(evidence.validated, false);
					assert.equal(evidence.command.status, 1);
					assert.equal(evidence.command.processTree, "unknown");
					assert.equal(execFileSync("git", ["branch", "--list", evidence.branch], { cwd: repo, encoding: "utf8" }).trim(), evidence.branch);
					const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "process-terminal.json"), "utf8"));
					assert.equal(persisted.state, "unknown");
					assert.equal(persisted.reason, "process-tree-unverified");
					assert.deepEqual(proof, persisted, "actual runner close must not promote setup unknown with zero child writers");
					const candidate = JSON.parse(fs.readFileSync(path.join(asyncDir, "process-terminal-candidate.json"), "utf8"));
					assert.deepEqual(Object.values(candidate.writers).flat(), []);
					assert.deepEqual(Object.values(candidate.expectedWriters), [0]);
				} else if (mode === "deadline") {
					assert.equal(payload.timedOut, true);
					assert.equal(status.timedOut, true);
					assert.ok(payload.deadlineAt! <= Date.now());
					assert.equal(group.cleanup.pruned, false);
					assert.equal(group.cleanup.tasks[0].preserved, true);
					assert.equal(fs.existsSync(group.cleanup.tasks[0].path), true);
				} else {
					assert.equal(group.cleanup.state, "complete");
					assert.equal(group.cleanup.tasks.length, 1);
					assert.equal(group.cleanup.tasks[0].worktreeRemoved, true);
					assert.equal(group.cleanup.tasks[0].branchRemoved, true);
					assert.equal(fs.existsSync(group.cleanup.tasks[0].path), false);
					assert.equal(execFileSync("git", ["branch", "--list", group.cleanup.tasks[0].branch], { cwd: repo, encoding: "utf8" }).trim(), "");
				}
			} finally {
				socket?.end("release");
				if (started && !closed) { deliverStopRequest({ asyncDir, source: "test-cleanup" }); await terminal; }
				socket?.destroy();
				await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
				if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
				removeTempDir(baseDir);
				removeTempDir(repo);
			}
		});
	}

	it("does not start child work when initial async status cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-status-write-fail-${Date.now().toString(36)}`;
		fs.mkdirSync(path.join(ASYNC_DIR, id, "status.json"), { recursive: true });
		mockPi.onCall({ output: "must not run" });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do not start",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to persist initial async status/);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns a tool error when an async run uses a missing cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-missing-cwd-${Date.now().toString(36)}`;
		const missingCwd = path.join(tempDir, "missing-cwd");

		const singleResult = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(singleResult.isError, true);
		assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

		const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(chainResult.isError, true);
		assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
	});

	it("returns a tool error when the async runner process cannot spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const originalExecPath = process.execPath;
		const pathKey = process.platform === "win32" ? "Path" : "PATH";
		const originalPath = process.env[pathKey];
		process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
		process.env[pathKey] = tempDir;
		try {
			const id = `async-spawn-fail-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
			assert.match(result.content[0]?.text ?? "", /async runner did not produce a pid/);
		} finally {
			process.execPath = originalExecPath;
			if (originalPath === undefined) {
				delete process.env[pathKey];
			} else {
				process.env[pathKey] = originalPath;
			}
		}
	});

	it("returns a tool error when an async chain cannot write its detached runner config", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-chain-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("background ignores child watchdog status when child watchdogs are not configured", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			const id = `async-watchdog-unconfigured-${Date.now().toString(36)}`;
			const terminalReleasePath = path.join(tempDir, `${id}-release`);
			mockPi.onCall({
				steps: [{ waitForPath: terminalReleasePath, jsonl: [events.assistantMessage("async-done-without-watchdog-config"), childWatchdogStatus(id, "reviewing", 1)] }],
				keepAliveAfterFinalMessageMs: 10000,
			});

			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			await waitForMockPiCall(mockPi, 0);
			// Measure final drain, not detached runner startup; terminal emission is still gated.
			const start = Date.now();
			fs.writeFileSync(terminalReleasePath, "release", "utf-8");
			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const elapsed = Date.now() - start;
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.ok(elapsed < 6000, `unconfigured watchdog status should not delay async final drain, took ${elapsed}ms`);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "async-done-without-watchdog-config");
			assert.equal((payload.results[0] as { watchdog?: unknown }).watchdog, undefined);
		});
	});

	it("background final-drain waits for child watchdog settlement", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			const id = `async-watchdog-drain-${Date.now().toString(36)}`;
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("async-done-before-watchdog"), childWatchdogStatus(id, "reviewing", 1)] },
					{ delay: 1400, jsonl: [childWatchdogStatus(id, "idle", 2)] },
				],
				keepAliveAfterFinalMessageMs: 10000,
			});

			const start = Date.now();
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const elapsed = Date.now() - start;
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.ok(elapsed >= 1200, `watchdog settlement should delay async final drain, took ${elapsed}ms`);
			assert.ok(elapsed < 9000, `settled watchdog should still allow async cleanup, took ${elapsed}ms`);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "async-done-before-watchdog");
			assert.equal((payload.results[0] as { watchdog?: { phase?: string } }).watchdog?.phase, "idle");
		});
	});

	it("background child watchdog tail timeout still finalizes successful output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir, 150);
			const id = `async-watchdog-timeout-${Date.now().toString(36)}`;
			mockPi.onCall({
				jsonl: [events.assistantMessage("async-done-before-watchdog-timeout"), childWatchdogStatus(id, "reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});

			const start = Date.now();
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const elapsed = Date.now() - start;
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.ok(elapsed < 6000, `watchdog tail fallback should not hang async final drain, took ${elapsed}ms`);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "async-done-before-watchdog-timeout");
			const watchdog = (payload.results[0] as { watchdog?: { phase?: string; timedOut?: boolean } }).watchdog;
			assert.equal(watchdog?.phase, "stale");
			assert.equal(watchdog?.timedOut, true);
		});
	});

	it("background runs carry unaddressed child watchdog blockers into the result payload and acceptance", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			const id = `async-watchdog-blocker-${Date.now().toString(36)}`;
			mockPi.onCall({ jsonl: [events.acceptanceReport(), events.watchdogWarning("blocker", "Claims tests passed without running them")] });

			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
				acceptance: { level: "checked", criteria: ["Ship it"] },
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, false);
			const child = payload.results[0] as AsyncResultPayload["results"][number] & { watchdog?: { warnings?: Array<{ severity: string; addressed: boolean; summary: string }> } };
			assert.deepEqual(child.watchdog?.warnings?.map((warning) => [warning.severity, warning.addressed]), [["blocker", false]]);
			const check = child.acceptance?.runtimeChecks?.find((entry) => entry.id === "watchdog-blocker");
			assert.equal(check?.status, "failed");
			assert.match(check?.message ?? "", /Unresolved watchdog blocker/);
		});
	});

	for (const type of ["turn_start", "agent_start", "auto_retry_start"]) {
		it(`background keeps resumed work alive after ${type}`, { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			const id = `async-resumed-${type}-${Date.now().toString(36)}`;
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("before continuation"), { type }] },
					// Queued steering/follow-up work is allowed to outlive the old final-stop grace.
					{ delay: 1400, jsonl: [events.assistantMessage("after continuation")] },
				],
			});
			executeAsyncSingle(id, {
				agent: "worker", task: "Do work", agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2,
			});
			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true, payload.results[0]?.error);
			assert.equal(payload.results[0]?.output, "after continuation");
		});
	}

	it("background ignores stale watchdog completion after resumed work", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			const id = `async-resumed-watchdog-${Date.now().toString(36)}`;
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("before continuation"), { type: "turn_start" }, childWatchdogStatus(id, "idle", 1)] },
					{ delay: 1400, jsonl: [events.assistantMessage("after continuation")] },
				],
			});
			executeAsyncSingle(id, {
				agent: "worker", task: "Do work", agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2,
			});
			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true, payload.results[0]?.error);
			assert.equal(payload.results[0]?.output, "after continuation");
		});
	});

	it("background forced drain after final assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			acceptance: { level: "attested", criteria: ["Finish cleanly"] },
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("reports terminal abort before a missing file-only handoff after mutation", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const partialOutput = "I’ll inspect the retained candidate before changing it.";
		const repo = createRepo("pi-subagents-missing-handoff-partial-");
		const outputPath = path.join(repo, "missing-challenge-report.md");
		mockPi.onCall({
			jsonl: [
				events.assistantMessage(partialOutput),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			writeFiles: [{ path: "input.md", content: "changed by retained child\n" }],
		});

		const task = [
			"You are reviving a previous subagent conversation.",
			"",
			"Original run: source-run",
			"Original agent: worker",
			"Original session file: /tmp/source-session.jsonl",
			"",
			"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child session is still running.",
			"",
			"Follow-up:",
			"Implementation challenge pass 1 for the accepted candidate. Reconsider it and implement any better current-scope change.",
		].join("\n");
		const id = `async-missing-handoff-guard-${Date.now().toString(36)}`;
		try {
			executeAsyncSingle(id, {
				agent: "worker",
				task,
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				output: outputPath,
				outputMode: "file-only",
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const child = payload.results[0];
			const diagnostic = child?.error ?? "";
			assert.equal(payload.success, false);
			assert.equal(payload.state, "partial");
			assert.equal(child?.success, false);
			assert.match(diagnostic, /^Subagent produced no output after terminal assistant stopReason "aborted"\./);
			assert.match(diagnostic, new RegExp(`Required file-only output was not produced: ${escapeRegExp(outputPath)}`));
			assert.doesNotMatch(diagnostic, /completed without making edits/);
			assert.doesNotMatch(child?.modelAttempts?.[0]?.error ?? "", /completed without making edits/);
			assert.equal(child?.effects?.fileMutation?.status, "observed");
			assert.equal(child?.effects?.fileMutation?.attempted, true);
			assert.deepEqual(child?.effects?.fileMutation?.evidence?.changedFiles, ["input.md"]);
			assert.equal(child?.effects?.settlementDiagnostic?.requiredOutput?.missing, true);
			assert.equal(fs.existsSync(outputPath), false);

			const status = await waitForAsyncState(id, (candidate) => candidate.state === "partial");
			assert.equal(status.activityState, "needs_attention");
			assert.equal(status.steps?.[0]?.activityState, "needs_attention");
			assert.equal(status.steps?.[0]?.error, diagnostic);
			const eventsText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8");
			assert.doesNotMatch(eventsText, /completed without making edits/);
		} finally {
			removeTempDir(repo);
		}
	});

	it("preserves terminal empty-output diagnostics after useful child work", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const partialOutput = "I’ll inspect the retained candidate before changing it.";
		const outputPath = path.join(tempDir, "missing-aborted-report.md");
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				events.assistantMessage(partialOutput),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 0,
		});

		const id = `async-aborted-empty-handoff-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved file changes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const child = payload.results[0];
		const diagnostic = child?.error ?? "";
		assert.equal(payload.success, false);
		assert.equal(child?.success, false);
		assert.match(diagnostic, /^Subagent produced no output after terminal assistant stopReason "aborted"\./);
		assert.match(diagnostic, /Required file-only output was not produced/);
		assert.doesNotMatch(diagnostic, /completed without making edits/);
		assert.doesNotMatch(child?.modelAttempts?.[0]?.error ?? "", /completed without making edits/);
		assert.equal(child?.effects?.settlementDiagnostic?.requiredOutput?.missing, true);
		assert.equal(child?.effects?.settlementDiagnostic?.finalTextPresent, true);
		assert.equal(fs.existsSync(outputPath), false);

		const eventsText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8");
		assert.doesNotMatch(eventsText, /completed without making edits/);
	});

	it("reports bounded compaction failure context when file-only output is missing", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const terminalError = `This operation was aborted\n${"x".repeat(12_000)}`;
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				{ type: "compaction_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "error",
						errorMessage: terminalError,
						usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				{ type: "agent_settled" },
			],
			exitCode: 0,
		});

		const id = `async-compaction-file-only-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const outputPath = path.join(tempDir, "missing-oracle-report.md");
		executeAsyncSingle(id, {
			agent: "oracle",
			task: "Write a report",
			agentConfig: makeAgent("oracle"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const child = payload.results[0] as (AsyncResultPayload["results"][number] & Record<string, unknown>) | undefined;
		const diagnostic = child?.error ?? "";
		assert.equal(payload.success, false);
		assert.equal(child?.success, false);
		assert.match(diagnostic, /^This operation was aborted/);
		assert.match(diagnostic, /Compaction-induced child abort could not be resumed safely: retained session unavailable\./);
		assert.match(diagnostic, /failure followed session compaction and agent settlement/);
		assert.match(diagnostic, /Required file-only output was not produced/);
		assert.ok(diagnostic.length <= 8_192);
		assert.equal(fs.existsSync(outputPath), false);
		assert.equal(child?.output, "");
		assert.equal("savedOutputPath" in (child ?? {}), false);
		assert.equal("outputReference" in (child ?? {}), false);
		assert.equal(payload.summary, `oracle:\n${diagnostic}`);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(status.steps?.[0]?.exitCode, 1);
		assert.equal(status.steps?.[0]?.error, diagnostic);
		const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(logPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async run log: ${logPath}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(fs.readFileSync(logPath, "utf-8").includes(`## Summary\noracle:\n${diagnostic}`));
	});

	it("preserves partial imported async roots with mutation evidence", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const sourceId = `partial-source-${Date.now().toString(36)}`;
		const sourceDir = path.join(ASYNC_DIR, sourceId);
		const message = "Required file-only output was not produced: report.md";
		const effects = { fileMutation: { status: "observed", expected: true, attempted: true, evidence: { source: "tracked-files", trackedOnly: true, cwd: tempDir, changedFiles: ["input.md"], attemptedMutation: true } } };
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "status.json"), JSON.stringify({
			runId: sourceId,
			mode: "single",
			state: "partial",
			activityState: "needs_attention",
			startedAt: Date.now(),
			error: message,
			steps: [{ agent: "worker", status: "failed", activityState: "needs_attention", error: message, effects }],
		}), "utf-8");

		const id = `async-imported-partial-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [],
			attachRoot: { runId: sourceId, asyncDir: sourceDir, resultPath: path.join(RESULTS_DIR, `${sourceId}.json`), index: 0, agent: "worker" },
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "partial");
		assert.equal(payload.summary, message);
		assert.equal(payload.results[0]?.execution?.status, "partial");
		assert.deepEqual(payload.results[0]?.effects?.fileMutation?.evidence?.changedFiles, ["input.md"]);

		const status = await waitForAsyncState(id, (candidate) => candidate.state === "partial");
		assert.equal(status.activityState, "needs_attention");
		assert.equal(status.steps?.[0]?.activityState, "needs_attention");
	});

	it("keeps concrete sibling failures above partial mutation evidence", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repo = createRepo("pi-subagents-partial-sibling-failure-");
		const outputPath = path.join(repo, "missing-report.md");
		mockPi.onCall({
			matchArgIncludes: "Write required report",
			jsonl: [
				events.assistantMessage("I changed the file but did not hand off the report."),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			writeFiles: [{ path: "input.md", content: "changed before missing report\n" }],
		});
		mockPi.onCall({ matchArgIncludes: "Fail normally", stderr: "ordinary sibling failure", exitCode: 1 });

		const id = `async-partial-sibling-failure-${Date.now().toString(36)}`;
		try {
			executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "partial", task: "Write required report" },
						{ agent: "failure", task: "Fail normally" },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("partial", { output: outputPath, outputMode: "file-only" }), makeAgent("failure", { completionGuard: false })],
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, false);
			assert.equal(payload.state, "failed");
			assert.match(payload.summary, /ordinary sibling failure/);
			assert.equal(payload.results[0]?.effects?.fileMutation?.status, "observed");
			assert.equal(payload.results[0]?.effects?.settlementDiagnostic?.requiredOutput?.missing, true);
			assert.match(payload.results[1]?.error ?? "", /ordinary sibling failure/);

			const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
			assert.equal(status.activityState, undefined);
			assert.match(status.error ?? "", /ordinary sibling failure/);
		} finally {
			removeTempDir(repo);
		}
	});

	it("background runs emit active-long-running control events from child turns", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "active_long_running" && status.steps?.[0]?.activityState === "active_long_running") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed active_long_running");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		assert.ok(statusDuringEvent, "expected status.json to expose active_long_running while the run is still active");
		assert.equal(statusDuringEvent.activityState, "active_long_running");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("does not flag a delayed active tool as idle attention", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "sleep 2" })] },
				{ delay: 2_500, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "done")] },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});

		const id = `async-delayed-tool-attention-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Run the command",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				activeNoticeAfterMs: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const deadline = Date.now() + 10_000;
		let statusDuringTool: AsyncStatusPayload | undefined;
		while (Date.now() < deadline && !fs.existsSync(resultPath)) {
			if (fs.existsSync(asyncDir) && fs.existsSync(path.join(asyncDir, "status.json"))) {
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
				const toolStartedAt = status.steps?.[0]?.currentToolStartedAt;
				if (status.currentTool === "bash" && status.steps?.[0]?.currentTool === "bash" && toolStartedAt && Date.now() - toolStartedAt >= 1_500) {
					statusDuringTool = status;
					break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(statusDuringTool, "expected status.json to expose the active tool");
		assert.equal(statusDuringTool?.activityState, undefined);
		assert.equal(statusDuringTool?.steps?.[0]?.activityState, undefined);
		const eventText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
		assert.doesNotMatch(eventText, /"type":"needs_attention"/);
		await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
	});

	it("background open-tool attention survives an overlapping quick tool", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "sleep 2" } }] },
				{ delay: 50, jsonl: [
					{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
					{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
				] },
				{ delay: 2_000, jsonl: [
					{ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash" },
					events.toolResult("bash", "done"),
					events.assistantMessage("Done"),
				] },
			],
		});

		const id = `async-overlap-tool-attention-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const statusPath = path.join(asyncDir, "status.json");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Run the command",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterMs: 100,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) eventText = fs.readFileSync(eventsPath, "utf-8");
			if (eventText.includes('"reason":"tool_open_threshold"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_open_threshold"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed overlapping tool attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_open_threshold"/);
		assert.match(eventText, /"currentTool":"bash"/);
		assert.ok(statusDuringEvent, "expected status.json to expose overlapping tool attention while the run is active");
		assert.equal(statusDuringEvent.currentTool, "bash");
		assert.equal(statusDuringEvent.steps?.[0]?.currentTool, "bash");
		await waitForAsyncResultFile(id);
	});

	it("bg_wait wakes when an async child is waiting on contact_supervisor", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-supervisor-attention-${Date.now().toString(36)}`;
		const replyReleasePath = path.join(tempDir, `${id}.reply`);
		const finalReleasePath = path.join(tempDir, `${id}.final`);
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ waitForPath: replyReleasePath, jsonl: [events.toolEnd("contact_supervisor"), events.toolResult("contact_supervisor", "**Reply from supervisor:**\nProceed")] },
				{ waitForPath: finalReleasePath, jsonl: [events.assistantMessage("Done")] },
			],
		});

		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Ask the supervisor for a blocking decision",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterMs: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const releaseMockChild = () => {
			if (!fs.existsSync(replyReleasePath)) fs.writeFileSync(replyReleasePath, "release", "utf-8");
			if (!fs.existsSync(finalReleasePath)) fs.writeFileSync(finalReleasePath, "release", "utf-8");
		};
		const releaseSupervisorReply = () => {
			if (!fs.existsSync(replyReleasePath)) fs.writeFileSync(replyReleasePath, "release", "utf-8");
		};
		try {
			const attentionDeadline = Date.now() + 10_000;
			let statusDuringAttention: AsyncStatusPayload | undefined;
			while (Date.now() < attentionDeadline && !fs.existsSync(resultPath)) {
				if (fs.existsSync(statusPath)) {
					const nextStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
					if (nextStatus.currentTool === "contact_supervisor" && nextStatus.activityState === "needs_attention") {
						statusDuringAttention = nextStatus;
						break;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(statusDuringAttention, "expected status.json to expose the blocking supervisor request");

			try {
				const waitResult = await waitForSubagents({ id, timeoutMs: 3_500 }, undefined, {
					state: { currentSessionId: "session-1", foregroundRuns: new Map(), asyncJobs: new Map(), cleanupTimers: new Map(), resultFileCoalescer: new Map() },
					pollIntervalMs: 100,
					events: createEventBus(),
				});
				const waitText = waitResult.content[0]?.text ?? "";
				assert.equal(waitResult.isError, undefined);
				assert.match(waitText, /attention required/i);
				assert.match(waitText, new RegExp(id));
				assert.match(waitText, /intercom\(\{ action: "pending" \}\)/);
				assert.equal(fs.existsSync(resultPath), false, "wait should return before the child completes");
			} finally {
				releaseSupervisorReply();
			}

			const eventText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
			assert.match(eventText, /"type":"needs_attention"/);
			assert.match(eventText, /"reason":"supervisor_request"/);
			assert.equal(statusDuringAttention.activityState, "needs_attention");
			assert.equal(statusDuringAttention.steps?.[0]?.activityState, "needs_attention");
			assert.equal(statusDuringAttention.currentTool, "contact_supervisor");
			assert.equal(statusDuringAttention.steps?.[0]?.currentTool, "contact_supervisor");

			const clearDeadline = Date.now() + 10_000;
			let statusAfterReply: AsyncStatusPayload | undefined;
			while (Date.now() < clearDeadline && !fs.existsSync(resultPath)) {
				const nextStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (nextStatus.state === "running" && !nextStatus.currentTool && !nextStatus.steps?.[0]?.currentTool) {
					statusAfterReply = nextStatus;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(statusAfterReply, "expected the child to keep running after the supervisor reply");
			assert.equal(statusAfterReply.activityState, undefined);
			assert.equal(statusAfterReply.steps?.[0]?.activityState, undefined);

			fs.writeFileSync(finalReleasePath, "release", "utf-8");
			await waitForAsyncResultFile(id);
		} finally {
			releaseMockChild();
		}
	});

	it("background runs escalate repeated mutating tool failures", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		assert.ok(statusDuringEvent, "expected status.json to expose needs_attention while the run is still active");
		assert.equal(statusDuringEvent.activityState, "needs_attention");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background event logs drop noisy message updates and cap child diagnostics", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const previousMaxBytes = process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
		process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = "1100";
		try {
			mockPi.onCall({
				steps: [
					{
						jsonl: [
							{
								type: "message_update",
								assistantMessageEvent: {
									type: "thinking_delta",
									delta: "NOISY_PARTIAL_DELTA",
									partial: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_SNAPSHOT".repeat(200) }] },
								},
								message: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_MESSAGE".repeat(200) }] },
							},
							events.toolStart("bash", { command: `echo ${"BIG_COMMAND_PAYLOAD".repeat(200)}` }),
							events.assistantMessage("Done after noisy stream"),
						],
					},
				],
			});

			const id = `async-noisy-events-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, id);
			const sessionRoot = path.join(tempDir, "sessions");

			executeAsyncSingle(id, {
				agent: "worker",
				task: "Stream noisy diagnostics",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot,
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "Done after noisy stream");

			const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
			assert.doesNotMatch(eventsText, /"type":"message_update"/);
			assert.doesNotMatch(eventsText, /NOISY_PARTIAL_/);
			assert.doesNotMatch(eventsText, /BIG_COMMAND_PAYLOAD/);
			assert.match(eventsText, /"type":"subagent\.events\.truncated"/);
			assert.match(eventsText, /"droppedEventType":"tool_execution_start"/);
		} finally {
			if (previousMaxBytes === undefined) delete process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
			else process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = previousMaxBytes;
		}
	});

	it("background runs stream child events and live output while active", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});
});
