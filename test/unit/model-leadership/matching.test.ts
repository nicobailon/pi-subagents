import { test, describe, it } from "node:test";
import { equal, deepEqual, throws, ok, strictEqual } from "node:assert/strict";
import {
  normalizeModelId,
  rankingModelIdMatches,
  createMockLeadershipModel,
  createMockRankingRow,
  mockFreeModel,
  mockPaidModel,
  mockNullRatingModel
} from "./fixtures.ts";

// Test suite for normalizeModelId function
test("normalizeModelId - basic transformations", () => {
  // Basic test cases
  strictEqual(normalizeModelId("test/available-paid"), "available-paid");
  strictEqual(normalizeModelId("TEST/AVAILABLE-PAID"), "available-paid");
  strictEqual(normalizeModelId("  test/available-paid  "), "available-paid");
  
  // Strip free suffix tests
  strictEqual(normalizeModelId("test/available-free:free"), "available");
  strictEqual(normalizeModelId("test/available-free-free"), "available-free");
  
  // Strip provider prefix tests
  strictEqual(normalizeModelId("provider/test/available-paid"), "available-paid");
  strictEqual(normalizeModelId("another-provider/test/available-paid"), "available-paid");
  
  // Combined transformations
  strictEqual(normalizeModelId("  Provider/Test/Available-Free:free  "), "available");
  strictEqual(normalizeModelId("  PROVIDER/Test/Available-Free-FREE  "), "available-free");
});

test("normalizeModelId - edge cases", () => {
  // Null and undefined cases
  // null/undefined are intentionally excluded because helpers require non-null strings

  
  // Empty string
  strictEqual(normalizeModelId(""), "");
  
  // Special characters
  strictEqual(normalizeModelId("model/with/slashes"), "slashes");
  strictEqual(normalizeModelId("model.with.dots"), "model.with.dots");
  strictEqual(normalizeModelId("model@special#chars"), "model@special#chars");
  
  // Numbers and special cases
  strictEqual(normalizeModelId("123model"), "123model");
  strictEqual(normalizeModelId("model123"), "model123");
});

// Test suite for rankingModelIdMatches function
test("rankingModelIdMatches - exact matches", () => {
  // Simple exact match
  ok(rankingModelIdMatches("test/available-paid", "test/available-paid"));
  
  // Case-insensitive exact match
  ok(rankingModelIdMatches("TEST/AVAILABLE-PAID", "test/available-paid"));
  ok(rankingModelIdMatches("test/available-paid", "TEST/AVAILABLE-PAID"));
  
  // Model with provider prefix
  ok(rankingModelIdMatches("provider/test/available-paid", "available-paid"));
  ok(rankingModelIdMatches("test/available-paid", "provider/test/available-paid"));
  
  // Model with free suffix
  ok(rankingModelIdMatches("test/available-free:free", "test/available-free"));
  ok(rankingModelIdMatches("test/available-free", "test/available-free:free"));
});

test("rankingModelIdMatches - provider-prefixed matches", () => {
  // Provider-prefixed match
  ok(rankingModelIdMatches("provider/test/available-paid", "provider/test/available-paid"));
  
  // Different provider but same model id
  ok(rankingModelIdMatches("different-provider/test/available-paid", "available-paid"));

  // Provider with normalized model id
  ok(rankingModelIdMatches("provider/test/available-paid", "available-paid"));

  // Complex provider example
  ok(rankingModelIdMatches("another-long-provider-name/test/available-paid", "available-paid"));
});

test("rankingModelIdMatches - free-tier matches", () => {
  // Basic free model match
  ok(rankingModelIdMatches("test/available-free", "test/available-free"));
  
  // Free model with suffix matching without suffix
  ok(rankingModelIdMatches("test/available-free:free", "test/available-free"));
  
  // Free model without suffix matching with suffix
  ok(rankingModelIdMatches("test/available-free", "test/available-free:free"));
  
  // Free model with provider
  ok(rankingModelIdMatches("provider/test/available-free", "available-free"));

  // Free model with provider and suffix
  ok(rankingModelIdMatches("provider/test/available-free:free", "available-free"));
});

test("rankingModelIdMatches - no matches", () => {
  // Different model ids
  equal(rankingModelIdMatches("test/available-paid", "test/different-model"), false);
  
  // Different model names
  equal(rankingModelIdMatches("test/available-paid", "test/available-free"), false);
  
  // Free vs paid models that are not equivalent
  equal(rankingModelIdMatches("test/available-free", "test/other-paid"), false);
  
  // Different providers with different actual model
  equal(rankingModelIdMatches("provider1/test/available-paid", "provider2/test/different-model"), false);
  
  // Completely different models
  equal(rankingModelIdMatches("some/other-model", "completely/different"), false);
  
  // Null test cases are excluded because the helpers expect non-null strings
});

test("rankingModelIdMatches - edge cases", () => {
  // Empty strings
  ok(rankingModelIdMatches("", ""));
  equal(rankingModelIdMatches("test/available-paid", ""), false);
  equal(rankingModelIdMatches("", "test/available-paid"), false);
  
  // Special characters
  ok(rankingModelIdMatches("model/with/slashes", "model/with/slashes"));
  ok(rankingModelIdMatches("model.with.dots", "model.with.dots"));
  ok(rankingModelIdMatches("model@special#chars", "model@special#chars"));
  
  // Numbers
  ok(rankingModelIdMatches("123model", "123model"));
  ok(rankingModelIdMatches("model123", "model123"));
  equal(rankingModelIdMatches("123model", "model123"), false);
  
  // Complex scenarios with special characters
  equal(rankingModelIdMatches("model-with-very-long-name123!@#", "model-with-very-long-name123!@#"), true);
  equal(rankingModelIdMatches("model-with-very-long-name123!@#", "different-model"), false);
});