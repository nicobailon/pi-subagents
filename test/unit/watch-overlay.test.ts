import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWatchOverlayState, handleWatchOverlayKey } from "../../src/watch/watch-overlay.ts";

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
});
