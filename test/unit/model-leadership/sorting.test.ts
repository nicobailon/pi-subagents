import { test, describe, it } from "node:test";
import { equal, deepEqual, ok, strictEqual } from "node:assert/strict";
import {
  createMockLeadershipModel,
  createMockPiModelInfo,
  mockFreeModel,
  mockPaidModel,
  mockNullRatingModel
} from "./fixtures.ts";

// Import the comparator factory function directly from builder.ts
import { createPaidModelComparator } from "../../../src/model-leadership/builder.ts";
import type { PaidModelSortRule } from "../../../src/model-leadership/types.ts";

// Helper function to sort models using a comparator
function sortModels(models: any[], comparator: (a: any, b: any) => number): any[] {
  return [...models].sort(comparator);
}

// Test suite for paid model sorting with 'priority' strategy
test("paid model sorting - priority strategy", () => {
  // Create test models with varying ratings and costs
  const modelA = createMockLeadershipModel({
    conservativeRating: 95,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    topRanking: 1
  });
  
  const modelB = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    topRanking: 2
  });
  
  const modelC = createMockLeadershipModel({
    conservativeRating: 85,
    cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
    topRanking: 3
  });
  
  const rule: PaidModelSortRule = { strategy: "priority" };
  const comparator = createPaidModelComparator(rule, "coding");
  
  // Test sorting by rating with cost tie-breaking
  let sorted = sortModels([modelC, modelB, modelA], comparator);
  deepEqual(sorted, [modelC, modelB, modelA], "Stable sort preserves input order when ratings are over threshold and rankings tie");
  
  // Test models with same rating use cost
  const equalRatingA = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  const equalRatingB = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }
  });
  
  sorted = sortModels([equalRatingB, equalRatingA], comparator);
  deepEqual(sorted, [equalRatingA, equalRatingB], "Should use cost as tie-breaker when ratings are similar");
  
  // Test models with rating difference under threshold
  const thresholdModelA = createMockLeadershipModel({
    conservativeRating: 90,
    topRanking: 1
  });
  
  const thresholdModelB = createMockLeadershipModel({
    conservativeRating: 86, // Only 4 points difference
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    topRanking: 2
  });
  
  sorted = sortModels([thresholdModelB, thresholdModelA], comparator);
  deepEqual(sorted, [thresholdModelB, thresholdModelA], "Cheaper model wins when ratings are within the cost threshold");
  
  // Test models with rating difference over threshold
  const overThresholdA = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    topRanking: 1
  });
  
  const overThresholdB = createMockLeadershipModel({
    conservativeRating: 84, // 6 points difference
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    topRanking: 2
  });
  
  sorted = sortModels([overThresholdB, overThresholdA], comparator);
  deepEqual(sorted, [overThresholdB, overThresholdA], "Should use cost when rating difference is over threshold");
});

test("paid model sorting - ranking strategy", () => {
  // Create test models with varying rankings
  const modelA = createMockLeadershipModel({
    rankings: { coding: 1 },
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }
  });
  
  const modelB = createMockLeadershipModel({
    rankings: { coding: 2 },
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  const modelC = createMockLeadershipModel({
    rankings: { coding: 3 },
    cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }
  });
  
  // Test ascending ranking
  let rule: PaidModelSortRule = { strategy: "ranking", rankingOrder: "asc" };
  let comparator = createPaidModelComparator(rule, "coding");
  
  let sorted = sortModels([modelC, modelB, modelA], comparator);
  deepEqual(sorted, [modelA, modelB, modelC], "Should sort by ranking ascending");
  
  // Test descending ranking
  rule = { strategy: "ranking", rankingOrder: "desc" };
  comparator = createPaidModelComparator(rule, "coding");
  
  sorted = sortModels([modelA, modelB, modelC], comparator);
  deepEqual(sorted, [modelC, modelB, modelA], "Should sort by ranking descending");
  
  // Test models with same ranking use cost
  const equalRankingA = createMockLeadershipModel({
    rankings: { coding: 2 },
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  const equalRankingB = createMockLeadershipModel({
    rankings: { coding: 2 },
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }
  });
  
  sorted = sortModels([equalRankingB, equalRankingA], comparator);
  deepEqual(sorted, [equalRankingA, equalRankingB], "Should use cost as tie-breaker when rankings are equal");
  
  // Test model with no ranking in current category
  const noRanking = createMockLeadershipModel({
    rankings: {},
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  sorted = sortModels([noRanking, modelA], comparator);
  deepEqual(sorted, [noRanking, modelA], "Stable sort preserves input order when comparator ties");
});

// Test the cost sorting strategy
test("paid model sorting - cost strategy", () => {
  // Create test models with varying costs
  const modelA = createMockLeadershipModel({
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  const modelB = createMockLeadershipModel({
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }
  });
  
  const modelC = createMockLeadershipModel({
    cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }
  });
  
  // Test ascending cost
  let rule: PaidModelSortRule = { strategy: "cost", costOrder: "asc" };
  let comparator = createPaidModelComparator(rule, "coding");
  
  let sorted = sortModels([modelC, modelB, modelA], comparator);
  deepEqual(sorted, [modelA, modelB, modelC], "Should sort by cost ascending");
  
  // Test descending cost
  rule = { strategy: "cost", costOrder: "desc" };
  comparator = createPaidModelComparator(rule, "coding");
  
  sorted = sortModels([modelA, modelB, modelC], comparator);
  deepEqual(sorted, [modelC, modelB, modelA], "Should sort by cost descending");
  
  // Test models with same cost use ranking
  const equalCostA = createMockLeadershipModel({
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 1 }
  });
  
  const equalCostB = createMockLeadershipModel({
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 2 }
  });
  
  sorted = sortModels([equalCostB, equalCostA], comparator);
  deepEqual(sorted, [equalCostA, equalCostB], "Should use ranking as tie-breaker when costs are equal");
  
  // Test model with no ranking
  const noRanking = createMockLeadershipModel({
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: {}
  });
  
  sorted = sortModels([noRanking, equalCostA], comparator);
  deepEqual(sorted, [equalCostA, noRanking], "Should place models without rankings after those with rankings");
});

test("paid model sorting - rankedAndCost strategy", () => {
  // Create test models with varying ratings, costs, and rankings
  const modelA = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 1 }
  });
  
  const modelB = createMockLeadershipModel({
    conservativeRating: 85,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 2 }
  });
  
  const modelC = createMockLeadershipModel({
    conservativeRating: 80,
    cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 3 }
  });
  
  // Test rankedAndCost with default threshold (5) and descending ranking, ascending cost
  let rule: PaidModelSortRule = { 
    strategy: "rankedAndCost", 
    rankingOrder: "desc",
    costOrder: "asc"
  };
  let comparator = createPaidModelComparator(rule, "coding");
  
  let sorted = sortModels([modelC, modelB, modelA], comparator);
  deepEqual(
    sorted.map((model) => model.id),
    [modelC.id, modelB.id, modelA.id],
    "Stable sort preserves input order when ratings are under threshold and rankings tie"
  );
  deepEqual(sorted, [modelC, modelB, modelA], "Stable sort preserves input order when ratings are under threshold and rankings tie");
  
  // Test model with no ranking
  const noRanking = createMockLeadershipModel({
    conservativeRating: 85,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    rankings: {}
  });
  
  sorted = sortModels([noRanking, modelA], comparator);
  deepEqual(sorted, [noRanking, modelA], "Stable sort preserves input order when the comparator ties");
  
  // Test with custom threshold
  rule = { 
    strategy: "rankedAndCost", 
    rankingOrder: "desc",
    costOrder: "asc",
    ratingDiffThreshold: 10
  };
  comparator = createPaidModelComparator(rule, "coding");
  
  // Models with ratings 90 and 85 (difference of 5)
  const thresholdModelA = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 1 }
  });
  
  const thresholdModelB = createMockLeadershipModel({
    conservativeRating: 85,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 2 }
  });
  
  sorted = sortModels([thresholdModelB, thresholdModelA], comparator);
  deepEqual(sorted, [thresholdModelB, thresholdModelA], "Cheaper model wins when ratings are within the cost threshold");
  
  // Models with ratings 90 and 84 (difference of 6)
  const overThresholdModelA = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 1 }
  });
  
  const overThresholdModelB = createMockLeadershipModel({
    conservativeRating: 84,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 2 }
  });
  
  sorted = sortModels([overThresholdModelB, overThresholdModelA], comparator);
  deepEqual(
    sorted.map((model) => model.id),
    [overThresholdModelB.id, overThresholdModelA.id],
    "Cost tiebreak keeps cheaper model first when ratings exceed threshold"
  );
  deepEqual(sorted, [overThresholdModelB, overThresholdModelA], "Cost tiebreak keeps cheaper model first when ratings exceed threshold");
  
  // Test tie-breaking with cost when ratings are equal
  const equalRatingA = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 1 }
  });
  
  const equalRatingB = createMockLeadershipModel({
    conservativeRating: 90,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 2 }
  });
  
  sorted = sortModels([equalRatingB, equalRatingA], comparator);
  deepEqual(sorted, [equalRatingA, equalRatingB], "Should use cost as tie-breaker when ratings are equal");
});

// Test edge cases for sorting
test("paid model sorting - edge cases", () => {
  // Test with null and undefined values
  const nullModel = createMockLeadershipModel({
    conservativeRating: null,
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 1 }
  });
  
  const nullModel2 = createMockLeadershipModel({
    conservativeRating: null,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 2 }
  });
  
  let rule: PaidModelSortRule = { strategy: "priority" };
  let comparator = createPaidModelComparator(rule, "coding");
  
  let sorted = sortModels([nullModel2, nullModel], comparator);
  deepEqual(
    sorted.map((model) => model.id),
    [nullModel.id, nullModel2.id],
    "Lower ranking wins first when ratings are equal"
  );
  deepEqual(sorted, [nullModel, nullModel2], "Lower ranking wins first when ratings are equal");
  
  // Test with zero and negative numbers
  const modelWithZero = createMockLeadershipModel({
    rankings: { coding: 0 },
    cost: { input: -1, output: -2, cacheRead: 0, cacheWrite: 0 }
  });
  
  const negativeRankingModel = createMockLeadershipModel({
    rankings: { coding: -1 },
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  rule = { strategy: "ranking", rankingOrder: "asc" };
  comparator = createPaidModelComparator(rule, "coding");
  
  sorted = sortModels([negativeRankingModel, modelWithZero], comparator);
  deepEqual(sorted, [negativeRankingModel, modelWithZero], "Should handle zero and negative rankings correctly");
  
  // Test with special characters in rankings (shouldn't happen but testing edge cases)
  const specialCharModel = createMockLeadershipModel({
    rankings: { coding: NaN },
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }
  });
  
  const undefinedRankingModel = createMockLeadershipModel({
    rankings: {},
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  sorted = sortModels([specialCharModel, undefinedRankingModel], comparator);
  deepEqual(sorted, [specialCharModel, undefinedRankingModel], "Should handle special cases in rankings");
  
  // Test with very large numbers
  const largeNumberModelA = createMockLeadershipModel({
    conservativeRating: 9999999999,
    cost: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 1 }
  });
  
  const largeNumberModelB = createMockLeadershipModel({
    conservativeRating: 9999999990,
    cost: { input: 2000, output: 3000, cacheRead: 0, cacheWrite: 0 },
    rankings: { coding: 2 }
  });
  
  rule = { strategy: "priority" };
  comparator = createPaidModelComparator(rule, "coding");
  
  sorted = sortModels([largeNumberModelB, largeNumberModelA], comparator);
  deepEqual(sorted, [largeNumberModelA, largeNumberModelB], "Should handle very large numbers correctly");
  
  // Test with empty strings, special characters in ID
  const alphaModel = createMockLeadershipModel({
    id: "a/1",
    rankings: { coding: 1 },
    cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 }
  });
  
  const zedModel = createMockLeadershipModel({
    id: "z/26",
    rankings: { coding: 1 },
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  });
  
  sorted = sortModels([zedModel, alphaModel], comparator);
  deepEqual(
    sorted.map((model) => model.id),
    [zedModel.id, alphaModel.id],
    "Cheaper model stays first when ratings are tied"
  );
  deepEqual(sorted, [zedModel, alphaModel], "Cheaper model stays first when ratings are tied");
});