import type { CategoryRankings, RankingsSnapshot, LeadershipModel, PiModelInfo, RankingRow } from "../../../src/model-leadership/types.ts";
import { _getNormalizedCanonicalModelId, _rankingModelIdMatches, createPaidModelComparator, getCategoryRank } from "../../../src/model-leadership/builder.ts";

// Re-export helpers for matching and sorting tests so the assertions live next to the public API surface.
export { _getNormalizedCanonicalModelId as normalizeModelId, _rankingModelIdMatches as rankingModelIdMatches, createPaidModelComparator, getCategoryRank };



// Mock RankingsSnapshot factory
export const createMockRankingsSnapshot = (override: Partial<RankingsSnapshot> = {}): RankingsSnapshot => ({
  generatedAt: new Date().toISOString(),
  source: "test",
  categories: {
    coding: { id: "coding" }
  },
  rankings: {
    coding: createMockCategoryRankings({
      category: "coding",
      rows: [
        createMockRankingRow({
          rank: 1,
          modelId: "test/available-paid",
        })
      ]
    })
  },
  modelsSummary: null,
  benchmarksSummary: null,
  ...override
});

// Mock CategoryRankings factory
export const createMockCategoryRankings = (override: Partial<CategoryRankings> = {}): CategoryRankings => ({
  category: "coding",
  method: "test",
  rankedAt: new Date().toISOString(),
  rows: [],
  ...override
});

// Mock RankingRow factory
export const createMockRankingRow = (override: Partial<RankingRow> = {}): RankingRow => ({
  rank: 1,
  modelId: "test/available-paid",
  modelName: "Available Paid",
  organization: "test",
  conservativeRating: 90,
  score: 90,
  openWeight: false,
  minInputPrice: 1,
  benchmarksEvaluated: 1,
  source: "test",
  url: null,
  ...override
});

// Mock LeadershipModel factory
export const createMockLeadershipModel = (override: Partial<LeadershipModel> = {}): LeadershipModel => ({
  id: "test/available-paid",
  provider: "provider",
  modelId: "test/available-paid",
  name: "Available Paid",
  isFree: false,
  cost: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0
  },
  contextWindow: 8192,
  family: "test",
  categories: ["coding"],
  rankings: {
    coding: 1
  },
  conservativeRating: 90,
  available: true,
  topRanking: 1,
  topRankingCategory: "coding",
  providers: ["provider/test/available-paid"],
  availableProviders: ["provider/test/available-paid"],
  ...override
});

// Mock free and paid models
export const mockFreeModel = createMockLeadershipModel({
  id: "test/available-free",
  provider: "provider",
  modelId: "test/available-free",
  name: "Available Free",
  isFree: true,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0
  },
  contextWindow: 8192,
  conservativeRating: 80,
  providers: ["provider/test/available-free"],
  availableProviders: ["provider/test/available-free"]
});

export const mockPaidModel = createMockLeadershipModel({
  id: "test/available-paid",
  provider: "provider",
  modelId: "test/available-paid",
  name: "Available Paid",
  isFree: false,
  cost: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0
  },
  contextWindow: 8192,
  conservativeRating: 90,
  providers: ["provider/test/available-paid"],
  availableProviders: ["provider/test/available-paid"]
});

// Model with null ratings
export const mockNullRatingModel = createMockLeadershipModel({
  conservativeRating: null
});

// Mock PiModelInfo factory
export const createMockPiModelInfo = (override: Partial<PiModelInfo> = {}): PiModelInfo => ({
  id: "test/available-paid",
  fullId: "provider/test/available-paid",
  provider: "provider",
  name: "Available Paid",
  isFree: false,
  cost: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0
  },
  contextWindow: 8192,
  available: true,
  categories: ["coding"],
  ...override
});

export const mockPiFreeModel = createMockPiModelInfo({
  id: "test/available-free",
  fullId: "provider/test/available-free",
  isFree: true,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0
  }
});