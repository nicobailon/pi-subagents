import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENT_NAMES } from "../agents/agents.ts";
import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, toModelInfo } from "../shared/model-info.ts";
import { getAgentDir } from "../shared/utils.ts";

export const DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS = 7;

type BuiltinAgentName = typeof BUILTIN_AGENT_NAMES[number];
export type ProfileKind = "quota" | "quality";
export type ProbeStatus = "ok" | "unavailable" | "auth" | "timeout" | "error" | "skipped";
export type CostTier = "cheap" | "medium" | "expensive";
export type QualityTier = "weak" | "medium" | "strong";
export type LatencyTier = "fast" | "medium" | "slow";
export type RecommendedRoleTier = "cheap" | "medium" | "strong";

interface ProfileAgentOverride {
	model?: string;
}

export interface SubagentProfileFile {
	subagents: {
		agentOverrides: Record<string, ProfileAgentOverride>;
	};
}

export type ClassificationSource = "official-metadata" | "heuristic-name";

export interface ProviderModelCatalogModel {
	id: string;
	fullId: string;
	observed: {
		availableInRegistry: boolean;
		name?: string;
		reasoning?: boolean;
		thinkingLevels: string[];
		contextWindow?: number;
		maxTokens?: number;
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
		};
		probe: {
			status: ProbeStatus;
			checkedAt: string;
			message?: string;
		};
	};
	derived: {
		profileRank: number;
		costTier: CostTier;
		qualityTier: QualityTier;
		latencyTier: LatencyTier;
		recommendedRoleTier: RecommendedRoleTier;
		recommendedAgents: BuiltinAgentName[];
		classificationSources: ClassificationSource[];
	};
	warnings: string[];
	notes: string[];
}

export interface ProviderModelCatalogFile {
	provider: string;
	refreshedAt: string;
	maxAgeDays: number;
	sources: string[];
	models: ProviderModelCatalogModel[];
}

export interface ProfileCheckResult {
	profileName: string;
	filePath: string;
	results: Array<{
		agent: string;
		model: string;
		inRegistry: boolean;
		probe: { status: ProbeStatus; message?: string };
	}>;
}

function readJsonObjectFile(filePath: string): Record<string, unknown> {
	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`File '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeJsonFile(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const SAFE_PATH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizePathToken(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required.`);
	if (!SAFE_PATH_TOKEN.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
		throw new Error(`${label} must be a safe file name using only letters, numbers, dots, underscores, and hyphens.`);
	}
	return trimmed;
}

function normalizeProfileName(name: string): string {
	const trimmed = name.trim();
	const stem = trimmed.endsWith(".json") ? trimmed.slice(0, -5) : trimmed;
	return normalizePathToken(stem, "Profile name");
}

function normalizeProviderName(provider: string): string {
	return normalizePathToken(provider, "Provider");
}

function validateSubagentProfile(filePath: string, parsed: Record<string, unknown>): SubagentProfileFile {
	const subagents = parsed.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) {
		throw new Error(`Profile '${filePath}' must contain a 'subagents' object.`);
	}
	const agentOverrides = (subagents as Record<string, unknown>).agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
		throw new Error(`Profile '${filePath}' must contain 'subagents.agentOverrides' as an object.`);
	}
	for (const [name, value] of Object.entries(agentOverrides)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Profile '${filePath}' has invalid override '${name}'; expected an object.`);
		}
		const model = (value as Record<string, unknown>).model;
		if (model !== undefined && typeof model !== "string") {
			throw new Error(`Profile '${filePath}' has invalid model for '${name}'; expected a string.`);
		}
	}
	return parsed as unknown as SubagentProfileFile;
}

function getUserSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

function readSettingsFile(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	return readJsonObjectFile(filePath);
}

function extractVersionScore(id: string): number {
	const match = id.match(/(\d+(?:\.\d+)?)/g);
	if (!match || match.length === 0) return 0;
	return Math.max(...match.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value)));
}

function modelNameTokens(modelName: string): string[] {
	return modelName
		.toLowerCase()
		.replace(/([a-z])([0-9])/g, "$1 $2")
		.replace(/([0-9])([a-z])/g, "$1 $2")
		.split(/[^a-z0-9.]+/)
		.filter(Boolean);
}

function inferProfileBand(modelName: string): 0 | 1 | 2 | 3 | 4 {
	const tokens = new Set(modelNameTokens(modelName));
	if (["spark", "flash", "nano", "tiny", "instant"].some((token) => tokens.has(token))) return 0;
	if (["mini", "haiku", "small"].some((token) => tokens.has(token))) return 1;
	if (["opus", "max", "ultra", "pro"].some((token) => tokens.has(token))) return 4;
	if (["sonnet", "turbo", "plus"].some((token) => tokens.has(token))) return 3;
	return 2;
}

interface ModelClassificationInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

interface NumericStats {
	min: number;
	max: number;
}

interface ClassificationContext {
	cost?: NumericStats;
	contextWindow?: NumericStats;
	maxTokens?: NumericStats;
}

function combinedCost(cost: ModelClassificationInput["cost"]): number | undefined {
	if (!cost) return undefined;
	const values = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	if (values.length === 0) return undefined;
	return values.reduce((sum, value) => sum + value, 0);
}

function collectStats(values: Array<number | undefined>): NumericStats | undefined {
	const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	if (filtered.length === 0) return undefined;
	return { min: Math.min(...filtered), max: Math.max(...filtered) };
}

function normalize(value: number | undefined, stats: NumericStats | undefined): number | undefined {
	if (value === undefined || !stats) return undefined;
	if (stats.max <= stats.min) return 0.5;
	return (value - stats.min) / (stats.max - stats.min);
}

function buildClassificationContext(models: ModelClassificationInput[]): ClassificationContext {
	return {
		cost: collectStats(models.map((model) => combinedCost(model.cost))),
		contextWindow: collectStats(models.map((model) => model.contextWindow)),
		maxTokens: collectStats(models.map((model) => model.maxTokens)),
	};
}

function rankToCostTier(rank: number): CostTier {
	if (rank <= 0.33) return "cheap";
	if (rank <= 0.66) return "medium";
	return "expensive";
}

function scoreToQualityTier(score: number): QualityTier {
	if (score <= 0.33) return "weak";
	if (score <= 0.66) return "medium";
	return "strong";
}

function qualityTierToRoleTier(quality: QualityTier, cost: CostTier): RecommendedRoleTier {
	if (quality === "strong") return "strong";
	if (quality === "medium") return cost === "cheap" ? "cheap" : "medium";
	return "cheap";
}

function agentsForRoleTier(roleTier: RecommendedRoleTier): BuiltinAgentName[] {
	if (roleTier === "cheap") return ["scout", "delegate"];
	if (roleTier === "medium") return ["planner", "context-builder", "researcher"];
	return ["worker", "reviewer", "oracle"];
}

function classifyModel(input: ModelClassificationInput, context: ClassificationContext): {
	profileRank: number;
	costTier: CostTier;
	qualityTier: QualityTier;
	latencyTier: LatencyTier;
	recommendedRoleTier: RecommendedRoleTier;
	recommendedAgents: BuiltinAgentName[];
	classificationSources: ClassificationSource[];
} {
	const modelName = input.name?.trim() || input.id;
	const tokens = new Set(modelNameTokens(modelName));
	const band = inferProfileBand(modelName);
	const versionScore = extractVersionScore(input.id);
	const costNorm = normalize(combinedCost(input.cost), context.cost);
	const contextNorm = normalize(input.contextWindow, context.contextWindow);
	const maxTokensNorm = normalize(input.maxTokens, context.maxTokens);
	const hasOfficialMetadata = costNorm !== undefined || contextNorm !== undefined || maxTokensNorm !== undefined;
	const classificationSources: ClassificationSource[] = hasOfficialMetadata
		? ["official-metadata", "heuristic-name"]
		: ["heuristic-name"];
	const heuristicBase = band / 4;
	const qualitySignals = [
		heuristicBase,
		...(contextNorm !== undefined ? [contextNorm] : []),
		...(maxTokensNorm !== undefined ? [maxTokensNorm] : []),
		...(input.reasoning === true ? [1] : []),
		...(input.reasoning === false ? [0] : []),
	];
	const latencyHintsFast = tokens.has("highspeed") || tokens.has("flash") || tokens.has("instant") || tokens.has("turbo");
	const latencyHintsSlow = tokens.has("pro") || tokens.has("ultra") || tokens.has("opus") || tokens.has("max");
	let qualityScore = qualitySignals.reduce((sum, value) => sum + value, 0) / qualitySignals.length;
	if (latencyHintsFast) {
		qualityScore -= 0.2;
	}
	qualityScore = Math.max(0, Math.min(1, qualityScore));
	const costTier = costNorm !== undefined
		? rankToCostTier(costNorm)
		: band === 0 ? "cheap" : band >= 3 ? "expensive" : "medium";
	const qualityTier = scoreToQualityTier(qualityScore);
	const latencyTier: LatencyTier = latencyHintsFast
		? "fast"
		: latencyHintsSlow
			? "slow"
			: costNorm !== undefined
				? (costNorm <= 0.33 ? "fast" : costNorm <= 0.66 ? "medium" : "slow")
				: (band <= 1 ? "fast" : band >= 3 ? "slow" : "medium");
	const recommendedRoleTier = qualityTierToRoleTier(qualityTier, costTier);
	const latencyPenalty = latencyHintsFast ? 125 : 0;
	const profileRank = Math.round((qualityScore * 100) * 10) + Math.round(versionScore * 25) - latencyPenalty;
	return {
		profileRank,
		costTier,
		qualityTier,
		latencyTier,
		recommendedRoleTier,
		recommendedAgents: agentsForRoleTier(recommendedRoleTier),
		classificationSources,
	};
}

function resolveProbeStatus(text: string, timedOut: boolean): ProbeStatus {
	if (timedOut) return "timeout";
	if (!text) return "error";
	if (/(unauthori[sz]ed|forbidden|api key|auth|billing|credit|quota)/i.test(text)) return "auth";
	if (/(not found|unknown model|model unavailable|model disabled|unsupported model|unavailable)/i.test(text)) return "unavailable";
	return "error";
}

async function probeModel(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd">,
	fullId: string,
): Promise<{ status: ProbeStatus; message?: string }> {
	if (typeof pi.exec !== "function") {
		return { status: "skipped", message: "pi.exec is unavailable in this runtime." };
	}
	const result = await pi.exec("pi", ["-p", "--model", fullId, "--no-tools", 'Reply with exactly "OK".'], {
		cwd: os.tmpdir(),
		timeout: 45_000,
	} as Record<string, unknown>);
	const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
	const combined = [stderr, stdout].filter(Boolean).join("\n").trim();
	if (result.code === 0) return { status: "ok", message: stdout || "Probe succeeded." };
	return { status: resolveProbeStatus(combined, result.killed === true), message: combined || `Probe exited with code ${result.code ?? "unknown"}.` };
}

function roundIndex(count: number, position: number): number {
	if (count <= 1) return 0;
	return Math.max(0, Math.min(count - 1, Math.round((count - 1) * position)));
}

function profilePositions(kind: ProfileKind): { cheap: number; medium: number; strong: number } {
	return kind === "quota"
		? { cheap: 0, medium: 1 / 3, strong: 2 / 3 }
		: { cheap: 1 / 3, medium: 2 / 3, strong: 1 };
}

function pickTierModels(models: ProviderModelCatalogModel[], kind: ProfileKind): { cheap: string; medium: string; strong: string } {
	if (models.length === 0) throw new Error("No provider models are available for profile generation.");
	const selectionPool = kind === "quota" && models.length > 1
		? models.slice(0, -1)
		: models;
	const positions = profilePositions(kind);
	return {
		cheap: selectionPool[roundIndex(selectionPool.length, positions.cheap)]!.fullId,
		medium: selectionPool[roundIndex(selectionPool.length, positions.medium)]!.fullId,
		strong: selectionPool[roundIndex(selectionPool.length, positions.strong)]!.fullId,
	};
}

function observedCombinedCost(model: ProviderModelCatalogModel): number | undefined {
	return combinedCost(model.observed.cost);
}

function dominatesModel(a: ProviderModelCatalogModel, b: ProviderModelCatalogModel): boolean {
	const costA = observedCombinedCost(a);
	const costB = observedCombinedCost(b);
	if (costA === undefined || costB === undefined) return false;
	if (costA > costB) return false;
	if (a.derived.profileRank < b.derived.profileRank) return false;
	if ((a.observed.reasoning === true ? 1 : 0) < (b.observed.reasoning === true ? 1 : 0)) return false;
	if ((a.observed.contextWindow ?? 0) < (b.observed.contextWindow ?? 0)) return false;
	if ((a.observed.maxTokens ?? 0) < (b.observed.maxTokens ?? 0)) return false;
	return costA < costB
		|| a.derived.profileRank > b.derived.profileRank
		|| (a.observed.reasoning === true && b.observed.reasoning !== true)
		|| (a.observed.contextWindow ?? 0) > (b.observed.contextWindow ?? 0)
		|| (a.observed.maxTokens ?? 0) > (b.observed.maxTokens ?? 0);
}

function filterDominatedModels(models: ProviderModelCatalogModel[]): ProviderModelCatalogModel[] {
	return models.filter((candidate, index) => !models.some((other, otherIndex) => otherIndex !== index && dominatesModel(other, candidate)));
}

function buildProfileFile(kind: ProfileKind, models: { cheap: string; medium: string; strong: string }): SubagentProfileFile {
	return {
		subagents: {
			agentOverrides: {
				scout: { model: models.cheap },
				delegate: { model: models.cheap },
				planner: { model: models.medium },
				"context-builder": { model: models.medium },
				researcher: { model: models.medium },
				worker: { model: models.strong },
				reviewer: { model: models.strong },
				oracle: { model: models.strong },
			},
		},
	};
}

function catalogModelIsUsable(model: ProviderModelCatalogModel): boolean {
	return model.observed.availableInRegistry && model.observed.probe.status !== "unavailable" && model.observed.probe.status !== "auth" && model.observed.probe.status !== "timeout" && model.observed.probe.status !== "error";
}

function modelUsesHeuristicClassification(model: ProviderModelCatalogModel): boolean {
	return model.derived.classificationSources.includes("heuristic-name")
		&& !model.derived.classificationSources.includes("official-metadata");
}

function warningLineForHeuristicFallback(): string {
	return "Classification fell back to name heuristics.";
}

export function countHeuristicFallbackModels(catalog: ProviderModelCatalogFile): number {
	return catalog.models.filter(modelUsesHeuristicClassification).length;
}

function resolveProfilePath(name: string): string {
	const dir = ensureSubagentProfilesDir();
	return path.join(dir, `${normalizeProfileName(name)}.json`);
}

export function getSubagentProfilesRootDir(): string {
	return path.join(getAgentDir(), "profiles", "pi-subagents");
}

export function getSubagentProfilesDir(): string {
	return getSubagentProfilesRootDir();
}

export function ensureSubagentProfilesDir(): string {
	const dir = getSubagentProfilesDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function getProviderModelsDir(): string {
	return path.join(getSubagentProfilesRootDir(), "providers");
}

export function ensureProviderModelsDir(): string {
	const dir = getProviderModelsDir();
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function getProviderModelsPath(provider: string): string {
	return path.join(ensureProviderModelsDir(), `${normalizeProviderName(provider)}.models.json`);
}

export function listSubagentProfiles(): string[] {
	const dir = ensureSubagentProfilesDir();
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name.slice(0, -5))
		.sort((a, b) => a.localeCompare(b));
}

export function readSubagentProfile(name: string): { filePath: string; profile: SubagentProfileFile } {
	const filePath = resolveProfilePath(name);
	if (!fs.existsSync(filePath)) throw new Error(`Profile not found: ${name}`);
	const parsed = readJsonObjectFile(filePath);
	return { filePath, profile: validateSubagentProfile(filePath, parsed) };
}

export function applySubagentProfile(name: string): { filePath: string; settingsPath: string } {
	const { filePath, profile } = readSubagentProfile(name);
	const settingsPath = getUserSettingsPath();
	const settings = readSettingsFile(settingsPath);
	settings.subagents = profile.subagents;
	writeJsonFile(settingsPath, settings);
	return { filePath, settingsPath };
}

export function readProviderModelCatalog(provider: string): ProviderModelCatalogFile | null {
	const filePath = getProviderModelsPath(provider);
	if (!fs.existsSync(filePath)) return null;
	return readJsonObjectFile(filePath) as unknown as ProviderModelCatalogFile;
}

export function isProviderModelCatalogStale(catalog: ProviderModelCatalogFile, maxAgeDays = DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS): boolean {
	const refreshedAt = Date.parse(catalog.refreshedAt);
	if (!Number.isFinite(refreshedAt)) return true;
	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	return Date.now() - refreshedAt > maxAgeMs;
}

export async function refreshProviderModelCatalog(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
	provider: string,
	options: { force?: boolean; maxAgeDays?: number; probe?: boolean } = {},
): Promise<{ filePath: string; catalog: ProviderModelCatalogFile; reused: boolean; heuristicFallbackCount: number }> {
	const normalizedProvider = normalizeProviderName(provider);
	const maxAgeDays = options.maxAgeDays ?? DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS;
	const filePath = getProviderModelsPath(normalizedProvider);
	if (!options.force) {
		const existing = readProviderModelCatalog(normalizedProvider);
		if (existing && !isProviderModelCatalogStale(existing, maxAgeDays)) {
			return { filePath, catalog: existing, reused: true, heuristicFallbackCount: countHeuristicFallbackModels(existing) };
		}
	}

	const availableModels = ctx.modelRegistry.getAvailable().filter((model) => model.provider === normalizedProvider);
	if (availableModels.length === 0) {
		throw new Error(`No models found in the current registry for provider '${normalizedProvider}'.`);
	}

	const observedModels = [] as Array<{
		rawModel: typeof availableModels[number];
		modelRecord: Record<string, unknown> & { provider: string; id: string; name?: string };
		fullId: string;
		probe: { status: ProbeStatus; message?: string };
	}>;
	for (const rawModel of availableModels) {
		const modelRecord = rawModel as unknown as Record<string, unknown> & { provider: string; id: string; name?: string };
		const fullId = `${modelRecord.provider}/${modelRecord.id}`;
		const probe = options.probe === false
			? { status: "skipped" as const, message: "Live probing disabled." }
			: await probeModel(pi, ctx, fullId);
		observedModels.push({ rawModel, modelRecord, fullId, probe });
	}
	const classificationContext = buildClassificationContext(observedModels.map(({ modelRecord }) => ({
		id: modelRecord.id,
		...(typeof modelRecord.name === "string" ? { name: modelRecord.name } : {}),
		...(typeof modelRecord.reasoning === "boolean" ? { reasoning: modelRecord.reasoning } : {}),
		...(typeof modelRecord.contextWindow === "number" ? { contextWindow: modelRecord.contextWindow } : {}),
		...(typeof modelRecord.maxTokens === "number" ? { maxTokens: modelRecord.maxTokens } : {}),
		...(modelRecord.cost && typeof modelRecord.cost === "object" ? { cost: modelRecord.cost as ProviderModelCatalogModel["observed"]["cost"] } : {}),
	})));
	const models: ProviderModelCatalogModel[] = [];
	for (const { rawModel, modelRecord, fullId, probe } of observedModels) {
		const classification = classifyModel({
			id: modelRecord.id,
			...(typeof modelRecord.name === "string" ? { name: modelRecord.name } : {}),
			...(typeof modelRecord.reasoning === "boolean" ? { reasoning: modelRecord.reasoning } : {}),
			...(typeof modelRecord.contextWindow === "number" ? { contextWindow: modelRecord.contextWindow } : {}),
			...(typeof modelRecord.maxTokens === "number" ? { maxTokens: modelRecord.maxTokens } : {}),
			...(modelRecord.cost && typeof modelRecord.cost === "object" ? { cost: modelRecord.cost as ProviderModelCatalogModel["observed"]["cost"] } : {}),
		}, classificationContext);
		const warnings = classification.classificationSources.includes("heuristic-name") && !classification.classificationSources.includes("official-metadata")
			? [warningLineForHeuristicFallback()]
			: [];
		models.push({
			id: modelRecord.id,
			fullId,
			observed: {
				availableInRegistry: true,
				...(typeof modelRecord.name === "string" ? { name: modelRecord.name } : {}),
				...(typeof modelRecord.reasoning === "boolean" ? { reasoning: modelRecord.reasoning } : {}),
				thinkingLevels: getSupportedThinkingLevels(toModelInfo(rawModel)).map((level) => level),
				...(typeof modelRecord.contextWindow === "number" ? { contextWindow: modelRecord.contextWindow } : {}),
				...(typeof modelRecord.maxTokens === "number" ? { maxTokens: modelRecord.maxTokens } : {}),
				...(modelRecord.cost && typeof modelRecord.cost === "object" ? { cost: modelRecord.cost as ProviderModelCatalogModel["observed"]["cost"] } : {}),
				probe: {
					status: probe.status,
					checkedAt: new Date().toISOString(),
					...(probe.message ? { message: probe.message } : {}),
				},
			},
			derived: classification,
			warnings,
			notes: [],
		});
	}
	models.sort((a, b) => a.derived.profileRank - b.derived.profileRank || a.fullId.localeCompare(b.fullId));
	const catalog: ProviderModelCatalogFile = {
		provider: normalizedProvider,
		refreshedAt: new Date().toISOString(),
		maxAgeDays,
		sources: ["runtime-registry", ...(options.probe === false ? [] : ["live-probe"]), "heuristic-classifier"],
		models,
	};
	writeJsonFile(filePath, catalog);
	return { filePath, catalog, reused: false, heuristicFallbackCount: countHeuristicFallbackModels(catalog) };
}

export async function generateProfilesForProvider(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
	provider: string,
	options: { maxAgeDays?: number; forceRefresh?: boolean; probe?: boolean } = {},
): Promise<{ quotaPath: string; qualityPath: string; catalogPath: string; quotaModels: { cheap: string; medium: string; strong: string }; qualityModels: { cheap: string; medium: string; strong: string }; heuristicFallbackCount: number; selectedHeuristicFallbackCount: number }> {
	const normalizedProvider = normalizeProviderName(provider);
	const { filePath: catalogPath, catalog, heuristicFallbackCount } = await refreshProviderModelCatalog(pi, ctx, normalizedProvider, {
		maxAgeDays: options.maxAgeDays,
		force: options.forceRefresh,
		probe: options.probe,
	});
	const usableModels = catalog.models.filter(catalogModelIsUsable);
	const profileModels = filterDominatedModels(usableModels);
	if (profileModels.length === 0) {
		throw new Error(`Provider '${normalizedProvider}' has no usable models after filtering.`);
	}
	const quotaModels = pickTierModels(profileModels, "quota");
	const qualityModels = pickTierModels(profileModels, "quality");
	const dir = ensureSubagentProfilesDir();
	const quotaPath = path.join(dir, `${normalizedProvider}.quota.json`);
	const qualityPath = path.join(dir, `${normalizedProvider}.quality.json`);
	writeJsonFile(quotaPath, buildProfileFile("quota", quotaModels));
	writeJsonFile(qualityPath, buildProfileFile("quality", qualityModels));
	const selectedModels = new Set([...Object.values(quotaModels), ...Object.values(qualityModels)]);
	const selectedHeuristicFallbackCount = profileModels.filter((model) => selectedModels.has(model.fullId) && modelUsesHeuristicClassification(model)).length;
	return { quotaPath, qualityPath, catalogPath, quotaModels, qualityModels, heuristicFallbackCount, selectedHeuristicFallbackCount };
}

export async function checkSubagentProfile(
	pi: Pick<ExtensionAPI, "exec"> | { exec?: ExtensionAPI["exec"] },
	ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
	name: string,
): Promise<ProfileCheckResult> {
	const { filePath, profile } = readSubagentProfile(name);
	const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const entries = Object.entries(profile.subagents.agentOverrides)
		.filter(([, value]) => typeof value?.model === "string" && value.model.trim())
		.map(([agent, value]) => ({ agent, model: value.model!.trim() }));
	const probeCache = new Map<string, { status: ProbeStatus; message?: string }>();
	const results: ProfileCheckResult["results"] = [];
	for (const entry of entries) {
		const modelInfo = findModelInfo(entry.model, availableModels);
		const { thinkingSuffix } = splitKnownThinkingSuffix(entry.model);
		const probeModelId = modelInfo ? `${modelInfo.fullId}${thinkingSuffix}` : entry.model;
		let probe = probeCache.get(probeModelId);
		if (!probe) {
			probe = await probeModel(pi, ctx, probeModelId);
			probeCache.set(probeModelId, probe);
		}
		results.push({
			agent: entry.agent,
			model: entry.model,
			inRegistry: modelInfo !== undefined,
			probe,
		});
	}
	return { profileName: name, filePath, results };
}
