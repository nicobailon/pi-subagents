import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatSubagentModelVerificationError,
	fuzzyResolveModel,
	isContextOverflow,
	normalizeModelSegment,
	normalizeParentModel,
	resolveEffectiveSubagentModel,
	resolveModelCandidate,
	resolveModelSelection,
	resolveSubagentModelOverride,
} from "../../src/runs/shared/model-resolution.ts";
import { resolveModelScopesForAgent } from "../../src/runs/shared/model-scope.ts";

const models = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	{ provider: "openai", id: "shared", fullId: "openai/shared" },
	{ provider: "anthropic", id: "shared", fullId: "anthropic/shared" },
	{ provider: "huggingface", id: "org/model-v1", fullId: "huggingface/org/model-v1" },
];

describe("single model resolution", () => {
	it("resolves exactly one configured model and preserves thinking suffixes", () => {
		assert.deepEqual(resolveModelSelection("gpt-5-mini", models), {
			model: "openai/gpt-5-mini",
			requestedModel: "gpt-5-mini",
		});
		assert.equal(resolveModelCandidate("gpt-5-mini:high", models), "openai/gpt-5-mini:high");
	});

	it("inherits the current parent model for omitted, false, empty, and inherit values", () => {
		const parent = normalizeParentModel({ provider: "anthropic", id: "claude-sonnet-4" });
		for (const requested of [undefined, false, "", "  ", "inherit", " inherit "] as const) {
			assert.equal(resolveSubagentModelOverride(requested, parent, models), "anthropic/claude-sonnet-4");
		}
		assert.equal(resolveEffectiveSubagentModel(undefined, undefined, parent, models), "anthropic/claude-sonnet-4");
		assert.equal(resolveSubagentModelOverride("inherit", undefined, models), undefined);
	});

	it("resolves explicit models against the registry instead of the parent", () => {
		const parent = { provider: "anthropic", id: "claude-sonnet-4" };
		assert.equal(resolveSubagentModelOverride("gpt-5-mini", parent, models, undefined, { source: "explicit" }), "openai/gpt-5-mini");
		assert.equal(resolveSubagentModelOverride("openai/gpt-5-mini", parent, models, undefined, { source: "explicit" }), "openai/gpt-5-mini");
	});

	it("uses provider preference for ambiguous bare and owner/name ids", () => {
		assert.equal(resolveModelCandidate("shared", models), "shared");
		assert.equal(resolveModelCandidate("shared", models, "anthropic"), "anthropic/shared");
		assert.equal(resolveModelCandidate("org/model-v1", models), "huggingface/org/model-v1");
	});

	it("rejects unknown explicit/configured models and suggests a unique alternate provider", () => {
		assert.throws(
			() => resolveSubagentModelOverride("openai/claude-sonnet-4", undefined, models, undefined, { source: "explicit" }),
			/Unknown subagent model 'openai\/claude-sonnet-4'.*Did you mean 'anthropic\/claude-sonnet-4'/,
		);
		assert.throws(() => resolveModelSelection("missing", models), /Unknown subagent model 'missing'/);
		assert.equal(resolveEffectiveSubagentModel("missing", "gpt-5-mini", undefined, models, undefined, { source: "inherited" }), "missing");
	});

	it("normalizes registry spelling without switching a qualified provider", () => {
		assert.equal(normalizeModelSegment("GPT_5--MINI"), "gpt-5-mini");
		assert.equal(fuzzyResolveModel("GPT_5_MINI", models), "openai/gpt-5-mini");
		assert.equal(resolveModelCandidate("openai/claude-sonnet-4", models), "openai/claude-sonnet-4");
	});

	it("resolves ids that already carry their provider prefix within that provider", () => {
		const registry = [
			{ provider: "openrouter", id: "openrouter/auto-beta", fullId: "openrouter/openrouter/auto-beta" },
			{ provider: "openrouter", id: "auto", fullId: "openrouter/auto" },
			{ provider: "other", id: "openrouter/free", fullId: "other/openrouter/free" },
		];
		assert.equal(resolveModelSelection("openrouter/auto-beta", registry).model, "openrouter/openrouter/auto-beta");
		assert.equal(resolveModelSelection("OpenRouter/Auto_Beta", registry).model, "openrouter/openrouter/auto-beta");
		assert.equal(resolveModelSelection("openrouter/auto", registry).model, "openrouter/auto");
		assert.throws(() => resolveModelSelection("openrouter/free", registry), /Unknown subagent model 'openrouter\/free'/);
		// An ordinary id that already resolved keeps winning over a provider-prefixed one.
		const collision = [...registry, { provider: "openrouter", id: "auto_beta", fullId: "openrouter/auto_beta" }];
		assert.equal(resolveModelSelection("OpenRouter/Auto-Beta", collision).model, "openrouter/auto_beta");
	});

	it("fuzzy matches case, separators, dates, and owner/name ids", () => {
		const registry = [
			{ provider: "openai", id: "GPT_5.Mini-2025-10-01", fullId: "openai/GPT_5.Mini-2025-10-01" },
			{ provider: "huggingface", id: "Org/Model_One", fullId: "huggingface/Org/Model_One" },
		];
		assert.equal(fuzzyResolveModel("gpt-5-mini", registry), "openai/GPT_5.Mini-2025-10-01");
		assert.equal(fuzzyResolveModel("openai/gpt-5-mini-20251001", registry), "openai/GPT_5.Mini-2025-10-01");
		assert.equal(fuzzyResolveModel("org/model-one", registry), "huggingface/Org/Model_One");
		assert.equal(fuzzyResolveModel("missing", registry), undefined);
	});

	it("enforces explicit and strict scopes while warning for inherited violations", () => {
		const scope = resolveModelScopesForAgent({ allow: ["anthropic/*"], enforce: true }, "worker", undefined);
		assert.throws(() => resolveModelSelection("openai/gpt-5-mini", models, undefined, { scope, origin: "explicit" }), /outside the configured subagent model scope/);
		const warnings: string[] = [];
		assert.equal(resolveSubagentModelOverride("openai/gpt-5-mini", undefined, models, undefined, {
			scope,
			source: "inherited",
			onWarn: (violation) => warnings.push(violation.message),
		}), "openai/gpt-5-mini");
		assert.equal(warnings.length, 1);
		const strict = resolveModelScopesForAgent({ allow: ["anthropic/*"], enforce: true, strict: true }, "worker", undefined);
		assert.throws(() => resolveModelSelection("openai/gpt-5-mini", models, undefined, { scope: strict, origin: "inherited" }), /outside the configured subagent model scope/);
	});

	it("fails closed when enforced inherit has no parent model", () => {
		const scope = resolveModelScopesForAgent({ allow: ["inherit"], enforce: true }, "worker", undefined);
		assert.throws(() => resolveModelSelection(undefined, models, undefined, { scope }), /'inherit' requires a current parent session model/);
	});
});

describe("model response identity", () => {
	it("accepts exact, bare, leaf, and declared alias response ids", () => {
		assert.equal(formatSubagentModelVerificationError("openai/gpt-5-mini:high", "gpt-5-mini", models), undefined);
		assert.equal(formatSubagentModelVerificationError("huggingface/org/model-v1", "model-v1", models), undefined);
		assert.equal(formatSubagentModelVerificationError("openai/gpt-5-mini", "gateway-model", models, {
			"openai/gpt-5-mini": ["gateway-model"],
		}), undefined);
	});

	it("rejects a different response route and does not apply another model's alias", () => {
		assert.match(formatSubagentModelVerificationError("openai/gpt-5-mini", "anthropic/claude-sonnet-4", models) ?? "", /model_verification_failed/);
		assert.match(formatSubagentModelVerificationError("openai/gpt-5-mini", "gateway-model", models, {
			"anthropic/claude-sonnet-4": ["gateway-model"],
		}) ?? "", /model_verification_failed/);
	});
});

describe("context overflow classification", () => {
	it("detects common context overflow errors", () => {
		for (const error of ["maximum context length exceeded", "context window overflow", "too many tokens", "context_length_exceeded", "input too long"]) {
			assert.equal(isContextOverflow(error), true, error);
		}
	});

	it("does not classify tool failures, provider failures, or empty input as overflow", () => {
		assert.equal(isContextOverflow("bash failed (exit 1): input too long"), false);
		assert.equal(isContextOverflow("429 rate limit exceeded"), false);
		assert.equal(isContextOverflow(undefined), false);
	});
});
