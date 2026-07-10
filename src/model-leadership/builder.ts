/**
 * Leadership builder
 *
 * Joins the raw llm-stats rankings snapshot with Pi's registered models and
 * produces the deterministic leadership artifact consumed by model selection.
 *
 * Multiple provider routes for the same logical model are grouped together
 * so ranking and selection treat them as one ranked entity with redundant
 * provider routes.
 */

import type {
	CategoryRankings,
	LeadershipArtifact,
	LeadershipModel,
	ModelLeadershipConfig,
	ModelLeadershipPreferences,
	PaidModelSortRule,
	PiModelInfo,
	RankingsSnapshot,
} from "./types.ts";

export function resolveLeadershipConfigOrDefault(config: ModelLeadershipConfig | undefined): Required<ModelLeadershipConfig> {
	const DEFAULT_LEADERSHIP_PRIORITIES: ModelLeadershipConfig["preferences"] = {
		preferFree: true,
		defaultCategory: "coding",
		maxResults: 50,
	};
	const preferences = { ...DEFAULT_LEADERSHIP_PRIORITIES, ...(config?.preferences ?? {}) };
	const maxResults = Number.isFinite(preferences.maxResults ?? 0) && (preferences.maxResults ?? 0) > 0
		? Number(preferences.maxResults)
		: 50;
	return {
		enabled: config?.enabled ?? false,
		snapshotPath: config?.snapshotPath ?? "",
		leadershipPath: config?.leadershipPath ?? "",
		llmStatsApiKey: config?.llmStatsApiKey ?? "",
		preferences: {
			preferFree: preferences.preferFree ?? true,
			defaultCategory: preferences.defaultCategory ?? "coding",
			maxResults,
			paidSortRule: preferences.paidSortRule ?? { strategy: "priority" },
		},
	};
}

function getNormalizedCanonicalModelId(modelId: string): string {
	const normalized = modelId.trim().toLowerCase().replace(/^~/, "").replace(/:free$/, "").replace(/-free$/, "");
	const segments = normalized.split("/");
	return segments[segments.length - 1] ?? normalized;
}

function rankingModelIdMatches(a: string, b: string): boolean {
	const normalizedA = getNormalizedCanonicalModelId(a);
	const normalizedB = getNormalizedCanonicalModelId(b);
	if (normalizedA === normalizedB) return true;
	return false;
}

function groupModelsByIdentity(models: PiModelInfo[]): Map<string, PiModelInfo[]> {
	const groups = new Map<string, PiModelInfo[]>();
	for (const model of models) {
		const key = getNormalizedCanonicalModelId(model.id);
		const existing = groups.get(key);
		if (existing) {
			existing.push(model);
		} else {
			groups.set(key, [model]);
		}
	}
	return groups;
}

function buildLeadershipModelRow(
	instances: PiModelInfo[],
	snapshot: RankingsSnapshot,
): LeadershipModel {
	const availableInstances = instances.filter((m) => m.available);
	const primary = availableInstances[0] ?? instances[0]!;
	const rankings: Record<string, number | null> = {};

	let bestRank: number | null = null;
	let bestConservative: number | null = null;
	for (const [category, ranking] of Object.entries(snapshot.rankings)) {
		const match = ranking.rows.find((r) =>
			rankingModelIdMatches(r.modelId, primary.id) || rankingModelIdMatches(r.modelId, primary.fullId),
		);
		if (match) {
			rankings[category] = match.rank;
			if (bestRank === null || match.rank < bestRank) bestRank = match.rank;
			if (
				match.conservativeRating != null &&
				(bestConservative === null || match.conservativeRating > bestConservative)
			) {
				bestConservative = match.conservativeRating;
			}
		}
	}

	const providers = instances.map((m) => `${m.provider}/${m.id}`);
	const availableProviders = availableInstances.map((m) => `${m.provider}/${m.id}`);
	const costReference = availableInstances[0] ?? primary;

	return {
		id: primary.id,
		provider: primary.provider,
		modelId: primary.id,
		name: primary.name,
		isFree: primary.isFree,
		hasApiKey: availableInstances.length > 0,
		cost: costReference.cost,
		contextWindow: primary.contextWindow,
		family: primary.family,
		categories: Object.keys(rankings),
		providers,
		availableProviders,
		rankings,
		conservativeRating: bestConservative,
		availabilityScore: providers.length > 0 ? availableProviders.length / providers.length : 0,
		available: availableInstances.length > 0,
		topRanking: bestRank,
		topRankingCategory: bestRank == null ? null : Object.entries(rankings).sort(([a], [b]) => a.localeCompare(b)).find(([, rank]) => rank === bestRank)?.[0] ?? null,
	};
}

function sortLeadershipModels(models: LeadershipModel[]): LeadershipModel[] {
	const copy = models.slice();
	copy.sort((a, b) => {
		if (a.available !== b.available) return a.available ? -1 : 1;
		const aRank = a.topRanking ?? Object.values(a.rankings)[0] ?? Infinity;
		const bRank = b.topRanking ?? Object.values(b.rankings)[0] ?? Infinity;
		return aRank - bRank;
	});
	return copy;
}

function buildLeadershipModels(snapshot: RankingsSnapshot, piModels: PiModelInfo[]): LeadershipModel[] {
	const rows: LeadershipModel[] = [];
	for (const [, instances] of groupModelsByIdentity(piModels)) {
		rows.push(buildLeadershipModelRow(instances, snapshot));
	}
	return sortLeadershipModels(rows);
}

export function buildLeadership(
	snapshot: RankingsSnapshot,
	piModels: PiModelInfo[],
	config: ModelLeadershipConfig | undefined,
	snapshotPath: string,
): LeadershipArtifact {
	const resolvedConfig = resolveLeadershipConfigOrDefault(config);
	const models = buildLeadershipModels(snapshot, piModels);

	const freeLocal = models.filter((m) => m.available && m.isFree).map((m) => m.availableProviders[0] ?? `${m.provider}/${m.id}`);
	const paidLocal = models.filter((m) => m.available && !m.isFree).map((m) => m.availableProviders[0] ?? `${m.provider}/${m.id}`);
	const overall = models.filter((m) => m.available).map((m) => m.availableProviders[0] ?? `${m.provider}/${m.id}`);

	const byCategory: Record<string, string[]> = {};
	for (const category of Object.keys(snapshot.rankings)) {
		const seen = new Set<string>();
		const sorted: string[] = [];
		for (const row of snapshot.rankings[category]!.rows) {
			const match = models.find((m) => rankingModelIdMatches(row.modelId, m.id));
			if (match && match.available && !seen.has(match.id)) {
				seen.add(match.id);
				sorted.push(match.availableProviders[0] ?? `${match.provider}/${match.id}`);
			}
		}
		byCategory[category] = sorted;
	}

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		source: {
			snapshotPath,
			snapshotGeneratedAt: snapshot.generatedAt,
		},
		config: resolvedConfig.preferences,
		models,
		views: {
			freeLocal,
			paidLocal,
			overall,
			byCategory,
		},
	};
}

export function selectModelFromLeadership(
	leadership: LeadershipArtifact | null,
	options: { category?: string; preferFree?: boolean; maxResults?: number; paidSortRule?: PaidModelSortRule } = {},
): string | null {
	const results = selectModelsFromLeadership(leadership, options);
	return results[0] ?? null;
}

function resolveSelectionOptions(
	leadership: LeadershipArtifact,
	options: { category?: string; preferFree?: boolean; maxResults?: number; paidSortRule?: PaidModelSortRule } = {},
) {
	return {
		category: options.category ?? leadership.config?.defaultCategory ?? "coding",
		maxResults: options.maxResults ?? leadership.config?.maxResults ?? 50,
		preferFree: options.preferFree ?? leadership.config?.preferFree ?? true,
		paidSortRule: options.paidSortRule ?? leadership.config.paidSortRule,
	};
}

function filterRankedCandidates(models: LeadershipModel[], category: string): LeadershipModel[] {
	return models.filter((m) => m.available && (m.rankings[category] != null || category === "overall"));
}

function applyModelSorting(models: LeadershipModel[], category: string, paidSortRule: PaidModelSortRule, preferFree: boolean): LeadershipModel[] {
	const rankingComparator = (a: LeadershipModel, b: LeadershipModel) => getCategoryRank(a, category) - getCategoryRank(b, category);
	const ranked = filterRankedCandidates(models, category);
	const freeRanked = ranked.filter((m) => m.isFree).sort(rankingComparator);
	const paidFiltered = ranked.filter((m) => !m.isFree);
	const paidRanked = preferFree
		? paidFiltered.sort(createPaidModelComparator(paidSortRule, category))
		: ranked.sort(createPaidModelComparator(paidSortRule, category));
	const rankedOrdered = preferFree ? [...freeRanked, ...paidRanked] : paidRanked;

	const unrankedFree = models.filter((m) => m.available && m.isFree && !ranked.includes(m));
	const unrankedPaid = models.filter((m) => m.available && !m.isFree && !ranked.includes(m));
	const unrankedFreeSorted = unrankedFree.sort(rankingComparator);
	const unrankedPaidSorted = unrankedPaid.sort(createPaidModelComparator(paidSortRule, category));
	const unrankedOrdered = preferFree ? [...unrankedFreeSorted, ...unrankedPaidSorted] : unrankedPaidSorted;

	return [...rankedOrdered, ...unrankedOrdered];
}

function deduplicateCandidates(models: LeadershipModel[], maxResults: number): string[] {
	const seen = new Set<string>();
	const results: string[] = [];
	for (const model of models) {
		const id = model.availableProviders[0] ?? `${model.provider}/${model.id}`;
		if (seen.has(id)) continue;
		seen.add(id);
		results.push(id);
		if (results.length >= maxResults) break;
	}
	return results;
}

export function selectModelsFromLeadership(
	leadership: LeadershipArtifact | null,
	options: { category?: string; preferFree?: boolean; maxResults?: number; paidSortRule?: PaidModelSortRule } = {},
): string[] {
	if (!leadership || leadership.models.length === 0) return [];
	const { category, maxResults, preferFree, paidSortRule } = resolveSelectionOptions(leadership, options);
	const sorted = applyModelSorting(leadership.models, category, paidSortRule, preferFree);
	return deduplicateCandidates(sorted, maxResults);
}

export function getCategoryRank(model: LeadershipModel, category: string): number {
	return model.rankings[category] ?? Object.values(model.rankings)[0] ?? Infinity;
}

function getModelCost(model: LeadershipModel): number {
	return model.cost.output ?? model.cost.input ?? 0;
}

function getModelConservativeRating(model: LeadershipModel): number | null {
	return model.conservativeRating;
}

export function createPaidModelComparator(
	rule: PaidModelSortRule,
	category: string,
): (a: LeadershipModel, b: LeadershipModel) => number {
	switch (rule.strategy) {
		case "priority":
			return (a, b) => {
				if (a.available !== b.available) return a.available ? -1 : 1;
				const aRating = getModelConservativeRating(a);
				const bRating = getModelConservativeRating(b);
				const ratingDiff = aRating === null || bRating === null ? Infinity : Math.abs(aRating - bRating);
				if (ratingDiff < 5) {
					const aCost = getModelCost(a);
					const bCost = getModelCost(b);
					if (aCost !== bCost) return aCost - bCost;
				}
				const aRank = getCategoryRank(a, category);
				const bRank = getCategoryRank(b, category);
				if (aRank !== bRank) return aRank - bRank;
				return 0;
			};
		case "ranking": {
			const dir = rule.rankingOrder === "desc" ? -1 : 1;
			return (a, b) => {
				if (a.available !== b.available) return a.available ? -1 : 1;
				const aRank = getCategoryRank(a, category);
				const bRank = getCategoryRank(b, category);
				if (aRank !== bRank) return (aRank - bRank) * dir;
				const aCost = getModelCost(a);
				const bCost = getModelCost(b);
				return aCost - bCost;
			};
		}
		case "cost": {
			const dir = rule.costOrder === "desc" ? -1 : 1;
			return (a, b) => {
				if (a.available !== b.available) return a.available ? -1 : 1;
				const aCost = getModelCost(a);
				const bCost = getModelCost(b);
				if (aCost !== bCost) return (aCost - bCost) * dir;
				const aRank = getCategoryRank(a, category);
				const bRank = getCategoryRank(b, category);
				return aRank - bRank;
			};
		}
		case "rankedAndCost": {
			const rankDir = rule.rankingOrder === "desc" ? -1 : 1;
			const costDir = rule.costOrder === "desc" ? -1 : 1;
			const threshold = Number.isFinite(rule.ratingDiffThreshold) && rule.ratingDiffThreshold! > 0 ? rule.ratingDiffThreshold! : 5;
			return (a, b) => {
				if (a.available !== b.available) return a.available ? -1 : 1;
				const aRating = getModelConservativeRating(a);
				const bRating = getModelConservativeRating(b);
				const ratingDiff = aRating === null || bRating === null ? Infinity : Math.abs(aRating - bRating);
				if (ratingDiff === Infinity) return 0;
				if (ratingDiff < threshold) {
					const aCost = getModelCost(a);
					const bCost = getModelCost(b);
					if (aCost !== bCost) return (aCost - bCost) * costDir;
				}
				const aRank = getCategoryRank(a, category);
				const bRank = getCategoryRank(b, category);
				if (aRank !== bRank) return (aRank - bRank) * rankDir;
				return 0;
			};
		}
		default:
			return (a, b) => getCategoryRank(a, category) - getCategoryRank(b, category);
	}
}

export function _getNormalizedCanonicalModelId(modelId: string): string {
	return getNormalizedCanonicalModelId(modelId);
}

export function _rankingModelIdMatches(a: string, b: string): boolean {
	return rankingModelIdMatches(a, b);
}
