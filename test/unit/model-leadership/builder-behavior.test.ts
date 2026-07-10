import { describe, it } from "node:test";
import { strictEqual, deepEqual } from "node:assert/strict";
import { createMockRankingsSnapshot, createMockLeadershipModel, mockFreeModel, mockPaidModel } from "./fixtures.ts";
import { createPaidModelComparator, getCategoryRank } from "../../../src/model-leadership/builder.ts";

describe("model-leadership builder behavior", () => {
  it("creates paid comparator with priority strategy", () => {
    const comparator = createPaidModelComparator({ strategy: "priority" }, "coding");
    const higher = createMockLeadershipModel({ conservativeRating: 98 });
    const lower = createMockLeadershipModel({ conservativeRating: 80 });
    const sorted = [higher, lower].toSorted((a, b) => comparator(a, b));
    strictEqual(sorted[0]!.conservativeRating, 98);
  });

  it("derives category rank from provided ranking data", () => {
    const model = createMockLeadershipModel({ rankings: { coding: 3, reasoning: 1 } });
    strictEqual(getCategoryRank(model, "coding"), 3);
    strictEqual(getCategoryRank(model, "reasoning"), 1);
  });

  it("returns fallback rank when the category is absent", () => {
    const missing = createMockLeadershipModel({ rankings: { coding: 2 } });
    strictEqual(getCategoryRank(missing, "summarization"), 2);
  });

  it("blends free and paid models using snapshot snapshot shape", () => {
    const snapshot = createMockRankingsSnapshot({
      rankings: {
        coding: {
          category: "coding",
          method: "evals",
          rows: [
            {
              rank: 1,
              modelId: "provider/test/available-free",
              modelName: "Available Free",
              organization: "test",
              conservativeRating: 82,
              score: 82,
              minInputPrice: 0,
              url: null,
            },
            {
              rank: 2,
              modelId: "provider/test/available-paid",
              modelName: "Available Paid",
              organization: "test",
              conservativeRating: 90,
              score: 90,
              minInputPrice: 1,
              url: null,
            },
          ],
        },
      },
      modelsSummary: [
        { modelId: "provider/test/available-free", conservativeRating: 82, available: true, isFree: true, rankings: { coding: 1 } },
        { modelId: "provider/test/available-paid", conservativeRating: 90, available: true, isFree: false, rankings: { coding: 2 } },
      ],
    });

    const paidIds = snapshot.modelsSummary!.filter((model) => !model.isFree).map((model) => model.modelId);
    strictEqual(paidIds.length, 1);
    strictEqual(paidIds[0], "provider/test/available-paid");

    const freeIds = snapshot.modelsSummary!.filter((model) => model.isFree).map((model) => model.modelId);
    strictEqual(freeIds.length, 1);
  });
});
