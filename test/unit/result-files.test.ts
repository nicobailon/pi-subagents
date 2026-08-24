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

	it("round-trips results for Windows session file paths", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-win-session-"));
		try {
			const sessionId = String.raw`C:\Users\theap\.pi\agent\sessions\leaf.jsonl`;
			const runId = "win-session-run";
			const resultPath = path.join(resultsDir, `${runId}.json`);
			writeAsyncResultFile(resultPath, { id: runId, runId, sessionId, success: true });

			const sessionDirs = fs.readdirSync(path.join(resultsDir, "result-index", "sessions"));
			assert.equal(sessionDirs.length, 1);
			assert.match(sessionDirs[0]!, /^~sha256-[a-f0-9]{64}$/);
			assert.deepEqual(resultFilesForSession(resultsDir, sessionId), [`${runId}.json`]);
			assert.deepEqual(resultCandidateFilesForSession(resultsDir, sessionId), [`${runId}.json`]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("treats an unaddressable legacy session alias as absent and keeps canonical fallback candidates", (t) => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-legacy-enametoolong-"));
		const sessionId = String.raw`C:\Users\theap\.pi\agent\sessions\leaf.jsonl`;
		const runId = "legacy-alias-fallback";
		const resultPath = path.join(resultsDir, `${runId}.json`);
		const legacyDir = path.join(resultsDir, "result-index", "sessions", encodeURIComponent(sessionId));
		const originalReadFileSync = fsDefault.readFileSync;
		const originalReaddirSync = fsDefault.readdirSync;
		const originalError = console.error;
		const errors: unknown[][] = [];
		try {
			writeAsyncResultFile(resultPath, { id: runId, runId, sessionId, success: true });
			const canonicalDir = path.join(resultsDir, "result-index", "sessions", encodeIndexSegment(sessionId));
			const [canonicalIndexFile] = fs.readdirSync(canonicalDir);
			assert.ok(canonicalIndexFile);
			const canonicalPendingPath = pendingPath(resultsDir, sessionId, runId);
			fs.mkdirSync(path.dirname(canonicalPendingPath), { recursive: true });
			fs.copyFileSync(resultPath, canonicalPendingPath);

			const nameTooLong = new Error("legacy alias is too long") as NodeJS.ErrnoException;
			nameTooLong.code = "ENAMETOOLONG";
			fsDefault.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
				if (String(filePath).startsWith(legacyDir)) throw nameTooLong;
				return (originalReadFileSync as (...input: unknown[]) => unknown)(filePath, ...args);
			}) as typeof fsDefault.readFileSync;
			fsDefault.readdirSync = ((dirPath: fs.PathLike, ...args: unknown[]) => {
				if (String(dirPath) === legacyDir) throw nameTooLong;
				return (originalReaddirSync as (...input: unknown[]) => unknown)(dirPath, ...args);
			}) as typeof fsDefault.readdirSync;
			console.error = (...args: unknown[]) => { errors.push(args); };
			syncBuiltinESMExports();

			assert.deepEqual(resultCandidateFilesForSession(resultsDir, sessionId), [`${runId}.json`]);
			fs.copyFileSync(resultPath, canonicalPendingPath);
			fs.rmSync(path.join(canonicalDir, canonicalIndexFile));
			assert.equal(resultPayloadPathForSessionRun(resultsDir, sessionId, runId), canonicalPendingPath);
			assert.deepEqual(errors, []);
		} finally {
			fsDefault.readFileSync = originalReadFileSync;
			fsDefault.readdirSync = originalReaddirSync;
			console.error = originalError;
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("leaves an unaddressable legacy index untouched during cleanup", (t) => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-cleanup-enametoolong-"));
		const sessionId = String.raw`C:\Users\theap\.pi\agent\sessions\leaf.jsonl`;
		const runId = "legacy-cleanup";
		const originalStatSync = fsDefault.statSync;
		const originalError = console.error;
		const errors: unknown[][] = [];
		try {
			writeAsyncResultFile(path.join(resultsDir, `${runId}.json`), { id: runId, runId, sessionId, success: true });
			const canonicalDir = path.join(resultsDir, "result-index", "sessions", encodeIndexSegment(sessionId));
			const legacyDir = path.join(resultsDir, "result-index", "sessions", encodeURIComponent(sessionId));
			fs.renameSync(canonicalDir, legacyDir);
			const [legacyIndexFile] = fs.readdirSync(legacyDir);
			assert.ok(legacyIndexFile);
			const legacyIndexPath = path.join(legacyDir, legacyIndexFile);
			const nameTooLong = new Error("legacy alias is too long") as NodeJS.ErrnoException;
			nameTooLong.code = "ENAMETOOLONG";
			t.mock.method(fsDefault, "statSync", ((filePath: fs.PathLike) => {
				if (String(filePath) === legacyIndexPath) throw nameTooLong;
				return originalStatSync(filePath);
			}) as typeof fsDefault.statSync);
			console.error = (...args: unknown[]) => { errors.push(args); };
			syncBuiltinESMExports();

			assert.equal(cleanupResultIndexes(resultsDir, Date.now() + 86_400_001, 86_400_000), 0);
			assert.equal(fs.existsSync(legacyIndexPath), true);
			assert.deepEqual(errors, []);
		} finally {
			console.error = originalError;
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("reads a pre-hash URI-encoded session index after the encoding change", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-legacy-session-"));
		try {
			const sessionId = String.raw`C:\Users\theap\.pi\agent\sessions\leaf.jsonl`;
			const runId = "legacy-session-run";
			const resultPath = path.join(resultsDir, `${runId}.json`);
			writeAsyncResultFile(resultPath, { id: runId, runId, sessionId, success: true });

			const currentDir = path.join(resultsDir, "result-index", "sessions", encodeIndexSegment(sessionId));
			const historicalDir = path.join(resultsDir, "result-index", "sessions", encodeURIComponent(sessionId));
			fs.renameSync(currentDir, historicalDir);

			assert.deepEqual(resultFilesForSession(resultsDir, sessionId), [`${runId}.json`]);
			assert.equal(resultPayloadPathForSessionRun(resultsDir, sessionId, runId), resultPath);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("reads a pre-hash extension-like run index filename", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-legacy-run-"));
		try {
			const sessionId = "session-a";
			const runId = "legacy.jsonl";
			const resultPath = path.join(resultsDir, `${runId}.json`);
			writeAsyncResultFile(resultPath, { id: runId, runId, sessionId, success: true });

			const indexDir = path.join(resultsDir, "result-index", "sessions", encodeIndexSegment(sessionId));
			const [currentFile] = fs.readdirSync(indexDir);
			assert.ok(currentFile);
			fs.renameSync(path.join(indexDir, currentFile), path.join(indexDir, `${runId}.json`));

			assert.equal(resultPayloadPathForSessionRun(resultsDir, sessionId, runId), resultPath);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("reads a pre-hash extension-like pending filename", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-legacy-pending-"));
		const originalError = console.error;
		try {
			const sessionId = "session-a";
			const runId = "legacy.jsonl";
			const resultPath = path.join(resultsDir, `${runId}.json`);
			fs.mkdirSync(resultPath);
			console.error = () => {};
			writePendingAsyncResultFile(resultPath, { id: runId, runId, sessionId, success: true });

			const currentPath = pendingPath(resultsDir, sessionId, runId);
			const historicalPath = path.join(path.dirname(currentPath), `${runId}.json`);
			fs.renameSync(currentPath, historicalPath);

			assert.equal(resultPayloadPathForSessionRun(resultsDir, sessionId, runId), historicalPath);
		} finally {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("throws access-denied direct session index reads", (t) => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-eacces-index-"));
		const error = new Error("permission denied") as NodeJS.ErrnoException;
		error.code = "EACCES";
		try {
			writeAsyncResultFile(path.join(resultsDir, "blocked.json"), { id: "blocked", runId: "blocked", sessionId: "session-a", success: true });
			t.mock.method(fsDefault, "readFileSync", () => { throw error; });
			syncBuiltinESMExports();

			assert.throws(() => resultPayloadPathForSessionRun(resultsDir, "session-a", "blocked"), (thrown) => thrown === error);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("returns no session candidates when the session index is unlistable", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-files-eperm-scan-"));
		const error = new Error("operation not permitted") as NodeJS.ErrnoException;
		error.code = "EPERM";
		const originalReaddirSync = fsDefault.readdirSync;
		try {
			fsDefault.readdirSync = (() => { throw error; }) as typeof fsDefault.readdirSync;
			syncBuiltinESMExports();
			assert.deepEqual(resultCandidateFilesForSession(resultsDir, "session-a"), []);
		} finally {
			fsDefault.readdirSync = originalReaddirSync;
			syncBuiltinESMExports();
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});
});
