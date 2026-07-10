import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recommendStrongWatchdogModel, resolveWatchdogModelInput } from "../../src/watchdog/model-selection.ts";

function createCtx(
	current: { provider: string; id: string },
	authenticated: string[] = ["openai-codex/gpt-5.5", "anthropic/claude-opus-4-8"],
	models: Array<{ provider: string; id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }> = [
		{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
		{ provider: "anthropic", id: "claude-opus-4-8", reasoning: true },
	],
) {
	return {
		cwd: "/tmp/watchdog-model-selection",
		model: current,
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: { provider: string; id: string }) => authenticated.includes(`${model.provider}/${model.id}`),
		},
	} as never;
}

describe("watchdog model selection", () => {
	it("recommends Opus 4.8 high when the main session is GPT 5.5", () => {
		const recommendation = recommendStrongWatchdogModel(createCtx({ provider: "openai-codex", id: "gpt-5.5" }));

		assert.equal(recommendation.model, "anthropic/claude-opus-4-8");
		assert.equal(recommendation.thinking, "high");
	});

	it("recommends GPT 5.5 high when the main session is Opus 4.8", () => {
		const recommendation = recommendStrongWatchdogModel(createCtx({ provider: "anthropic", id: "claude-opus-4-8" }));

		assert.equal(recommendation.model, "openai-codex/gpt-5.5");
		assert.equal(recommendation.thinking, "high");
	});

	it("requires the complementary strong model to be authenticated", () => {
		assert.throws(
			() => recommendStrongWatchdogModel(createCtx({ provider: "openai-codex", id: "gpt-5.5" }, ["openai-codex/gpt-5.5"])),
			/No authenticated strong complementary watchdog model/,
		);
	});

	it("does not treat GPT 5.5 mini variants as the strong GPT 5.5 watchdog", () => {
		const models = [
			{ provider: "openai-codex", id: "gpt-5.5-mini", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.5-20250101-mini", reasoning: true },
		];
		const ctx = {
			cwd: "/tmp/watchdog-model-selection",
			model: { provider: "anthropic", id: "claude-opus-4-8" },
			modelRegistry: {
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: (model: { provider: string; id: string }) => `${model.provider}/${model.id}` === "openai-codex/gpt-5.5-mini" || `${model.provider}/${model.id}` === "openai-codex/gpt-5.5-20250101-mini",
			},
		} as never;

		assert.throws(
			() => recommendStrongWatchdogModel(ctx),
			/No authenticated strong complementary watchdog model/,
		);
	});

	it("does not treat dated Opus mini variants as the strong Opus 4.8 watchdog", () => {
		const models = [{ provider: "anthropic", id: "claude-opus-4-8-20250101-mini", reasoning: true }];
		const ctx = {
			cwd: "/tmp/watchdog-model-selection",
			model: { provider: "openai-codex", id: "gpt-5.5" },
			modelRegistry: {
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: (model: { provider: string; id: string }) => `${model.provider}/${model.id}` === "anthropic/claude-opus-4-8-20250101-mini",
			},
		} as never;

		assert.throws(
			() => recommendStrongWatchdogModel(ctx),
			/No authenticated strong complementary watchdog model/,
		);
	});

	it("does not treat cheap-prefixed variants as strong watchdog families", () => {
		const models = [
			{ provider: "openai-codex", id: "cheap-gpt-5.5", reasoning: true },
			{ provider: "anthropic", id: "cheap-claude-opus-4-8", reasoning: true },
		];
		const ctx = {
			cwd: "/tmp/watchdog-model-selection",
			model: { provider: "anthropic", id: "claude-opus-4-8" },
			modelRegistry: {
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: (model: { provider: string; id: string }) => `${model.provider}/${model.id}` === "openai-codex/cheap-gpt-5.5" || `${model.provider}/${model.id}` === "anthropic/cheap-claude-opus-4-8",
			},
		} as never;

		assert.throws(
			() => recommendStrongWatchdogModel(ctx),
			/No authenticated strong complementary watchdog model/,
		);
	});

	it("canonicalizes explicit models and preserves thinking suffixes", () => {
		const resolved = resolveWatchdogModelInput(createCtx({ provider: "anthropic", id: "claude-opus-4-8" }), "openai-codex/gpt-5-5:high");

		assert.equal(resolved.model, "openai-codex/gpt-5.5");
		assert.equal(resolved.thinking, "high");
	});

	it("accepts a max suffix for an authenticated watchdog model", () => {
		const ctx = createCtx(
			{ provider: "openai", id: "gpt-5" },
			["openai/gpt-5"],
			[{ provider: "openai", id: "gpt-5", reasoning: true, thinkingLevelMap: { max: "max" } }],
		);
		assert.equal(resolveWatchdogModelInput(ctx, "openai/gpt-5:max").thinking, "max");
	});
});
