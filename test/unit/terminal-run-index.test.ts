import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { encodeIndexSegment } from "../../src/runs/background/index-segment.ts";
import { readRecentTerminalRunIndex, TERMINAL_RUN_INDEX_DIR, updateTerminalRunIndex } from "../../src/runs/background/terminal-run-index.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

describe("terminal run index", () => {
	it("skips markers that ended before endedAfter without reading them", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-terminal-index-"));
		try {
			const sessionId = "session-ended-after";
			const writeRun = (runId: string, endedAt: number) => {
				const status = { runId, sessionId, mode: "workflow", state: "failed", startedAt: endedAt - 1, endedAt } satisfies Partial<AsyncStatus>;
				fs.mkdirSync(path.join(root, runId), { recursive: true });
				fs.writeFileSync(path.join(root, runId, "status.json"), JSON.stringify(status));
				updateTerminalRunIndex(path.join(root, runId), status as AsyncStatus);
			};
			writeRun("recent", 5_000);
			writeRun("old", 1_000);
			// An unreadable marker is removed when read, so its survival proves it was not read.
			const sessionDir = path.join(root, TERMINAL_RUN_INDEX_DIR, encodeIndexSegment(sessionId));
			const oldMarker = fs.readdirSync(sessionDir).find((name) => name.endsWith(`-${encodeIndexSegment("old")}.json`))!;
			fs.writeFileSync(path.join(sessionDir, oldMarker), "{not json");

			assert.deepEqual(readRecentTerminalRunIndex(root, { sessionId, endedAfter: 2_000 }), ["recent"]);
			assert.equal(fs.existsSync(path.join(sessionDir, oldMarker)), true, "the old marker was not read");
			assert.deepEqual(readRecentTerminalRunIndex(root, { sessionId, endedAfter: 5_000 }), ["recent"], "a run that ended exactly then is kept");
			assert.deepEqual(readRecentTerminalRunIndex(root, { sessionId }), ["recent"]);
			assert.equal(fs.existsSync(path.join(sessionDir, oldMarker)), false, "without endedAfter it is read, and removed as invalid");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
