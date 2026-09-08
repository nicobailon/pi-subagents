/**
 * Outcome classification for the paired catalog evaluation.
 *
 * Provider and setup/runner failures and wall-clock timeouts are
 * infrastructure results and never count as semantic model failures; they are
 * recorded and remain eligible for bounded pair retry. Turn-cap exhaustion is
 * a model/efficiency outcome and is never silently retried. Classification
 * depends only on the reduced observations, never on model text, so it stays
 * deterministically unit-testable.
 */

import type {
  EvalOutcome,
  OutcomeClassification,
  OutcomeObservations,
  PairAttemptRecord,
  SelectedComparableAttempts,
  SessionAttemptMetrics,
  VariantOutcomeTallies,
  VariantOutcomeTally,
} from "./eval-types.ts";

export interface ComparableSelection {
  comparable: boolean;
  baseline: SessionAttemptMetrics | null;
  candidate: SessionAttemptMetrics | null;
}

const PROVIDER_ERROR_PATTERNS: readonly RegExp[] = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b5\d{2}\b.*(error|overload)/i,
  /provider (error|failure)/i,
  /api (error|request failed)/i,
  /(econnreset|econnrefused|etimedout|fetch failed|network error)/i,
  /(bad ?gateway|service unavailable|internal server error)/i,
  /request timed? ?out/i,
];

/** True when a harness-thrown prompt error looks like a provider-side failure. */
export function isProviderErrorMessage(message: string): boolean {
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Classify one attempted session. Order matters:
 * setup (no session) -> provider stopReason error -> turn-cap exhaustion ->
 * wall-clock timeout -> provider-pattern prompt error -> other prompt error
 * (runner/setup) -> semantic pass/fail (prohibited effects force a fail).
 * Neither timeout flavor is ever a semantic failure.
 */
export function classifyEvalOutcome(observations: OutcomeObservations): OutcomeClassification {
  if (!observations.sessionCreated) {
    return {
      outcome: "setup-error",
      reason:
        "session was never created (extension load, model resolution, or harness setup failed)",
    };
  }
  if (observations.turnLimitHit) {
    return {
      outcome: "turn-limit",
      reason: "session aborted before exceeding the configured model-turn cap",
    };
  }
  if (observations.wallTimeoutHit) {
    return {
      outcome: "wall-timeout",
      reason: "session aborted by the wall-clock timeout before a final answer",
    };
  }
  if (observations.lastAssistantStopReason === "error") {
    return {
      outcome: "provider-error",
      reason:
        observations.lastAssistantErrorMessage === undefined
          ? "assistant turn ended with stopReason=error"
          : `assistant turn ended with stopReason=error: ${observations.lastAssistantErrorMessage}`,
    };
  }
  if (observations.promptError !== undefined && isProviderErrorMessage(observations.promptError)) {
    return {
      outcome: "provider-error",
      reason: `provider failure aborted the prompt: ${observations.promptError}`,
    };
  }
  if (observations.promptError !== undefined) {
    return {
      outcome: "setup-error",
      reason: `runner or setup failure aborted the prompt: ${observations.promptError}`,
    };
  }
  if (observations.prohibitedEffects.length > 0) {
    return {
      outcome: "semantic-fail",
      reason: `prohibited effect observed: ${observations.prohibitedEffects.map((entry) => entry.kind).join(", ")}`,
    };
  }
  if (!observations.semanticEvaluated) {
    return { outcome: "semantic-fail", reason: "no evaluable final answer was produced" };
  }
  return {
    outcome: observations.semanticPass ? "semantic-pass" : "semantic-fail",
    reason: observations.semanticPass
      ? "semantic predicate satisfied"
      : "semantic predicate rejected the observed behavior",
  };
}

/** Infrastructure outcomes: recorded, retry-eligible, excluded from the semantic denominator. */
const INFRASTRUCTURE_OUTCOMES: ReadonlySet<string> = new Set([
  "provider-error",
  "setup-error",
  "wall-timeout",
]);

/** Decide whether a pair whose attempt hit infrastructure should be retried. */
export function shouldRetryPair(
  baselineOutcome: EvalOutcome,
  candidateOutcome: EvalOutcome,
  retriesRemaining: number,
): boolean {
  if (retriesRemaining <= 0) {
    return false;
  }
  return (
    INFRASTRUCTURE_OUTCOMES.has(baselineOutcome) || INFRASTRUCTURE_OUTCOMES.has(candidateOutcome)
  );
}

function attemptIsSemantic(attempt: SessionAttemptMetrics): boolean {
  return attempt.outcome === "semantic-pass" || attempt.outcome === "semantic-fail";
}

/**
 * Pick the first attempt index where both variants produced a semantic
 * outcome; attempts stay aligned by attempt index within each variant.
 * Infrastructure attempts stay recorded but leave the pair non-comparable
 * when no such attempt exists.
 */
export function selectComparableAttempts(attempts: SessionAttemptMetrics[]): ComparableSelection {
  const baselineAttempts = attempts.filter((attempt) => attempt.variant === "baseline");
  const candidateAttempts = attempts.filter((attempt) => attempt.variant === "candidate");
  const attemptCount = Math.min(baselineAttempts.length, candidateAttempts.length);
  for (let index = 0; index < attemptCount; index += 1) {
    const baseline = baselineAttempts[index];
    const candidate = candidateAttempts[index];
    if (baseline === undefined || candidate === undefined) {
      break;
    }
    if (attemptIsSemantic(baseline) && attemptIsSemantic(candidate)) {
      return { comparable: true, baseline, candidate };
    }
  }
  return { comparable: false, baseline: null, candidate: null };
}

function emptyTally(): VariantOutcomeTally {
  return {
    semanticPass: 0,
    semanticFail: 0,
    providerErrors: 0,
    setupErrors: 0,
    turnLimits: 0,
    wallTimeouts: 0,
    comparablePairs: 0,
  };
}

function tallyOutcome(tally: VariantOutcomeTally, outcome: EvalOutcome): void {
  if (outcome === "provider-error") {
    tally.providerErrors += 1;
  } else if (outcome === "setup-error") {
    tally.setupErrors += 1;
  } else if (outcome === "turn-limit") {
    tally.turnLimits += 1;
  } else if (outcome === "wall-timeout") {
    tally.wallTimeouts += 1;
  }
}

/**
 * Aggregate pairs per variant. Infrastructure outcomes and both timeout
 * flavors are reported but never enter the semantic pass-rate denominator.
 */
export function summarizePairs(pairs: PairAttemptRecord[]): VariantOutcomeTallies {
  const tallies = {
    baseline: emptyTally(),
    candidate: emptyTally(),
  } satisfies VariantOutcomeTallies;
  for (const pair of pairs) {
    for (const attempt of pair.attempts) {
      const tally = tallies[attempt.variant];
      tallyOutcome(tally, attempt.outcome);
    }
    const chosen: SelectedComparableAttempts | null = pair.chosen;
    if (!pair.comparable || chosen === null) {
      continue;
    }
    tallies.baseline.comparablePairs += 1;
    tallies.candidate.comparablePairs += 1;
    if (chosen.baseline.outcome === "semantic-pass") {
      tallies.baseline.semanticPass += 1;
    } else {
      tallies.baseline.semanticFail += 1;
    }
    if (chosen.candidate.outcome === "semantic-pass") {
      tallies.candidate.semanticPass += 1;
    } else {
      tallies.candidate.semanticFail += 1;
    }
  }
  return tallies;
}
