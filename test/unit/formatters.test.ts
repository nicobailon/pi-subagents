import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatUsage } from "../../src/shared/formatters.ts";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 1,
};

describe("formatUsage", () => {
	it("does not show a requested-model mismatch for thinking suffix differences", () => {
		assert.equal(
			formatUsage(usage, "openai/gpt-5.5", "openai/gpt-5.5:high"),
			"1 turn in:10 out:5 openai/gpt-5.5",
		);
	});
});
