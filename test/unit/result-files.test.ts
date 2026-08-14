import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanupResultIndexes, removeResultIndex, resultCandidateFilesForSession, resultFilesForSession, resultPayloadPathForIndexedRun, resultPayloadPathForSessionRun, writeAsyncResultFile, writePendingAsyncResultFile, writeResultIndexForData } from "../../src/runs/background/result-files.ts";

function pendingPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(resultsDir, "result-pending", encodeURIComponent(sessionId), `${encodeURIComponent(runId)}.json`);
}

describe("result file indexes", () => {
	it("removes orphan index entries without deleting flat result files", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-index-"));
		try {
			writeAsyncResultFile(path.join(resultsDir, "kept.json"), { id: "kept", runId: "kept", sessionId: "session-a", success: true });
			writeAsyncResultFile(path.join(resultsDir, "missing.json"), { id: "missing", runId: "missing", sessionId: "session-a", toolCallId: "call-missing", success: true });
			fs.rmSync(path.join(resultsDir, "missing.json"));
			fs.writeFileSync(path.join(resultsDir, "unindexed.json"), JSON.stringify({ id: "unindexed", sessionId: "session-a" }), "utf-8");

			assert.equal(cleanupResultIndexes(resultsDir, Date.now() + 86_400_001, 86_400_000), 2);

			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), ["kept.json"]);
			assert.equal(fs.existsSync(path.join(resultsDir, "kept.json")), true);
			assert.equal(fs.existsSync(path.join(resultsDir, "unindexed.json")), true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("promotes an indexed pending result payload", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-pending-payload-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const resultPath = path.join(resultsDir, "late.json");
			fs.mkdirSync(resultPath, { recursive: true });

			assert.deepEqual(writeAsyncResultFile(resultPath, { id: "late", runId: "late", sessionId: "session-a", success: true }), { state: "pending" });
			assert.equal(fs.existsSync(pendingPath(resultsDir, "session-a", "late")), true);
			fs.rmSync(resultPath, { recursive: true, force: true });

			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), ["late.json"]);
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).success, true);
			assert.equal(fs.existsSync(pendingPath(resultsDir, "session-a", "late")), false);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("writes an indexed pending result without publishing it", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-pending-only-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const resultPath = path.join(resultsDir, "pending-only.json");
			fs.mkdirSync(resultPath, { recursive: true });

			writePendingAsyncResultFile(resultPath, { id: "pending-only", runId: "pending-only", sessionId: "session-a", success: true });

			assert.equal(fs.statSync(resultPath).isDirectory(), true);
			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), []);
			assert.deepEqual(resultCandidateFilesForSession(resultsDir, "session-a"), ["pending-only.json"]);
			assert.equal(resultPayloadPathForSessionRun(resultsDir, "session-a", "pending-only"), pendingPath(resultsDir, "session-a", "pending-only"));
			assert.equal(resultPayloadPathForIndexedRun(resultsDir, "pending-only"), pendingPath(resultsDir, "session-a", "pending-only"));
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("keeps a legacy valid index while the result payload is not visible yet", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-legacy-late-payload-"));
		try {
			const resultPath = path.join(resultsDir, "late.json");
			writeResultIndexForData(resultPath, { id: "late", runId: "late", sessionId: "session-a", success: true });

			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), []);

			fs.writeFileSync(resultPath, JSON.stringify({ id: "late", runId: "late", sessionId: "session-a", success: true }), "utf-8");
			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), ["late.json"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("keeps an unindexed pending result recoverable when its session index cannot be written", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-index-failure-"));
		try {
			fs.writeFileSync(path.join(resultsDir, "result-index"), "not a directory", "utf-8");
			const resultPath = path.join(resultsDir, "blocked.json");

			assert.throws(() => writeAsyncResultFile(resultPath, { id: "blocked", runId: "blocked", sessionId: "session-a", success: true }));
			assert.equal(fs.existsSync(resultPath), false);
			assert.equal(fs.existsSync(pendingPath(resultsDir, "session-a", "blocked")), true);
			assert.equal(resultPayloadPathForSessionRun(resultsDir, "session-a", "blocked"), pendingPath(resultsDir, "session-a", "blocked"));
			assert.equal(resultPayloadPathForIndexedRun(resultsDir, "blocked"), pendingPath(resultsDir, "session-a", "blocked"));
			assert.deepEqual(resultCandidateFilesForSession(resultsDir, "session-a"), ["blocked.json"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("does not commit a result payload without a session id", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-no-session-"));
		try {
			const resultPath = path.join(resultsDir, "blocked.json");

			assert.throws(() => writeAsyncResultFile(resultPath, { id: "blocked", runId: "blocked", success: true }), /sessionId/);
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("prefers pending payload over an older public result", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-pending-wins-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const resultPath = path.join(resultsDir, "blocked.json");
			writeAsyncResultFile(resultPath, { id: "blocked", runId: "blocked", sessionId: "session-a", success: false });
			fs.rmSync(resultPath, { force: true });
			fs.mkdirSync(resultPath, { recursive: true });

			assert.deepEqual(writeAsyncResultFile(resultPath, { id: "blocked", runId: "blocked", sessionId: "session-a", success: true }), { state: "pending" });
			fs.rmSync(resultPath, { recursive: true, force: true });
			fs.writeFileSync(resultPath, JSON.stringify({ id: "blocked", runId: "blocked", sessionId: "session-a", success: false }), "utf-8");

			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), ["blocked.json"]);
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).success, true);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("removes pending payloads with result indexes", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-pending-cleanup-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const resultPath = path.join(resultsDir, "pending-cleanup.json");
			fs.mkdirSync(resultPath, { recursive: true });
			writeAsyncResultFile(resultPath, { id: "pending-cleanup", runId: "pending-cleanup", sessionId: "session-a", success: true });

			assert.equal(fs.existsSync(pendingPath(resultsDir, "session-a", "pending-cleanup")), true);
			removeResultIndex(resultsDir, "session-a", "pending-cleanup");
			assert.equal(fs.existsSync(pendingPath(resultsDir, "session-a", "pending-cleanup")), false);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("commits a result payload when only an optional index fails", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-optional-index-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			fs.mkdirSync(path.join(resultsDir, "result-index"), { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "result-index", "tool-calls"), "not a directory", "utf-8");
			const resultPath = path.join(resultsDir, "kept.json");

			writeAsyncResultFile(resultPath, { id: "kept", runId: "kept", sessionId: "session-a", toolCallId: "call-a", success: true });

			assert.equal(fs.existsSync(resultPath), true);
			assert.deepEqual(resultFilesForSession(resultsDir, "session-a"), ["kept.json"]);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});
});
