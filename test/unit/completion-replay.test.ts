import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanupCompletionReplay, completionArchivePath, completionReplayPath, readCompletionArchive, readCompletionReplay, writeCompletionReplay, writeCompletionArchive } from "../../src/runs/background/completion-replay.ts";
import { utf8Tail } from "../../src/shared/utf8.ts";
import { collectWaitCompletions, recordWaitCompletion } from "../../src/runs/background/wait-completions.ts";
import { writeAsyncResultFile } from "../../src/runs/background/result-files.ts";
import type { AsyncRunSummary } from "../../src/runs/background/async-status.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const require = createRequire(import.meta.url);
const fsCjs = require("node:fs") as typeof fs;

function makeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: "session-a",
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

describe("completion replay", () => {
	it("surfaces a consumed completion after in-memory watcher state is lost", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-replay-"));
		try {
			const now = Date.now();
			recordWaitCompletion(makeState(), "run-a", {
				agent: "worker",
				mode: "single",
				state: "complete",
				success: true,
				results: [{ agent: "worker", success: true, outputState: "present", output: "finished output", contextOverflow: true }],
			}, now, 60_000, { resultsDir, sessionId: "session-a" });

			const replay = readCompletionReplay(resultsDir, "run-a", { sessionId: "session-a", now: now + 1 });
			assert.equal(replay?.version, 1);
			assert.equal(replay?.completion.archivePath, replay?.archivePath);
			assert.deepEqual(readCompletionArchive(replay!.archivePath)?.entries[0], {
				agent: "worker",
				resultIndex: 0,
				source: "result-tail",
				text: "finished output",
			});

			const terminal = [{ id: "run-a", sessionId: "session-a" }] as AsyncRunSummary[];
			const completions = collectWaitCompletions(terminal, makeState(), resultsDir);
			assert.equal(completions?.[0]?.runId, "run-a");
			assert.equal(completions?.[0]?.results?.[0]?.agent, "worker");
			assert.equal(completions?.[0]?.results?.[0]?.contextOverflow, true);
			assert.equal(completions?.[0]?.archivePath, replay?.archivePath);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("surfaces pending completions when the direct session index is temporarily inaccessible", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-index-denied-"));
		const originalReadFileSync = fsCjs.readFileSync;
		try {
			const publicPath = path.join(resultsDir, "run-pending.json");
			fs.mkdirSync(publicPath, { recursive: true });
			writeAsyncResultFile(publicPath, {
				id: "run-pending",
				runId: "run-pending",
				sessionId: "session-a",
				agent: "worker",
				success: true,
				results: [{ agent: "worker", success: true, outputState: "present" }],
			});
			fsCjs.readFileSync = ((file, ...args) => {
				if (String(file).includes(`${path.sep}result-index${path.sep}`)) {
					const error = new Error("permission denied") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return originalReadFileSync(file, ...args);
			}) as typeof fsCjs.readFileSync;
			syncBuiltinESMExports();

			const terminal = [{ id: "run-pending", sessionId: "session-a" }] as AsyncRunSummary[];
			const completions = collectWaitCompletions(terminal, makeState(), resultsDir);
			assert.equal(completions?.[0]?.runId, "run-pending");
			assert.equal(completions?.[0]?.results?.[0]?.agent, "worker");
		} finally {
			fsCjs.readFileSync = originalReadFileSync;
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("surfaces malformed pending payload errors when the direct session index is inaccessible", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-index-denied-malformed-"));
		const originalReadFileSync = fsCjs.readFileSync;
		try {
			const publicPath = path.join(resultsDir, "run-pending.json");
			fs.mkdirSync(publicPath, { recursive: true });
			writeAsyncResultFile(publicPath, {
				id: "run-pending",
				runId: "run-pending",
				sessionId: "session-a",
				success: true,
			});
			fs.rmSync(publicPath, { recursive: true, force: true });
			const pendingDir = path.join(resultsDir, "result-pending", encodeURIComponent("session-a"));
			fs.writeFileSync(path.join(pendingDir, "run-pending.json"), "{", "utf-8");
			fsCjs.readFileSync = ((file, ...args) => {
				if (String(file).includes(`${path.sep}result-index${path.sep}`)) {
					const error = new Error("permission denied") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return originalReadFileSync(file, ...args);
			}) as typeof fsCjs.readFileSync;
			syncBuiltinESMExports();

			const terminal = [{ id: "run-pending", sessionId: "session-a" }] as AsyncRunSummary[];
			assert.throws(() => collectWaitCompletions(terminal, makeState(), resultsDir), /Failed to read/);
		} finally {
			fsCjs.readFileSync = originalReadFileSync;
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("keeps UTF-8 tails valid at multibyte boundaries", () => {
		const bounded = utf8Tail(`start-${"é".repeat(10)}-tail`, 9);
		assert.equal(bounded.truncated, true);
		assert.equal(bounded.text, "éé-tail");
	});

	it("does not delete untrusted or cross-run archive paths from replay records", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-replay-untrusted-"));
		try {
			const resultsDir = path.join(root, "results");
			const replayDir = path.join(resultsDir, "completion-replay");
			fs.mkdirSync(replayDir, { recursive: true });
			const victim = path.join(root, "victim.txt");
			fs.writeFileSync(victim, "keep", "utf-8");
			fs.writeFileSync(path.join(replayDir, `${encodeURIComponent("run-c")}.json`), JSON.stringify({
				version: 1,
				runId: "run-c",
				sessionId: "session-a",
				completedAt: 1,
				expiresAt: 2,
				archivePath: victim,
				completion: { runId: "run-c", archivePath: victim },
			}), "utf-8");

			const replayPath = path.join(replayDir, `${encodeURIComponent("run-c")}.json`);
			assert.equal(readCompletionReplay(resultsDir, "run-c", { sessionId: "session-a", now: 1 }), undefined);
			assert.equal(fs.readFileSync(victim, "utf-8"), "keep");
			assert.equal(fs.existsSync(replayPath), false);

			fs.writeFileSync(replayPath, JSON.stringify({
				version: 1,
				runId: "run-c",
				sessionId: "session-a",
				completedAt: 1,
				expiresAt: 2,
				archivePath: victim,
				completion: { runId: "run-c", archivePath: victim },
			}), "utf-8");
			cleanupCompletionReplay(resultsDir, 3, 60_000);
			assert.equal(fs.readFileSync(victim, "utf-8"), "keep");
			assert.equal(fs.existsSync(replayPath), false);

			const victimArchive = completionArchivePath(resultsDir, "run-a");
			fs.mkdirSync(path.dirname(victimArchive), { recursive: true });
			fs.writeFileSync(victimArchive, "keep", "utf-8");
			fs.writeFileSync(replayPath, JSON.stringify({
				version: 1,
				runId: "run-a",
				sessionId: "session-a",
				completedAt: 1,
				expiresAt: 2,
				archivePath: victimArchive,
				completion: { runId: "run-a", archivePath: victimArchive },
			}), "utf-8");
			cleanupCompletionReplay(resultsDir, 3, 60_000);
			assert.equal(fs.readFileSync(victimArchive, "utf-8"), "keep");
			assert.equal(fs.existsSync(replayPath), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats replay read deletion failures as best-effort cleanup", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-replay-rm-failure-"));
		const originalRmSync = fsCjs.rmSync;
		try {
			const resultsDir = path.join(root, "results");
			const replayDir = path.join(resultsDir, "completion-replay");
			const replayPath = path.join(replayDir, `${encodeURIComponent("run-d")}.json`);
			const archivePath = completionArchivePath(resultsDir, "run-d");
			fs.mkdirSync(replayDir, { recursive: true });
			fs.mkdirSync(path.dirname(archivePath), { recursive: true });
			fs.writeFileSync(archivePath, "archive", "utf-8");
			fs.writeFileSync(replayPath, JSON.stringify({
				version: 1,
				runId: "run-d",
				sessionId: "session-a",
				completedAt: 1,
				expiresAt: 2,
				archivePath,
				completion: { runId: "run-d", archivePath },
			}), "utf-8");

			fsCjs.rmSync = ((target: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
				if (String(target) === replayPath || String(target) === archivePath) {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return originalRmSync(target, options);
			}) as typeof fs.rmSync;
			syncBuiltinESMExports();

			assert.equal(readCompletionReplay(resultsDir, "run-d", { sessionId: "session-a", now: 3 }), undefined);
			assert.equal(fs.existsSync(replayPath), true);
			assert.equal(fs.existsSync(archivePath), true);
		} finally {
			fsCjs.rmSync = originalRmSync;
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("throttles cleanup while writing completion replay records", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-replay-throttle-"));
		const originalReaddirSync = fsCjs.readdirSync;
		let cleanupScans = 0;
		try {
			fsCjs.readdirSync = ((target: Parameters<typeof fs.readdirSync>[0], options?: Parameters<typeof fs.readdirSync>[1]) => {
				if (String(target).includes(`${path.sep}completion-replay`)) cleanupScans += 1;
				return originalReaddirSync(target, options as never);
			}) as typeof fs.readdirSync;
			syncBuiltinESMExports();

			writeCompletionReplay({
				resultsDir: root,
				runId: "run-a",
				sessionId: "session-a",
				completion: { runId: "run-a" },
				data: { summary: "done" },
				now: 10_000,
				ttlMs: 60_000,
			});
			writeCompletionReplay({
				resultsDir: root,
				runId: "run-b",
				sessionId: "session-a",
				completion: { runId: "run-b" },
				data: { summary: "done" },
				now: 10_001,
				ttlMs: 60_000,
			});

			assert.equal(cleanupScans, 1);
			assert.equal(fs.existsSync(completionReplayPath(root, "run-a")), true);
			assert.equal(fs.existsSync(completionReplayPath(root, "run-b")), true);
		} finally {
			fsCjs.readdirSync = originalReaddirSync;
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers saved outputs and bounds fallback output tails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-archive-"));
		try {
			const savedOutput = path.join(root, "saved-output.md");
			fs.writeFileSync(savedOutput, "saved", "utf-8");
			const archivePath = writeCompletionArchive(root, "run-b", {
				results: [
					{ agent: "saved", output: "duplicate text", artifactPaths: { outputPath: savedOutput } },
					{ agent: "fallback", output: `start-${"x".repeat(70 * 1024)}-tail` },
				],
			}, Date.now());
			const archive = readCompletionArchive(archivePath);
			assert.deepEqual(archive?.entries[0], { agent: "saved", resultIndex: 0, source: "output-artifact", path: savedOutput });
			const fallback = archive?.entries[1];
			assert.equal(fallback?.source, "result-tail");
			assert.equal(fallback?.agent, "fallback");
			assert.equal(fallback?.resultIndex, 1);
			assert.equal(fallback?.truncated, true);
			assert.ok(Buffer.byteLength(fallback?.text ?? "", "utf-8") <= 64 * 1024);
			assert.match(fallback?.text ?? "", /-tail$/);
			assert.equal((fallback?.text ?? "").includes("duplicate text"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
