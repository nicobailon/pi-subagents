import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWatchScrollState, getVisibleRange, scrollWatchState } from "../../src/watch/watch-scroll.ts";

describe("watch scroll state", () => {
	it("uses offset 0 as bottom/tail", () => {
		const state = createWatchScrollState();
		const range = getVisibleRange(state, 100, 10);
		assert.deepEqual(range, { start: 90, end: 100 });
	});

	it("scrolls by page and line from the bottom", () => {
		const state = createWatchScrollState();
		scrollWatchState(state, "pageUp", 100, 10);
		assert.equal(state.scrollOffset, 10);
		scrollWatchState(state, "lineUp", 100, 10);
		assert.equal(state.scrollOffset, 11);
		scrollWatchState(state, "pageDown", 100, 10);
		assert.equal(state.scrollOffset, 1);
		scrollWatchState(state, "lineDown", 100, 10);
		assert.equal(state.scrollOffset, 0);
	});

	it("clamps offsets when content shrinks", () => {
		const state = createWatchScrollState();
		scrollWatchState(state, "pageUp", 100, 10);
		scrollWatchState(state, "pageUp", 100, 10);
		assert.equal(state.scrollOffset, 20);
		const range = getVisibleRange(state, 12, 10);
		assert.deepEqual(range, { start: 0, end: 10 });
		assert.equal(state.scrollOffset, 2);
	});
});
