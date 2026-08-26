import * as fs from "node:fs";
import * as path from "node:path";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

export const EXCLUSIONS_PATH_ENV = "PI_MODEL_EXCLUSIONS_PATH";

type ModelExclusionTarget = { modelId: string; provider?: string } | { provider: string; modelId?: never };

export type ModelExclusion = ModelExclusionTarget & {
	reason?: string;
	recordedAt: number;
	expiresAt: number;
};

type RecordModelFailureOptions = ModelExclusionTarget & {
	reason?: string;
	ttlMs?: number;
};

let exclusions: ModelExclusion[] = [];
let loaded = false;
/** Default duration for a new model exclusion when no per-record TTL is supplied. */
export const DEFAULT_MODEL_EXCLUSION_TTL_MS = 24 * 60 * 60_000;
/** Keeps a new expiry safely below JavaScript's maximum Date timestamp. */
export const MAX_MODEL_EXCLUSION_TTL_MS = 8_000_000_000_000_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
let defaultTTLMs = DEFAULT_MODEL_EXCLUSION_TTL_MS;
let loadedTTLCeilingMs: number | undefined;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistSeq = 0;

/**
 * Override the default TTL applied to newly recorded model exclusions.
 *
 * @param ms Duration in milliseconds. Must be finite and positive.
 * @returns Nothing.
 */
// TEST:test/unit/model-exclusions.test.ts[model exclusions — TTL expiry]
export function setDefaultTTL(ms: number, options?: { shortenExisting?: boolean }): void {
	if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MODEL_EXCLUSION_TTL_MS) {
		throw new Error(`Default model exclusion TTL must be a finite positive number no greater than ${MAX_MODEL_EXCLUSION_TTL_MS}.`);
	}
	defaultTTLMs = ms;
	loadedTTLCeilingMs = options?.shortenExisting ? ms : undefined;
	if (loaded && loadedTTLCeilingMs !== undefined && shortenExclusionsToTTL(exclusions, loadedTTLCeilingMs, Date.now())) schedulePersist();
}

/**
 * Resolve the persistence path. Honors PI_MODEL_EXCLUSIONS_PATH; defaults to
 * <TEMP_ROOT_DIR>/model-exclusions.json. Resolved lazily so tests can point the
 * store at an isolated location after module load.
 */
export function getExclusionsFilePath(): string {
	const envPath = process.env[EXCLUSIONS_PATH_ENV];
	if (typeof envPath === "string" && envPath.trim()) return envPath.trim();
	return path.join(TEMP_ROOT_DIR, "model-exclusions.json");
}

/**
 * Persist exclusions to disk immediately (atomic write via tmp + rename).
 * The store otherwise debounces writes; call this when durability matters
 * (and in tests).
 */
export function flushPersist(): void {
	const file = getExclusionsFilePath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmpPath = `${file}.${process.pid}.${persistSeq++}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify({
			version: 1,
			exclusions: deduplicate(exclusions),
		}, null, 2), "utf-8");
		fs.renameSync(tmpPath, file);
	} catch (error) {
		console.error(`[model-exclusions] Failed to persist exclusions to ${file}:`, error);
	}
}

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		flushPersist();
	}, 5000);
	// Never hold the process open just to flush exclusions.
	persistTimer.unref?.();
}

function ensureLoaded(): void {
	if (loaded) return;
	loaded = true;
	try {
		const raw = fs.readFileSync(getExclusionsFilePath(), "utf-8");
		const data = JSON.parse(raw);
		if (data.version === 1) {
			if (!Array.isArray(data.exclusions)) throw new Error("Model exclusion store version 1 must contain an exclusions array.");
			for (let index = 0; index < data.exclusions.length; index++) {
				const entry = data.exclusions[index];
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Model exclusion store entry ${index} must be an object.`);
				if (entry.reason !== undefined && typeof entry.reason !== "string") throw new Error(`Model exclusion store entry ${index} has an invalid reason.`);
				for (const field of ["recordedAt", "expiresAt"] as const) {
					const timestamp = entry[field];
					if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > MAX_DATE_TIMESTAMP_MS) {
						throw new Error(`Model exclusion store entry ${index} has an invalid ${field}.`);
					}
				}
			}
			const now = Date.now();
			exclusions = (data.exclusions ?? []).filter((e: ModelExclusion) => e.expiresAt > now);
			const shortened = loadedTTLCeilingMs !== undefined && shortenExclusionsToTTL(exclusions, loadedTTLCeilingMs, now);
			exclusions = deduplicate(exclusions);
			if (shortened) schedulePersist();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[model-exclusions] Failed to load exclusions from ${getExclusionsFilePath()}:`, error);
		}
	}
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

/**
 * Record a model failure as a temporary exclusion. While the exclusion is
 * active, {@link isExcluded} returns true for the model (or for every model of
 * the provider when modelId is omitted), and {@link filterFallbackCandidates}
 * removes matching candidates from fallback lists.
 */
export function recordModelFailure(options: RecordModelFailureOptions): void {
	ensureLoaded();
	const ttl = options.ttlMs ?? defaultTTLMs;
	const now = Date.now();
	const target: ModelExclusionTarget = options.modelId !== undefined
		? { modelId: options.modelId, ...(options.provider ? { provider: options.provider } : {}) }
		: { provider: options.provider };
	const exclusion: ModelExclusion = {
		...target,
		reason: options.reason ?? "runtime-failure",
		recordedAt: now,
		expiresAt: now + ttl,
	};
	exclusions.unshift(exclusion);
	exclusions = deduplicate(exclusions);
	if (exclusions.length > 200) exclusions.length = 200;
	flushPersist();
}

/**
 * Drop all expired exclusions from memory and schedule a persist.
 */
export function clearExpiredExclusions(): void {
	ensureLoaded();
	prune(exclusions, Date.now());
	schedulePersist();
}

/**
 * Remove every exclusion (e.g. after the operator fixes credentials).
 */
export function clearExclusions(): void {
	ensureLoaded();
	exclusions.length = 0;
	schedulePersist();
}

/**
 * Whether an exclusion entry matches a candidate.
 *
 * Semantics:
 * - Entry with modelId: model-specific exclusion. Matches only that modelId;
 *   when both the entry and the candidate carry a provider, the providers must
 *   also agree so `openai/gpt-4` does not exclude `github-copilot/gpt-4`.
 * - Entry without modelId: provider-wide exclusion (e.g. quota or auth failure).
 *   Matches every model of that provider.
 */
function entryMatches(entry: ModelExclusion, candidateModelId: string, candidateProvider: string | undefined, now: number): boolean {
	if (entry.expiresAt <= now) return false;
	if (entry.modelId) {
		if (entry.modelId !== candidateModelId) return false;
		return !entry.provider || !candidateProvider || entry.provider === candidateProvider;
	}
	return Boolean(entry.provider) && entry.provider === candidateProvider;
}

/**
 * Whether a model (or its provider) is currently excluded.
 */
export function isExcluded(modelId: string, provider: string): boolean {
	ensureLoaded();
	return exclusions.some((entry) => entryMatches(entry, modelId, provider, Date.now()));
}

/**
 * Return the active exclusion matching a full model id, if any.
 *
 * The caller uses this for hard-fail diagnostics; fallback filtering should
 * continue to use {@link filterFallbackCandidates}.
 */
export function findModelExclusion(fullId: string, now = Date.now()): Readonly<ModelExclusion> | undefined {
	ensureLoaded();
	const { provider, modelId } = parseModelKey(fullId);
	return exclusions.find((entry) => entryMatches(entry, modelId, provider, now));
}

/**
 * Number of live (non-expired) exclusions.
 */
export function getExcludedCount(): number {
	ensureLoaded();
	clearExpiredExclusions();
	return exclusions.length;
}

/**
 * Split a candidate fullId into its provider + modelId components.
 *
 * A fullId may carry a thinking suffix (`provider/model:thinking`) which is
 * stripped before parsing, and the modelId itself may contain slashes
 * (e.g. `openrouter/google/gemini-flash`). The first `/`-segment is the
 * provider; everything after is the modelId. This MUST stay in lock-step with
 * the matching inside {@link isExcluded} so that a failure recorded via
 * {@link recordModelFailure} is later recognised by the candidate filter.
 */
export function parseModelKey(fullId: string): { provider?: string; modelId: string } {
	const base = splitKnownThinkingSuffix(fullId).baseModel;
	if (!base.includes("/")) return { modelId: base };
	const slash = base.indexOf("/");
	return { provider: base.slice(0, slash), modelId: base.slice(slash + 1) };
}

/**
 * Filter a list of candidate fullIds, removing excluded models/providers and
 * duplicates while preserving order.
 */
export function filterFallbackCandidates(candidates: string[], opts?: {
	now?: number;
	onExcluded?: (candidate: string, exclusion: Readonly<ModelExclusion>) => void;
}): string[] {
	ensureLoaded();
	const timestamp = opts?.now ?? Date.now();
	const seen = new Set<string>();
	const filtered: string[] = [];
	for (const raw of candidates) {
		if (!raw || seen.has(raw)) continue;
		const { provider: candidateProvider, modelId: candidateModelId } = parseModelKey(raw);
		const exclusion = exclusions.find((entry) => entryMatches(entry, candidateModelId, candidateProvider, timestamp));
		if (exclusion) {
			opts?.onExcluded?.(raw, exclusion);
			continue;
		}
		seen.add(raw);
		filtered.push(raw);
	}
	return filtered;
}

/**
 * Reload exclusions from disk (for tests and config hot-reload).
 * Discards any in-memory-only exclusions that were not yet persisted.
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

function shortenExclusionsToTTL(items: ModelExclusion[], ttlMs: number, now: number): boolean {
	let changed = false;
	for (const entry of items) {
		const configuredExpiry = entry.recordedAt + ttlMs;
		if (entry.expiresAt > configuredExpiry) {
			entry.expiresAt = configuredExpiry;
			changed = true;
		}
	}
	const previousLength = items.length;
	prune(items, now);
	return changed || items.length !== previousLength;
}
