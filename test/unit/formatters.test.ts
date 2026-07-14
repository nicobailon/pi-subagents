import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration } from "../../src/shared/formatters.ts";

describe("formatDuration", () => {
	it("truncates displayed durations to whole seconds", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(999), "0s");
		assert.equal(formatDuration(1_000), "1s");
		assert.equal(formatDuration(1_999), "1s");
		assert.equal(formatDuration(2_000), "2s");
	});
});
