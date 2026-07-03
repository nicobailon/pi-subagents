import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkModelScope,
	matchesScopePattern,
	parseModelScopeConfig,
	type ModelScopeConfig,
} from "../../src/runs/shared/model-scope.ts";

describe("matchesScopePattern", () => {
	it("matches an exact provider/id", () => {
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4"), true);
	});

	it("matches a provider wildcard", () => {
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4", "anthropic/*"), true);
		assert.equal(matchesScopePattern("anthropic/claude-haiku-4-5", "anthropic/*"), true);
	});

	it("matches a model-prefix wildcard", () => {
		assert.equal(matchesScopePattern("openai/gpt-5-mini", "openai/gpt-5-*"), true);
		// The dash in the pattern is literal, so the bare id without a trailing part does not match.
		assert.equal(matchesScopePattern("openai/gpt-5", "openai/gpt-5-*"), false);
		assert.equal(matchesScopePattern("openai/gpt-5", "openai/gpt-5*"), true);
	});

	it("does not match across providers", () => {
		assert.equal(matchesScopePattern("deepseek/deepseek-v4", "anthropic/*"), false);
		assert.equal(matchesScopePattern("openai/gpt-5-mini", "anthropic/*"), false);
	});

	it("ignores case on both sides", () => {
		assert.equal(matchesScopePattern("Anthropic/Claude-Sonnet-4", "anthropic/*"), true);
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4", "ANTHROPIC/CLAUDE-*"), true);
	});

	it("strips a thinking suffix before matching", () => {
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4:high", "anthropic/claude-sonnet-4"), true);
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4:high", "anthropic/*"), true);
	});

	it("does not treat arbitrary colon text as a thinking suffix", () => {
		assert.equal(matchesScopePattern("anthropic:claude-opus", "anthropic"), false);
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4:experimental", "anthropic/claude-sonnet-4"), false);
	});

	it("requires a full match, not a substring", () => {
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4", "anthropic/claude"), false);
		assert.equal(matchesScopePattern("anthropic/claude-sonnet-4", "*claude*"), true);
	});
});

describe("checkModelScope", () => {
	const scope: ModelScopeConfig = { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] };

	it("returns undefined when enforcement is off", () => {
		assert.equal(checkModelScope("deepseek/deepseek-v4", { enforce: false, allow: ["anthropic/*"] }, "explicit"), undefined);
		assert.equal(checkModelScope("deepseek/deepseek-v4", undefined, "explicit"), undefined);
	});

	it("returns undefined when no allow list is configured", () => {
		assert.equal(checkModelScope("deepseek/deepseek-v4", { enforce: true }, "explicit"), undefined);
		assert.equal(checkModelScope("deepseek/deepseek-v4", { enforce: true, allow: [] }, "explicit"), undefined);
	});

	it("returns undefined when the model is in scope", () => {
		assert.equal(checkModelScope("anthropic/claude-sonnet-4", scope, "explicit"), undefined);
		assert.equal(checkModelScope("openai/gpt-5-mini:high", scope, "inherited"), undefined);
	});

	it("returns an error violation for an explicit out-of-scope model", () => {
		const violation = checkModelScope("deepseek/deepseek-v4", scope, "explicit");
		assert.equal(violation?.severity, "error");
		assert.equal(violation?.model, "deepseek/deepseek-v4");
		assert.deepEqual(violation?.allowedPatterns, ["anthropic/*", "openai/gpt-5-*"]);
		assert.match(violation?.message ?? "", /outside the configured subagent model scope/);
	});

	it("returns a warn violation for an inherited out-of-scope model", () => {
		const violation = checkModelScope("deepseek/deepseek-v4", scope, "inherited");
		assert.equal(violation?.severity, "warn");
	});

	it("defaults to inherited (warn) severity when source is omitted-ish via inherited", () => {
		// Caller passes "inherited" for frontmatter/parent-inherited models.
		assert.equal(checkModelScope("meta/llama-4", scope, "inherited")?.severity, "warn");
	});

	it("strips the thinking suffix from the reported model", () => {
		const violation = checkModelScope("deepseek/deepseek-v4:high", scope, "explicit");
		assert.equal(violation?.model, "deepseek/deepseek-v4");
	});

	it("returns undefined for an undefined model", () => {
		assert.equal(checkModelScope(undefined, scope, "explicit"), undefined);
	});
});

describe("parseModelScopeConfig", () => {
	const meta = { filePath: "~/.pi/agent/settings.json" };

	it("returns undefined when the field is absent", () => {
		assert.equal(parseModelScopeConfig(undefined, meta), undefined);
	});

	it("parses a well-formed config", () => {
		assert.deepEqual(
			parseModelScopeConfig({ enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] }, meta),
			{ enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] },
		);
	});

	it("parses enforce alone", () => {
		assert.deepEqual(parseModelScopeConfig({ enforce: false }, meta), { enforce: false });
	});

	it("trims allow patterns and drops empties", () => {
		assert.deepEqual(
			parseModelScopeConfig({ enforce: true, allow: ["  anthropic/*  ", "", "  "] }, meta),
			{ enforce: true, allow: ["anthropic/*"] },
		);
	});

	it("rejects a non-object value", () => {
		assert.throws(() => parseModelScopeConfig("anthropic/*", meta), /invalid 'modelScope'/);
		assert.throws(() => parseModelScopeConfig([], meta), /invalid 'modelScope'/);
	});

	it("rejects a non-boolean enforce", () => {
		assert.throws(() => parseModelScopeConfig({ enforce: "yes" }, meta), /invalid 'modelScope.enforce'/);
	});

	it("rejects a non-array allow", () => {
		assert.throws(() => parseModelScopeConfig({ allow: "anthropic/*" }, meta), /invalid 'modelScope.allow'/);
	});

	it("rejects an allow array with non-string entries", () => {
		assert.throws(() => parseModelScopeConfig({ enforce: true, allow: ["anthropic/*", 42] }, meta), /invalid 'modelScope.allow'/);
	});

	it("rejects enforce without a non-empty allow list", () => {
		assert.throws(() => parseModelScopeConfig({ enforce: true }, meta), /without a non-empty 'allow'/);
		assert.throws(() => parseModelScopeConfig({ enforce: true, allow: [] }, meta), /non-empty array of patterns/);
	});
});
