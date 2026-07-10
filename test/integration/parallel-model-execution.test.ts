/**
 * Integration test: parallel subagent execution across multiple models.
 *
 * Purpose:
 * - Run several model routes in parallel within one subagent execution call.
 * - Record which models succeed, which fail, and whether parallel results
 *   preserve per-task model metadata.
 *
 * These tests require pi packages to be importable. If unavailable, tests
 * skip gracefully.
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

describe("parallel model execution probe", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		mockPi.reset();
	});

	afterEach(() => {
		//
	});

	it("runs multiple model candidates in parallel and reports per-model outcomes", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "primary ok" }],
						model: "provider-a/model-a",
						stopReason: "stop",
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
						content: [{ type: "text", text: "secondary ok" }],
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
			"parallel-model-probe",
			{
				tasks: [
					{ agent: "echo", task: "Probe A", model: "provider-a/model-a" },
					{ agent: "echo", task: "Probe B", model: "provider-b/model-b" },
				],
				concurrency: 2,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results?.length, 2);
		const completedResults = result.details?.results ?? [];
		const successCount = completedResults.filter((entry: any) => entry?.exitCode === 0).length;
		assert.equal(successCount, 2, "both parallel model probes should succeed");
	});

	it("surfaces mixed success/failure across parallel model probes", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "primary failed" }],
						model: "provider-a/model-a",
						errorMessage: "provider-a/model-a: capacity error",
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
						content: [{ type: "text", text: "fallback ok" }],
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
			"parallel-model-mixed-probe",
			{
				tasks: [
					{ agent: "echo", task: "Probe failing model", model: "provider-a/model-a" },
					{ agent: "echo", task: "Probe working model", model: "provider-b/model-b" },
				],
				concurrency: 2,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		const completedResults = result.details?.results ?? [];
		assert.equal(completedResults.length, 2, "expected two parallel results");
		const failedResults = completedResults.filter((entry: any) => entry?.exitCode !== 0);
		const succeededResults = completedResults.filter((entry: any) => entry?.exitCode === 0);
		assert.equal(failedResults.length, 1, "expected one failing model probe");
		assert.ok((failedResults[0]?.error ?? "").includes("capacity error"), `expected capacity error, got: ${failedResults[0]?.error}`);
		assert.equal(succeededResults.length, 1, "expected one successful model probe");
	});

	it("aggregates parallel model probe summary without requiring file output", async () => {
		for (const model of ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"]) {
			mockPi.onCall({
				jsonl: [
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: `${model} done` }],
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
			"parallel-model-summary",
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
		assert.equal(result.details?.results?.length, 3);
		const models = (result.details?.results ?? []).map((entry: any) => entry?.model);
		assert.deepEqual(models, ["provider-a/model-a", "provider-b/model-b", "provider-c/model-c"]);
		assert.equal((result.content[0]?.text ?? "").includes("3/3 succeeded"), true);
	});
});
