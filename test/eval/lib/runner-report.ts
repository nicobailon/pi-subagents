/**
 * Result document assembly and persistence for the paired evaluation runner.
 *
 * The document is written incrementally after every attempt so interrupted
 * runs still leave a readable partial record. Pairs are comparable only when
 * both variants produced semantic outcomes; infrastructure attempts stay in
 * the document but outside the semantic pass-rate denominator.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { selectComparableAttempts, summarizePairs } from "./classify-outcome.ts";
import type {
  PairAttemptRecord,
  SessionAttemptMetrics,
  SuiteSourceReport,
  VariantKind,
  VariantOutcomeTallies,
} from "./eval-types.ts";

/** Reproducibility metadata fixed before the first paired session starts. */
export interface RunnerHarnessMetadata {
  entry: string;
  candidateRoot: string;
  baselineRoot: string;
  piSdkEntry: string;
  providerExtensions: ProviderExtensionSource[];
  models: string[];
  suite: string;
  repetitions: number;
  retryCap: number;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  suiteSources: SuiteSourceEntry[];
  heldOutSourceReport: SuiteSourceReport | null;
  systemPrompt: string;
  scope: string;
}

/** One explicitly loaded provider extension and its content digest. */
export interface ProviderExtensionSource {
  path: string;
  sha256: string;
}

/** One decoded fixture source and the independent-design provenance it carries. */
export interface SuiteSourceEntry {
  file: string;
  sha256: string;
  suite: string;
  sourceReport: SuiteSourceReport | null;
}

/** Aggregate pre-effect denial evidence from deterministic policy probes. */
export interface PolicyProbeSummary {
  total: number;
  blockedWithZeroEffects: number;
}

/** Bounded outcome summary that keeps semantic and infrastructure counts separate. */
export interface ResultSummary {
  totalPairAttempts: number;
  pairs: number;
  byVariant: VariantOutcomeTallies;
  infrastructureNote: string;
  policyProbes: PolicyProbeSummary;
}

/** Incrementally persisted evaluator document; interrupted runs remain readable. */
export interface ResultDocument {
  version: number;
  startedAt: string;
  completedAt?: string;
  status: string;
  failure?: string;
  harness: RunnerHarnessMetadata;
  pairs: PairEntry[];
  policyProbes: PolicyProbeRecord[];
  summary?: ResultSummary;
}

/** One preserved variant attempt associated with its stable pair identity. */
export interface PairEntry {
  pairId: string;
  attempt: SessionAttemptMetrics;
}

/** One deterministic policy decision with its pre-effect evidence. */
export interface PolicyProbeRecord {
  fixtureId: string;
  variant: VariantKind;
  name: string;
  blocked: boolean;
  parseOk: boolean;
  parseError?: string;
  effectCount: number;
  reasons: string[];
}

/** Hash one text artifact for evaluator provenance. */
export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file, "utf8")).digest("hex");
}

/** Start an empty running result document for one evaluator invocation. */
export function createResultDocument(harness: RunnerHarnessMetadata): ResultDocument {
  return {
    version: 3,
    startedAt: new Date().toISOString(),
    status: "running",
    harness,
    pairs: [],
    policyProbes: [],
  };
}

/** Persist the complete current document so abrupt termination loses no prior attempts. */
export function saveResultDocument(document: ResultDocument, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(document, null, 2));
}

/**
 * Deterministic variant order for one (repetition, attemptIndex) pair:
 * baseline-first on odd sums, candidate-first on even sums, so the order
 * alternates across repetitions and across bounded retries.
 */
export function variantOrderFor(repetition: number, attemptIndex: number): readonly VariantKind[] {
  const order: VariantKind[] =
    (repetition + attemptIndex) % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  return order;
}

function groupAttemptsByPair(pairs: PairEntry[]): Map<string, SessionAttemptMetrics[]> {
  const byPair = new Map<string, SessionAttemptMetrics[]>();
  for (const entry of pairs) {
    const list = byPair.get(entry.pairId) ?? [];
    list.push(entry.attempt);
    byPair.set(entry.pairId, list);
  }
  return byPair;
}

/** Pair-level attempt history plus denominator-safe aggregate tallies. */
export interface AssembledReport {
  pairRecords: PairAttemptRecord[];
  tallies: VariantOutcomeTallies;
}

/** Assemble pair records (all attempts preserved) plus the variant tallies. */
export function assembleReport(document: ResultDocument): AssembledReport {
  const byPair = groupAttemptsByPair(document.pairs);
  const pairRecords: PairAttemptRecord[] = [];
  for (const [pairId, attempts] of byPair) {
    const selection = selectComparableAttempts(attempts);
    pairRecords.push({
      pairId,
      attempts,
      comparable: selection.comparable,
      chosen:
        selection.baseline === null || selection.candidate === null
          ? null
          : { baseline: selection.baseline, candidate: selection.candidate },
    });
  }
  return { pairRecords, tallies: summarizePairs(pairRecords) };
}

/** Summarize a result document without counting infrastructure outcomes as model failures. */
export function summarizeDocument(document: ResultDocument): ResultSummary {
  const { pairRecords, tallies } = assembleReport(document);
  return {
    totalPairAttempts: document.pairs.length,
    pairs: pairRecords.length,
    byVariant: tallies,
    infrastructureNote:
      "provider-error, setup-error, and wall-timeout attempts are recorded and retry-eligible but excluded from the semantic pass-rate denominator; turn-limit is a model/efficiency outcome and is never silently retried.",
    policyProbes: {
      total: document.policyProbes.length,
      blockedWithZeroEffects: document.policyProbes.filter(
        (probe) => probe.blocked && probe.effectCount === 0,
      ).length,
    },
  };
}

/** Human-readable line for one completed attempt. */
export function attemptLine(attempt: SessionAttemptMetrics): string {
  return `${attempt.fixtureId} ${attempt.variant} order=${attempt.variantOrder.join("/")} attempt=${attempt.attemptIndex}: ${attempt.outcome}, turns=${attempt.turns}, calls=${attempt.toolCalls.length}`;
}
