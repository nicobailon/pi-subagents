/**
 * Integration tests for model leadership + dynamic fallback.
 *
 * Covers:
 * - leadership-ranked selection in parallel flow
 * - seamless fallback on unknown/unrecognized errors
 * - exclusion enrichment with provider rate-limit hints
 * - exhaustive fallback candidate switching behavior
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	tryImport,
} from "../support/helpers.ts";
import { buildLeadership, selectModelsFromLeadership } from "../../src/model-leadership/builder.ts";
import type { LeadershipArtifact, RankingsSnapshot } from "../../src/model-leadership/types.ts";
import { setLeadershipArtifact } from "../../src/runs/shared/model-fallback.ts";
import { recordModelFailure, getExclusionsFilePath, flushPersist } from "../../src/runs/shared/model-exclusions.ts";
import { loadProviderRateLimits, resetProviderRateLimitCache } from "../../src/runs/shared/provider-rate-limits.ts";

const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
const piAvailable = !!(executorMod && execution);

const runSync = execution?.runSync;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeExecutor(
	agents = [makeAgent("echo")],
	config: Record<string, unknown> = {},
	ctxOverride: Record<string, unknown> = {},
) {
	const tempDir = createTempDir();
	const ctx = { ...makeMinimalCtx(tempDir), ...ctxOverride };
	return {
		tempDir,
		ctx,
		executor: createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: {
				baseCwd: tempDir,
				currentSessionId: null,
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			},
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		}),
	};
}

function createMockRankingsSnapshot(rows: Array<{ modelId: string; rank: number; conservativeRating?: number }>): RankingsSnapshot {
	return {
		generatedAt: new Date().toISOString(),
		source: "test",
		categories: { coding: { id: "coding" } },
		rankings: {
			coding: {
				category: "coding",
				method: "test",
				rankedAt: new Date().toISOString(),
				rows: rows.map((row) => ({
					rank: row.rank,
					modelId: row.modelId,
					modelName: row.modelId,
					organization: "test",
					conservativeRating: row.conservativeRating ?? 90,
					score: row.conservativeRating ?? 90,
					openWeight: false,
					minInputPrice: 1,
					benchmarksEvaluated: 1,
					source: "test",
					url: null,
				})),
			},
		},
		modelsSummary: null,
		benchmarksSummary: null,
	};
}

function createLeadershipArtifact(models: Array<{ id: string; isFree?: boolean; cost?: { input: number; output: number }; rankings?: Record<string, number> }>): LeadershipArtifact {
	const leadershipModels = models.map((m, index) => ({
		id: m.id,
		provider: m.id.includes("/") ? m.id.split("/")[0] : "provider",
		modelId: m.id.includes("/") ? m.id.split("/")[1] ?? m.id : m.id,
		name: m.id,
		isFree: m.isFree ?? false,
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		family: "test",
		categories: Object.keys(m.rankings ?? { coding: index + 1 }),
		rankings: m.rankings ?? { coding: index + 1 },
		conservativeRating: 90 - index,
		available: true,
		topRanking: index + 1,
		topRankingCategory: "coding",
		providers: [m.id],
		availableProviders: [m.id],
		availabilityScore: 1,
	}));

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		source: { snapshotPath: "test", snapshotGeneratedAt: new Date().toISOString() },
		config: {
			preferFree: true,
			defaultCategory: "coding",
			maxResults: 50,
			paidSortRule: { strategy: "rankedAndCost", rankingOrder: "asc", costOrder: "asc", ratingDiffThreshold: 5 },
		},
		models: leadershipModels,
		views: {
			freeLocal: leadershipModels.filter((m) => m.isFree).map((m) => m.availableProviders[0]!),
			paidLocal: leadershipModels.filter((m) => !m.isFree).map((m) => m.availableProviders[0]!),
			overall: leadershipModels.map((m) => m.availableProviders[0]!),
			byCategory: { coding: leadershipModels.map((m) => m.availableProviders[0]!) },
		},
	};
}

describe("model leadership integration + dynamic fallback", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
	let mockPi: MockPi;
	let tempDir: string;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
		resetProviderRateLimitCache();
	});

	afterEach(() => {
		try {
			const exclPath = getExclusionsFilePath();
			if (fs.existsSync(exclPath)) fs.unlinkSync(exclPath);
		} catch {
			// best-effort cleanup
		}
		removeTempDir(tempDir);
	});

	describe("leadership selection in parallel flow", () => {
		it("uses leadership-ranked order when selecting models for parallel tasks", async () => {
			const snapshot = createMockRankingsSnapshot([
				{ modelId: "provider-a/model-a", rank: 1 },
				{ modelId: "provider-b/model-b", rank: 2 },
				{ modelId: "provider-c/model-c", rank: 3 },
			]);
			const piModels = [
				{ provider: "provider-a", id: "model-a", fullId: "provider-a/model-a", available: true, isFree: false, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, family: "a" },
				{ provider: "provider-b", id: "model-b", fullId: "provider-b/model-b", available: true, isFree: false, cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, family: "b" },
				{ provider: "provider-c", id: "model-c", fullId: "provider-c/model-c", available: true, isFree: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, family: "c" },
			];
			const leadership = buildLeadership(snapshot, piModels, { enabled: true, preferences: { preferFree: true, defaultCategory: "coding", maxResults: 50, paidSortRule: { strategy: "priority" } } }, "test");
			const ranked = selectModelsFromLeadership(leadership, { category: "coding", preferFree: true, maxResults: 3 });
			assert.deepEqual(ranked, ["provider-c/model-c", "provider-a/model-a", "provider-b/model-b"]);
		});

		it("parallel tasks receive leadership-selected models when no explicit override is set", async () => {
			const leadership = createLeadershipArtifact([
				{ id: "provider-a/model-a", rankings: { coding: 1 } },
				{ id: "provider-b/model-b", rankings: { coding: 2 } },
			]);
			setLeadershipArtifact(leadership);

			for (const model of ["provider-a/model-a", "provider-a/model-a"]) {
				mockPi.onCall({
					jsonl: [
						{
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: `${model} result` }],
								model,
								stopReason: "stop",
								usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
							},
						},
					],
					exitCode: 0,
				});
			}
			const { tempDir, executor } = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"leadership-parallel-select",
				{
					tasks: [
						{ agent: "echo", task: "Probe A" },
						{ agent: "echo", task: "Probe B" },
					],
					concurrency: 2,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.equal(result.details?.results?.length, 2);
			const models = (result.details?.results ?? []).map((entry: any) => entry?.model);
			assert.deepEqual(models, ["provider-a/model-a", "provider-a/model-a"]);
		});
	});

	describe("dynamic fallback on unknown/unrecognized errors", () => {
		it("falls back to the next candidate when a parallel task fails with an unknown error", async () => {
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "something weird broke" }],
							model: "provider-a/model-a",
							errorMessage: "unrecognized runtime error: 0xDEADBEEF",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
						},
					},
				],
				exitCode: 0,
			});
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "recovered on fallback" }],
							model: "provider-b/model-b",
							stopReason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
						},
					},
				],
				exitCode: 0,
			});
			const { tempDir, executor } = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"fallback-unknown-error",
				{
					tasks: [
						{ agent: "echo", task: "Probe primary", model: "provider-a/model-a" },
						{ agent: "echo", task: "Probe fallback", model: "provider-b/model-b" },
					],
					concurrency: 2,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.equal(result.details?.results?.length, 2);
			const failed = (result.details?.results ?? []).find((entry: any) => entry?.model === "provider-a/model-a");
			const succeeded = (result.details?.results ?? []).find((entry: any) => entry?.model === "provider-b/model-b");
			assert.ok(failed, "expected failing model result");
			assert.ok((failed.error ?? "").includes("0xDEADBEEF"), `expected unknown error, got: ${failed.error}`);
			assert.ok(succeeded, "expected successful fallback result");
			assert.equal(succeeded.exitCode, 0);
		});

		it("exhausts all fallback candidates before failing on unknown errors", async () => {
			for (const model of ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"]) {
				mockPi.onCall({
					jsonl: [
						{
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: `${model} exploded` }],
								model,
								errorMessage: `unknown failure from ${model}`,
								usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
							},
						},
					],
					exitCode: 0,
				});
			}
			const { tempDir, executor } = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"fallback-all-unknown",
				{
					tasks: [
						{ agent: "echo", task: "Probe A", model: "provider-a/model-a" },
						{ agent: "echo", task: "Probe B", model: "provider-b/model-b" },
						{ agent: "echo", task: "Probe C", model: "provider-c/model-c" },
					],
					concurrency: 3,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const attempts = (result.details?.results ?? []).map((entry: any) => entry?.model);
			assert.deepEqual(attempts, ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"]);
			assert.equal((result.details?.results ?? []).filter((entry: any) => entry?.exitCode !== 0).length, 3);
		});

		it("records all failed model attempts in parallel multi-model flow", async () => {
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "weird failure" }],
							model: "provider-a/model-a",
							errorMessage: "random unknown provider error",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
						},
					},
				],
				exitCode: 0,
			});
			mockPi.onCall({ output: "Recovered" });
			const { tempDir, executor } = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"fallback-unknown-records-attempts",
				{
					tasks: [
						{ agent: "echo", task: "Probe failing model", model: "provider-a/model-a" },
						{ agent: "echo", task: "Probe fallback model", model: "provider-b/model-b" },
					],
					concurrency: 2,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const failing = (result.details?.results ?? []).find((entry: any) => entry?.model === "provider-a/model-a");
			assert.ok(failing, "expected failing model result");
			assert.equal(failing.exitCode, 1);
			assert.ok((failing.error ?? "").includes("random unknown provider error"));
		});
	});

	describe("exclusion rate-limit enrichment", () => {
		it("records rate-limit hints in persisted exclusions", async () => {
			recordModelFailure({
				provider: "test-provider",
				modelId: "test-model",
				reason: "unknown test failure",
				ttlMs: 60_000,
				retryAfterHint: "custom hint",
				retryCondition: "retry after custom hint",
			});
			flushPersist();

			const raw = fs.readFileSync(getExclusionsFilePath(), "utf-8");
			const data = JSON.parse(raw);
			const failure = data.exclusions.find((entry: any) => entry.provider === "test-provider" && entry.modelId === "test-model");
			assert.ok(failure, "expected exclusion to be persisted");
			assert.equal(failure.retryAfterHint, "custom hint");
			assert.equal(failure.retryCondition, "retry after custom hint");
		});
	});

	describe("single-run exhaustive fallback behavior", () => {
		it("tries every candidate until success or exhaustion on unknown errors", async () => {
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "unknown issue" }],
							model: "openai/gpt-5-mini",
							errorMessage: "spontaneous combustion",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
						},
					},
				],
				exitCode: 0,
			});
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Recovered" }],
							model: "anthropic/claude-sonnet-4",
							stopReason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
						},
					},
				],
				exitCode: 0,
			});
			const agents = [makeAgent("echo", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			})];

			const result = await runSync!(tempDir, agents, "echo", "Task", {
				runId: "unknown-error-exhaustive",
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.model, "anthropic/claude-sonnet-4");
			assert.deepEqual(result.modelAttempts?.map((attempt: any) => attempt.success), [false, true]);
			assert.equal(result.modelAttempts?.length, 2);
			assert.equal(mockPi.callCount(), 2);
		});

		it("fails after the last candidate even on unknown errors", async () => {
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "unknown fatal" }],
							model: "openai/gpt-5-mini",
							errorMessage: "completely unknown",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
						},
					},
				],
				exitCode: 0,
			});
			const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

			const result = await runSync!(tempDir, agents, "echo", "Task", {
				runId: "unknown-error-last-candidate",
			});

			assert.equal(result.exitCode, 1);
			assert.match(result.error ?? "", /completely unknown/);
			assert.equal(result.modelAttempts?.length, 1);
			assert.equal(mockPi.callCount(), 1);
		});
	});
});
