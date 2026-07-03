import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildModelCandidates,
	fuzzyResolveModel,
	isRetryableModelFailure,
	normalizeModelSegment,
	resolveModelCandidate,
	resolveSubagentModelOverride,
} from "../../src/runs/shared/model-fallback.ts";

describe("model fallback helpers", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];

	it("keeps explicit provider/model ids unchanged", () => {
		assert.equal(resolveModelCandidate("openai/gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("resolves a bare id when there is exactly one registry match", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("preserves thinking suffix when resolving a bare id", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini:high", availableModels), "openai/gpt-5-mini:high");
	});

	it("leaves ambiguous bare ids untouched", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous), "gpt-5-mini");
	});

	it("prefers the current provider when an ambiguous bare id exists there", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous, "github-copilot"), "github-copilot/gpt-5-mini");
	});

	it("falls back to the unique registry match when the current provider does not offer the model", () => {
		assert.equal(resolveModelCandidate("claude-sonnet-4", availableModels, "github-copilot"), "anthropic/claude-sonnet-4");
	});

	it("builds a deduplicated ordered candidate list", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"], availableModels),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("applies the current provider preference to fallback candidates too", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["gpt-5-mini", "anthropic/claude-sonnet-4"], ambiguous, "github-copilot"),
			["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("detects retryable provider/model failures", () => {
		assert.equal(isRetryableModelFailure("rate limit exceeded for provider"), true);
		assert.equal(isRetryableModelFailure("model unavailable"), true);
		assert.equal(isRetryableModelFailure("authentication failed"), true);
		assert.equal(isRetryableModelFailure("Subagent produced no output (possible model cold-start or empty response)."), true);
		assert.equal(isRetryableModelFailure("model load failed"), true);
	});

	it("does not treat ordinary task/tool failures as retryable model failures", () => {
		assert.equal(isRetryableModelFailure("bash failed (exit 1): command not found"), false);
		assert.equal(isRetryableModelFailure("read failed (exit 1): no such file or directory"), false);
		assert.equal(isRetryableModelFailure(undefined), false);
	});
});

describe("resolveSubagentModelOverride (cross-session inherit, issue #266)", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];
	const parentModel = { provider: "deepseek", id: "deepseek-v4-flash" };

	it("inherits the parent session model when no model is requested", () => {
		// The crux of the bug: an undefined model must NOT collapse to `undefined`
		// (which leaves the child to read the shared global settings.json), but
		// must pin the parent session's in-memory provider/id.
		assert.equal(
			resolveSubagentModelOverride(undefined, parentModel, availableModels),
			"deepseek/deepseek-v4-flash",
		);
	});

	it("inherits the parent session model when the model is the \"inherit\" sentinel", () => {
		assert.equal(
			resolveSubagentModelOverride("inherit", parentModel, availableModels),
			"deepseek/deepseek-v4-flash",
		);
	});

	it("inherits the parent session model when the agent config sets model: false (delegate)", () => {
		assert.equal(
			resolveSubagentModelOverride(false, parentModel, availableModels),
			"deepseek/deepseek-v4-flash",
		);
	});

	it("treats an empty or whitespace-only model as inherit", () => {
		assert.equal(resolveSubagentModelOverride("", parentModel, availableModels), "deepseek/deepseek-v4-flash");
		assert.equal(resolveSubagentModelOverride("   ", parentModel, availableModels), "deepseek/deepseek-v4-flash");
	});

	it("trims surrounding whitespace from the \"inherit\" sentinel", () => {
		assert.equal(resolveSubagentModelOverride("  inherit  ", parentModel, availableModels), "deepseek/deepseek-v4-flash");
	});

	it("keeps an explicit provider/id model unchanged", () => {
		assert.equal(
			resolveSubagentModelOverride("anthropic/claude-sonnet-4", parentModel, availableModels),
			"anthropic/claude-sonnet-4",
		);
	});

	it("resolves an explicit bare id against the registry, not the parent", () => {
		assert.equal(
			resolveSubagentModelOverride("gpt-5-mini", parentModel, availableModels),
			"openai/gpt-5-mini",
		);
	});

	it("returns undefined when inheriting but no parent model is known", () => {
		// No parent session model available: fall back to the prior behavior of
		// emitting no override rather than inventing an invalid one.
		assert.equal(resolveSubagentModelOverride(undefined, undefined, availableModels), undefined);
		assert.equal(resolveSubagentModelOverride("inherit", undefined, availableModels), undefined);
		assert.equal(resolveSubagentModelOverride(false, undefined, availableModels), undefined);
	});

	it("never emits the literal \"inherit\" string as a model", () => {
		// Regression guard: the old resolveModelCandidate returned "inherit" verbatim
		// (no registry match), which the child rejected and silently fell back to
		// the global default.
		assert.notEqual(resolveSubagentModelOverride("inherit", parentModel, availableModels), "inherit");
		assert.notEqual(resolveSubagentModelOverride("inherit", undefined, availableModels), "inherit");
	});
});

describe("fuzzyResolveModel / normalizeModelSegment", () => {
	const registry = [
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		{ provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5" },
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
	];

	it("normalizes dots, underscores, case, and repeated dashes", () => {
		assert.equal(normalizeModelSegment("Claude.Sonnet_4"), "claude-sonnet-4");
		assert.equal(normalizeModelSegment("GPT--5.Mini"), "gpt-5-mini");
	});

	it("fuzzy-matches a bare id with separator/case differences", () => {
		assert.equal(fuzzyResolveModel("Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(fuzzyResolveModel("claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
	});

	it("fuzzy-matches a bare id with an optional trailing date stamp", () => {
		assert.equal(fuzzyResolveModel("claude-haiku-4-5-20251001", registry), "anthropic/claude-haiku-4-5");
		assert.equal(fuzzyResolveModel("claude-haiku-4-5-2025-10-01", registry), "anthropic/claude-haiku-4-5");
	});

	it("does not strip arbitrary trailing 8-digit numbers as date stamps", () => {
		const numbered = [{ provider: "test", id: "model", fullId: "test/model" }];
		assert.equal(fuzzyResolveModel("model-12345678", numbered), undefined);
	});

	it("fuzzy-matches an undated query against a dated registry id", () => {
		const dated = [
			{ provider: "anthropic", id: "claude-3-5-sonnet-20241022", fullId: "anthropic/claude-3-5-sonnet-20241022" },
			{ provider: "openai", id: "gpt-5-2025-10-01", fullId: "openai/gpt-5-2025-10-01" },
		];
		assert.equal(fuzzyResolveModel("claude-3-5-sonnet", dated), "anthropic/claude-3-5-sonnet-20241022");
		assert.equal(fuzzyResolveModel("gpt-5", dated), "openai/gpt-5-2025-10-01");
	});

	it("fuzzy-matches a qualified provider/id with case/separator differences", () => {
		assert.equal(fuzzyResolveModel("Anthropic/Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(fuzzyResolveModel("Anthropic:Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(fuzzyResolveModel("anthropic.claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
		assert.equal(fuzzyResolveModel("anthropic/claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
	});

	it("does not switch providers for a qualified query", () => {
		// Named provider has no such model; do not fall back to another provider.
		assert.equal(fuzzyResolveModel("openai/claude-sonnet-4", registry), undefined);
		assert.equal(fuzzyResolveModel("github-copilot/claude-haiku-4-5", registry), undefined);
	});

	it("prefers the current provider for an ambiguous bare fuzzy id", () => {
		assert.equal(fuzzyResolveModel("GPT.5.Mini", registry, "github-copilot"), "github-copilot/gpt-5-mini");
	});

	it("returns undefined for an ambiguous bare fuzzy id with no preferred provider", () => {
		assert.equal(fuzzyResolveModel("gpt-5-mini", registry), undefined);
	});

	it("returns undefined when nothing fuzzy-matches", () => {
		assert.equal(fuzzyResolveModel("does-not-exist", registry), undefined);
		assert.equal(fuzzyResolveModel("anthropic/does-not-exist", registry), undefined);
	});
});

describe("resolveModelCandidate fuzzy fallback", () => {
	const registry = [
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		{ provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5" },
	];

	it("resolves a bare id with case/separator differences via fuzzy fallback", () => {
		assert.equal(resolveModelCandidate("Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(resolveModelCandidate("claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
	});

	it("resolves a bare id with a trailing date stamp via fuzzy fallback", () => {
		assert.equal(resolveModelCandidate("claude-haiku-4-5-20251001", registry), "anthropic/claude-haiku-4-5");
	});

	it("resolves a qualified provider/id with case differences via fuzzy fallback", () => {
		assert.equal(resolveModelCandidate("Anthropic/Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(resolveModelCandidate("Anthropic:Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
	});

	it("preserves the thinking suffix through fuzzy resolution", () => {
		assert.equal(resolveModelCandidate("claude.haiku.4.5:high", registry), "anthropic/claude-haiku-4-5:high");
		assert.equal(resolveModelCandidate("anthropic:claude.sonnet.4:high", registry), "anthropic/claude-sonnet-4:high");
	});

	it("still prefers exact registry matches over fuzzy", () => {
		assert.equal(resolveModelCandidate("anthropic/claude-sonnet-4", registry), "anthropic/claude-sonnet-4");
	});

	it("leaves an unknown qualified model unchanged instead of switching providers", () => {
		assert.equal(resolveModelCandidate("openai/claude-sonnet-4", registry), "openai/claude-sonnet-4");
	});

	it("leaves an unknown bare id unchanged when no fuzzy match exists", () => {
		assert.equal(resolveModelCandidate("does-not-exist", registry), "does-not-exist");
	});
});

describe("resolveSubagentModelOverride scope enforcement", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		{ provider: "deepseek", id: "deepseek-v4", fullId: "deepseek/deepseek-v4" },
	];
	const parentModel = { provider: "deepseek", id: "deepseek-v4" };
	const scope = { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] } as const;

	it("is a no-op when scope is not enforced", () => {
		assert.equal(
			resolveSubagentModelOverride("deepseek/deepseek-v4", parentModel, availableModels, undefined, { scope: { enforce: false, allow: ["anthropic/*"] }, source: "explicit" }),
			"deepseek/deepseek-v4",
		);
	});

	it("throws for an explicit out-of-scope model", () => {
		assert.throws(
			() => resolveSubagentModelOverride("deepseek/deepseek-v4", parentModel, availableModels, undefined, { scope, source: "explicit" }),
			/outside the configured subagent model scope/,
		);
	});

	it("warns (and still returns the model) for an inherited out-of-scope model", () => {
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("deepseek/deepseek-v4", parentModel, availableModels, undefined, {
			scope,
			source: "inherited",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "deepseek/deepseek-v4");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /outside the configured subagent model scope/);
	});

	it("warns for an inherited parent-session model that is out of scope", () => {
		const warnings: string[] = [];
		// No explicit model requested: inherits the parent (deepseek), which is out of scope.
		const resolved = resolveSubagentModelOverride(undefined, parentModel, availableModels, undefined, {
			scope,
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "deepseek/deepseek-v4");
		assert.equal(warnings.length, 1);
	});

	it("passes through an in-scope explicit model without warning or error", () => {
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("gpt-5-mini", parentModel, availableModels, undefined, {
			scope,
			source: "explicit",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "openai/gpt-5-mini");
		assert.equal(warnings.length, 0);
	});

	it("checks the resolved (canonicalized) model against the scope", () => {
		// Fuzzy-resolves Claude-Sonnet-4 -> anthropic/claude-sonnet-4, which is in scope.
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("Claude-Sonnet-4", parentModel, availableModels, undefined, {
			scope,
			source: "explicit",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "anthropic/claude-sonnet-4");
		assert.equal(warnings.length, 0);
	});

	it("ignores a thinking suffix when checking scope", () => {
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("gpt-5-mini:high", parentModel, availableModels, undefined, {
			scope,
			source: "explicit",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "openai/gpt-5-mini:high");
		assert.equal(warnings.length, 0);
	});

	it("warns for out-of-scope fallback models while keeping them available", () => {
		const warnings: string[] = [];
		const candidates = buildModelCandidates("gpt-5-mini", ["deepseek/deepseek-v4"], availableModels, undefined, {
			scope,
			onWarn: (v) => warnings.push(v.message),
		});
		assert.deepEqual(candidates, ["openai/gpt-5-mini", "deepseek/deepseek-v4"]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /deepseek\/deepseek-v4/);
	});
});
