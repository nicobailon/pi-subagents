/**
 * Runtime model exclusions
 *
 * Tracks retry-safe exclusions by modelId/provider with TTL, so automatic
 * cross-provider fallback does not override selection strategy. Leadership
 * still chooses candidates; this module only removes known-bad candidates
 * from the next selection pass.
 *
 * Exclusions are persisted to ~/.pi/agent/model-exclusions.json so they
 * survive process restarts and are shared across sessions. Persistence also
 * provides a browsable debug log of what failed, when, and why.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProviderRateLimits, type ProviderRateLimit } from "./provider-rate-limits.ts";

export const EXCLUSIONS_PATH_ENV = "PI_MODEL_EXCLUSIONS_PATH";

export interface ModelExclusion {
  modelId?: string;
  provider?: string;
  reason?: string;
  retryAfterHint?: string;
  retryCondition?: string;
  recordedAt: number;
  expiresAt: number;
}

let exclusions: ModelExclusion[] = [];
let loaded = false;
let defaultTTLMs = 24 * 60 * 60_000; // 24 hours, overridable via config + setDefaultTTL
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Optional rate-limit enrichment for model exclusions.
 *
 * This does not create exclusions by itself. It only adds richer metadata
 * when a runtime failure is already being recorded.
 */
export function enrichExclusionWithRateLimits(options: {
  provider?: string;
  modelId?: string;
  rateType?: string;
  usageProfile?: string;
  endpoint?: string;
  now?: string;
}): { retryAfterHint?: string; retryCondition?: string } {
  const provider = options.provider;
  const modelId = options.modelId;
  if (!provider) return {};
  const snapshot = loadProviderRateLimits();
  if (!snapshot) return {};
  const now = options.now ?? new Date().toISOString().slice(0, 10);
  const candidates = snapshot.filter((row) => row.provider.toLowerCase() === provider.toLowerCase());
  const applicable = candidates.filter((row) => isApplicableRateLimit(row, now));
  if (!applicable.length) return {};
  const scored = applicable.map((row) => ({
    row,
    score: scoreMatch(row, modelId, options.rateType, options.usageProfile, options.endpoint),
    hasHint: Boolean(row.retryAfterHint?.trim()),
    hardLimit: row.limitMode.toLowerCase() === "hard" ? 1 : 0,
    specificity: scopeSpecificity(row.scope),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.hasHint !== b.hasHint) return a.hasHint ? -1 : 1;
    if (b.hardLimit !== a.hardLimit) return b.hardLimit - a.hardLimit;
    return b.specificity - a.specificity;
  });
  const best = scored[0];
  const explicitHint = best.row.retryAfterHint?.trim();
  const inferredHint = explicitHint || inferRetryHintFromRow(best.row);
  const hint = inferredHint || undefined;
  const tokenWindow = formatTokenWindow(best.row);
  const condition = hint
    ? tokenWindow
      ? `retry after ${hint}; token window: ${tokenWindow}`
      : `retry after ${hint}`
    : tokenWindow
      ? `retry after exclusion TTL; token window: ${tokenWindow}`
      : `retry after exclusion TTL`;
  return {
    retryAfterHint: hint,
    retryCondition: condition,
  };
}

export function inferRetryHintFromRow(row: ProviderRateLimit): string | undefined {
  const rpm = Number(row.rpmMax);
  const rph = Number(row.rphMax);
  const rpd = Number(row.rpdMax);
  if (Number.isFinite(rpm) && rpm > 0) return "next minute";
  if (Number.isFinite(rph) && rph > 0) return "next hour";
  if (Number.isFinite(rpd) && rpd > 0) return "next day";

  const tpm = Number(row.tpmMax);
  const tph = Number(row.tphMax);
  const tpd = Number(row.tpdMax);
  if (Number.isFinite(tpm) && tpm > 0) return "next minute";
  if (Number.isFinite(tph) && tph > 0) return "next hour";
  if (Number.isFinite(tpd) && tpd > 0) return "next day";

  return undefined;
}

export function formatTokenWindow(row: ProviderRateLimit): string | undefined {
  const parts: string[] = [];
  const tpm = Number(row.tpmMax);
  const tph = Number(row.tphMax);
  const tpd = Number(row.tpdMax);
  if (Number.isFinite(tpm) && tpm > 0) parts.push(`${tpm} TPM`);
  if (Number.isFinite(tph) && tph > 0) parts.push(`${tph} TPH`);
  if (Number.isFinite(tpd) && tpd > 0) parts.push(`${tpd} TPD`);
  return parts.length ? parts.join(", ") : undefined;
}

function scoreMatch(row: ProviderRateLimit, modelId?: string, rateType?: string, usageProfile?: string, endpoint?: string) {
  let score = 0;
  if (modelId && row.target.toLowerCase() === modelId.toLowerCase()) score += 4;
  if (rateType && row.rateType.toLowerCase() === rateType.toLowerCase()) score += 2;
  if (usageProfile && row.usageProfile.toLowerCase() === usageProfile.toLowerCase()) score += 2;
  if (endpoint && row.endpoint.toLowerCase() === endpoint.toLowerCase()) score += 1;
  return score;
}

function scopeSpecificity(scope: string) {
  const value = (scope ?? "").trim().toLowerCase();
  if (value === "model") return 2;
  if (value === "family") return 1;
  return 0;
}

function isApplicableRateLimit(row: ProviderRateLimit, now: string): boolean {
  if (row.effectiveStart && now < row.effectiveStart) return false;
  if (row.effectiveEnd && now > row.effectiveEnd) return false;
  return true;
}

export function setDefaultTTL(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) defaultTTLMs = ms;
}

export function getExclusionsFilePath(): string {
  const envPath = process.env[EXCLUSIONS_PATH_ENV];
  if (typeof envPath === "string" && envPath.trim()) return envPath.trim();
  return path.join(os.homedir(), ".pi", "agent", "model-exclusions.json");
}

const EXCLUSIONS_FILE = getExclusionsFilePath();

export function flushPersist(): void {
  try {
    fs.mkdirSync(path.dirname(EXCLUSIONS_FILE), { recursive: true });
    const tmpPath = EXCLUSIONS_FILE + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify({
      version: 1,
      exclusions: deduplicate(exclusions),
    }, null, 2), "utf-8");
    fs.renameSync(tmpPath, EXCLUSIONS_FILE);
  } catch (error) {
    console.error(`[model-exclusions] Failed to persist exclusions to ${EXCLUSIONS_FILE}:`, error);
  }
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersist();
  }, 5000);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(EXCLUSIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data.version === 1) {
      const now = Date.now();
      exclusions = (data.exclusions ?? []).filter((e: ModelExclusion) => e.expiresAt > now);
      exclusions = deduplicate(exclusions);
    }
  } catch {
    // File missing, corrupt, or unreadable — start fresh.
  }
}

function persist(): void {
  ensureLoaded();
  schedulePersist();
}

function dedupKey(entry: ModelExclusion): string {
  return `${entry.provider ?? ""}|${entry.modelId ?? ""}`;
}

function deduplicate(items: ModelExclusion[]): ModelExclusion[] {
  const map = new Map<string, ModelExclusion>();
  for (const entry of items) {
    const key = dedupKey(entry);
    const existing = map.get(key);
    if (!existing || entry.recordedAt > existing.recordedAt) {
      map.set(key, entry);
    }
  }
  return Array.from(map.values());
}

function ttlFromRetryHint(hint: string | undefined, fallbackMs: number): number {
  if (!hint) return fallbackMs;
  const normalized = hint.toLowerCase();
  if (normalized.includes("minute")) return 60_000;
  if (normalized.includes("hour")) return 60 * 60_000;
  if (normalized.includes("day")) return 24 * 60 * 60_000;
  return fallbackMs;
}

export function recordModelFailure(options: {
  modelId?: string;
  provider?: string;
  reason?: string;
  ttlMs?: number;
  retryAfterHint?: string;
  retryCondition?: string;
}): void {
  ensureLoaded();
  const ttl = options.ttlMs ?? ttlFromRetryHint(options.retryAfterHint, defaultTTLMs);
  const exclusion: ModelExclusion = {
    modelId: options.modelId,
    provider: options.provider,
    reason: options.reason ?? "runtime-failure",
    retryAfterHint: options.retryAfterHint,
    retryCondition: options.retryCondition,
    recordedAt: Date.now(),
    expiresAt: Date.now() + ttl,
  };
  exclusions.unshift(exclusion);
  exclusions = deduplicate(exclusions);
  if (exclusions.length > 200) exclusions.length = 200;
  persist();
}

export function exclude(options: {
  modelId?: string;
  provider?: string;
  reason?: string;
  ttlMs?: number;
  retryAfterHint?: string;
  retryCondition?: string;
} = {}): void {
  ensureLoaded();
  const ttl = options.ttlMs ?? ttlFromRetryHint(options.retryAfterHint, defaultTTLMs);
  const exclusion: ModelExclusion = {
    modelId: options.modelId,
    provider: options.provider,
    reason: options.reason ?? "runtime-failure",
    retryAfterHint: options.retryAfterHint,
    retryCondition: options.retryCondition,
    recordedAt: Date.now(),
    expiresAt: Date.now() + ttl,
  };
  exclusions.unshift(exclusion);
  exclusions = deduplicate(exclusions);
  if (exclusions.length > 200) exclusions.length = 200;
  persist();
}

export function clearExpiredExclusions(): void {
  ensureLoaded();
  const now = Date.now();
  prune(exclusions, now);
  persist();
}

export function clearExclusions(): void {
  ensureLoaded();
  exclusions.length = 0;
  persist();
}

export function isExcluded(modelId: string, provider: string): boolean {
  ensureLoaded();
  const now = Date.now();
  return exclusions.some((entry) => {
    if (entry.expiresAt <= now) return false;
    return (entry.modelId && entry.modelId === modelId) || (entry.provider && entry.provider === provider);
  });
}

export function getExcludedCount(): number {
  ensureLoaded();
  clearExpiredExclusions();
  return exclusions.length;
}

export function filterFallbackCandidates(candidates: string[], opts?: { now?: number }): string[] {
  ensureLoaded();
  const timestamp = opts?.now ?? Date.now();
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const raw of candidates) {
    if (!raw || seen.has(raw)) continue;
    const baseModel = raw.includes(":") ? raw.substring(0, raw.lastIndexOf(":")) : raw;
    const candidateProvider = baseModel.includes("/") ? baseModel.split("/")[0]! : undefined;
    const candidateModelId = candidateProvider ? baseModel.split("/").slice(1).join("/") : baseModel;
    const expired = exclusions.some((entry) => {
      if (entry.expiresAt <= timestamp) return false;
      return (entry.modelId && entry.modelId === candidateModelId) || (entry.provider && entry.provider === candidateProvider);
    });
    if (expired) continue;
    seen.add(raw);
    filtered.push(raw);
  }
  return filtered;
}

/**
 * Reload exclusions from disk (for tests and config hot‑reload).
 * Discards any in‑memory‑only exclusions that were not yet persisted.
 */
export function reloadFromDisk(): void {
  loaded = false;
  exclusions = [];
  ensureLoaded();
}

function prune(items: ModelExclusion[], now: number): void {
  let write = 0;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!;
    if (entry.expiresAt > now) {
      items[write++] = entry;
    }
  }
  items.length = write;
}
