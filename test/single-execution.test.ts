/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses mock-pi.mjs to simulate the pi CLI. Tests the full spawn→parse→result
 * pipeline in runSync without needing a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	setupMockPi,
	teardownMockPi,
	resetMockEnv,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	events,
	tryImport,
} from "./helpers.ts";

// Top-level await: try importing pi-dependent modules
const execution = await tryImport<any>("./execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;

	before(() => setupMockPi());
	after(() => teardownMockPi());

	beforeEach(() => {
		tempDir = createTempDir();
		resetMockEnv();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("spawns agent and captures output", async () => {
		process.env.MOCK_PI_OUTPUT = "Hello from mock agent";
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Say hello", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});

	it("captures non-zero exit code", async () => {
		process.env.MOCK_PI_EXIT_CODE = "1";
		process.env.MOCK_PI_STDERR = "Something went wrong";
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		process.env.MOCK_PI_OUTPUT = "Got it";
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("tracks usage from message events", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("tracks progress during execution", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		process.env.MOCK_PI_EXIT_CODE = "1";
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		const jsonl = [
			events.toolStart("bash", { command: "ls" }),
			events.toolEnd("bash"),
			events.toolResult("bash", "file1.txt\nfile2.txt"),
			events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
		];
		process.env.MOCK_PI_JSONL = JSON.stringify(jsonl);
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("writes artifacts when configured", async () => {
		process.env.MOCK_PI_OUTPUT = "Result text";
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		process.env.MOCK_PI_DELAY_MS = "10000"; // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("handles stderr without exit code as info (not error)", async () => {
		process.env.MOCK_PI_OUTPUT = "Success";
		process.env.MOCK_PI_STDERR = "Warning: something";
		process.env.MOCK_PI_EXIT_CODE = "0";
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});
});
