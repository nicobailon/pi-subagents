import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	clearExclusions,
	DEFAULT_MODEL_EXCLUSION_TTL_MS,
	filterFallbackCandidates,
	flushPersist,
	getExcludedCount,
	getExclusionsFilePath,
	isExcluded,
	parseModelKey,
	recordModelFailure,
	reloadFromDisk,
	MAX_MODEL_EXCLUSION_TTL_MS,
	setDefaultTTL,
	type ModelExclusion,
} from "../../src/runs/shared/model-exclusions.ts";

// The exclusion store is a process-wide singleton persisted under TEMP_ROOT_DIR
// (isolated per test run by test/support/isolated-temp-root.mjs). Clear it
// before/after each test so cases don't leak state into each other.
beforeEach(() => {
	setDefaultTTL(DEFAULT_MODEL_EXCLUSION_TTL_MS);
	fs.rmSync(getExclusionsFilePath(), { force: true });
	clearExclusions();
});
afterEach(() => clearExclusions());

describe("model exclusions — record & query", () => {
	it("excludes a recorded model", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "429" });
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("does not exclude other models of the same provider when modelId is set", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		assert.equal(isExcluded("gpt-4o", "openai"), false);
	});

	it("does not exclude the same modelId under a different provider", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		assert.equal(isExcluded("gpt-4", "github-copilot"), false);
	});

	it("matches by provider when modelId is omitted", () => {
		recordModelFailure({ provider: "openai", reason: "quota" });
		assert.equal(isExcluded("any-model", "openai"), true);
	});

	it("deduplicates repeated recordings for the same key", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		assert.equal(getExcludedCount(), 1);
	});

	it("tracks distinct keys separately", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		recordModelFailure({ modelId: "claude", provider: "anthropic" });
		assert.equal(getExcludedCount(), 2);
	});
});

describe("model exclusions — TTL expiry", () => {
	it("rejects invalid default TTLs", () => {
		assert.throws(() => setDefaultTTL(0), /finite positive/);
		assert.throws(() => setDefaultTTL(Number.POSITIVE_INFINITY), /finite positive/);
		assert.throws(() => setDefaultTTL(MAX_MODEL_EXCLUSION_TTL_MS + 1), /no greater than/);
	});

	it("keeps the maximum configured expiry representable", () => {
		setDefaultTTL(MAX_MODEL_EXCLUSION_TTL_MS);
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		reloadFromDisk();
		const entry = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.doesNotThrow(() => new Date(entry.expiresAt).toISOString());
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("drops an exclusion after its TTL elapses", async () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", ttlMs: 100 });
		assert.equal(isExcluded("gpt-4", "openai"), true);
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(isExcluded("gpt-4", "openai"), false);
	});

	it("shortens active exclusions without synchronously persisting or extending expiries", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503", ttlMs: 60_000 });
		const before = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		setDefaultTTL(30_000, { shortenExisting: true });
		const beforeFlush = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.equal(beforeFlush.expiresAt, before.expiresAt);
		flushPersist();
		const shortened = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.equal(shortened.expiresAt, shortened.recordedAt + 30_000);

		setDefaultTTL(120_000, { shortenExisting: true });
		flushPersist();
		const notExtended = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.equal(notExtended.expiresAt, shortened.expiresAt);
		assert.ok(shortened.expiresAt < before.expiresAt);
	});
});

describe("model exclusions — parseModelKey", () => {
	it("splits provider and modelId", () => {
		assert.deepEqual(parseModelKey("openai/gpt-4"), { provider: "openai", modelId: "gpt-4" });
	});

	it("strips a thinking suffix before parsing", () => {
		assert.deepEqual(parseModelKey("openai/gpt-5:high"), { provider: "openai", modelId: "gpt-5" });
	});

	it("preserves variant tags before stripping a known thinking suffix", () => {
		assert.deepEqual(parseModelKey("ollama-cloud/deepseek-v4-flash:0731:high"), {
			provider: "ollama-cloud",
			modelId: "deepseek-v4-flash:0731",
		});
	});

	it("keeps slashes inside the modelId", () => {
		assert.deepEqual(parseModelKey("openrouter/google/gemini-flash"), {
			provider: "openrouter",
			modelId: "google/gemini-flash",
		});
	});

	it("handles a bare model id without a provider", () => {
		assert.deepEqual(parseModelKey("gpt-4"), { modelId: "gpt-4" });
	});
});

describe("model exclusions — filtering fallback candidates", () => {
	it("removes excluded candidates from a candidate list", () => {
		const candidates = ["anthropic/claude-3", "openai/gpt-4", "openai/gpt-4o"];
		recordModelFailure({ provider: "openai" });
		const filtered = filterFallbackCandidates(candidates);
		assert.deepEqual(filtered, ["anthropic/claude-3"]);
	});

	it("removes a candidate recorded with a thinking suffix", () => {
		const candidates = ["anthropic/claude-3", "openai/gpt-5:high"];
		recordModelFailure({ modelId: "gpt-5", provider: "openai" });
		const filtered = filterFallbackCandidates(candidates);
		assert.deepEqual(filtered, ["anthropic/claude-3"]);
	});

	it("keeps unexcluded candidates and de-duplicates", () => {
		const candidates = ["anthropic/claude-3", "anthropic/claude-3", "openai/gpt-4"];
		const filtered = filterFallbackCandidates(candidates);
		assert.deepEqual(filtered, ["anthropic/claude-3", "openai/gpt-4"]);
	});

	it("reports the cached reason and expiry for skipped candidates", () => {
		const skipped: Array<{ candidate: string; exclusion: Readonly<ModelExclusion> }> = [];
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 unavailable" });
		const filtered = filterFallbackCandidates(["openai/gpt-4", "anthropic/claude-3"], {
			onExcluded: (candidate, exclusion) => skipped.push({ candidate, exclusion }),
		});
		assert.deepEqual(filtered, ["anthropic/claude-3"]);
		assert.equal(skipped[0]?.candidate, "openai/gpt-4");
		assert.equal(skipped[0]?.exclusion.reason, "503 unavailable");
		assert.ok((skipped[0]?.exclusion.expiresAt ?? 0) > Date.now());
	});
});

describe("model exclusions — persistence", () => {
	it("survives a reload from disk", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "429" });
		reloadFromDisk();
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("persists a recorded model failure before process exit", () => {
		const file = getExclusionsFilePath();
		fs.rmSync(file, { force: true });
		reloadFromDisk();
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "429" });
		assert.equal(fs.existsSync(file), true);
		reloadFromDisk();
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("does not reload expired exclusions", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", ttlMs: 1 });
		flushPersist();
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				reloadFromDisk();
				assert.equal(isExcluded("gpt-4", "openai"), false);
				resolve();
			}, 20);
		});
	});

	it("reports corrupt persisted exclusions and starts empty", () => {
		fs.writeFileSync(getExclusionsFilePath(), "not json", "utf-8");
		const originalError = console.error;
		const errors: unknown[][] = [];
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			reloadFromDisk();
		} finally {
			console.error = originalError;
		}
		assert.equal(getExcludedCount(), 0);
		assert.equal(errors.length, 1);
		assert.match(String(errors[0]?.[0]), /Failed to load exclusions/);
	});

	it("rejects persisted exclusions with invalid timestamps", () => {
		for (const [field, value] of [
			["expiresAt", null],
			["expiresAt", 0],
			["expiresAt", 9_000_000_000_000_000],
			["recordedAt", null],
			["recordedAt", -1],
			["recordedAt", 9_000_000_000_000_000],
		] as const) {
			const now = Date.now();
			const entry = { modelId: "gpt-4", provider: "openai", reason: "503", recordedAt: now, expiresAt: now + 60_000, [field]: value };
			fs.writeFileSync(getExclusionsFilePath(), JSON.stringify({ version: 1, exclusions: [entry] }), "utf-8");
			const originalError = console.error;
			const errors: unknown[][] = [];
			console.error = (...args: unknown[]) => errors.push(args);
			try {
				reloadFromDisk();
			} finally {
				console.error = originalError;
			}
			assert.equal(getExcludedCount(), 0);
			assert.equal(errors.length, 1);
			assert.match(String(errors[0]?.[1]), new RegExp(`invalid ${field}`));
		}
	});

	it("rejects persisted exclusions with non-string reasons", () => {
		for (const reason of [null, 503, { bad: true }, ["503"]]) {
			const now = Date.now();
			fs.writeFileSync(getExclusionsFilePath(), JSON.stringify({
				version: 1,
				exclusions: [{ modelId: "gpt-4", provider: "openai", reason, recordedAt: now, expiresAt: now + 60_000 }],
			}), "utf-8");
			const originalError = console.error;
			const errors: unknown[][] = [];
			console.error = (...args: unknown[]) => errors.push(args);
			try {
				reloadFromDisk();
			} finally {
				console.error = originalError;
			}
			assert.equal(getExcludedCount(), 0);
			assert.equal(errors.length, 1);
			assert.match(String(errors[0]?.[1]), /invalid reason/);
			assert.deepEqual(filterFallbackCandidates(["openai/gpt-4", "anthropic/claude-3"]), ["openai/gpt-4", "anthropic/claude-3"]);
		}
	});
});
