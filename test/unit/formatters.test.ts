import test from "node:test";
import assert from "node:assert/strict";
import { formatContextUsage, formatTokens } from "../../src/shared/formatters.ts";

test("formats million-scale token values with an M suffix", () => {
	assert.equal(formatTokens(999_499), "999k");
	assert.equal(formatTokens(999_500), "1M");
	assert.equal(formatTokens(1_000_000), "1M");
	assert.equal(formatTokens(1_250_000), "1.3M");
});

test("formats million-scale context limits clearly", () => {
	assert.equal(formatContextUsage({ window: 93_000 }, 1_000_000), "ctx 93k/1M (9%)");
});
