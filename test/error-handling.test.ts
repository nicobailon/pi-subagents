/**
 * Integration tests for error handling across execution modes.
 *
 * Tests: agent crashes, stderr capture, detectSubagentError override,
 * signal/abort handling, and error propagation in chains.
 *
 * Requires pi packages for execution tests. Skips gracefully if unavailable.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
	tryImport,
} from "./helpers.ts";

// Top-level await
const utils = await tryImport<any>("./utils.ts");
const execution = await tryImport<any>("./execution.ts");
const chainMod = await tryImport<any>("./chain-execution.ts");
const runtimeFallback = await tryImport<any>("./runtime-model-fallback.ts");

const piAvailable = !!(execution && utils);
const chainAvailable = !!chainMod;
const runtimeFallbackAvailable = !!runtimeFallback;

const runSync = execution?.runSync;
const detectSubagentError = utils?.detectSubagentError;
const executeChain = chainMod?.executeChain;
const buildModelCandidates = runtimeFallback?.buildModelCandidates;
const classifyRuntimeModelFailure = runtimeFallback?.classifyRuntimeModelFailure;
const getCooldownSkipReason = runtimeFallback?.getCooldownSkipReason;
const updateCooldownStore = runtimeFallback?.updateCooldownStore;

// ---------------------------------------------------------------------------
// runtime-model-fallback
// ---------------------------------------------------------------------------

describe("runtime model fallback policy", { skip: !runtimeFallbackAvailable ? "runtime-model-fallback not importable" : undefined }, () => {
	it("builds candidates in override -> session -> agent -> fallback order with dedupe", () => {
		const candidates = buildModelCandidates({
			context: {
				availableModels: [
					{ provider: "anthropic", id: "claude-sonnet-4-5", fullId: "anthropic/claude-sonnet-4-5" },
					{ provider: "openai", id: "gpt-4.1", fullId: "openai/gpt-4.1" },
				],
				currentSessionModel: "gpt-4.1",
				config: {
					preferCurrentSessionModel: true,
					fallbackModels: ["claude-sonnet-4-5", "gpt-4.1"],
				},
			},
			modelOverride: "claude-sonnet-4-5",
			agentModel: "gpt-4.1",
			agentThinking: "high",
		});

		assert.deepEqual(
			candidates.map((candidate: any) => [candidate.source, candidate.model]),
			[
				["override", "claude-sonnet-4-5:high"],
				["session", "gpt-4.1:high"],
			],
		);
	});

	it("omits current session model when preferCurrentSessionModel is false", () => {
		const candidates = buildModelCandidates({
			context: {
				availableModels: [{ provider: "openai", id: "gpt-4.1", fullId: "openai/gpt-4.1" }],
				currentSessionModel: "openai/gpt-4.1",
				config: { preferCurrentSessionModel: false, fallbackModels: ["openai/gpt-4.1", "openai/gpt-4.1-mini"] },
			},
			agentModel: "openai/gpt-4.1",
		});

		assert.deepEqual(
			candidates.map((candidate: any) => candidate.source),
			["agent", "fallback"],
		);
	});

	it("prefers the current session model over the agent default when both are available", () => {
		const candidates = buildModelCandidates({
			context: {
				availableModels: [
					{ provider: "openai-codex", id: "gpt-5.4", fullId: "openai-codex/gpt-5.4" },
					{ provider: "anthropic", id: "claude-sonnet-4-6", fullId: "anthropic/claude-sonnet-4-6" },
				],
				currentSessionModel: "openai-codex/gpt-5.4",
				config: { preferCurrentSessionModel: true },
			},
			agentModel: "anthropic/claude-sonnet-4-6",
		});

		assert.deepEqual(
			candidates.map((candidate: any) => candidate.source),
			["session", "agent"],
		);
		assert.deepEqual(
			candidates.map((candidate: any) => candidate.model),
			["openai-codex/gpt-5.4", "anthropic/claude-sonnet-4-6"],
		);
	});

	it("classifies provider/runtime failures conservatively", () => {
		assert.equal(
			classifyRuntimeModelFailure({ error: "429 rate limit exceeded by provider" }).classification,
			"retryable-runtime",
		);
		assert.equal(
			classifyRuntimeModelFailure({ error: "bash failed (exit 1): No such file or directory" }).classification,
			"deterministic",
		);
		assert.equal(
			classifyRuntimeModelFailure({ error: "weird unexplained issue" }).classification,
			"unknown",
		);
	});

	it("tracks cooldown by model and never skips explicit overrides", () => {
		const dir = createTempDir();
		try {
			const cooldownPath = path.join(dir, "cooldowns.json");
			updateCooldownStore(
				cooldownPath,
				{ model: "openai/gpt-4.1", source: "agent", normalizedModel: "openai/gpt-4.1" },
				{ classification: "retryable-runtime", reason: "429 rate limit", cooldownScope: "model" },
				{ cooldownMinutes: 10 },
			);
			const store = runtimeFallback.readCooldownStore(cooldownPath);
			assert.ok(getCooldownSkipReason({ model: "openai/gpt-4.1", source: "fallback", normalizedModel: "openai/gpt-4.1" }, store));
			assert.equal(
				getCooldownSkipReason({ model: "openai/gpt-4.1", source: "override", normalizedModel: "openai/gpt-4.1" }, store),
				null,
			);
		} finally {
			removeTempDir(dir);
		}
	});

	it("keeps the current cooldown store when provider-scoped cooldown cannot parse a provider", () => {
		const dir = createTempDir();
		try {
			const cooldownPath = path.join(dir, "cooldowns.json");
			const existingStore = updateCooldownStore(
				cooldownPath,
				{ model: "openai/gpt-4.1", source: "agent", normalizedModel: "openai/gpt-4.1" },
				{ classification: "retryable-runtime", reason: "429 rate limit", cooldownScope: "model" },
				{ cooldownMinutes: 10 },
			);

			const nextStore = updateCooldownStore(
				cooldownPath,
				{ model: "gpt-4.1", source: "fallback" },
				{ classification: "retryable-runtime", reason: "provider outage", cooldownScope: "provider" },
				{ cooldownMinutes: 10 },
				Date.now(),
				existingStore,
			);

			assert.deepEqual(nextStore, existingStore);
			assert.ok(nextStore.models?.["openai/gpt-4.1"]);
		} finally {
			removeTempDir(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// detectSubagentError
// ---------------------------------------------------------------------------

describe("detectSubagentError", { skip: !detectSubagentError ? "utils not importable" : undefined }, () => {
	it("returns no error for successful messages", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "Let me check..." }] },
			{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "OK" }] },
			{ role: "assistant", content: [{ type: "text", text: "All good!" }] },
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false);
	});

	it("detects fatal bash error in last tool result", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "Running..." }] },
			{
				role: "toolResult",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "command not found" }],
			},
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "bash");
	});

	it("detects non-zero exit code in bash output", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "Running..." }] },
			{
				role: "toolResult",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "Error: process exited with code 127" }],
			},
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.exitCode, 127);
	});

	it("ignores errors before last successful tool result", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "Trying..." }] },
			{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "EISDIR" }] },
			{ role: "assistant", content: [{ type: "text", text: "Let me fix that..." }] },
			{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "OK" }] },
			{ role: "assistant", content: [{ type: "text", text: "Fixed!" }] },
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false);
	});

	it("detects isError on tool result", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "Running..." }] },
			{
				role: "toolResult",
				toolName: "write",
				isError: true,
				content: [{ type: "text", text: "Permission denied" }],
			},
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "write");
	});
});

// ---------------------------------------------------------------------------
// runSync error handling
// ---------------------------------------------------------------------------

describe("runSync error handling", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

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
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("captures stderr on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 2, stderr: "Fatal: out of memory" });
		const agents = makeAgentConfigs(["crash"]);

		const result = await runSync(tempDir, agents, "crash", "Do heavy work", {});

		assert.equal(result.exitCode, 2);
		assert.ok(result.error?.includes("out of memory"));
	});

	it("detectSubagentError overrides exit 0 on hidden failure", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "deploy" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "connection refused"),
			],
		});
		const agents = makeAgentConfigs(["deployer"]);

		const result = await runSync(tempDir, agents, "deployer", "Deploy app", {});

		assert.notEqual(result.exitCode, 0, "should detect hidden failure");
		assert.ok(result.error?.includes("connection refused"));
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// Key: should complete much faster than the 10s delay
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
	});
});

// ---------------------------------------------------------------------------
// Chain error propagation
// ---------------------------------------------------------------------------

describe("chain error propagation", { skip: !chainAvailable ? "chain module not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

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
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(chain: any[], agents: any[]) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: "test-err",
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(tempDir, "artifacts"),
			artifactConfig: { enabled: false },
			clarify: false,
		};
	}

	it("preserves error context from failed step", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Step 1 exploded" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Fail here" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(result.isError);
		const failedResult = result.details.results[0];
		assert.equal(failedResult.exitCode, 1);
		assert.ok(failedResult.error?.includes("exploded"));
	});

	it("reports currentStepIndex on failure", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = [makeAgent("a"), makeAgent("b"), makeAgent("c")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "First" }, { agent: "b" }, { agent: "c" }],
				agents,
			),
		);

		assert.ok(result.isError);
		assert.equal(result.details.currentStepIndex, 0);
		assert.equal(result.details.results.length, 1);
	});
});
