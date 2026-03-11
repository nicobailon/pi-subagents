/**
 * Shared runtime model fallback policy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ModelAttempt,
	ModelCandidate,
	ModelCandidateSource,
	RuntimeModelExecutionContext,
	RuntimeModelFallbackConfig,
} from "./types.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface AttemptFailureInput {
	exitCode?: number | null;
	error?: string;
	stderr?: string;
	stdout?: string;
	output?: string;
}

export interface AttemptFailureClassification {
	classification: "retryable-runtime" | "deterministic" | "unknown";
	reason: string;
	cooldownScope?: "model" | "provider";
}

export interface ModelAttemptExecutionResult<T> {
	ok: boolean;
	result: T;
	exitCode?: number | null;
	error?: string;
	stderr?: string;
	stdout?: string;
	output?: string;
}

export interface RuntimeModelExecutionResult<T> {
	result: T;
	requestedModel?: string;
	finalModel?: string;
	modelAttempts: ModelAttempt[];
	fallbackSummary?: string;
	stoppedEarly: boolean;
	exhausted: boolean;
	lastFailure?: AttemptFailureClassification;
}

interface CooldownEntry {
	expiresAt: number;
	reason: string;
	scope: "model" | "provider";
}

interface CooldownStore {
	models?: Record<string, CooldownEntry>;
	providers?: Record<string, CooldownEntry>;
}

export interface RuntimeModelExecutionOptions<T> {
	context?: RuntimeModelExecutionContext;
	modelOverride?: string;
	agentModel?: string;
	agentThinking?: string;
	executeAttempt: (candidate?: ModelCandidate) => Promise<ModelAttemptExecutionResult<T>>;
	makeFailureResult?: (message: string) => T;
	onAttemptEvent?: (event:
		| { type: "attempt"; candidate: ModelCandidate }
		| { type: "success"; candidate: ModelCandidate; attempts: ModelAttempt[] }
		| { type: "skipped"; candidate: ModelCandidate; attempt: ModelAttempt }
		| { type: "retry"; candidate: ModelCandidate; attempt: ModelAttempt; nextCandidate?: ModelCandidate }
		| { type: "stop"; candidate: ModelCandidate; attempt: ModelAttempt }
		| { type: "exhausted"; attempts: ModelAttempt[]; lastFailure?: AttemptFailureClassification }
	) => void;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1) as (typeof THINKING_LEVELS)[number])) {
		return model;
	}
	return `${model}:${thinking}`;
}

export function normalizeModelId(model: string | undefined, availableModels: RuntimeModelExecutionContext["availableModels"] = []): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;

	const colonIdx = model.lastIndexOf(":");
	const baseModel = colonIdx !== -1 ? model.substring(0, colonIdx) : model;
	const suffix = colonIdx !== -1 ? model.substring(colonIdx) : "";
	const match = availableModels.find((candidate) => candidate.id === baseModel);
	return match ? `${match.fullId}${suffix}` : model;
}

export function getCandidateIdentity(candidate: Pick<ModelCandidate, "model" | "normalizedModel">): string | undefined {
	return candidate.normalizedModel ?? candidate.model;
}

export function getProviderFromModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const base = model.split(":")[0] ?? model;
	const slashIdx = base.indexOf("/");
	return slashIdx === -1 ? undefined : base.slice(0, slashIdx);
}

export function buildModelCandidates(input: {
	context?: RuntimeModelExecutionContext;
	modelOverride?: string;
	agentModel?: string;
	agentThinking?: string;
}): ModelCandidate[] {
	const context = input.context;
	const config: RuntimeModelFallbackConfig = context?.config ?? {};
	const preferCurrentSessionModel = config.preferCurrentSessionModel !== false;
	const rawCandidates: Array<{ model?: string; source: ModelCandidateSource }> = [
		{ model: input.modelOverride, source: "override" },
		{ model: input.agentModel, source: "agent" },
		{ model: preferCurrentSessionModel ? context?.currentSessionModel : undefined, source: "session" },
		...(config.fallbackModels ?? []).map((model) => ({ model, source: "fallback" as const })),
	];

	const seen = new Set<string>();
	const candidates: ModelCandidate[] = [];
	for (const candidate of rawCandidates) {
		const modelWithThinking = applyThinkingSuffix(candidate.model, input.agentThinking);
		if (!modelWithThinking) continue;
		const normalizedModel = normalizeModelId(modelWithThinking, context?.availableModels);
		const identity = normalizedModel ?? modelWithThinking;
		if (seen.has(identity)) continue;
		seen.add(identity);
		candidates.push({
			model: modelWithThinking,
			source: candidate.source,
			normalizedModel,
		});
	}
	return candidates;
}

function normalizeCooldownStore(store: CooldownStore, now: number): CooldownStore {
	const next: CooldownStore = { models: {}, providers: {} };
	for (const [key, value] of Object.entries(store.models ?? {})) {
		if (value.expiresAt > now) next.models![key] = value;
	}
	for (const [key, value] of Object.entries(store.providers ?? {})) {
		if (value.expiresAt > now) next.providers![key] = value;
	}
	if (Object.keys(next.models ?? {}).length === 0) delete next.models;
	if (Object.keys(next.providers ?? {}).length === 0) delete next.providers;
	return next;
}

export function readCooldownStore(cooldownPath: string | undefined, now = Date.now()): CooldownStore {
	if (!cooldownPath) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(cooldownPath, "utf-8")) as CooldownStore;
		return normalizeCooldownStore(parsed, now);
	} catch {
		return {};
	}
}

export function writeCooldownStore(cooldownPath: string | undefined, store: CooldownStore): void {
	if (!cooldownPath) return;
	const normalized = normalizeCooldownStore(store, Date.now());
	fs.mkdirSync(path.dirname(cooldownPath), { recursive: true });
	const tmpPath = `${cooldownPath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), "utf-8");
	fs.renameSync(tmpPath, cooldownPath);
}

export function getCooldownSkipReason(
	candidate: ModelCandidate,
	store: CooldownStore,
	now = Date.now(),
): { scope: "model" | "provider"; reason: string } | null {
	if (candidate.source === "override") return null;
	const identity = getCandidateIdentity(candidate);
	if (identity) {
		const modelEntry = store.models?.[identity];
		if (modelEntry && modelEntry.expiresAt > now) {
			return { scope: "model", reason: modelEntry.reason };
		}
	}
	const provider = getProviderFromModel(identity ?? candidate.model);
	if (!provider) return null;
	const providerEntry = store.providers?.[provider];
	if (providerEntry && providerEntry.expiresAt > now) {
		return { scope: "provider", reason: providerEntry.reason };
	}
	return null;
}

export function updateCooldownStore(
	cooldownPath: string | undefined,
	candidate: ModelCandidate,
	classification: AttemptFailureClassification,
	config?: RuntimeModelFallbackConfig,
	now = Date.now(),
	storeOverride?: CooldownStore,
): CooldownStore {
	if (!cooldownPath || classification.classification !== "retryable-runtime") return storeOverride ?? {};
	const cooldownMinutes = config?.cooldownMinutes ?? 0;
	if (cooldownMinutes <= 0) return storeOverride ?? {};
	const store = storeOverride ?? readCooldownStore(cooldownPath, now);
	const expiresAt = now + cooldownMinutes * 60 * 1000;
	if (classification.cooldownScope === "provider") {
		const provider = getProviderFromModel(candidate.normalizedModel ?? candidate.model);
		if (!provider) return;
		store.providers = store.providers ?? {};
		store.providers[provider] = {
			expiresAt,
			reason: classification.reason,
			scope: "provider",
		};
		writeCooldownStore(cooldownPath, store);
		return store;
	}
	const identity = getCandidateIdentity(candidate);
	if (!identity) return store;
	store.models = store.models ?? {};
	store.models[identity] = {
		expiresAt,
		reason: classification.reason,
		scope: "model",
	};
	writeCooldownStore(cooldownPath, store);
	return store;
}

function summarizeReason(text: string | undefined, fallback: string): string {
	if (!text) return fallback;
	const compact = text.replace(/\s+/g, " ").trim();
	return compact ? compact.slice(0, 240) : fallback;
}

export function classifyRuntimeModelFailure(input: AttemptFailureInput): AttemptFailureClassification {
	const combined = [input.error, input.stderr, input.stdout, input.output]
		.filter((value): value is string => Boolean(value && value.trim()))
		.join("\n")
		.slice(0, 4000);
	const text = combined.toLowerCase();

	const deterministicToolFailure = /^(bash|read|write|edit|todo|ce_todo|webfetch|websearch|codecontextsearch|sitemap|mcporter|generate_image|ssh_hosts|ask_user_question|review_loop|subagent|subagent_status) failed/i;
	if (deterministicToolFailure.test(combined)) {
		return {
			classification: "deterministic",
			reason: summarizeReason(combined, "Tool execution failed"),
		};
	}

	const deterministicPatterns: RegExp[] = [
		/unknown agent/i,
		/invalid cwd/i,
		/enoent/i,
		/enotdir/i,
		/eisdir/i,
		/no such file or directory/i,
		/file not found/i,
		/cannot find (file|module|path)/i,
		/missing required/i,
		/invalid argument/i,
		/validation error/i,
		/failed to parse/i,
		/malformed input/i,
		/zoderror/i,
		/schema validation failed/i,
	];
	for (const pattern of deterministicPatterns) {
		if (pattern.test(combined)) {
			return {
				classification: "deterministic",
				reason: summarizeReason(combined, "Deterministic task failure"),
			};
		}
	}

	const providerWidePatterns: RegExp[] = [
		/invalid api key/i,
		/api key .* expired/i,
		/expired credentials/i,
		/authentication failed/i,
		/unauthorized/i,
		/forbidden/i,
		/insufficient quota/i,
		/quota exceeded/i,
		/provider unavailable/i,
		/service unavailable/i,
		/provider outage/i,
		/provider overloaded/i,
	];
	for (const pattern of providerWidePatterns) {
		if (pattern.test(combined)) {
			return {
				classification: "retryable-runtime",
				reason: summarizeReason(combined, "Provider unavailable"),
				cooldownScope: "provider",
			};
		}
	}

	const retryablePatterns: RegExp[] = [
		/rate limit/i,
		/too many requests/i,
		/\b429\b/i,
		/model .* unavailable/i,
		/model .* not found/i,
		/model unavailable/i,
		/overloaded/i,
		/temporarily unavailable/i,
		/connection reset/i,
		/econnreset/i,
		/etimedout/i,
		/eai_again/i,
		/socket hang up/i,
		/bad gateway/i,
		/gateway timeout/i,
		/\b5\d\d\b/i,
		/network error/i,
		/transport error/i,
		/does not support tools/i,
		/tool schema/i,
		/function calling .* not supported/i,
		/unsupported tool/i,
	];
	for (const pattern of retryablePatterns) {
		if (pattern.test(combined)) {
			return {
				classification: "retryable-runtime",
				reason: summarizeReason(combined, "Retryable runtime failure"),
				cooldownScope: "model",
			};
		}
	}

	if ((input.exitCode ?? 0) !== 0 && !text) {
		return {
			classification: "unknown",
			reason: `Process exited with code ${input.exitCode ?? 1}`,
		};
	}

	return {
		classification: "unknown",
		reason: summarizeReason(combined, "Unclassified runtime failure"),
	};
}

export function formatFallbackSummary(attempts: ModelAttempt[], finalModel?: string): string | undefined {
	if (attempts.length === 0) return undefined;
	const failed = attempts.filter((attempt) => attempt.outcome === "failed");
	const skipped = attempts.filter((attempt) => attempt.outcome === "skipped");
	const success = attempts.find((attempt) => attempt.outcome === "success");
	if (success && failed.length === 0 && skipped.length === 0) return undefined;
	if (success) {
		return `fallback: recovered after ${failed.length + skipped.length} prior attempt${failed.length + skipped.length === 1 ? "" : "s"}; using ${finalModel ?? success.model}`;
	}
	const lastFailure = failed[failed.length - 1];
	return `fallback: exhausted ${attempts.length} candidate${attempts.length === 1 ? "" : "s"}${lastFailure?.reason ? `; last error: ${lastFailure.reason}` : ""}`;
}

export async function executeWithRuntimeModelFallback<T>(
	options: RuntimeModelExecutionOptions<T>,
): Promise<RuntimeModelExecutionResult<T>> {
	const candidates = buildModelCandidates({
		context: options.context,
		modelOverride: options.modelOverride,
		agentModel: options.agentModel,
		agentThinking: options.agentThinking,
	});
	const attempts: ModelAttempt[] = [];
	const requestedModel = candidates[0]?.model;
	let cooldownStore = readCooldownStore(options.context?.cooldownPath);
	let lastResult: T | undefined;
	let lastFailure: AttemptFailureClassification | undefined;

	if (candidates.length === 0) {
		const attempt = await options.executeAttempt(undefined);
		lastResult = attempt.result;
		return {
			result: attempt.result,
			requestedModel: undefined,
			finalModel: attempt.ok ? undefined : undefined,
			modelAttempts: [],
			fallbackSummary: undefined,
			stoppedEarly: !attempt.ok,
			exhausted: !attempt.ok,
			lastFailure: attempt.ok ? undefined : classifyRuntimeModelFailure(attempt),
		};
	}

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]!;
		const cooldown = getCooldownSkipReason(candidate, cooldownStore);
		if (cooldown) {
			const skippedAttempt: ModelAttempt = {
				model: candidate.model,
				source: candidate.source,
				outcome: "skipped",
				classification: "cooldown",
				reason: cooldown.reason,
				cooldownScope: cooldown.scope,
			};
			attempts.push(skippedAttempt);
			options.onAttemptEvent?.({ type: "skipped", candidate, attempt: skippedAttempt });
			continue;
		}

		options.onAttemptEvent?.({ type: "attempt", candidate });
		const attempt = await options.executeAttempt(candidate);
		lastResult = attempt.result;
		if (attempt.ok) {
			const successAttempt: ModelAttempt = {
				model: candidate.model,
				source: candidate.source,
				outcome: "success",
			};
			attempts.push(successAttempt);
			options.onAttemptEvent?.({ type: "success", candidate, attempts });
			return {
				result: attempt.result,
				requestedModel,
				finalModel: candidate.model,
				modelAttempts: attempts,
				fallbackSummary: formatFallbackSummary(attempts, candidate.model),
				stoppedEarly: false,
				exhausted: false,
			};
		}

		const classification = classifyRuntimeModelFailure(attempt);
		lastFailure = classification;
		const failedAttempt: ModelAttempt = {
			model: candidate.model,
			source: candidate.source,
			outcome: "failed",
			classification: classification.classification,
			reason: classification.reason,
			cooldownScope: classification.cooldownScope,
		};
		attempts.push(failedAttempt);

		if (classification.classification !== "retryable-runtime") {
			options.onAttemptEvent?.({ type: "stop", candidate, attempt: failedAttempt });
			return {
				result: attempt.result,
				requestedModel,
				finalModel: candidate.model,
				modelAttempts: attempts,
				fallbackSummary: `fallback: stopped after ${candidate.model} (${classification.classification})`,
				stoppedEarly: true,
				exhausted: false,
				lastFailure: classification,
			};
		}

		cooldownStore = updateCooldownStore(
			options.context?.cooldownPath,
			candidate,
			classification,
			options.context?.config,
			Date.now(),
			cooldownStore,
		);
		const nextCandidate = candidates.slice(i + 1).find((next) => !getCooldownSkipReason(next, cooldownStore));
		options.onAttemptEvent?.({ type: "retry", candidate, attempt: failedAttempt, nextCandidate });
	}

	options.onAttemptEvent?.({ type: "exhausted", attempts, lastFailure });
	const failureMessage = formatFallbackSummary(attempts) ?? "fallback: exhausted candidates";
	const exhaustedResult = lastResult ?? options.makeFailureResult?.(failureMessage);
	if (exhaustedResult === undefined) {
		throw new Error("Runtime model fallback exhausted without a result or failure factory");
	}
	return {
		result: exhaustedResult,
		requestedModel,
		finalModel: attempts.at(-1)?.model,
		modelAttempts: attempts,
		fallbackSummary: failureMessage,
		stoppedEarly: false,
		exhausted: true,
		lastFailure,
	};
}
