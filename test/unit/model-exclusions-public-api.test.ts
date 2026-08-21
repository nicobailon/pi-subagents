import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	EXCLUSIONS_PATH_ENV,
	clearExclusions,
	clearExpiredExclusions,
	filterFallbackCandidates,
	flushPersist,
	getExcludedCount,
	getExclusionsFilePath,
	isExcluded,
	parseModelKey,
	recordModelFailure,
	reloadFromDisk,
	setDefaultTTL,
	type ModelExclusion,
	type RecordModelFailureOptions,
} from "pi-subagents/model-exclusions";
import * as internal from "../../src/runs/shared/model-exclusions.ts";

// The exclusion store is a process-wide singleton; clear it before/after each
// test so cases don't leak state into each other (same pattern as
// test/unit/model-exclusions.test.ts).
beforeEach(() => {
	fs.rmSync(getExclusionsFilePath(), { force: true });
	clearExclusions();
});
afterEach(() => clearExclusions());

describe("public model-exclusions package export", () => {
	it("exposes the exclusion store surface", () => {
		assert.equal(EXCLUSIONS_PATH_ENV, "PI_MODEL_EXCLUSIONS_PATH");
		assert.equal(typeof clearExclusions, "function");
		assert.equal(typeof clearExpiredExclusions, "function");
		assert.equal(typeof filterFallbackCandidates, "function");
		assert.equal(typeof flushPersist, "function");
		assert.equal(typeof getExcludedCount, "function");
		assert.equal(typeof getExclusionsFilePath, "function");
		assert.equal(typeof isExcluded, "function");
		assert.equal(typeof parseModelKey, "function");
		assert.equal(typeof recordModelFailure, "function");
		assert.equal(typeof reloadFromDisk, "function");
		assert.equal(typeof setDefaultTTL, "function");
	});

	it("shares the same store instance as the internal module", () => {
		const options: RecordModelFailureOptions = { modelId: "gpt-5", provider: "openai", reason: "429" };
		recordModelFailure(options);
		assert.equal(internal.isExcluded("gpt-5", "openai"), true);
		assert.equal(internal.getExcludedCount(), 1);
		internal.clearExclusions();
		assert.equal(getExcludedCount(), 0);
	});

	it("records and filters excluded candidates through the public surface", () => {
		recordModelFailure({ modelId: "gpt-5", provider: "openai", reason: "rate limit" });
		assert.equal(isExcluded("gpt-5", "openai"), true);
		assert.deepEqual(filterFallbackCandidates(["openai/gpt-5", "anthropic/claude-sonnet-4-6"]), [
			"anthropic/claude-sonnet-4-6",
		]);
	});

	it("persists exclusions to the public file path", () => {
		recordModelFailure({ provider: "anthropic", reason: "timeout" });
		flushPersist();
		const raw = fs.readFileSync(getExclusionsFilePath(), "utf-8");
		const parsed = JSON.parse(raw) as { exclusions: ModelExclusion[] };
		assert.equal(parsed.exclusions.length, 1);
		assert.equal(parsed.exclusions[0]?.provider, "anthropic");
	});

	it("parses provider/model keys", () => {
		assert.deepEqual(parseModelKey("openrouter/google/gemini-flash"), {
			provider: "openrouter",
			modelId: "google/gemini-flash",
		});
		assert.deepEqual(parseModelKey("gpt-5"), { modelId: "gpt-5" });
	});
});
