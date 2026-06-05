import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectWatchFiles, createWatchOverlayState, handleWatchOverlayKey } from "../../src/watch/watch-overlay.ts";

describe("watch overlay state", () => {
	it("cycles tabs with tab and shift-tab", () => {
		const state = createWatchOverlayState();
		assert.equal(state.tab, "transcript");
		handleWatchOverlayKey(state, "\t", { totalLines: 0, visibleLines: 10 });
		assert.equal(state.tab, "status");
		handleWatchOverlayKey(state, "\t", { totalLines: 0, visibleLines: 10 });
		assert.equal(state.tab, "log");
		handleWatchOverlayKey(state, "\x1b[Z", { totalLines: 0, visibleLines: 10 });
		assert.equal(state.tab, "status");
	});

	it("returns navigation actions for back and close", () => {
		const state = createWatchOverlayState();
		assert.equal(handleWatchOverlayKey(state, "b", { totalLines: 0, visibleLines: 10 }), "back");
		assert.equal(handleWatchOverlayKey(state, "q", { totalLines: 0, visibleLines: 10 }), "close");
	});

	it("collects transcript, log, root log, and events files for refresh", () => {
		const files = collectWatchFiles({
			sessionFile: "/tmp/session.jsonl",
			outputLog: "/tmp/output-0.log",
			rootLog: "/tmp/root.md",
			eventsFile: "/tmp/events.jsonl",
		} as any);
		assert.deepEqual(files, ["/tmp/session.jsonl", "/tmp/output-0.log", "/tmp/root.md", "/tmp/events.jsonl"]);
	});
});
