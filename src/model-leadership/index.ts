/**
 * Model leadership orchestrator
 *
 * Owns the lifecycle of the local leadership artifact:
 *  1. Check for an existing snapshot
 *  2. Fetch a fresh snapshot when missing or explicitly requested
 *  3. Build leadership from snapshot + pi model registry
 *  4. Write the deterministic leadership file
 *
 * Selection-time consumers should call `selectModelFromLeadership()` and avoid
 * network calls.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadRankingsSnapshot, fetchRankingsSnapshot, getDefaultSnapshotPath, hasBundledSnapshot, seedOfflineSnapshot, resolveHomeDir, toAbsolutePath } from "./snapshot.ts";
import type { LeadershipArtifact, ModelLeadershipConfig, PiModelInfo, RankingsSnapshot, PaidModelSortRule } from "./types.ts";
import { buildLeadership, resolveLeadershipConfigOrDefault, selectModelFromLeadership, selectModelsFromLeadership } from "./builder.ts";



export const LEADERSHIP_PATH_ENV = "PI_MODEL_LEADERSHIP_PATH";

export function getDefaultLeadershipPath(): string {
	const envPath = process.env[LEADERSHIP_PATH_ENV];
	if (typeof envPath === "string" && envPath.trim()) return envPath.trim();
	const home = resolveHomeDir();
	return join(home, ".pi", "agent", "model-leadership.json");
}

export async function ensureLeadership(
	options: {
		snapshotPath?: string;
		leadershipPath?: string;
		forceRefresh?: boolean;
		config?: ModelLeadershipConfig;
		getPiModels?: () => PiModelInfo[];
		skipSnapshotFetch?: boolean;
	},
): Promise<LeadershipArtifact | null> {
	const config = resolveLeadershipConfigOrDefault(options.config);
	if (!config.enabled) return null;

	const snapshotPath = toAbsolutePath(options.snapshotPath ?? config.snapshotPath ?? "", getDefaultSnapshotPath());
	const leadershipPath = toAbsolutePath(options.leadershipPath ?? config.leadershipPath ?? "", getDefaultLeadershipPath());

	let snapshot: RankingsSnapshot | null = null;

	// First-run offline fallback: seed from repo-bundled snapshot before any network fetch.
	if (!options.skipSnapshotFetch && !options.forceRefresh && !existsSync(snapshotPath) && hasBundledSnapshot()) {
		const seeded = seedOfflineSnapshot(snapshotPath);
		if (seeded) {
			console.log("[model-leadership] Seeded offline snapshot from bundled asset.");
		}
	}

	if (options.skipSnapshotFetch) {
		// Rebuild-only mode: do not touch the snapshot on disk.
		snapshot = loadRankingsSnapshot(snapshotPath);
		if (!snapshot) {
			console.error("[model-leadership] No existing rankings snapshot to rebuild from. Run /fetch-rankings first.");
			return null;
		}
	} else if (options.forceRefresh || !existsSync(snapshotPath)) {
		try {
			snapshot = await fetchRankingsSnapshot({ outputPath: snapshotPath, apiKey: config.llmStatsApiKey, quiet: true });
		} catch (error) {
			const stale = existsSync(snapshotPath);
			console.error(
				`[model-leadership] Failed to fetch rankings snapshot: ${getErrorMessage(error)}`,
				stale
					? 'Falling back to the existing snapshot on disk; it may be stale because forceRefresh=true.'
					: 'No existing snapshot available.',
			);
			snapshot = stale ? loadRankingsSnapshot(snapshotPath) : null;
		}
	} else {
		snapshot = loadRankingsSnapshot(snapshotPath);
	}

	if (!snapshot) {
		console.error("[model-leadership] No rankings snapshot available.");
		return null;
	}

	const piModels = typeof options.getPiModels === "function" ? options.getPiModels() : [];
	const leadership = buildLeadership(snapshot, piModels, config, snapshotPath);
	const rankedModels = leadership.models.filter((m) => Object.keys(m.rankings).length > 0).length;
	const availableModels = leadership.models.filter((m) => m.available).length;
	const categoryCoverage = Object.values(leadership.views.byCategory).filter((list) => list.length > 0).length;
	console.log(
		`[model-leadership] refreshed: ${leadership.models.length} models (${availableModels} available, ${rankedModels} ranked, ${categoryCoverage} categories with entries)`,
	);

	try {
		writeFileSync(leadershipPath, JSON.stringify(leadership, null, 2), "utf-8");
	} catch (error) {
		console.error(`[model-leadership] Failed to write leadership file: ${getErrorMessage(error)}`);
		return null;
	}

	return leadership;
}

export async function rebuildLeadership(
	options: {
		snapshotPath?: string;
		leadershipPath?: string;
		config?: ModelLeadershipConfig;
		getPiModels?: () => PiModelInfo[];
	},
): Promise<LeadershipArtifact | null> {
	return ensureLeadership({ ...options, skipSnapshotFetch: true });
}

export function loadLeadership(path?: string): LeadershipArtifact | null {
	const resolved = toAbsolutePath(path, getDefaultLeadershipPath());
	if (!existsSync(resolved)) return null;
	try {
		const content = readFileSync(resolved, "utf-8");
		return JSON.parse(content) as LeadershipArtifact;
	} catch (error) {
		console.error(`[model-leadership] Failed to load leadership from ${resolved}: ${getErrorMessage(error)}`);
		return null;
	}
}

export { selectModelFromLeadership, selectModelsFromLeadership, resolveLeadershipConfigOrDefault, type PaidModelSortRule };

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
