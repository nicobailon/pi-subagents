import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EvalOutcome, SessionAttemptMetrics, VariantKind } from "../eval/lib/eval-types.ts";
import {
  assembleReport,
  createResultDocument,
  summarizeDocument,
  variantOrderFor,
} from "../eval/lib/runner-report.ts";

function attempt(
  fixtureId: string,
  variant: VariantKind,
  attemptIndex: number,
  outcome: EvalOutcome,
): SessionAttemptMetrics {
  return {
    fixtureId,
    suite: "held-out",
    variant,
    variantOrder: ["candidate", "baseline"],
    model: "provider/model",
    repetition: 1,
    attemptIndex,
    startedAt: "2031-04-07T09:30:00.000Z",
    elapsedMs: 1,
    turns: 1,
    turnLimitHit: outcome === "turn-limit",
    wallTimeoutHit: outcome === "wall-timeout",
    outcome,
    outcomeReason: outcome,
    semanticPass: outcome === "semantic-pass",
    semanticReasons: [],
    firstCall: null,
    firstLaunch: null,
    invalidCalls: 0,
    helpCalls: 0,
    discoveryCalls: 0,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    effectTrace: [],
    prohibitedEffects: [],
    finalText: "",
    assembledSystemPrompt: "",
    publishedToolDefinition: { name: "subagent", description: "", parameters: {} },
    providerPayloads: [],
  };
}

function document() {
  return createResultDocument({
    entry: "test/eval/paired-eval.mjs",
    candidateRoot: "/candidate",
    baselineRoot: "/baseline",
    piSdkEntry: "/sdk/dist/index.js",
    providerExtensions: [],
    models: ["provider/model"],
    suite: "held-out",
    repetitions: 2,
    retryCap: 1,
    maxTurns: 8,
    timeoutMs: 120_000,
    maxOutputTokens: 2_500,
    suiteSources: [],
    heldOutSourceReport: null,
    systemPrompt: "evaluate",
    scope: "fake effects",
  });
}

describe("paired evaluator report assembly", () => {
  it("alternates variant order across repetitions and retries", () => {
    assert.deepEqual(variantOrderFor(1, 1), ["candidate", "baseline"]);
    assert.deepEqual(variantOrderFor(2, 1), ["baseline", "candidate"]);
    assert.deepEqual(variantOrderFor(1, 2), ["baseline", "candidate"]);
  });

  it("preserves infrastructure attempts and selects the later comparable retry", () => {
    const result = document();
    result.pairs.push(
      { pairId: "fixture#1", attempt: attempt("fixture", "baseline", 1, "provider-error") },
      { pairId: "fixture#1", attempt: attempt("fixture", "candidate", 1, "semantic-pass") },
      { pairId: "fixture#1", attempt: attempt("fixture", "candidate", 2, "semantic-fail") },
      { pairId: "fixture#1", attempt: attempt("fixture", "baseline", 2, "semantic-pass") },
    );

    const assembled = assembleReport(result);
    assert.equal(assembled.pairRecords[0]?.attempts.length, 4);
    assert.equal(assembled.pairRecords[0]?.chosen?.baseline.attemptIndex, 2);
    assert.equal(assembled.pairRecords[0]?.chosen?.candidate.attemptIndex, 2);

    const summary = summarizeDocument(result);
    assert.equal(summary.byVariant.baseline.providerErrors, 1);
    assert.equal(summary.byVariant.baseline.semanticPass, 1);
    assert.equal(summary.byVariant.candidate.semanticFail, 1);
    assert.equal(summary.byVariant.candidate.comparablePairs, 1);
  });
});
