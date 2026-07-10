import { describe, it } from "node:test";
import assert from "node:assert";
import { enrichExclusionWithRateLimits, inferRetryHintFromRow, formatTokenWindow } from "../../src/runs/shared/model-exclusions.ts";
import type { ProviderRateLimit } from "../../src/runs/shared/provider-rate-limits.ts";

describe("enrichExclusionWithRateLimits", () => {
  it("prefers request windows over token windows when both are present", () => {
    const result = enrichExclusionWithRateLimits({
      provider: "openai",
      modelId: "gpt-4o",
      rateType: "paid",
      usageProfile: "chat",
      endpoint: "/v1/chat/completions",
    });

    assert.strictEqual(result.retryAfterHint, "next minute");
    assert.strictEqual(result.retryCondition, "retry after next minute; token window: 30000 TPM");
  });

  it("falls back to token windows when request caps are absent", () => {
    const result = enrichExclusionWithRateLimits({
      provider: "inception",
      modelId: "mercury-2",
      usageProfile: "chat",
      endpoint: "/v1/chat/completions",
    });

    assert.strictEqual(result.retryAfterHint, "next minute");
    assert.strictEqual(result.retryCondition, "retry after next minute; token window: 100000 TPM");
  });

  it("skips enrichment for unknown provider", () => {
    const result = enrichExclusionWithRateLimits({
      provider: "unknown-provider",
      modelId: "m",
    });

    assert.deepStrictEqual(result, {});
  });
});

describe("inferRetryHintFromRow", () => {
  const base: ProviderRateLimit = {
    provider: "p",
    scope: "model",
    target: "m",
    rateType: "paid",
    endpoint: "/v1/chat/completions",
    scopeMode: "",
    limitMode: "hard",
    usageProfile: "chat",
    tierRule: "",
    effectiveStart: "",
    effectiveEnd: "",
    rpmMax: "",
    tpmMax: "",
    rphMax: "",
    rpdMax: "",
    tphMax: "",
    tpdMax: "",
    conMax: "",
    retryAfterHint: "",
  };

  it("prefers the shortest request window (rpm -> next minute)", () => {
    assert.strictEqual(inferRetryHintFromRow({ ...base, rpmMax: "500", rphMax: "1000", rpdMax: "5000" }), "next minute");
  });

  it("infers next hour from hourly request cap", () => {
    assert.strictEqual(inferRetryHintFromRow({ ...base, rphMax: "1000", rpdMax: "5000" }), "next hour");
  });

  it("infers next day from daily request cap", () => {
    assert.strictEqual(inferRetryHintFromRow({ ...base, rpdMax: "5000" }), "next day");
  });

  it("falls back to token windows when request caps are absent (tpm -> next minute)", () => {
    assert.strictEqual(inferRetryHintFromRow({ ...base, tpmMax: "30000", tphMax: "1000", tpdMax: "50000" }), "next minute");
  });

  it("infers next hour from hourly token cap", () => {
    assert.strictEqual(inferRetryHintFromRow({ ...base, tphMax: "1000", tpdMax: "50000" }), "next hour");
  });

  it("infers next day from daily token cap", () => {
    assert.strictEqual(inferRetryHintFromRow({ ...base, tpdMax: "50000" }), "next day");
  });

  it("returns undefined when no caps are present", () => {
    assert.strictEqual(inferRetryHintFromRow(base), undefined);
  });

  it("prefers an explicit retry_after_hint over inferred caps", () => {
    assert.strictEqual(
      inferRetryHintFromRow({ ...base, rpmMax: "500", retryAfterHint: "custom hint" }),
      "next minute",
    );
  });
});

describe("formatTokenWindow", () => {
  const base: ProviderRateLimit = {
    provider: "p",
    scope: "model",
    target: "m",
    rateType: "paid",
    endpoint: "/v1/chat/completions",
    scopeMode: "",
    limitMode: "hard",
    usageProfile: "chat",
    tierRule: "",
    effectiveStart: "",
    effectiveEnd: "",
    rpmMax: "",
    tpmMax: "",
    rphMax: "",
    rpdMax: "",
    tphMax: "",
    tpdMax: "",
    conMax: "",
    retryAfterHint: "",
  };

  it("joins multiple token windows", () => {
    assert.strictEqual(formatTokenWindow({ ...base, tpmMax: "30000", tphMax: "1000", tpdMax: "50000" }), "30000 TPM, 1000 TPH, 50000 TPD");
  });

  it("returns undefined when no token windows are present", () => {
    assert.strictEqual(formatTokenWindow(base), undefined);
  });
});
