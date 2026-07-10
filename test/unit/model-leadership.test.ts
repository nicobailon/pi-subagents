import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLeadership, selectModelFromLeadership, resolveLeadershipConfigOrDefault } from "../../src/model-leadership/builder.ts";
import type { LeadershipArtifact, RankingsSnapshot } from "../../src/model-leadership/types.ts";

const snapshotPath = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "llm-rankings-snapshot.json");
const leadershipPath = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "model-leadership.json");

function buildSnapshot(): RankingsSnapshot {
	const content = readFileSync(snapshotPath, "utf-8");
	return JSON.parse(content) as RankingsSnapshot;
}

function buildLeadershipArtifact(config?: { preferFree?: boolean; defaultCategory?: string; maxResults?: number }) {
	const snapshot = buildSnapshot();
	const piModels = [
		{
			id: "test/available-free",
			fullId: "provider/test/available-free",
			provider: "provider",
			name: "Available Free",
			isFree: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			family: "test",
			categories: ["coding"],
			available: true,
		},
		{
			id: "test/available-paid",
			fullId: "provider/test/available-paid",
			provider: "provider",
			name: "Available Paid",
			isFree: false,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			family: "test",
			categories: ["coding"],
			available: true,
		},
		{
			id: "test/unavailable",
			fullId: "provider/test/unavailable",
			provider: "provider",
			name: "Unavailable",
			isFree: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			family: "test",
			categories: [],
			available: false,
		},
	];
	return buildLeadership(snapshot, piModels, { preferences: config }, snapshotPath);
}

describe("resolveLeadershipConfigOrDefault", () => {
	it("resolves defaults when config is missing", () => {
		const config = resolveLeadershipConfigOrDefault(undefined);
		assert.deepEqual(config.preferences, { preferFree: true, defaultCategory: "coding", maxResults: 50, paidSortRule: { strategy: "priority" } });
	});

	it("merges user preferences over defaults", () => {
		const config = resolveLeadershipConfigOrDefault({
			preferences: { preferFree: false, defaultCategory: "writing", maxResults: 10 },
		});
		assert.deepEqual(config.preferences, { preferFree: false, defaultCategory: "writing", maxResults: 10, paidSortRule: { strategy: "priority" } });
	});

	it("normalizes invalid maxResults to 50", () => {
		const config = resolveLeadershipConfigOrDefault({
			preferences: { maxResults: 0 },
		});
		assert.equal(config.preferences?.maxResults, 50);
	});
});

describe("selectModelFromLeadership", () => {
	it("returns the top-ranked available model for the default category", () => {
		let artifact = buildLeadershipArtifact();
		const modelId = selectModelFromLeadership(artifact);
		assert.ok(modelId, "expected a model id");
	});

	it("prefers free models when configured", () => {
		const artifact = buildLeadershipArtifact({ preferFree: true });
		const modelId = selectModelFromLeadership(artifact);
		assert.ok(modelId?.includes("available-free") ?? false, "expected free model");
	});

	it("prefers free models even when paid model outranks them in snapshot", () => {
		// Create a mock snapshot where paid model has better rank than free model
		const mockSnapshot: RankingsSnapshot = {
			generatedAt: new Date().toISOString(),
			source: "test",
			categories: { coding: { id: "coding" } },
			rankings: {
				coding: {
					category: "coding",
					method: "test",
					rankedAt: new Date().toISOString(),
					rows: [
						{ rank: 1, modelId: "test/available-paid", modelName: "Available Paid", organization: "test", conservativeRating: 90, score: 90, openWeight: false, minInputPrice: 1, benchmarksEvaluated: 1, source: "test", url: null },
						{ rank: 5, modelId: "test/available-free", modelName: "Available Free", organization: "test", conservativeRating: 80, score: 80, openWeight: true, minInputPrice: 0, benchmarksEvaluated: 1, source: "test", url: null },
					],
				},
			},
			modelsSummary: [],
			benchmarksSummary: null,
		};
		const piModels = [
			{
				id: "test/available-free",
				fullId: "provider/test/available-free",
				provider: "provider",
				name: "Available Free",
				isFree: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				family: "test",
				categories: ["coding"],
				available: true,
			},
			{
				id: "test/available-paid",
				fullId: "provider/test/available-paid",
				provider: "provider",
				name: "Available Paid",
				isFree: false,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				family: "test",
				categories: ["coding"],
				available: true,
			},
		];
		const artifact = buildLeadership(mockSnapshot, piModels, { preferences: { preferFree: true } }, snapshotPath);
		const modelId = selectModelFromLeadership(artifact);
		assert.ok(modelId?.includes("available-free") ?? false, "expected free model to win despite worse rank when preferFree=true");
	});

	it("honors preferFree from the leadership artifact config", () => {
		const artifact = buildLeadershipArtifact({ preferFree: false });
		const modelId = selectModelFromLeadership(artifact);
		assert.ok(modelId?.includes("available-paid") ?? false, "expected paid model");
	});

	it("returns null for an empty leadership", () => {
		const artifact: LeadershipArtifact = { version: 1, generatedAt: new Date().toISOString(), source: { snapshotPath, snapshotGeneratedAt: new Date().toISOString() }, models: [], views: { freeLocal: [], paidLocal: [], overall: [], byCategory: {} } };
		assert.equal(selectModelFromLeadership(artifact), null);
	});

	it("respects category-specific option override", () => {
		const artifact = buildLeadershipArtifact();
		const modelId = selectModelFromLeadership(artifact, { category: "coding" });
		assert.ok(modelId, "expected a model id for coding");
	});

	it("respects maxResults option", () => {
		const artifact = buildLeadershipArtifact();
		const modelId = selectModelFromLeadership(artifact, { maxResults: 1 });
		assert.ok(modelId, "expected a model id");
	});

	it("falls back to any available model when no ranked model matches", () => {
		const artifact = buildLeadershipArtifact();
		const modelId = selectModelFromLeadership(artifact, { category: "unknown_category" });
		assert.ok(modelId, "expected fallback model");
	});

	it("returns null when all models are unavailable", () => {
		const snapshot = buildSnapshot();
		const piModels = [
			{
				id: "unavailable",
				fullId: "provider/unavailable",
				provider: "provider",
				name: "Unavailable",
				isFree: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				family: "test",
				categories: [],
				available: false,
			},
		];
		const artifact = buildLeadership(snapshot, piModels, undefined, snapshotPath);
		assert.equal(selectModelFromLeadership(artifact), null);
	});
});

describe("Edge cases: configuration and artifact building", () => {
	it("always populates artifact config with defaults when building", () => {
		const snapshot = buildSnapshot();
		const piModels = [
			{
				id: "test/model",
				fullId: "provider/test/model",
				provider: "provider",
				name: "Test Model",
				isFree: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				available: true,
			},
		];
		const artifact = buildLeadership(snapshot, piModels, undefined, snapshotPath);
		assert.ok(artifact.config, "artifact should always have config");
		assert.equal(artifact.config?.preferFree, true, "should default preferFree to true");
		assert.equal(artifact.config?.defaultCategory, "coding", "should default category to coding");
		assert.equal(artifact.config?.maxResults, 50, "should default maxResults to 50");
		assert.deepEqual(artifact.config?.paidSortRule, { strategy: "priority" }, "should default sort strategy");
	});

	it("respects custom config when provided during building", () => {
		const snapshot = buildSnapshot();
		const piModels = [
			{
				id: "test/model",
				fullId: "provider/test/model",
				provider: "provider",
				name: "Test Model",
				isFree: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				available: true,
			},
		];
		const artifact = buildLeadership(
			snapshot,
			piModels,
			{ preferences: { preferFree: false, defaultCategory: "writing", maxResults: 25 } },
			snapshotPath
		);
		assert.equal(artifact.config?.preferFree, false);
		assert.equal(artifact.config?.defaultCategory, "writing");
		assert.equal(artifact.config?.maxResults, 25);
	});

	it("handles empty models array gracefully", () => {
		const snapshot = buildSnapshot();
		const artifact = buildLeadership(snapshot, [], { preferences: { preferFree: true, maxResults: 10 } }, snapshotPath);
		assert.equal(artifact.models.length, 0, "should have no models");
		assert.ok(artifact.config, "should still have config");
		assert.equal(artifact.views.freeLocal.length, 0, "should have no free models");
		assert.equal(artifact.views.paidLocal.length, 0, "should have no paid models");
		assert.equal(artifact.views.overall.length, 0, "should have no models overall");
		// byCategory should have all categories from snapshot, but with empty arrays
		assert.ok(Object.keys(artifact.views.byCategory).length > 0, "should have categories from snapshot");
		for (const models of Object.values(artifact.views.byCategory)) {
			assert.equal(models.length, 0, "all category arrays should be empty");
		}
	});

	it("respects maxResults in selection even with single model return", () => {
		const artifact = buildLeadershipArtifact({ maxResults: 100 });
		const modelId = selectModelFromLeadership(artifact);
		assert.ok(modelId, "should return a model");
	});

	it("falls back to default maxResults from config when option not provided", () => {
		const snapshot = buildSnapshot();
		const piModels = [
			{
				id: "test/available-free",
				fullId: "provider/test/available-free",
				provider: "provider",
				name: "Available Free",
				isFree: true,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				family: "test",
				categories: ["coding"],
				available: true,
			},
		];
		const artifact = buildLeadership(snapshot, piModels, { preferences: { maxResults: 5 } }, snapshotPath);
		// Verify config has the custom maxResults
		assert.equal(artifact.config?.maxResults, 5);
		const modelId = selectModelFromLeadership(artifact);
		assert.ok(modelId, "should select model using config defaults");
	});
});
