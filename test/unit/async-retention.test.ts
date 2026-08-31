import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { ASYNC_RETENTION_BATCH_SIZE, cleanupAsyncRetention } from "../../src/runs/background/async-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 16);
const OLD = NOW - 31 * DAY_MS;

function makeRoots(): { root: string; asyncDirRoot: string; resultsDir: string; waitsDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-retention-"));
	const asyncDirRoot = path.join(root, "async-subagent-runs");
	const resultsDir = path.join(root, "async-subagent-results");
	const waitsDir = path.join(root, "wait-subscriptions");
	fs.mkdirSync(asyncDirRoot);
	fs.mkdirSync(resultsDir);
	fs.mkdirSync(waitsDir);
	return { root, asyncDirRoot, resultsDir, waitsDir };
}

function writeOldRun(asyncDirRoot: string, runId: string, overrides: Record<string, unknown> = {}): string {
	const runDir = path.join(asyncDirRoot, runId);
	fs.mkdirSync(runDir, { recursive: true });
	const status = {
		runId,
		state: "complete",
		mode: "single",
		startedAt: OLD - 1_000,
		endedAt: OLD,
		steps: [{ agent: "worker", status: "complete" }],
		...overrides,
	};
	const statusPath = path.join(runDir, "status.json");
	fs.writeFileSync(statusPath, JSON.stringify(status));
	fs.utimesSync(statusPath, OLD / 1000, OLD / 1000);
	fs.utimesSync(runDir, OLD / 1000, OLD / 1000);
	return runDir;
}

function writeOldResult(resultsDir: string, runId: string, overrides: Record<string, unknown> = {}): string {
	const resultPath = path.join(resultsDir, `${runId}.json`);
	fs.writeFileSync(resultPath, JSON.stringify({ runId, sessionId: "session-a", success: true, state: "complete", endedAt: OLD, ...overrides }));
	fs.utimesSync(resultPath, OLD / 1000, OLD / 1000);
	return resultPath;
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function cleanupOptions(roots: ReturnType<typeof makeRoots>) {
	return {
		...roots,
		now: () => NOW,
		randomId: () => "fixed-tombstone",
	};
}

function writeRunTombstoneMarker(roots: ReturnType<typeof makeRoots>, runId: string, tombstonePath: string): string {
	const markerDir = path.join(roots.root, "async-retention-run-tombstones");
	fs.mkdirSync(markerDir, { recursive: true });
	const markerPath = path.join(markerDir, `${encodeURIComponent(runId)}.json`);
	fs.writeFileSync(markerPath, JSON.stringify({ version: 1, runId, tombstonePath, createdAt: OLD }));
	return markerPath;
}

describe("async retention cleanup", () => {
	it("repairs bounded dead running candidates before retention classification", async () => {
		const roots = makeRoots();
		try {
			const runDir = writeOldRun(roots.asyncDirRoot, "dead-running", {
				state: "running",
				endedAt: undefined,
				lastUpdate: OLD,
				pid: 12345,
				sessionId: "session-a",
				steps: [{ agent: "worker", status: "running" }],
			});
			fs.mkdirSync(path.join(roots.asyncDirRoot, ".active-runs"));
			fs.writeFileSync(path.join(roots.asyncDirRoot, ".active-runs", "dead-running"), "");
			const protectedDir = writeOldRun(roots.asyncDirRoot, "protected-running", {
				state: "running",
				endedAt: undefined,
				lastUpdate: OLD,
				pid: 12346,
				steps: [{ agent: "worker", status: "running" }],
			});

			const repaired = await cleanupAsyncRetention({
				...cleanupOptions(roots),
				protectedRunIds: ["protected-running"],
				reconcileKill: () => { throw errno("ESRCH"); },
			});

			assert.equal(repaired.repairedRuns, 1);
			assert.equal(repaired.deletedRuns, 0);
			assert.equal(repaired.skipped.recent, 1);
			const repairedStatusPath = path.join(runDir, "status.json");
			assert.equal(JSON.parse(fs.readFileSync(repairedStatusPath, "utf-8")).state, "failed");
			fs.utimesSync(repairedStatusPath, NOW / 1000, NOW / 1000);
			fs.utimesSync(runDir, NOW / 1000, NOW / 1000);
			assert.equal(fs.existsSync(path.join(roots.asyncDirRoot, ".active-runs", "dead-running")), false);
			assert.equal(fs.existsSync(path.join(roots.resultsDir, "dead-running.json")), true);
			assert.equal(JSON.parse(fs.readFileSync(path.join(protectedDir, "status.json"), "utf-8")).state, "running");
			assert.equal(repaired.skipped["runtime-reference"], 1);

			const retained = await cleanupAsyncRetention({
				...cleanupOptions(roots),
				now: () => NOW + 45 * DAY_MS,
			});
			assert.equal(retained.deletedRuns, 1);
			assert.equal(fs.existsSync(runDir), false);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("deletes old proven-terminal runs and orphan results through tombstones", async () => {
		const roots = makeRoots();
		try {
			const runDir = writeOldRun(roots.asyncDirRoot, "old-run");
			const topLevelRoute = writeOldRun(roots.asyncDirRoot, "top-level-route", { isNested: false });
			const nonResumableDir = writeOldRun(roots.asyncDirRoot, "missing-session");
			const descriptorPath = path.join(nonResumableDir, "recovery-descriptor.json");
			fs.writeFileSync(descriptorPath, JSON.stringify({ sourceRunId: "missing-session", sessionFile: path.join(roots.root, "missing.jsonl") }));
			fs.utimesSync(descriptorPath, OLD / 1000, OLD / 1000);
			fs.utimesSync(nonResumableDir, OLD / 1000, OLD / 1000);
			const resolvedHandoffDir = writeOldRun(roots.asyncDirRoot, "resolved-handoff");
			const handoffPath = path.join(resolvedHandoffDir, "handoff.json");
			fs.writeFileSync(handoffPath, JSON.stringify({ version: 1, groups: [{ cleanup: { state: "complete" } }] }));
			fs.utimesSync(handoffPath, OLD / 1000, OLD / 1000);
			fs.utimesSync(resolvedHandoffDir, OLD / 1000, OLD / 1000);
			const resultPath = writeOldResult(roots.resultsDir, "orphan-result");

			const result = await cleanupAsyncRetention(cleanupOptions(roots));

			assert.equal(result.acquired, true);
			assert.equal(result.deletedRuns, 4);
			assert.equal(result.deletedResults, 1);
			assert.equal(fs.existsSync(runDir), false);
			assert.equal(fs.existsSync(topLevelRoute), false);
			assert.equal(fs.existsSync(nonResumableDir), false);
			assert.equal(fs.existsSync(resolvedHandoffDir), false);
			assert.equal(fs.existsSync(resultPath), false);
			assert.equal(fs.readdirSync(roots.asyncDirRoot).some((name) => name.startsWith(".deleting-run-")), false);
			assert.equal(fs.readdirSync(roots.resultsDir).some((name) => name.startsWith(".deleting-result-")), false);
			const log = fs.readFileSync(path.join(roots.root, "async-retention-maintenance.jsonl"), "utf-8").trim();
			const record = JSON.parse(log) as { deletedRuns: number; deletedResults: number; deleted: string[]; rawReads: number; sourceExhausted: Record<string, boolean>; durationMs: number };
			assert.deepEqual({ deletedRuns: record.deletedRuns, deletedResults: record.deletedResults }, { deletedRuns: 4, deletedResults: 1 });
			assert.deepEqual(record.deleted.sort(), ["result:orphan-result", "run:missing-session", "run:old-run", "run:resolved-handoff", "run:top-level-route"]);
			assert.ok(record.rawReads > 0);
			assert.equal(typeof record.sourceExhausted.runs, "boolean");
			assert.equal(typeof record.durationMs, "number");
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("fails closed for live, recent, resumable, wait, mission, workflow, handoff, and runtime references", async () => {
		const roots = makeRoots();
		try {
			writeOldRun(roots.asyncDirRoot, "active", { state: "running" });
			fs.mkdirSync(path.join(roots.asyncDirRoot, ".active-runs"));
			fs.writeFileSync(path.join(roots.asyncDirRoot, ".active-runs", "active"), "");
			writeOldRun(roots.asyncDirRoot, "paused", { state: "paused" });
			const recent = writeOldRun(roots.asyncDirRoot, "recent", { endedAt: NOW - DAY_MS });
			fs.utimesSync(path.join(recent, "status.json"), (NOW - DAY_MS) / 1000, (NOW - DAY_MS) / 1000);
			fs.utimesSync(recent, (NOW - DAY_MS) / 1000, (NOW - DAY_MS) / 1000);
			const resumable = writeOldRun(roots.asyncDirRoot, "resumable");
			const sessionFile = path.join(roots.root, "resumable.jsonl");
			fs.writeFileSync(sessionFile, "{}\n");
			fs.writeFileSync(path.join(resumable, "recovery-descriptor.json"), JSON.stringify({ sourceRunId: "resumable", sessionFile }));
			const statusSessionFile = path.join(roots.root, "status-session.jsonl");
			fs.writeFileSync(statusSessionFile, "{}\n");
			writeOldRun(roots.asyncDirRoot, "status-session", { sessionFile: statusSessionFile });
			const stepSessionFile = path.join(roots.root, "step-session.jsonl");
			fs.writeFileSync(stepSessionFile, "{}\n");
			writeOldRun(roots.asyncDirRoot, "step-session", { steps: [{ agent: "worker", status: "complete", sessionFile: stepSessionFile }] });
			writeOldRun(roots.asyncDirRoot, "uninspectable-session", { sessionFile: "bad\0session.jsonl" });
			writeOldRun(roots.asyncDirRoot, "malformed-ended-at", { endedAt: "not-a-number" });
			writeOldRun(roots.asyncDirRoot, "malformed-last-update", { endedAt: undefined, lastUpdate: "not-a-number" });
			writeOldRun(roots.asyncDirRoot, "missing-mode", { mode: undefined });
			const nonFinite = writeOldRun(roots.asyncDirRoot, "non-finite-ended-at");
			const nonFiniteStatus = path.join(nonFinite, "status.json");
			fs.writeFileSync(nonFiniteStatus, '{"runId":"non-finite-ended-at","state":"complete","mode":"single","startedAt":1,"endedAt":1e309,"steps":[{"agent":"worker","status":"complete"}]}');
			fs.utimesSync(nonFiniteStatus, OLD / 1000, OLD / 1000);
			fs.utimesSync(nonFinite, OLD / 1000, OLD / 1000);
			const mission = writeOldRun(roots.asyncDirRoot, "mission");
			fs.writeFileSync(path.join(mission, "mission.json"), "{}");
			writeOldRun(roots.asyncDirRoot, "workflow", { mode: "workflow" });
			writeOldRun(roots.asyncDirRoot, "nested", { isNested: true });
			writeOldRun(roots.asyncDirRoot, "handoff", { parallelHandoff: { path: "/tmp/handoff.json" } });
			writeOldRun(roots.asyncDirRoot, "waited");
			fs.writeFileSync(path.join(roots.waitsDir, "wait.json"), JSON.stringify({ runId: "waited", expiresAt: NOW + DAY_MS }));
			writeOldRun(roots.asyncDirRoot, "runtime");

			const result = await cleanupAsyncRetention({ ...cleanupOptions(roots), protectedRunIds: ["runtime"] });

			for (const runId of ["active", "paused", "recent", "resumable", "status-session", "step-session", "uninspectable-session", "malformed-ended-at", "malformed-last-update", "missing-mode", "non-finite-ended-at", "mission", "workflow", "nested", "handoff", "waited", "runtime"]) {
				assert.equal(fs.existsSync(path.join(roots.asyncDirRoot, runId)), true, runId);
			}
			assert.equal(result.deletedRuns, 0);
			assert.equal(result.skipped["active-index"], 1);
			assert.equal(result.skipped["non-terminal"], 1);
			assert.equal(result.skipped.recent, 1);
			assert.equal(result.skipped.resumable, 4);
			assert.equal(result.skipped["invalid-status"], 1);
			assert.equal(result.skipped["unknown-age"], 3);
			assert.equal(result.skipped["mission-reference"], 1);
			assert.equal(result.skipped["workflow-reference"], 1);
			assert.equal(result.skipped["nested-reference"], 1);
			assert.equal(result.skipped["handoff-reference"], 1);
			assert.equal(result.skipped["wait-reference"], 1);
			assert.equal(result.skipped["runtime-reference"], 1);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("uses one cleaner, reaps stale tombstones safely, and limits processed runs", async () => {
		const roots = makeRoots();
		try {
			fs.mkdirSync(path.join(roots.root, ".async-retention.lock"));
			const locked = await cleanupAsyncRetention(cleanupOptions(roots));
			assert.equal(locked.acquired, false);
			assert.equal(locked.skipped["lock-busy"], 1);
			fs.rmSync(path.join(roots.root, ".async-retention.lock"), { recursive: true });
			const liveLock = path.join(roots.root, ".async-retention.lock");
			fs.mkdirSync(liveLock);
			fs.writeFileSync(path.join(liveLock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: NOW - 6 * 60 * 1000 }));
			const liveLockResult = await cleanupAsyncRetention(cleanupOptions(roots));
			assert.equal(liveLockResult.acquired, false);
			assert.equal(liveLockResult.skipped["lock-busy"], 1);
			fs.rmSync(liveLock, { recursive: true });
			fs.mkdirSync(liveLock);
			fs.writeFileSync(path.join(liveLock, "owner.json"), JSON.stringify({ version: 1, token: "old-token", pid: process.pid, hostname: "test-host", processStartIdentity: "old-process", startedAt: NOW - 60_000 }));
			const reusedPidLockResult = await cleanupAsyncRetention({ ...cleanupOptions(roots), hostname: "test-host", processStartIdentity: "current-process", getProcessStartIdentity: () => "current-process" });
			assert.equal(reusedPidLockResult.acquired, true);
			fs.mkdirSync(liveLock);
			fs.writeFileSync(path.join(liveLock, "owner.json"), JSON.stringify({ version: 1, token: "other-token", pid: process.pid, hostname: "test-host", processStartIdentity: "current-process", startedAt: NOW - 60_000 }));
			const protectedLockResult = await cleanupAsyncRetention({ ...cleanupOptions(roots), hostname: "test-host", processStartIdentity: "current-process", getProcessStartIdentity: () => "current-process" });
			assert.equal(protectedLockResult.acquired, false);
			assert.equal(JSON.parse(fs.readFileSync(path.join(liveLock, "owner.json"), "utf-8")).token, "other-token");
			fs.rmSync(liveLock, { recursive: true });
			const replacementOwner = {
				version: 1,
				token: "successor-token",
				pid: process.pid,
				hostname: "test-host",
				processStartIdentity: "current-process",
				startedAt: NOW,
			};
			const mutatingReferences = (function* () {
				fs.writeFileSync(path.join(liveLock, "owner.json"), JSON.stringify(replacementOwner));
			})();
			const cursorPath = path.join(roots.root, ".async-retention-cursor.json");
			const cursorBeforeOwnerChange = fs.readFileSync(cursorPath, "utf-8");
			const changedOwnerResult = await cleanupAsyncRetention({ ...cleanupOptions(roots), randomId: () => "owned-token", protectedRunIds: mutatingReferences, hostname: "test-host", processStartIdentity: "current-process", getProcessStartIdentity: () => "current-process" });
			assert.equal(changedOwnerResult.acquired, true);
			assert.equal(changedOwnerResult.skipped["lock-owner-changed"], 1);
			assert.equal(fs.readFileSync(cursorPath, "utf-8"), cursorBeforeOwnerChange);
			assert.equal(JSON.parse(fs.readFileSync(path.join(liveLock, "owner.json"), "utf-8")).token, "successor-token");
			fs.rmSync(liveLock, { recursive: true });
			const staleLock = path.join(roots.root, ".async-retention.lock");
			fs.mkdirSync(staleLock);
			fs.writeFileSync(path.join(staleLock, "owner.json"), JSON.stringify({ startedAt: NOW - 25 * 60 * 60 * 1000 }));
			fs.utimesSync(staleLock, (NOW - 25 * 60 * 60 * 1000) / 1000, (NOW - 25 * 60 * 60 * 1000) / 1000);
			const staleLockResult = await cleanupAsyncRetention(cleanupOptions(roots));
			assert.equal(staleLockResult.acquired, true);

			const tombstone = writeOldRun(roots.asyncDirRoot, ".deleting-run-stale", { runId: "stale-run" });
			writeRunTombstoneMarker(roots, "stale-run", tombstone);
			for (let index = 0; index < 110; index += 1) writeOldRun(roots.asyncDirRoot, `old-${String(index).padStart(3, "0")}`);
			const result = await cleanupAsyncRetention({ ...cleanupOptions(roots), randomId: () => `delete-${Math.random()}` });

			assert.ok(result.scanned <= ASYNC_RETENTION_BATCH_SIZE);
			assert.equal(fs.existsSync(tombstone), false);
			assert.equal(result.reapedTombstones, 1);
			assert.ok(fs.readdirSync(roots.asyncDirRoot).filter((name) => name.startsWith("old-")).length >= 60);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("limits result candidates to the cleanup batch", async () => {
		const roots = makeRoots();
		try {
			for (let index = 0; index < 90; index += 1) writeOldResult(roots.resultsDir, `recent-result-${String(index).padStart(3, "0")}`, { endedAt: NOW - DAY_MS });
			const stalePath = writeOldResult(roots.resultsDir, "zz-stale-result");
			let result = await cleanupAsyncRetention(cleanupOptions(roots));
			for (let pass = 0; pass < 10 && fs.existsSync(stalePath); pass += 1) result = await cleanupAsyncRetention(cleanupOptions(roots));
			assert.equal(fs.existsSync(stalePath), false);
			assert.ok(result.scanned <= ASYNC_RETENTION_BATCH_SIZE);
			assert.ok(fs.readdirSync(roots.resultsDir).filter((name) => name.endsWith(".json")).length >= 60);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("keeps replay cleanup fair when pending results fill their source budget", async () => {
		const roots = makeRoots();
		try {
			const pendingRoot = path.join(roots.resultsDir, "result-pending");
			for (let sessionIndex = 0; sessionIndex < 13; sessionIndex += 1) {
				const sessionId = `session-${String(sessionIndex).padStart(3, "0")}`;
				const dir = path.join(pendingRoot, sessionId);
				fs.mkdirSync(dir, { recursive: true });
				for (let fileIndex = 0; fileIndex < 13; fileIndex += 1) {
					const runId = `recent-${sessionIndex}-${fileIndex}`;
					const file = path.join(dir, `${runId}.json`);
					fs.writeFileSync(file, JSON.stringify({ runId, sessionId, success: true, state: "complete", endedAt: NOW - DAY_MS }));
					fs.utimesSync(file, (NOW - DAY_MS) / 1000, (NOW - DAY_MS) / 1000);
				}
			}
			const replayDir = path.join(roots.resultsDir, "completion-replay");
			fs.mkdirSync(replayDir);
			const replayPath = path.join(replayDir, "stale-replay.json");
			fs.writeFileSync(replayPath, JSON.stringify({ version: 1, runId: "stale-replay", createdAt: OLD, expiresAt: OLD, completion: { runId: "stale-replay", mode: "single" } }));
			fs.utimesSync(replayPath, OLD / 1000, OLD / 1000);

			const result = await cleanupAsyncRetention(cleanupOptions(roots));

			assert.equal(fs.existsSync(replayPath), false);
			assert.equal(result.deletedResults, 1);
			assert.ok(result.scanned <= ASYNC_RETENTION_BATCH_SIZE);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("uses full delayed discovery so retained raw-order prefixes cannot starve stale runs", async () => {
		const roots = makeRoots();
		try {
			for (const runId of ["recent-a", "recent-b", "recent-c", "recent-d"]) writeOldRun(roots.asyncDirRoot, runId, { endedAt: NOW - DAY_MS });
			const victim = writeOldRun(roots.asyncDirRoot, "zz-old-victim");
			let result = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 4 });
			for (let pass = 0; pass < 5 && fs.existsSync(victim); pass += 1) {
				assert.ok(result.scanned <= ASYNC_RETENTION_BATCH_SIZE);
				assert.ok(result.rawReads >= 5);
				result = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 4 });
			}

			assert.equal(fs.existsSync(victim), false);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("uses the same ordering for mixed-case cursor filtering and selection", async () => {
		const roots = makeRoots();
		try {
			writeOldRun(roots.asyncDirRoot, "a", { endedAt: NOW - DAY_MS });
			const victim = writeOldRun(roots.asyncDirRoot, "B");
			await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 1 });
			for (let pass = 0; pass < 3 && fs.existsSync(victim); pass += 1) await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 1 });

			assert.equal(fs.existsSync(victim), false);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("wraps a cursor and makes progress when no usable entries are after it", async () => {
		const roots = makeRoots();
		try {
			const runDir = writeOldRun(roots.asyncDirRoot, "cursor-wrap");
			fs.writeFileSync(path.join(roots.root, ".async-retention-cursor.json"), JSON.stringify({ version: 1, runAfter: "zzzz" }));
			const wrapped = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 1 });
			assert.equal(fs.existsSync(runDir), false);
			assert.equal(wrapped.rawReads, 1);
			assert.equal(wrapped.deletedRuns, 1);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("uses exact run tombstone markers for result blocking", async () => {
		const roots = makeRoots();
		try {
			const blockedResult = writeOldResult(roots.resultsDir, "blocked-result");
			const freeResult = writeOldResult(roots.resultsDir, "free-result");
			const blockingTombstone = path.join(roots.root, "blocking-tombstone");
			fs.mkdirSync(blockingTombstone);
			writeRunTombstoneMarker(roots, "blocked-result", blockingTombstone);

			const result = await cleanupAsyncRetention(cleanupOptions(roots));

			assert.equal(fs.existsSync(blockedResult), true);
			assert.equal(fs.existsSync(freeResult), false);
			assert.equal(result.skipped["run-tombstone-present"], 1);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("removes a stray run tombstone marker when its tombstone is gone", async () => {
		const roots = makeRoots();
		try {
			const resultPath = writeOldResult(roots.resultsDir, "stray-marker-result");
			const markerPath = writeRunTombstoneMarker(roots, "stray-marker-result", path.join(roots.root, "missing-tombstone"));

			const result = await cleanupAsyncRetention(cleanupOptions(roots));

			assert.equal(fs.existsSync(resultPath), false);
			assert.equal(fs.existsSync(markerPath), false);
			assert.equal(result.deletedResults, 1);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("advances pending result session windows beyond the first batch", async () => {
		const roots = makeRoots();
		try {
			const pendingRoot = path.join(roots.resultsDir, "result-pending");
			const writePending = (sessionId: string, runId: string, endedAt: number): string => {
				const dir = path.join(pendingRoot, sessionId);
				fs.mkdirSync(dir, { recursive: true });
				const file = path.join(dir, `${runId}.json`);
				fs.writeFileSync(file, JSON.stringify({ runId, sessionId, success: true, state: "complete", endedAt }));
				fs.utimesSync(file, endedAt / 1000, endedAt / 1000);
				return file;
			};
			for (let index = 0; index < 60; index += 1) writePending(`session-${String(index).padStart(3, "0")}`, `recent-${index}`, NOW - DAY_MS);
			const stalePath = writePending("session-zz", "stale-pending", OLD);

			let result = await cleanupAsyncRetention(cleanupOptions(roots));
			for (let pass = 0; pass < 5 && fs.existsSync(stalePath); pass += 1) result = await cleanupAsyncRetention(cleanupOptions(roots));

			assert.equal(fs.existsSync(stalePath), false);
			assert.ok(result.scanned <= ASYNC_RETENTION_BATCH_SIZE);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("keeps pending result file cursors separate per session", async () => {
		const roots = makeRoots();
		try {
			const pendingRoot = path.join(roots.resultsDir, "result-pending");
			const writePending = (sessionId: string, runId: string, endedAt: number): string => {
				const dir = path.join(pendingRoot, sessionId);
				fs.mkdirSync(dir, { recursive: true });
				const file = path.join(dir, `${runId}.json`);
				fs.writeFileSync(file, JSON.stringify({ runId, sessionId, success: true, state: "complete", endedAt }));
				fs.utimesSync(file, endedAt / 1000, endedAt / 1000);
				return file;
			};
			for (let index = 0; index < 6; index += 1) writePending("session-a", `recent-${String(index).padStart(2, "0")}`, NOW - DAY_MS);
			const stalePath = writePending("session-a", "zz-stale", OLD);
			writePending("session-b", "recent-b", NOW - DAY_MS);

			let result = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 8 });
			for (let pass = 0; pass < 20 && fs.existsSync(stalePath); pass += 1) {
				assert.ok(result.scanned <= ASYNC_RETENTION_BATCH_SIZE);
				result = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 8 });
			}

			assert.equal(fs.existsSync(stalePath), false);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("prunes pending result cursors for removed session directories", async () => {
		const roots = makeRoots();
		try {
			const pendingRoot = path.join(roots.resultsDir, "result-pending");
			const liveSession = path.join(pendingRoot, "live-session");
			fs.mkdirSync(liveSession, { recursive: true });
			const liveFile = path.join(liveSession, "zz-live.json");
			fs.writeFileSync(liveFile, JSON.stringify({ runId: "zz-live", sessionId: "live-session", success: true, state: "complete", endedAt: NOW - DAY_MS }));
			fs.utimesSync(liveFile, (NOW - DAY_MS) / 1000, (NOW - DAY_MS) / 1000);
			fs.writeFileSync(path.join(roots.root, ".async-retention-cursor.json"), JSON.stringify({
				version: 1,
				resultPendingAfterBySession: {
					"live-session": "result-pending/live-session/live.json",
					"removed-session": "result-pending/removed-session/stale.json",
				},
			}));

			await cleanupAsyncRetention(cleanupOptions(roots));

			const cursor = JSON.parse(fs.readFileSync(path.join(roots.root, ".async-retention-cursor.json"), "utf-8")) as { resultPendingAfterBySession?: Record<string, string> };
			assert.equal(cursor.resultPendingAfterBySession?.["removed-session"], undefined);
			assert.equal(cursor.resultPendingAfterBySession?.["live-session"], path.join("result-pending", "live-session", "zz-live.json"));
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("keeps orphan results with recoverability or durable references", async () => {
		const roots = makeRoots();
		try {
			writeOldResult(roots.resultsDir, "waited-result");
			fs.writeFileSync(path.join(roots.waitsDir, "wait.json"), JSON.stringify({ runId: "waited-result", expiresAt: NOW + DAY_MS }));
			writeOldResult(roots.resultsDir, "workflow-result", { mode: "workflow" });
			const sessionFile = path.join(roots.root, "result-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n");
			writeOldResult(roots.resultsDir, "resumable-result", { sessionFile });
			writeOldResult(roots.resultsDir, "mission-result");
			const observerDir = path.join(roots.resultsDir, "result-index", "observers", "mission");
			fs.mkdirSync(observerDir, { recursive: true });
			fs.writeFileSync(path.join(observerDir, "mission-result.json"), "{}");
			const recentResult = writeOldResult(roots.resultsDir, "recent-result", { endedAt: NOW - DAY_MS });
			fs.utimesSync(recentResult, (NOW - DAY_MS) / 1000, (NOW - DAY_MS) / 1000);
			const malformedAgeResult = path.join(roots.resultsDir, "malformed-age-result.json");
			fs.writeFileSync(malformedAgeResult, JSON.stringify({ runId: "malformed-age-result", success: true, state: "complete", endedAt: "not-a-number" }));
			fs.utimesSync(malformedAgeResult, OLD / 1000, OLD / 1000);
			const nonFiniteAgeResult = path.join(roots.resultsDir, "non-finite-age-result.json");
			fs.writeFileSync(nonFiniteAgeResult, '{"runId":"non-finite-age-result","success":true,"state":"complete","endedAt":1e309}');
			fs.utimesSync(nonFiniteAgeResult, OLD / 1000, OLD / 1000);
			const nonFiniteTimestampResult = path.join(roots.resultsDir, "non-finite-timestamp-result.json");
			fs.writeFileSync(nonFiniteTimestampResult, '{"runId":"non-finite-timestamp-result","success":true,"state":"complete","timestamp":1e309}');
			fs.utimesSync(nonFiniteTimestampResult, OLD / 1000, OLD / 1000);
			writeOldResult(roots.resultsDir, "uninspectable-session-result", { sessionFile: "bad\0session.jsonl" });
			writeOldResult(roots.resultsDir, "runtime-result");
			const replayDir = path.join(roots.resultsDir, "completion-replay");
			const archiveDir = path.join(roots.resultsDir, "output-archives");
			fs.mkdirSync(replayDir);
			fs.mkdirSync(archiveDir);
			const replayPath = path.join(replayDir, "workflow-replay.json");
			const archivePath = path.join(archiveDir, "workflow-replay.json");
			fs.writeFileSync(replayPath, JSON.stringify({ version: 1, runId: "workflow-replay", createdAt: OLD, expiresAt: OLD, completion: { runId: "workflow-replay", mode: "workflow" } }));
			fs.writeFileSync(archivePath, JSON.stringify({ version: 1, runId: "workflow-replay", createdAt: OLD, entries: [] }));
			fs.utimesSync(replayPath, OLD / 1000, OLD / 1000);
			fs.utimesSync(archivePath, OLD / 1000, OLD / 1000);

			const result = await cleanupAsyncRetention({ ...cleanupOptions(roots), protectedRunIds: ["runtime-result"] });

			for (const runId of ["waited-result", "workflow-result", "resumable-result", "mission-result", "recent-result", "malformed-age-result", "non-finite-age-result", "non-finite-timestamp-result", "uninspectable-session-result", "runtime-result"]) {
				assert.equal(fs.existsSync(path.join(roots.resultsDir, `${runId}.json`)), true, runId);
			}
			assert.equal(fs.existsSync(replayPath), true);
			assert.equal(fs.existsSync(archivePath), true);
			assert.equal(result.deletedResults, 0);
			assert.equal(result.skipped["wait-reference"], 1);
			assert.equal(result.skipped["workflow-reference"], 2);
			assert.equal(result.skipped["replay-reference"], 1);
			assert.equal(result.skipped.resumable, 2);
			assert.equal(result.skipped["mission-reference"], 1);
			assert.equal(result.skipped.recent, 1);
			assert.equal(result.skipped["unknown-age"], 3);
			assert.equal(result.skipped["runtime-reference"], 1);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("keeps the cursor unchanged for failed, malformed, and cancelled workers", async () => {
		const roots = makeRoots();
		try {
			const cursorPath = path.join(roots.root, ".async-retention-cursor.json");
			const cursorBytes = '{"version":1,"runAfter":"keep-me"}\n';
			fs.writeFileSync(cursorPath, cursorBytes);
			const malformedWorker = path.join(roots.root, "malformed-worker.mjs");
			fs.writeFileSync(malformedWorker, 'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => parentPort.postMessage({ type: "result", passId: "stale" }));');

			const malformed = await cleanupAsyncRetention({ ...cleanupOptions(roots), discoveryWorkerUrl: pathToFileURL(malformedWorker) });

			assert.equal(malformed.workerFailed, true);
			assert.equal(malformed.skipped["worker-failure"], 1);
			assert.equal(fs.readFileSync(cursorPath, "utf-8"), cursorBytes);

			const failedWorker = path.join(roots.root, "failed-worker.mjs");
			fs.writeFileSync(failedWorker, 'throw new Error("worker crash");');
			const failed = await cleanupAsyncRetention({ ...cleanupOptions(roots), discoveryWorkerUrl: pathToFileURL(failedWorker) });
			assert.equal(failed.workerFailed, true);
			assert.match(failed.errors[0] ?? "", /worker crash/);
			assert.equal(fs.readFileSync(cursorPath, "utf-8"), cursorBytes);

			const hangingWorker = path.join(roots.root, "hanging-worker.mjs");
			fs.writeFileSync(hangingWorker, 'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => {});');
			const abort = new AbortController();
			const pending = cleanupAsyncRetention({ ...cleanupOptions(roots), discoveryWorkerUrl: pathToFileURL(hangingWorker), signal: abort.signal });
			setImmediate(() => abort.abort());
			const cancelled = await pending;

			assert.equal(cancelled.cancelled, true);
			assert.equal(cancelled.skipped.cancelled, 1);
			assert.equal(fs.readFileSync(cursorPath, "utf-8"), cursorBytes);
			assert.equal(fs.existsSync(path.join(roots.root, ".async-retention.lock")), false);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("advances past a candidate with a read error when no mutation started", async () => {
		const roots = makeRoots();
		try {
			const unreadable = writeOldRun(roots.asyncDirRoot, "aaa-unreadable");
			const victim = writeOldRun(roots.asyncDirRoot, "zzz-victim");
			const realLstatSync = fs.lstatSync;
			const lstatSync = ((filePath: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
				if (path.resolve(String(filePath)) === path.resolve(unreadable)) throw Object.assign(new Error("read failed"), { code: "EIO" });
				return realLstatSync(filePath, options);
			}) as typeof fs.lstatSync;

			const first = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 2, lstatSync });
			assert.deepEqual(first.errors, ["read failed"]);
			assert.equal(first.skipped["commit-failure"], undefined);
			assert.equal(fs.existsSync(victim), true);

			const second = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 2, lstatSync });
			assert.equal(second.deletedRuns, 1);
			assert.equal(fs.existsSync(victim), false);
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});

	it("yields the extension event loop during full directory discovery", async () => {
		const roots = makeRoots();
		try {
			for (let index = 0; index < 2_000; index += 1) fs.mkdirSync(path.join(roots.asyncDirRoot, `run-${index}`));
			let yielded = false;
			setImmediate(() => { yielded = true; });

			const result = await cleanupAsyncRetention({ ...cleanupOptions(roots), batchSize: 2 });

			assert.equal(yielded, true);
			assert.ok(result.rawReads >= 2_000);
			assert.equal(result.sourceExhausted.runs, true);
			assert.equal(typeof result.discoveryDurationMs, "number");
			assert.equal(typeof result.commitDurationMs, "number");
		} finally {
			fs.rmSync(roots.root, { recursive: true, force: true });
		}
	});
});
