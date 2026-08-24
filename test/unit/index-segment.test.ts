import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ACTIVE_RUN_INDEX_DIR, readActiveRunToolCallIndex, releaseActiveRunIndex, updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { encodeIndexSegment, indexSegmentAliases, MAX_INDEX_SEGMENT_BYTES } from "../../src/runs/background/index-segment.ts";

describe("bounded index segments", () => {
	it("preserves legacy encoding for short values and hashes oversized opaque ids", () => {
		assert.equal(encodeIndexSegment("call/a+b="), encodeURIComponent("call/a+b="));
		assert.equal(encodeIndexSegment("x".repeat(255)), "x".repeat(255));
		assert.match(encodeIndexSegment("x".repeat(256)), /^~sha256-[a-f0-9]{64}$/);
		for (const unsafe of ["", ".", "..", "CON", "nul.txt", "trailing."]) {
			assert.match(encodeIndexSegment(unsafe), /^~sha256-[a-f0-9]{64}$/);
		}

		const longId = `call_${"opaque/+=".repeat(80)}`;
		const first = encodeIndexSegment(longId);
		assert.equal(first, encodeIndexSegment(longId));
		assert.match(first, /^~sha256-[a-f0-9]{64}$/);
		assert.ok(Buffer.byteLength(first, "utf-8") <= MAX_INDEX_SEGMENT_BYTES);
		assert.deepEqual(indexSegmentAliases(longId), [first]);
		assert.notEqual(first, encodeIndexSegment(`${longId}other`));
	});

	it("hashes Windows session file paths that stay under the byte limit", () => {
		const sessionId = String.raw`C:\Users\theap\.pi\agent\sessions\--C--Users-theap--\2026-08-17T07-29-51-353Z_01a00ea0-72f9-754f-82ca-2b74ded94746.jsonl`;
		assert.ok(Buffer.byteLength(encodeURIComponent(sessionId), "utf-8") <= MAX_INDEX_SEGMENT_BYTES);
		assert.match(encodeIndexSegment(sessionId), /^~sha256-[a-f0-9]{64}$/);
		assert.equal(encodeIndexSegment(sessionId), encodeIndexSegment(sessionId));
		assert.match(encodeIndexSegment("session.jsonl"), /^~sha256-[a-f0-9]{64}$/);
		assert.deepEqual(indexSegmentAliases(sessionId), [encodeIndexSegment(sessionId), encodeURIComponent(sessionId)]);
		assert.deepEqual(indexSegmentAliases("session-a"), ["session-a"]);
	});

	it("indexes and releases active runs with oversized provider tool-call ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-active-index-long-tool-call-"));
		try {
			const asyncDir = path.join(root, "workflow-run");
			const toolCallId = `call_${"opaque/+=".repeat(80)}`;
			assert.ok(Buffer.byteLength(encodeURIComponent(toolCallId), "utf-8") > 255);
			fs.mkdirSync(asyncDir, { recursive: true });

			updateActiveRunIndex(asyncDir, "running", toolCallId);

			assert.deepEqual(readActiveRunToolCallIndex(root, toolCallId), ["workflow-run"]);
			const aliases = fs.readdirSync(path.join(root, ACTIVE_RUN_INDEX_DIR, "tool-calls"));
			assert.equal(aliases.length, 1);
			assert.ok(Buffer.byteLength(aliases[0]!, "utf-8") <= MAX_INDEX_SEGMENT_BYTES);

			releaseActiveRunIndex(asyncDir);
			assert.equal(fs.existsSync(path.join(root, ACTIVE_RUN_INDEX_DIR, "workflow-run")), false);
			assert.deepEqual(readActiveRunToolCallIndex(root, toolCallId), []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws non-missing tool-call index read failures", (t) => {
		const error = new Error("permission denied") as NodeJS.ErrnoException;
		error.code = "EACCES";
		t.mock.method(fsDefault, "readdirSync", () => {
			throw error;
		});
		syncBuiltinESMExports();
		try {
			assert.throws(() => readActiveRunToolCallIndex("/tmp/async", "call-a"), (thrown) => thrown === error);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});

	it("keeps the authoritative marker when optional tool-call indexing fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-active-index-optional-alias-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const asyncDir = path.join(root, "workflow-run");
			const aliasRoot = path.join(root, ACTIVE_RUN_INDEX_DIR, "tool-calls");
			fs.mkdirSync(path.dirname(aliasRoot), { recursive: true });
			fs.writeFileSync(aliasRoot, "not a directory", "utf-8");
			fs.mkdirSync(asyncDir, { recursive: true });

			assert.doesNotThrow(() => updateActiveRunIndex(asyncDir, "running", "call-a"));
			assert.equal(fs.existsSync(path.join(root, ACTIVE_RUN_INDEX_DIR, "workflow-run")), true);
			assert.deepEqual(readActiveRunToolCallIndex(root, "call-a"), []);
			assert.doesNotThrow(() => releaseActiveRunIndex(asyncDir));
		} finally {
			console.error = originalError;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
