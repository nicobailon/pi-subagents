import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyEvalOutcome,
  isProviderErrorMessage,
  selectComparableAttempts,
  shouldRetryPair,
  summarizePairs,
} from "../../test/eval/lib/classify-outcome.ts";
import type {
  OutcomeObservations,
  PairAttemptRecord,
  SessionAttemptMetrics,
} from "../../test/eval/lib/eval-types.ts";

function observations(overrides: Partial<OutcomeObservations> = {}): OutcomeObservations {
  return {
    sessionCreated: true,
    turnLimitHit: false,
    wallTimeoutHit: false,
    semanticEvaluated: true,
    semanticPass: false,
    prohibitedEffects: [],
    ...overrides,
  };
}

function attemptMetrics(
  variant: "baseline" | "candidate",
  outcome: SessionAttemptMetrics["outcome"],
  attemptIndex: number,
): SessionAttemptMetrics {
  return {
    fixtureId: "writer-review-fix",
    suite: "development",
    variant,
    variantOrder: ["baseline", "candidate"],
    model: "provider/model",
    repetition: 1,
    attemptIndex,
    startedAt: "2026-01-01T00:00:00.000Z",
    elapsedMs: 1,
    turns: 2,
    turnLimitHit: false,
    wallTimeoutHit: false,
    outcome,
    outcomeReason: "test",
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

describe("eval outcome classification", () => {
  it("classifies assistant stopReason error as provider error, not semantic failure", () => {
    const classification = classifyEvalOutcome(
      observations({
        lastAssistantStopReason: "error",
        lastAssistantErrorMessage: "Codex overloaded",
      }),
    );
    assert.equal(classification.outcome, "provider-error");
    assert.match(classification.reason, /Codex overloaded/);
  });

  it("classifies provider-pattern prompt errors as provider error", () => {
    for (const message of [
      "Provider overloaded, please retry",
      "Rate limit exceeded for this key",
      "fetch failed: ECONNRESET",
      "Request timed out contacting the provider",
    ]) {
      assert.equal(isProviderErrorMessage(message), true, message);
      assert.equal(
        classifyEvalOutcome(observations({ promptError: message })).outcome,
        "provider-error",
        message,
      );
    }
  });

  it("classifies harness and setup prompt errors as setup error", () => {
    const classification = classifyEvalOutcome(
      observations({ promptError: "extension factory threw TypeError: pi.on is not a function" }),
    );
    assert.equal(classification.outcome, "setup-error");
    assert.equal(
      classifyEvalOutcome(observations({ sessionCreated: false })).outcome,
      "setup-error",
    );
  });

  it("splits turn-cap exhaustion from wall-clock timeout", () => {
    assert.equal(
      classifyEvalOutcome(observations({ turnLimitHit: true, lastAssistantStopReason: "aborted" }))
        .outcome,
      "turn-limit",
    );
    assert.equal(
      classifyEvalOutcome(
        observations({ wallTimeoutHit: true, lastAssistantStopReason: "aborted" }),
      ).outcome,
      "wall-timeout",
    );
    const turnCapReason = classifyEvalOutcome(observations({ turnLimitHit: true })).reason;
    const wallReason = classifyEvalOutcome(observations({ wallTimeoutHit: true })).reason;
    assert.match(turnCapReason, /model-turn cap/);
    assert.match(wallReason, /wall-clock timeout/);
    assert.equal(
      classifyEvalOutcome(observations({ turnLimitHit: true, lastAssistantStopReason: "error" }))
        .outcome,
      "turn-limit",
    );
    assert.equal(
      classifyEvalOutcome(observations({ wallTimeoutHit: true, lastAssistantStopReason: "error" }))
        .outcome,
      "wall-timeout",
    );
  });

  it("never classifies either timeout flavor as a semantic failure", () => {
    for (const flags of [{ turnLimitHit: true }, { wallTimeoutHit: true }]) {
      const outcome = classifyEvalOutcome(
        observations({ ...flags, semanticEvaluated: true, semanticPass: true }),
      ).outcome;
      assert.notEqual(outcome, "semantic-pass");
      assert.notEqual(outcome, "semantic-fail");
    }
  });

  it("classifies semantic pass and fail", () => {
    assert.equal(
      classifyEvalOutcome(observations({ semanticPass: true })).outcome,
      "semantic-pass",
    );
    assert.equal(
      classifyEvalOutcome(observations({ semanticPass: false })).outcome,
      "semantic-fail",
    );
  });

  it("forces semantic fail when prohibited effects were observed", () => {
    const classification = classifyEvalOutcome(
      observations({
        semanticPass: true,
        prohibitedEffects: [
          { kind: "prohibited-launch", index: 3, form: "direct", key: "x", task: "", params: {} },
        ],
      }),
    );
    assert.equal(classification.outcome, "semantic-fail");
    assert.match(classification.reason, /prohibited-launch/);
  });

  it("treats a missing final answer as semantic fail, not success", () => {
    const classification = classifyEvalOutcome(
      observations({ semanticEvaluated: false, semanticPass: false }),
    );
    assert.equal(classification.outcome, "semantic-fail");
    assert.match(classification.reason, /no evaluable final answer/);
  });
});

describe("eval pair retry and comparability", () => {
  it("retries wall-clock timeouts and provider/setup errors, never turn-limit or semantic outcomes", () => {
    assert.equal(shouldRetryPair("provider-error", "semantic-fail", 1), true);
    assert.equal(shouldRetryPair("semantic-pass", "setup-error", 2), true);
    assert.equal(shouldRetryPair("wall-timeout", "semantic-pass", 1), true);
    assert.equal(shouldRetryPair("semantic-pass", "wall-timeout", 3), true);
    assert.equal(shouldRetryPair("turn-limit", "semantic-pass", 1), false);
    assert.equal(shouldRetryPair("semantic-pass", "semantic-fail", 2), false);
    assert.equal(shouldRetryPair("provider-error", "semantic-pass", 0), false);
    assert.equal(shouldRetryPair("wall-timeout", "semantic-pass", 0), false);
  });

  it("selects the first attempt where both variants produced semantic outcomes, aligned by attempt index", () => {
    const attempts = [
      attemptMetrics("baseline", "provider-error", 1),
      attemptMetrics("candidate", "semantic-pass", 1),
      attemptMetrics("baseline", "wall-timeout", 2),
      attemptMetrics("candidate", "semantic-pass", 2),
      attemptMetrics("baseline", "semantic-fail", 3),
      attemptMetrics("candidate", "semantic-pass", 3),
    ];
    const selection = selectComparableAttempts(attempts);
    assert.equal(selection.comparable, true);
    assert.equal(selection.baseline?.attemptIndex, 3);
    assert.equal(selection.candidate?.attemptIndex, 3);

    const infraOnly = [
      attemptMetrics("baseline", "provider-error", 1),
      attemptMetrics("candidate", "wall-timeout", 1),
    ];
    const noneComparable = selectComparableAttempts(infraOnly);
    assert.equal(noneComparable.comparable, false);
    assert.equal(noneComparable.baseline, null);
  });

  it("reports wall-timeout and turn-limit tallies separately and excludes both from the semantic denominator", () => {
    const chosenPair: PairAttemptRecord = {
      pairId: "provider/model/a#1",
      attempts: [
        attemptMetrics("baseline", "semantic-fail", 1),
        attemptMetrics("candidate", "semantic-pass", 1),
      ],
      comparable: true,
      chosen: {
        baseline: attemptMetrics("baseline", "semantic-fail", 1),
        candidate: attemptMetrics("candidate", "semantic-pass", 1),
      },
    };
    const timeoutPair: PairAttemptRecord = {
      pairId: "provider/model/b#1",
      attempts: [
        attemptMetrics("baseline", "wall-timeout", 1),
        attemptMetrics("candidate", "turn-limit", 1),
        attemptMetrics("baseline", "provider-error", 2),
        attemptMetrics("candidate", "setup-error", 2),
      ],
      comparable: false,
      chosen: null,
    };
    const tallies = summarizePairs([chosenPair, timeoutPair]);
    assert.equal(tallies.baseline.semanticFail, 1);
    assert.equal(tallies.candidate.semanticPass, 1);
    assert.equal(tallies.baseline.comparablePairs, 1);
    assert.equal(tallies.candidate.comparablePairs, 1);
    assert.equal(tallies.baseline.wallTimeouts, 1);
    assert.equal(tallies.candidate.turnLimits, 1);
    assert.equal(tallies.baseline.providerErrors, 1);
    assert.equal(tallies.candidate.setupErrors, 1);
  });
});
