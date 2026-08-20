import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, toModelInfo, type ModelInfo } from "../../src/shared/model-info.ts";

describe("model info helpers", () => {
	const ambiguousModels: ModelInfo[] = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true, thinkingLevelMap: { high: "high" } },
		{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini", reasoning: true, thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh" } },
	];

	it("does not choose arbitrary metadata for ambiguous bare model ids", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels), undefined);
	});

	it("uses the preferred provider for ambiguous bare model metadata", () => {
		assert.equal(findModelInfo("gpt-5-mini", ambiguousModels, "github-copilot")?.fullId, "github-copilot/gpt-5-mini");
	});

	it("matches provider-qualified model metadata before bare ids", () => {
		assert.equal(findModelInfo("openai/gpt-5-mini:high", ambiguousModels, "github-copilot")?.fullId, "openai/gpt-5-mini");
	});

	it("matches owner/name registry ids without treating the owner as a provider", () => {
		const hfModels: ModelInfo[] = [
			{
				provider: "huggingface",
				id: "thinkingmachines/Inkling",
				fullId: "huggingface/thinkingmachines/Inkling",
				reasoning: true,
			},
		];
		assert.equal(findModelInfo("thinkingmachines/Inkling", hfModels)?.fullId, "huggingface/thinkingmachines/Inkling");
		assert.equal(
			findModelInfo("huggingface/thinkingmachines/Inkling", hfModels)?.fullId,
			"huggingface/thinkingmachines/Inkling",
		);
	});

	it("preserves registry API metadata", () => {
		assert.equal(toModelInfo({ provider: "gateway", id: "model", api: "anthropic-messages" }).api, "anthropic-messages");
	});

	it("keeps the legacy thinking list for models without per-level metadata", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: true }),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
		assert.deepEqual(getSupportedThinkingLevels(undefined), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("keeps the legacy thinking list when older model metadata omits reasoning", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }),
			["off", "minimal", "low", "medium", "high", "xhigh"],
		);
	});

	it("filters levels only when per-level metadata is present", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "deepseek",
				id: "deepseek-v4-pro",
				fullId: "deepseek/deepseek-v4-pro",
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
			}),
			["off", "high", "xhigh"],
		);
	});

	it("honors metadata that marks off unsupported", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "always-thinking",
				id: "model",
				fullId: "always-thinking/model",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
			}),
			["high"],
		);
	});

	it("honors an explicit max mapping and recognizes max suffixes", () => {
		assert.deepEqual(
			getSupportedThinkingLevels({
				provider: "openai",
				id: "gpt-5",
				fullId: "openai/gpt-5",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" },
			}),
			["max"],
		);
		assert.deepEqual(
			splitKnownThinkingSuffix("openai/gpt-5:max"),
			{ baseModel: "openai/gpt-5", thinkingSuffix: ":max" },
		);
	});
});

describe("toModelInfo registry fields", () => {
	it("carries contextWindow, maxTokens, input, and cost from the registry", () => {
		const info = toModelInfo({
			provider: "openai",
			id: "gpt-5-mini",
			api: "openai-responses",
			reasoning: true,
			contextWindow: 272000,
			maxTokens: 128000,
			input: ["text", "image"],
			cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
		});
		assert.equal(info.contextWindow, 272000);
		assert.equal(info.maxTokens, 128000);
		assert.deepEqual(info.input, ["text", "image"]);
		assert.deepEqual(info.cost, { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 });
	});

	it("omits fields the registry does not report", () => {
		const info = toModelInfo({ provider: "local", id: "custom-model" });
		assert.equal(info.fullId, "local/custom-model");
		assert.equal("contextWindow" in info, false);
		assert.equal("maxTokens" in info, false);
		assert.equal("input" in info, false);
		assert.equal("cost" in info, false);
	});

	it("ignores non-positive or malformed registry values", () => {
		const info = toModelInfo({
			provider: "local",
			id: "broken",
			contextWindow: 0,
			maxTokens: -1,
			input: [],
			cost: { input: Number.NaN, output: 1 },
		});
		assert.equal("contextWindow" in info, false);
		assert.equal("maxTokens" in info, false);
		assert.equal("input" in info, false);
		assert.equal("cost" in info, false);
	});

	it("copies the input array instead of aliasing the registry entry", () => {
		const registryInput = ["text"];
		const info = toModelInfo({ provider: "local", id: "m", input: registryInput });
		assert.notEqual(info.input, registryInput);
		assert.deepEqual(info.input, ["text"]);
	});

	it("preserves and copies tiered registry cost", () => {
		const tiers = [{ inputTokensAbove: 100_000, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }];
		const info = toModelInfo({
			provider: "openai",
			id: "tiered",
			cost: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0.1, tiers },
		});
		assert.deepEqual(info.cost?.tiers, tiers);
		assert.notEqual(info.cost?.tiers, tiers);
		assert.notEqual(info.cost?.tiers?.[0], tiers[0]);
	});
});
