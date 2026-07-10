/**
 * Rankings snapshot fetcher
 *
 * Fetches the llm-stats catalog via the public REST API and writes a
 * local snapshot file. The snapshot is the raw source of truth for leadership
 * generation; it is not user-preference-shaped.
 *
 * Baseline endpoints used:
 *   - GET https://api.zeroeval.com/stats/v1/models
 *   - GET https://api.zeroeval.com/stats/v1/benchmarks
 *   - GET https://api.zeroeval.com/stats/v1/rankings?category={id}&limit=50
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CategoryRankings, RankingsSnapshot, RankingRow } from "./types.ts";

const BASE_URL = "https://api.zeroeval.com/stats";
const RANKINGS_LIMIT = 50;
const REQUEST_DELAY_MS = 120;

export function getErrorMessage(error: unknown): string {
	if (error == null) return "Unknown error";
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message || error.name;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

class CategoryFetchError extends Error {
	public readonly category: string;

	constructor(category: string, cause: unknown) {
		super(`Failed to fetch rankings for category ${category}: ${getErrorMessage(cause)}`);
		this.name = "CategoryFetchError";
		this.category = category;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveHomeDir(): string {
	if (process.env.HOME) return process.env.HOME;
	if (process.env.USERPROFILE) return process.env.USERPROFILE;
	if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
	return require("node:os").homedir();
}

export function toAbsolutePath(value: string | undefined, fallback: string): string {
	const home = resolveHomeDir();
	const base = join(home, ".pi");
	if (!value) return fallback;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "." || trimmed === "..") return fallback;
	if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
	if (isAbsolute(trimmed)) return trimmed;
	if (trimmed.startsWith("/")) return trimmed;
	// Treat bare filename or relative path as anchored under ~/.pi/agent
	return join(base, "agent", trimmed);
}

const BUNDLED_SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "llm-rankings-snapshot.json");

export function getBundledSnapshotPath(): string {
	return BUNDLED_SNAPSHOT_PATH;
}

export function hasBundledSnapshot(): boolean {
	return existsSync(BUNDLED_SNAPSHOT_PATH);
}

export function seedOfflineSnapshot(outputPath: string): boolean {
	if (!existsSync(BUNDLED_SNAPSHOT_PATH)) return false;
	try {
		copyFileSync(BUNDLED_SNAPSHOT_PATH, outputPath);
		return true;
	} catch (error) {
		console.error(`[model-leadership] Failed to seed offline snapshot: ${getErrorMessage(error)}`);
		return false;
	}
}

export function getDefaultSnapshotPath(): string {
	const home = resolveHomeDir();
	return join(home, ".pi", "agent", "llm-rankings-snapshot.json");
}


async function fetchJson<T>(url: string, apiKey?: string): Promise<T> {
	const headers: Record<string, string> = { "Accept": "application/json", "User-Agent": "pi-subagents-leadership" };
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	return (await response.json()) as T;
}

async function fetchAllModels(apiKey?: string): Promise<unknown[]> {
	const raw = await fetchJson<{ models?: unknown[] }>(`${BASE_URL}/v1/models?limit=200`, apiKey);
	if (!Array.isArray(raw.models)) {
		return [];
	}
	const items: unknown[] = [];
	for (const entry of raw.models) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const value = entry as Record<string, unknown>;
		if (typeof value.id !== "string") {
			continue;
		}
		const organization = value.organization;
		const organizationId = value.organization_id;
		if (typeof organization !== "string") {
			continue;
		}
		if (typeof organizationId !== "string") {
			continue;
		}
		const displayName =
			typeof value.display_name === "string"
				? value.display_name
				: typeof value.name === "string"
					? value.name
					: String(value.id);
		const modelName =
			typeof value.model_name === "string"
				? value.model_name
				: typeof value.name === "string"
					? value.name
					: String(value.id);
		const providerName = typeof value.provider_name === "string" ? value.provider_name : organization;
		const contextLength = typeof value.context_length === "number" ? value.context_length : 0;
		const inputPrice = typeof value.input_price === "number" ? value.input_price : 0;
		const outputPrice = typeof value.output_price === "number" ? value.output_price : 0;
		const tier = typeof value.tier === "string" ? value.tier : "unknown";
		const modalities = (candidate: unknown): string[] => {
			if (!Array.isArray(candidate)) {
				return [];
			}
			const values: string[] = [];
			for (const item of candidate) {
				if (typeof item === "string") {
					values.push(item);
				}
			}
			return values;
		};
		const inputModalities = modalities(value.input_modalities);
		const outputModalities = modalities(value.output_modalities);
		items.push({
			id: value.id,
			displayName,
			modelName,
			providerName,
			organizationName: organization,
			organizationId,
			contextLength,
			inputPrice,
			outputPrice,
			tier,
			inputModalities,
			outputModalities,
		});
	}
	return items;
}

async function fetchBenchmarkCategories(apiKey?: string): Promise<string[]> {
	try {
		const data = await fetchJson<{ benchmarks?: Array<Record<string, unknown>> }>(`${BASE_URL}/v1/benchmarks?limit=200`, apiKey);
		if (!Array.isArray(data.benchmarks)) {
			return [];
		}
		const categories: string[] = [];
		for (const benchmark of data.benchmarks) {
			if (!benchmark || typeof benchmark !== "object") {
				continue;
			}
			const value = benchmark as Record<string, unknown>;
			const items = value.categories;
			if (!Array.isArray(items)) {
				continue;
			}
			categories.push(...items.filter((category): category is string => typeof category === "string"));
		}
		return [...new Set(categories)].sort();
	} catch {
		return [];
	}
}

async function fetchRankingsForCategory(category: string, apiKey?: string): Promise<CategoryRankings | null> {
	try {
		const data = await fetchJson<{
			category?: string;
			method?: string;
			ranked_at?: string;
			models?: Record<string, unknown>[];
		}>(`${BASE_URL}/v1/rankings?category=${encodeURIComponent(category)}&limit=${RANKINGS_LIMIT}`, apiKey);
		const rows: RankingRow[] = [];
		const models = data.models ?? [];
		for (const model of models) {
			if (!model || typeof model !== "object") {
				continue;
			}
			const value = model as Record<string, unknown>;
			const conservativeRatingRaw = value.conservative_rating;
			let conservativeRating: number | null = null;
			if (conservativeRatingRaw !== undefined && conservativeRatingRaw !== null) {
				const coerce = Number(conservativeRatingRaw);
				if (Number.isFinite(coerce)) {
					conservativeRating = coerce;
				}
			}
			rows.push({
				rank: Number.isFinite(value.rank) ? Number(value.rank) : 0,
				modelId: typeof value.model_id === "string" ? value.model_id : "",
				modelName: typeof value.model_name === "string" ? value.model_name : "",
				organization: typeof value.organization === "string" ? value.organization : "",
				conservativeRating,
				score: value.score === null || value.score === undefined ? null : Number(value.score),
				openWeight: value.open_weight === null || value.open_weight === undefined ? null : Boolean(value.open_weight),
				minInputPrice: value.min_input_price === null || value.min_input_price === undefined ? null : Number(value.min_input_price),
				benchmarksEvaluated: value.benchmarks_evaluated === null || value.benchmarks_evaluated === undefined ? null : Number(value.benchmarks_evaluated),
				url: typeof value.url === "string" ? value.url : null,
			});
		}
		return {
			category: typeof data.category === "string" ? data.category : category,
			method: typeof data.method === "string" ? data.method : "trueskill",
			rankedAt: typeof data.ranked_at === "string" ? data.ranked_at : new Date().toISOString(),
			rows,
		};
	} catch (error) {
		throw new CategoryFetchError(category, error);
	}
}

export async function fetchRankingsSnapshot(
	options: {
		outputPath?: string;
		baseUrl?: string;
		limit?: number;
		delayMs?: number;
		apiKey?: string;
		quiet?: boolean;
	} = {},
): Promise<RankingsSnapshot> {
	const outputPath = toAbsolutePath(options.outputPath, getDefaultSnapshotPath());
	const delayMs = options.delayMs ?? REQUEST_DELAY_MS;
	const apiKey = options.apiKey;
	const quiet = options.quiet ?? false;

	const categories = await fetchBenchmarkCategories(apiKey);

	const snapshot: RankingsSnapshot = {
		generatedAt: new Date().toISOString(),
		source: "llm-stats REST API",
		categories: Object.fromEntries(categories.map((category) => [category, { id: category }])),
		rankings: {} as Record<string, CategoryRankings>,
		modelsSummary: await fetchAllModels(apiKey),
	};

	if (!quiet) console.log(`Fetching rankings for ${categories.length} categories...`);
	let successCount = 0;
	for (let i = 0; i < categories.length; i++) {
		const category = categories[i]!;
		try {
			const ranking = await fetchRankingsForCategory(category, apiKey);
			if (ranking) {
				snapshot.rankings[category] = ranking;
				successCount++;
				if (!quiet) console.log(`[${i + 1}/${categories.length}] ${category}: ${ranking.rows.length} ranked`);
			} else {
				if (!quiet) console.log(`[${i + 1}/${categories.length}] ${category}: skipped`);
			}
		} catch (error) {
			if (!quiet) console.error(`[model-leadership] Failed to fetch rankings for ${category}: ${getErrorMessage(error)}`);
		}
		if (i < categories.length - 1) {
			await sleep(delayMs);
		}
	}

	writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");
	const successThreshold = Math.max(1, Math.floor(categories.length * 0.5));
	if (successCount < successThreshold) {
		console.error(
			`[model-leadership] Snapshot wrote with low coverage: ${successCount}/${categories.length} categories succeeded (minimum ${successThreshold}).`,
		);
	}
	if (!quiet) console.log(`Saved snapshot to ${outputPath}`);
	return snapshot;
}

export function loadRankingsSnapshot(path?: string): RankingsSnapshot | null {
	const resolved = toAbsolutePath(path, getDefaultSnapshotPath());
	if (!existsSync(resolved)) {
		return null;
	}
	try {
		const content = readFileSync(resolved, "utf-8");
		return JSON.parse(content) as RankingsSnapshot;
	} catch (error) {
		console.error(`Failed to load rankings snapshot from ${resolved}: ${getErrorMessage(error)}`);
		return null;
	}
}

export function validateModelsSummary(models: unknown[]): RankingsSnapshot["modelsSummary"] {
	const normalized: RankingsSnapshot["modelsSummary"] = [];
	for (const raw of models) {
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const value = raw as Record<string, unknown>;
		if (typeof value.id !== "string" || typeof value.organization !== "string" || typeof value.organization_id !== "string") {
			continue;
		}
		const text = (candidate: unknown, fallback = ""): string => (typeof candidate === "string" ? candidate : fallback);
		const numbers = (candidate: unknown, fallback = 0): number => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback);
		const stringArray = (candidate: unknown): string[] => {
			if (!Array.isArray(candidate)) {
				return [];
			}
			const items: string[] = [];
			for (const entry of candidate) {
				if (typeof entry === "string") {
					items.push(entry);
				}
			}
			return items;
		};
		normalized.push({
			id: value.id,
			displayName: text(value.display_name ?? value.name, value.id),
			modelName: text(value.model_name ?? value.name, value.id),
			providerName: text(value.provider_name ?? value.organization),
			organizationName: value.organization,
			organizationId: value.organization_id,
			contextLength: numbers(value.context_length),
			inputPrice: numbers(value.input_price),
			outputPrice: numbers(value.output_price),
			tier: text(value.tier, "unknown"),
			inputModalities: stringArray(value.input_modalities),
			outputModalities: stringArray(value.output_modalities),
		});
	}
	return normalized;
}
