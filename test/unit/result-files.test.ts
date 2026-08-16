import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { encodeIndexSegment, MAX_INDEX_SEGMENT_BYTES } from "../../src/runs/background/index-segment.ts";
import { cleanupResultIndexes, removeResultIndex, resultCandidateFilesForSession, resultFilesForSession, resultFilesForToolCall, resultPayloadPathForIndexedRun, resultPayloadPathForSessionRun, writeAsyncResultFile, writePendingAsyncResultFile, writeResultIndexForData } from "../../src/runs/background/result-files.ts";

const JSON_EXTENSION = ".json";
const MAX_JSON_FILE_STEM_BYTES = MAX_INDEX_SEGMENT_BYTES - Buffer.byteLength(JSON_EXTENSION, "utf-8");

function pendingPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(resultsDir, "result-pending", encodeIndexSegment(sessionId), `${encodeIndexSegment(runId, MAX_JSON_FILE_STEM_BYTES)}${JSON_EXTENSION}`);
}

describe("result file indexes", () => {
	it("resolves run ids without enumerating session indexes", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-run-index-"));
		const originalReaddirSync = fsDefault.readdirSync;
		try {
			const resultPath = path.join(resultsDir, "direct-run.json");
			writeAsyncResultFile(resultPath, { id: "direct-run", runId: "direct-run", sessionId: "session-a", success: true });
			fsDefault.readdirSync = (() => { throw new Error("result index enumerated"); }) as typeof fsDefault.readdirSync;
			syncBuiltinESMExports();

			assert.equal(resultPayloadPathForIndexedRun(resultsDir, "direct-run"), resultPath);
			assert.equal(resultPayloadPathForIndexedRun(resultsDir, "missing-run"), undefined);
		} finally {
			fsDefault.readdirSync = originalReaddirSync;
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("removes orphan index entries without deleting flat result files", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-index-"));
		try {
			writeAsyncResultFile(path.join(resultsDir, "kept.json"), { id: "kept", runId: "kept", sessionId: "session-a", success: true });
			writeAsyncResultFile(path.join(resultsDir, "missing.json"), { id: "missing", runId: "missing", sessionId: "session-a", toolCallId: "call-missing", success: true });
			fs.rmSync(path.join(resultsDir, "missing.json"));
			fs.writeFileSync(path.join(resultsDir, "unindexed.json"), JSON.stringify({ id: "unindexed", sessionId: "session-a" }), "utf-8");

			assert.equal(cleanupResultIndexes(resultsDir, Date.now() + 86_400_001, 86_400_000), 3);

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

	it("keeps pending results for long session ids below filesystem component limits", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-long-session-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const sessionId = `/Users/zhouatie/.config/pi/sessions/${"界".repeat(100)}.jsonl`;
			const runId = "pending-long-session";
			const resultPath = path.join(resultsDir, `${runId}.json`);
			fs.mkdirSync(resultPath);

			writePendingAsyncResultFile(resultPath, { id: runId, runId, sessionId, success: true });

			const payloadPath = pendingPath(resultsDir, sessionId, runId);
			assert.ok(Buffer.byteLength(path.basename(path.dirname(payloadPath)), "utf-8") <= 255);
			assert.equal(fs.existsSync(payloadPath), true);
			assert.deepEqual(resultCandidateFilesForSession(resultsDir, sessionId), [`${runId}.json`]);
			assert.equal(resultPayloadPathForSessionRun(resultsDir, sessionId, runId), payloadPath);
			fs.rmSync(path.join(resultsDir, "result-index"), { recursive: true });
			assert.equal(resultPayloadPathForIndexedRun(resultsDir, runId), undefined);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("keeps pending results for near-limit run ids below filesystem component limits", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-long-run-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const sessionId = "session-a";
			for (const runId of ["x".repeat(250), "y".repeat(251)]) {
				const resultPath = path.join(resultsDir, `${runId}.json`);
				if (runId.length === 250) fs.mkdirSync(resultPath);
				writePendingAsyncResultFile(resultPath, { id: runId, runId, sessionId, success: true });

				const payloadPath = pendingPath(resultsDir, sessionId, runId);
				const pendingFile = path.basename(payloadPath);
				assert.ok(Buffer.byteLength(pendingFile, "utf-8") <= 255);
				assert.equal(fs.existsSync(payloadPath), true);
				assert.equal(resultPayloadPathForSessionRun(resultsDir, sessionId, runId), payloadPath);
			}
			assert.equal(path.basename(pendingPath(resultsDir, sessionId, "x".repeat(250))), `${"x".repeat(250)}.json`);
			assert.match(path.basename(pendingPath(resultsDir, sessionId, "y".repeat(251))), /^~sha256-[a-f0-9]{64}\.json$/);
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
			assert.equal(resultPayloadPathForIndexedRun(resultsDir, "blocked"), undefined);
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

	it("keeps a newer pending payload readable when Windows cannot replace the public result", (t) => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-windows-pending-wins-"));
		try {
			const resultPath = path.join(resultsDir, "blocked.json");
			writeAsyncResultFile(resultPath, { id: "blocked", runId: "blocked", sessionId: "session-a", success: false });
			writePendingAsyncResultFile(resultPath, { id: "blocked", runId: "blocked", sessionId: "session-a", success: true });

			t.mock.method(fsDefault, "renameSync", () => {
				const error = new Error("destination exists") as NodeJS.ErrnoException;
				error.code = "EEXIST";
				throw error;
			});
			syncBuiltinESMExports();

			const payloadPath = resultPayloadPathForSessionRun(resultsDir, "session-a", "blocked");
			assert.equal(payloadPath, pendingPath(resultsDir, "session-a", "blocked"));
			assert.equal(JSON.parse(fs.readFileSync(payloadPath, "utf-8")).success, true);
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).success, false);
			assert.equal(fs.existsSync(pendingPath(resultsDir, "session-a", "blocked")), true);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
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

	it("indexes results with oversized provider tool-call ids", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-long-tool-call-"));
		try {
			const runId = "workflow-long-tool-call";
			const toolCallId = `call_${"opaque/+=".repeat(80)}`;
			const resultPath = path.join(resultsDir, `${runId}.json`);

			writeAsyncResultFile(resultPath, { id: runId, runId, sessionId: "session-a", toolCallId, success: true });

			assert.deepEqual(resultFilesForToolCall(resultsDir, toolCallId), [`${runId}.json`]);
			removeResultIndex(resultsDir, "session-a", runId, toolCallId);
			assert.deepEqual(resultFilesForToolCall(resultsDir, toolCallId), []);
			assert.equal(fs.existsSync(resultPath), true);
		} finally {
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
