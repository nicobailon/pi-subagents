import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readTranscriptEntries } from "../../src/watch/transcript-reader.ts";

describe("readTranscriptEntries", () => {
	it("parses complete JSONL lines and ignores an incomplete trailing line", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-reader-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, [
				JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
				JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } }),
				"{\"type\":\"message\"",
			].join("\n"), "utf-8");

			const result = readTranscriptEntries(file);
			assert.equal(result.entries.length, 2);
			assert.equal(result.warnings.length, 0);
			assert.equal(result.partialTail, true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports malformed complete lines as warnings", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-reader-bad-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, "{bad json}\n", "utf-8");
			const result = readTranscriptEntries(file);
			assert.equal(result.entries.length, 0);
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0]!, /line 1/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an unavailable result for missing files", () => {
		const result = readTranscriptEntries("/tmp/does-not-exist-subagent-watch.jsonl");
		assert.equal(result.available, false);
		assert.match(result.warnings[0]!, /not found/);
	});
});
