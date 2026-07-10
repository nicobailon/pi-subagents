/**
 * Model leadership types
 *
 * This module defines the shape of the llm-stats snapshot and the generated
 * leadership artifact. The contract is intentionally stable so downstream
 * consumers (model selection, slash commands, future extensions) can rely on
 * exact field names.
 */

export interface RankingRow {
	rank: number;
	modelId: string;
	modelName: string;
	organization: string;
	conservativeRating: number | null;
	score: number | null;
	openWeight: boolean | null;
	minInputPrice: number | null;
	benchmarksEvaluated: number | null;
	url: string | null;
}

export interface CategoryRankings {
	category: string;
	method: string;
	rankedAt: string;
	rows: RankingRow[];
}



export interface RankingsSnapshot {
	generatedAt: string;
	source: string;
	categories: Record<string, { id: string }>;
	rankings: Record<string, CategoryRankings>;
	modelsSummary: {
		id: string;
		displayName: string;
		modelName: string;
		providerName: string;
		organizationName: string;
		organizationId: string;
		contextLength: number;
		inputPrice: number;
		outputPrice: number;
		tier: string;
		inputModalities: string[];
		outputModalities: string[];
	}[] | null;

}

export interface PiModelInfo {
	id: string;
	fullId: string;
	provider: string;
	name: string;
	isFree: boolean;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens?: number;
	family?: string;
	categories?: string[];
	available: boolean;
}

export interface LeadershipModel {
	id: string;
	provider: string;
	modelId: string;
	name: string;
	isFree: boolean;
	hasApiKey?: boolean;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	family?: string;
	categories?: string[];
	rankings: Record<string, number | null>;
	conservativeRating: number | null;
	available: boolean;
	topRanking: number | null;
	topRankingCategory: string | null;
	providers: string[];
	availableProviders: string[];
	availabilityScore?: number;
}

export interface LeadershipArtifact {
	version: number;
	generatedAt: string;
	source: {
		snapshotPath: string;
		snapshotGeneratedAt: string;
	};
	config?: ModelLeadershipPreferences;
	models: LeadershipModel[];
	views: {
		freeLocal: string[];
		paidLocal: string[];
		overall: string[];
		byCategory: Record<string, string[]>;
	};
}

export interface ModelLeadershipConfig {
	enabled?: boolean;
	snapshotPath?: string;
	leadershipPath?: string;
	llmStatsApiKey?: string;
	preferences?: ModelLeadershipPreferences;
}

export type PaidModelSortRule =
	| { strategy: "priority" }
	| { strategy: "ranking"; rankingOrder?: "asc" | "desc" }
	| { strategy: "cost"; costOrder?: "asc" | "desc" }
	| {
		strategy: "rankedAndCost";
		rankingOrder?: "asc" | "desc";
		costOrder?: "asc" | "desc";
		ratingDiffThreshold?: number;
	};

export interface ModelLeadershipPreferences {
	preferFree?: boolean;
	defaultCategory?: string;
	maxResults?: number;
	paidSortRule?: PaidModelSortRule;
	exclusionTTLMs?: number;
}

export const DEFAULT_LEADERSHIP_CONFIG: ModelLeadershipConfig = {
	enabled: false,
	snapshotPath: "",
	leadershipPath: "",
	llmStatsApiKey: "",
	preferences: {
		preferFree: true,
		defaultCategory: "coding",
		maxResults: 50,
		exclusionTTLMs: 24 * 60 * 60_000,
	},
};


