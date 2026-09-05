/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childSessionFactoryModule, setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import { createEventBus, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { ACTIVE_ASYNC_CAPACITY_DIR, acquireActiveAsyncCapacity, activeAsyncCapacitySessionKey } from "../../src/runs/background/active-async-capacity.ts";
import { deriveForkPromptCacheKey } from "../../src/runs/shared/child-tool-plan.ts";
import type { AsyncExecutionResult, AsyncResultPayload, AsyncStatusPayload } from "../support/async-execution-fixture.ts";
import {
	installAsyncExecutionHooks, waitForMockPiRuntime, available, isAsyncAvailable,
	executeAsyncSingle, executeAsyncChain, ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR,
	createSubagentExecutor, escapeRegExp, createRepo, writePackageSkill,
	waitForAsyncResultFile, waitForAsyncEvent, waitForAsyncState, waitForMockPiCall,
	readLastMockPiArgs, readMockPiArgs, readMockPiArgsMatching, tempDir, mockPi,
	makeAsyncExecutor, readAsyncPayload, observeSharedCwdRunner,
} from "../support/async-execution-fixture.ts";

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("background does not use compaction recovery after compaction_end willRetry false and a continued agent turn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const sessionFile = path.join(tempDir, "async-generic-empty-after-successful-compaction-session.jsonl");
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				{ type: "compaction_end", willRetry: false },
				{ type: "agent_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Compaction recovery must not run" });
		const id = `async-no-compaction-recovery-after-successful-compaction-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			sessionFile,
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" }],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /Subagent produced no output after terminal assistant stopReason "aborted"\./u);
		assert.equal(payload.results[0]?.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background single thinking override replaces primary and fallback suffixes", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-thinking-off-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
				thinking: "high",
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			thinkingOverride: "off",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const firstArgs = readMockPiArgs(mockPi, 0);
		const secondArgs = readMockPiArgs(mockPi, 1);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:off");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:off", "anthropic/claude-sonnet-4:off"]);
		assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "openai/gpt-5-mini:off");
		assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4:off");
	});

	it("background runs retry fallback models when a zero-exit attempt has empty output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "openai/gpt-5-mini",
					stopReason: "error",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered asynchronously from empty output" });
		const id = `async-empty-output-fallback-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4");
		assert.match(payload.results[0]?.output ?? "", /Recovered asynchronously from empty output/);
		assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.deepEqual(payload.results[0]?.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background fails a zero-exit child that stops during a tool after earlier assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("Work is in progress"),
				events.toolStart("bash", { command: "write files" }),
			],
			exitCode: 0,
		});
		const id = `async-mid-tool-exit-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /ended during 'bash' tool execution before the tool completed/);
		assert.match(payload.results[0]?.error ?? "", /Earlier assistant output is not a terminal result/);
		assert.doesNotMatch(payload.results[0]?.error ?? "", /cold-start/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background retains an earlier open tool when a later overlapping tool completes", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "wait" } },
				{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
				{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
			],
			exitCode: 0,
		});
		const id = `async-overlap-mid-tool-exit-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /ended during 'bash' tool execution before the tool completed/);
	});

	for (const terminal of [
		{ name: "empty text stop", content: [{ type: "text", text: "" }], stopReason: "stop", error: /no output.*empty response/i },
		{ name: "tool-call-only stop", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }], stopReason: "toolUse", error: /grep failed.*Path not found/i },
		{ name: "empty text length limit", content: [{ type: "text", text: "" }], stopReason: "length", error: /grep failed.*Path not found/i },
	]) {
		it(`background diagnoses ${terminal.name} after an exploratory tool error`, { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			mockPi.onCall({
				stdoutRaw: [
					events.toolResult("grep", "Path not found", true),
					events.toolResult("read", "recovered file contents"),
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: terminal.content,
							model: "openai/gpt-5-mini",
							stopReason: terminal.stopReason,
							usage: { input: 0, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						},
					},
				].map((event) => JSON.stringify(event)).join("\n"),
				exitCode: 0,
			});
			const id = `async-terminal-diagnosis-${Date.now().toString(36)}`;
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, false);
			assert.equal(payload.exitCode, 1);
			assert.match(payload.results[0]?.error ?? "", terminal.error);
			assert.equal(payload.results[0]?.output, "");
			const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
			assert.match(status.steps?.[0]?.error ?? "", terminal.error);
		});
	}

	it("background runs prefer empty-output fallback over an earlier tool error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "ENOENT: no such file or directory", true),
				events.toolResult("read", "recovered file contents"),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "stop",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered asynchronously on fallback" });
		const id = `async-empty-output-after-tool-error-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4");
		assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
		const statusPayload = await waitForAsyncState(id, (status) => status.state === "failed");
		assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
	});

	it("background runs treat recovered child errors as successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered asynchronously"),
			],
		});
		const id = `async-recovered-child-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "Recovered asynchronously");
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.status, "complete");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
	});

	it("background runs keep provider errors failed when followed only by empty assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
		assert.equal(payload.results[0]?.output, "");
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(statusPayload.state, "failed");
		assert.equal(statusPayload.steps?.[0]?.status, "failed");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
	});

	it("background file-only runs write full output but return only a file reference", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "analyst",
			task: "Analyze without modifying files",
			agentConfig: makeAgent("analyst", { tools: ["read", "grep", "find", "ls"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		for (const instruction of [taskArg, systemPrompt]) {
			assert.match(instruction, /Return the complete artifact in your final response\./);
			assert.match(instruction, /runtime will persist it to exactly this path:/);
			assert.match(instruction, /Do not call contact_supervisor merely because no write-capable tool is available\./);
			assert.doesNotMatch(instruction, /Write your findings to exactly this path/);
		}
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.match(payload.summary ?? "", /2 lines/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("removes Pi turn-timing telemetry from runtime-persisted background output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const report = "## Review\n\nVERDICT: FINDINGS";
		const timingFooter = "\x1b[38;2;136;136;136m✻ Turn took 5m 54s (Total time 5m 54s · 2 turns)\x1b[0m";
		mockPi.onCall({ output: `${report}\n\n${timingFooter}` });
		const id = `async-timing-footer-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "async-review.md");
		executeAsyncSingle(id, {
			agent: "reviewer",
			task: "Review without modifying files",
			agentConfig: makeAgent("reviewer", { tools: ["read", "grep", "find", "ls"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			acceptance: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), report);
		assert.doesNotMatch(payload.summary ?? "", /Turn took/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /Turn took/);
	});

	it("background single runs route relative outputs to outputBaseDir", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async configured report" });
		const id = `async-configured-output-base-${Date.now().toString(36)}`;
		const outputBaseDir = path.join(tempDir, "async-configured-outputs");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", { output: "context.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "context.md",
			outputBaseDir,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const outputPath = path.join(outputBaseDir, "context.md");
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("background single runs make output overrides authoritative in the child system prompt", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async override report" });
		const id = `async-output-override-system-prompt-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "async-custom-report.md");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
		await waitForAsyncResultFile(id);
	});

	it("background single runs treat string false as disabled output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async inline report" });
		const id = `async-string-false-output-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { output: "default-report.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "false",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "async inline report");
		assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("background runs detect hidden tool failures even when the child exits 0", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background completion intent uses disposed child model services before publishing evidence", { timeout: 60_000, skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async (t) => {
		const reviewTask = 'Review the proposal "Implement the approved fixes" and report whether its reasoning is sound.';
		const factoryPath = path.join(tempDir, "intent-factory.mjs");
		const tracePath = path.join(tempDir, "intent-trace.jsonl");
		const casePath = path.join(tempDir, "intent-case.json");
		fs.writeFileSync(factoryPath, `
import fs from "node:fs";
import assert from "node:assert/strict";
import { createDefaultChildSessionFactory } from ${JSON.stringify(new URL("../../src/runs/shared/child-session.ts", import.meta.url).href)};
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(casePath)}, "utf8"));
const trace = event => fs.appendFileSync(${JSON.stringify(tracePath)}, event + "\\n");
export default function() {
  let disposed = false;
  const model = { provider: "intent-test", id: "child-attempt", api: "intent-test-api" };
  const runtime = { apiKey: "fixture-key" };
  const registry = {
    runtime,
    async getApiKeyAndHeaders() {
      trace("auth");
      assert.ok(disposed, "auth after child disposal");
      return { ok: true, apiKey: this.runtime.apiKey, headers: { "x-intent-test": "fixture-header" } };
    },
    getRegisteredProviderConfig() { return { api: model.api, streamSimple(selected, context, options) {
      trace("stream");
      assert.ok(disposed, "stream after child disposal");
      assert.equal(selected.provider + "/" + selected.id, "intent-test/child-attempt");
      assert.equal(options.apiKey, "fixture-key");
      assert.equal(options.headers["x-intent-test"], "fixture-header");
      const decided = context.messages.some(message => message.role === "toolResult");
      const message = !decided
        ? fauxAssistantMessage(fauxToolCall("task_mutation_decision", { classification: scenario.classification ?? "read_only", confidence: "high", reason: "Scripted task intent." }), { stopReason: "toolUse" })
        : fauxAssistantMessage("Review findings: the proposal is sound.", { stopReason: "stop" });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
      return stream;
    } }; },
  };
  // Existing SDK seam: production factory/hooks, scripted child/model services.
  return createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
    ModelRuntime: { create: async () => runtime },
    SettingsManager: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      loaded = false;
      handlers = [];
      constructor(options) { this.options = options; }
      async reload() {
        const pi = { on: (event, handler) => this.handlers.push({ event, handler }), registerTool() {}, events: { on() { return () => {}; }, emit() {} } };
        for (const hook of this.options.extensionFactories) hook.factory(pi);
      }
    },
    resolveCliModel: ({ cliModel }) => { assert.equal(cliModel, "intent-test/child-attempt"); return { model }; },
    createAgentSession: async ({ resourceLoader, model }) => {
      const ctx = Proxy.revocable({ model, modelRegistry: registry }, {});
      let listener;
      const messages = [];
      return { session: {
        model, messages, sessionId: "intent-child",
        async bindExtensions() { for (const { event, handler } of resourceLoader.handlers) if (event === "session_start") await handler({ type: event }, ctx.proxy); },
        extensionRunner: { hasHandlers: () => false },
        subscribe(next) { listener = next; return () => {}; },
        async prompt() {
          const message = fauxAssistantMessage("Review findings: the proposal is sound.", { stopReason: "stop" }); messages.push(message); listener({ type: "message_end", message });
        },
        async abort() {}, async steer() {}, async followUp() {},
        dispose() { disposed = true; ctx.revoke(); },
      } };
    },
  }) });
}
`);
		setChildSessionFactoryModule(factoryPath);
		t.after(() => setChildSessionFactoryModule(fileURLToPath(new URL("../support/runner-child-session-factory.ts", import.meta.url))));
		for (const scenario of [
			{ name: "review-rescue", task: reviewTask, success: true, effect: "not-applicable", calls: true },
			{ name: "implementation", task: "Implement the approved fixes", classification: "implementation", success: false, effect: "missing", calls: true },
			{ name: "ordinary", task: "Summarize the proposal", success: true, effect: "not-applicable", calls: false },
		]) {
			fs.writeFileSync(casePath, JSON.stringify(scenario));
			fs.writeFileSync(tracePath, "");
			const id = `async-intent-${scenario.name}-${Date.now().toString(36)}`;
			const outputPath = path.join(tempDir, `${id}.md`);
			const launched = executeAsyncSingle(id, {
				agent: "worker", task: scenario.task,
				agentConfig: makeAgent("worker", { model: "intent-test/child-attempt" }),
				output: outputPath,
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, maxSubagentDepth: 2,
			});
			assert.notEqual(launched.isError, true, `${scenario.name}: ${JSON.stringify(launched)}`);
			const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8"));
			await waitForAsyncEvent(id, "subagent.run.process_terminal");
			assert.equal(payload.success, scenario.success, `${scenario.name}: ${JSON.stringify(payload)}`);
			assert.equal(payload.results[0].effects?.fileMutation?.status, scenario.effect, scenario.name);
			const trace = fs.readFileSync(tracePath, "utf8");
			assert.equal(trace.includes("auth"), scenario.calls, scenario.name);
			assert.equal(trace.includes("stream"), scenario.calls, scenario.name);
			if (!scenario.success) assert.match(payload.results[0].modelAttempts[0].error, /completed without making edits/, scenario.name);
			if (scenario.name === "review-rescue") {
				assert.equal(payload.results[0].effects.fileMutation.resolvedBy, "llm-intent-arbiter");
				assert.equal(payload.results[0].effects.fileMutation.expected, true);
				assert.equal(payload.results[0].modelAttempts[0].success, true);
				assert.equal(payload.results[0].modelAttempts[0].error, undefined);
				assert.match(fs.readFileSync(outputPath, "utf8"), /Review findings: the proposal is sound/);
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
				assert.equal(status.state, "complete");
				assert.doesNotMatch(fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf8"), /"reason":"completion_guard"|completed without making edits/);
			}
		}
	});

	it("background implementation runs fail when no mutation attempt occurred", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
		assert.match(String(payload.results[0].modelAttempts?.[0]?.error ?? ""), /completed without making edits/);
		assert.deepEqual(payload.results[0].effects?.settlementDiagnostic?.mutation, {
			expected: true,
			attempted: false,
			observed: false,
		});
		assert.equal(payload.results[0].effects?.settlementDiagnostic?.finalTextPresent, true);

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.match(eventsText, /"reason":"completion_guard"/);
		assert.match(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /Status:/);
		assert.doesNotMatch(eventsText, /Interrupt:/);
	});

	it("does not use shared-cwd sibling tracked edits as parallel completion-guard proof", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async (t) => {
		mockPi.onCall({
			matchArgIncludes: "Edit tracked file",
			delay: 50,
			writeFiles: [{ path: "input.md", content: "changed by first sibling\n" }],
			jsonl: [
				...events.completedWrite("input.md", "changed by first sibling\n"),
				events.assistantMessage("Implemented first sibling change."),
			],
		});
		mockPi.onCall({
			matchArgIncludes: "Implement second sibling change",
			delay: 500,
			output: "Implemented second sibling change.",
		});
		const repo = createRepo("pi-subagents-shared-cwd-mutation-guard-");
		const id = `async-parallel-shared-cwd-mutation-${Date.now().toString(36)}`;
		let runnerStarted = false;
		const observer = observeSharedCwdRunner(id);
		const originalFactoryModule = childSessionFactoryModule();
		const failures: unknown[] = [];
		let reported = false;
		const reportFailure = () => {
			if (reported) return;
			reported = true;
			try { t.diagnostic(`#1906 ${JSON.stringify({ ...observer.summary(), snapshot: observer.snapshot() })}`); }
			catch { t.diagnostic("#1906 failure snapshot unavailable (contents withheld)"); }
		};
		try {
			assert.ok(originalFactoryModule, "expected the installed scripted runner factory");
			const factoryPath = path.join(tempDir, "shared-cwd-exit-phases.mjs");
			fs.writeFileSync(factoryPath, `
import { writeSync } from "node:fs";
import createFactory from ${JSON.stringify(pathToFileURL(originalFactoryModule).href)};
export default function() {
  const factory = createFactory();
  let invocation = 0;
  const mark = (phase, call) => writeSync(process.stderr.fd, "#1906 phase=" + phase + " invocation=" + call + " ts=" + Date.now() + " pid=" + process.pid + "\\n");
  process.once("exit", () => mark("exit", 0));
  return {
    create(...args) { return factory.create(...args); },
    async dispose() {
      const call = ++invocation;
      mark("dispose-entry", call);
      const result = await factory.dispose();
      mark("dispose-return", call);
      return result;
    },
  };
}
`);
			setChildSessionFactoryModule(factoryPath);
			const launch = observer.launch(() => executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "first", task: "Edit tracked file" },
						{ agent: "second", task: "Implement second sibling change" },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("first"), makeAgent("second")],
				ctx: { pi: { events: { emit: observer.emit } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			}));
			runnerStarted = !launch.isError;

			const payload = await readAsyncPayload(id);
			observer.marks.payloadReadAt = Date.now();
			assert.equal(payload.results[0]?.success, true);
			assert.equal(payload.results[0]?.effects?.fileMutation?.status, "observed");
			assert.equal(payload.results[1]?.success, false);
			assert.equal(payload.results[1]?.effects?.fileMutation?.status, "missing");
			assert.equal(payload.results[1]?.effects?.fileMutation?.attempted, false);
			assert.match(payload.results[1]?.error ?? "", /completed without making edits/);
			observer.marks.assertionsCompletedAt = Date.now();
		} catch (error) {
			failures.push(error);
		} finally {
			try {
				if (runnerStarted) {
					observer.marks.waitStartedAt = Date.now();
					try { await waitForAsyncEvent(id, "subagent.run.process_terminal"); }
					finally { observer.marks.waitFinishedAt = Date.now(); }
				}
				if (failures.length) reportFailure();
				fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
				// Validate channel support/correlation without reading artifacts on success.
				const summary = observer.summary();
				t.diagnostic(`#1906 observer ${JSON.stringify(summary)}`);
				if (runnerStarted) {
					assert.equal(summary.correlatedProcesses, 1, "diagnostic channel must capture the started-event runner PID");
					for (const type of ["spawn", "exit", "close"]) assert.ok(summary.processEvents.flat().some((event) => (event as { type: string }).type === type), `diagnostic runner ${type} must be observed`);
				}
			} catch (error) {
				failures.push(error);
				reportFailure();
			} finally {
				setChildSessionFactoryModule(originalFactoryModule);
				observer.dispose();
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Primary execution and cleanup/diagnostic failures", { cause: failures[0] });
	});

	it("background implementation challenges keep explicit no-change reports successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: [
			"Kept the current implementation. No new code or test changes were made in this challenge pass.",
			"Reason: the current candidate is the smallest correct shape.",
		].join("\n\n") });

		const id = `async-no-change-challenge-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const task = [
			"You are reviving a previous subagent conversation.",
			"",
			"Original run: source-run",
			"Original agent: worker",
			"Original session file: /tmp/source-session.jsonl",
			"",
			"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child session is still running.",
			"",
			"Follow-up:",
			"Implementation challenge pass 1 for the accepted candidate. Reconsider it and implement any better current-scope change.",
		].join("\n");

		executeAsyncSingle(id, {
			agent: "worker",
			task,
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.match(String(payload.results[0].output), /Kept the current implementation/);
		assert.doesNotMatch(String(payload.results[0].error ?? ""), /completed without making edits/);

		const eventsText = fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8");
		assert.doesNotMatch(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("agent contract v1 keeps async acceptance and file-mutation effects separate from execution", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing.\n```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"not-satisfied\",\"evidence\":\"no proof\"}]}\n```" });
		const id = `async-v1-separate-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker", { completionGuard: true }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			agentContract: { version: 1 },
			acceptance: { level: "checked", criteria: ["Return required proof"] },
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "complete");

		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.agentContract?.version, 1);
		assert.equal(payload.results[0]?.execution?.status, "completed");
		assert.equal(payload.results[0]?.execution?.success, true);
		assert.equal(payload.results[0]?.acceptance?.status, "rejected");
		assert.equal(payload.results[0]?.effects?.fileMutation?.status, "missing");
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.agentContract?.version, 1);
		assert.equal(statusPayload.steps?.[0]?.execution?.status, "completed");
		assert.equal(statusPayload.steps?.[0]?.effects?.fileMutation?.status, "missing");
	});

	it("background single runs support outputSchema", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "structured", structuredOutput: { ok: true, note: "async" } });
		const id = `async-single-schema-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Return structured data",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
			structuredOutputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" }, note: { type: "string" } } },
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0]?.structuredOutput, { ok: true, note: "async" });
	});

	it("background outputSchema runs fail closed when required acceptanceReport is missing", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "structured", structuredOutput: { ok: true } });
		const id = `async-schema-missing-acceptance-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Return structured data",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: { level: "checked", report: "on" },
			structuredOutputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /Missing acceptanceReport/);
		assert.equal(payload.results[0]?.acceptance?.status, "rejected");
	});

	it("background bash-enabled non-implementation agents can opt out of the completion guard", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "cold start test after patch" });

		const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "test-runner",
			task: "Run cold start test after patch",
			agentConfig: makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "cold start test after patch");

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("rejects an over-cap top-level async launch before creating run artifacts", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		fs.rmSync(path.join(ACTIVE_ASYNC_CAPACITY_DIR, activeAsyncCapacitySessionKey("session-cap")), { recursive: true, force: true });
		const state = {
			baseCwd: tempDir,
			currentSessionId: "session-cap",
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const occupied = acquireActiveAsyncCapacity({
			sessionId: "session-cap",
			limit: 1,
			runId: "held-run",
			kind: "runner",
			asyncDir: path.join(tempDir, "held-run"),
		});
		assert.ok(occupied);
		occupied.markStarted("held-runner");
		const rejectedAsyncDir = path.join(ASYNC_DIR, "cap-rejected");
		const rejectedResultPath = path.join(RESULTS_DIR, "cap-rejected.json");
		fs.rmSync(rejectedAsyncDir, { recursive: true, force: true });
		fs.rmSync(rejectedResultPath, { force: true });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { maxActiveAsyncRunsPerSession: 1, artifactDir: "project" },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const context = makeMinimalCtx(tempDir);
		context.sessionManager.getSessionFile = () => null;
		context.sessionManager.getSessionId = () => "session-cap";
		const previousDepth = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "0";
		const result = await executor.execute("cap-rejected", { agent: "worker", task: "Must not start", async: true }, new AbortController().signal, undefined, context);
		if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = previousDepth;
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Active async run capacity exhausted: 1\/1 used/);
		assert.equal(fs.existsSync(rejectedAsyncDir), false);
		assert.equal(fs.existsSync(rejectedResultPath), false);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi", "subagents")), false);
		fs.rmSync(path.join(ACTIVE_ASYNC_CAPACITY_DIR, activeAsyncCapacitySessionKey("session-cap")), { recursive: true, force: true });
	});

	it("scheduled executor launches retain the live active session ownership", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Scheduled work completed" });
		const liveCwd = path.join(tempDir, "live-project");
		fs.mkdirSync(liveCwd);
		const state = {
			baseCwd: liveCwd,
			currentSessionId: "session-b",
			lastParentModel: { provider: "deepseek", id: "live-model" },
			subagentSpawns: { sessionId: "session-b", count: 1, configuredLimit: 1, granted: 1, grantHistory: [] },
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { maxSubagentSpawnsPerSession: 1 },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const retainedCtx = makeMinimalCtx(tempDir);
		retainedCtx.sessionManager.getSessionId = () => "session-a";
		retainedCtx.model = { provider: "deepseek", id: "scheduled-model" };
		const launch = await executor.executeScheduled(
			`scheduled-owner-${Date.now().toString(36)}`,
			{ agent: "worker", task: "Run retained project timer", async: true, acceptance: false },
			new AbortController().signal,
			retainedCtx,
		) as AsyncExecutionResult;

		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);
		assert.equal(state.currentSessionId, "session-b");
		assert.equal(state.baseCwd, liveCwd);
		assert.deepEqual(state.lastParentModel, { provider: "deepseek", id: "live-model" });
		assert.deepEqual(state.subagentSpawns, { sessionId: "session-b", count: 1, configuredLimit: 1, granted: 1, grantHistory: [] });
		const blocked = await executor.executeScheduled(
			`scheduled-owner-blocked-${Date.now().toString(36)}`,
			{ agent: "worker", task: "Exceed the retained owner budget", async: true, acceptance: false },
			new AbortController().signal,
			retainedCtx,
		);
		assert.equal(blocked.isError, true);
		assert.match(blocked.content[0]?.type === "text" ? blocked.content[0].text : "", /1\/1 used/);
		assert.deepEqual(state.subagentSpawns, { sessionId: "session-b", count: 1, configuredLimit: 1, granted: 1, grantHistory: [] });
		await readAsyncPayload(launch.details.asyncId);
	});

	it("scheduled owners without a model do not inherit the live session model", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Scheduled owner work completed" });
		const liveCwd = path.join(tempDir, "live-model-project");
		fs.mkdirSync(liveCwd);
		const state = {
			baseCwd: liveCwd,
			currentSessionId: "session-live",
			lastParentModel: { provider: "router", id: "live-model" },
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const retainedCtx = makeMinimalCtx(tempDir);
		retainedCtx.sessionManager.getSessionId = () => "session-scheduled-owner";

		const launch = await executor.executeScheduled(
			`scheduled-owner-no-model-${Date.now().toString(36)}`,
			{ agent: "worker", task: "Run owner without model", async: true, acceptance: false },
			new AbortController().signal,
			retainedCtx,
		) as AsyncExecutionResult;
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);

		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.success, true);
		assert.equal(state.currentSessionId, "session-live");
		assert.deepEqual(state.lastParentModel, { provider: "router", id: "live-model" });
		const args = readMockPiArgsMatching(mockPi, "Run owner without model");
		assert.equal(args.includes("router/live-model"), false);
		assert.equal(args.includes("--model"), false);
	});

	it("scheduled workflows keep owner status and registries isolated from the live session", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const liveCwd = path.join(tempDir, "live-workflow-project");
		fs.mkdirSync(liveCwd);
		const state = {
			baseCwd: liveCwd,
			currentSessionId: "session-b",
			subagentSpawns: { sessionId: "session-b", count: 4, configuredLimit: 5, granted: 0, grantHistory: [] },
			asyncJobs: new Map(),
			fleetJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: { maxSubagentSpawnsPerSession: 5 },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const retainedCtx = makeMinimalCtx(tempDir);
		retainedCtx.sessionManager.getSessionId = () => "session-a";
		const workflowId = `scheduled-workflow-${Date.now().toString(36)}`;
		const launch = await executor.executeScheduled(
			workflowId,
			{ workflowScript: `return await runs.status("${workflowId}")`, async: true },
			new AbortController().signal,
			retainedCtx,
		) as AsyncExecutionResult;

		assert.equal(launch.isError, undefined);
		assert.equal(state.asyncJobs.size, 0);
		assert.equal(state.fleetJobs.size, 0);
		assert.deepEqual(state.subagentSpawns, { sessionId: "session-b", count: 4, configuredLimit: 5, granted: 0, grantHistory: [] });
		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(state.asyncJobs.size, 0);
		assert.equal(state.fleetJobs.size, 0);
		assert.match(payload.workflow.value.output, /Spawn budget: 0\/5 used/);
		assert.match(payload.workflow.value.output, new RegExp(workflowId));
	});

	it("async executor keeps the last parent session model after continuation drops ctx.model", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const initialCtx = makeMinimalCtx(tempDir);
		initialCtx.sessionManager.getSessionId = () => "session-continued";
		initialCtx.model = { provider: "deepseek", id: "deepseek-v4-flash" };
		await executor.execute("prime-parent-model", { action: "list" }, new AbortController().signal, undefined, initialCtx);

		const continuedCtx = makeMinimalCtx(tempDir);
		continuedCtx.sessionManager.getSessionId = () => "session-continued";
		const launch = await executor.execute(
			"continued-async-child",
			{ agent: "worker", task: "Do work", async: true, acceptance: false },
			new AbortController().signal,
			undefined,
			continuedCtx,
		) as AsyncExecutionResult;
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);

		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "deepseek/deepseek-v4-flash");
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("async workflows snapshot the parent model before workflow setup reads session data", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Inherited model work" });
		mockPi.onCall({ output: "Explicit model work" });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const context = makeMinimalCtx(tempDir);
		context.sessionManager.getSessionId = () => "session-workflow-parent-model";
		context.model = { provider: "router", id: "openai-personal" };
		context.sessionManager.getSessionFile = () => {
			context.model = undefined;
			return null;
		};

		const launch = await executor.execute(
			"workflow-parent-model",
			{ workflowScript: `await runs.run("inherited", { agent: "worker", task: "Do inherited work" }); return runs.run("explicit", { agent: "worker", task: "Do explicit work", model: "openai/gpt-5-mini" });`, async: true },
			new AbortController().signal,
			undefined,
			context,
		) as AsyncExecutionResult;
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);

		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.success, true);
		const inheritedArgs = readMockPiArgsMatching(mockPi, "Do inherited work");
		const explicitArgs = readMockPiArgsMatching(mockPi, "Do explicit work");
		assert.equal(inheritedArgs[inheritedArgs.indexOf("--model") + 1], "router/openai-personal");
		assert.equal(explicitArgs[explicitArgs.indexOf("--model") + 1], "openai/gpt-5-mini");
	});

	it("background single runs inherit the parent session model when no model is set", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-single-parent-model-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "deepseek",
				currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
		assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("background forked runs use an available fallback when the configured primary is unavailable", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Forked async work" });
		const parentSessionFile = path.join(tempDir, "parent-pruned-fallback.jsonl");
		const forkedSessionFile = path.join(tempDir, "forked-pruned-fallback.jsonl");
		const sessionHeader = { type: "session", version: 1, id: "child", cwd: fs.realpathSync(tempDir), parentSession: parentSessionFile };
		fs.writeFileSync(parentSessionFile, `${JSON.stringify({ type: "session", version: 1, id: "parent", cwd: fs.realpathSync(tempDir) })}\n`, "utf-8");
		fs.writeFileSync(forkedSessionFile, `${JSON.stringify(sessionHeader)}\n`, "utf-8");
		const pruner = { provider: "test", id: "pruner", api: "faux", maxTokens: 1024 };
		const ctx = {
			...makeMinimalCtx(tempDir),
			modelRegistry: {
				getAvailable: () => [
					{ provider: "mock", id: "fallback" },
					pruner,
				],
				find: (provider: string, id: string) => provider === "test" && id === "pruner" ? pruner : undefined,
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "faux" }),
			},
			sessionManager: {
				getSessionId: () => "session-configured-fallback",
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-current",
				openSession: () => ({ createBranchedSession: () => forkedSessionFile }),
			},
		};
		const launch = await makeAsyncExecutor([
			makeAgent("worker", {
				model: "mock/missing-primary",
				fallbackModels: ["mock/fallback"],
				completionGuard: false,
			}),
		], { forkContext: { mode: "pruned", model: "test/pruner" } }).execute(
			"forked-configured-fallback",
			{ agent: "worker", task: "Do work", async: true, context: "fork" },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;
		assert.ok(!launch.isError, launch.content[0]?.text);
		assert.ok(launch.details.asyncId);
		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.results[0]?.model, "mock/fallback");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["mock/fallback"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "mock/fallback");
	});

	it("revival preserves captured response aliases and their absence after config changes", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const route = "databricks-bedrock/ias-claude-opus-5";
		const agents = [makeAgent("worker", { model: route, completionGuard: false })];
		const cases = [
			{ original: { [route]: ["original-echo"] }, current: {}, echo: "original-echo", success: true },
			{ original: { [route]: ["original-echo"] }, current: { [route]: ["new-echo"] }, echo: "new-echo", success: false },
			{ original: undefined, current: { [route]: ["new-echo"] }, echo: "new-echo", success: false },
		];
		for (const [index, scenario] of cases.entries()) {
			const parentSessionFile = path.join(tempDir, `alias-parent-${index}.jsonl`);
			const sessionFile = path.join(tempDir, `alias-child-${index}.jsonl`);
			const header = JSON.stringify({ type: "session", version: 1, id: `alias-${index}`, cwd: fs.realpathSync(tempDir) });
			fs.writeFileSync(parentSessionFile, `${header}\n`);
			fs.writeFileSync(sessionFile, `${header}\n`);
			const ctx = {
				...makeMinimalCtx(tempDir),
				modelRegistry: { getAvailable: () => [{ provider: "databricks-bedrock", id: "ias-claude-opus-5" }] },
				sessionManager: {
					getSessionId: () => `alias-session-${index}`,
					getSessionFile: () => parentSessionFile,
					getLeafId: () => "leaf",
					openSession: () => ({ createBranchedSession: () => sessionFile }),
				},
			};
			mockPi.onCall({ jsonl: [events.assistantMessage("Initial work", route)] });
			const launch = await makeAsyncExecutor(agents, { modelResponseAliases: scenario.original }).execute(
				`alias-launch-${index}`, { agent: "worker", task: "Do work", async: true, context: "fork", acceptance: false },
				new AbortController().signal, undefined, ctx,
			) as AsyncExecutionResult;
			assert.ok(!launch.isError, launch.content[0]?.text);
			assert.ok(launch.details.asyncId);
			assert.equal((await readAsyncPayload(launch.details.asyncId)).success, true);

			// A new executor must recover the durable launch declaration, not its current settings.
			mockPi.onCall({ jsonl: [events.assistantMessage("Continued work", scenario.echo)] });
			const resumed = await makeAsyncExecutor(agents, { modelResponseAliases: scenario.current }).execute(
				`alias-revive-${index}`, { action: "resume", id: launch.details.asyncId, message: "Continue", acceptance: false },
				new AbortController().signal, undefined, ctx,
			) as AsyncExecutionResult;
			assert.ok(!resumed.isError, resumed.content[0]?.text);
			assert.ok(resumed.details.asyncId);
			const payload = await readAsyncPayload(resumed.details.asyncId);
			assert.equal(payload.success, scenario.success, `case ${index}: ${payload.results[0]?.error}`);
			if (!scenario.success) assert.match(payload.results[0]?.error ?? "", /model_verification_failed/);
			const args = readMockPiArgs(mockPi, index * 2 + 1);
			assert.equal(args[args.indexOf("--model") + 1], route);
			assert.equal(args[args.indexOf("--session") + 1], sessionFile);
		}
	});

	it("aligns initial and resumed background forked sessions with an explicit child cwd", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Forked async work" });
		const parentCwd = fs.realpathSync(tempDir);
		const childCwd = path.join(tempDir, "child-cwd");
		fs.mkdirSync(childCwd);
		const parentSessionFile = path.join(tempDir, "parent-cross-cwd.jsonl");
		const forkedSessionFile = path.join(tempDir, "forked-cross-cwd.jsonl");
		const parentHeader = { type: "session", version: 1, id: "parent", cwd: parentCwd };
		const childHeader = { type: "session", version: 1, id: "child", cwd: parentCwd, parentSession: parentSessionFile };
		fs.writeFileSync(parentSessionFile, `${JSON.stringify(parentHeader)}\n`, "utf-8");
		fs.writeFileSync(forkedSessionFile, `${JSON.stringify(childHeader)}\n`, "utf-8");
		const ctx = {
			...makeMinimalCtx(parentCwd),
			sessionManager: {
				getSessionId: () => "session-cross-cwd",
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-current",
				openSession: () => ({ createBranchedSession: () => forkedSessionFile }),
			},
		};

		const executor = makeAsyncExecutor([makeAgent("worker")]);
		const launch = await executor.execute(
			"forked-cross-cwd",
			{ agent: "worker", task: "Do work", async: true, context: "fork", cwd: childCwd },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;
		assert.ok(!launch.isError, launch.content[0]?.text);
		assert.ok(launch.details.asyncId);
		await readAsyncPayload(launch.details.asyncId);

		const sessionHeader = JSON.parse(fs.readFileSync(forkedSessionFile, "utf-8").split("\n", 1)[0]!) as { cwd?: string };
		assert.equal(sessionHeader.cwd, fs.realpathSync.native(childCwd));

		fs.writeFileSync(forkedSessionFile, `${JSON.stringify(childHeader)}\n`, "utf-8");
		mockPi.onCall({ output: "Resumed async work" });
		const resumed = await executor.execute(
			"resume-cross-cwd",
			{ action: "resume", id: launch.details.asyncId, message: "Continue" },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;
		assert.ok(!resumed.isError, resumed.content[0]?.text);
		assert.ok(resumed.details.asyncId);
		await readAsyncPayload(resumed.details.asyncId);

		const resumedHeader = JSON.parse(fs.readFileSync(forkedSessionFile, "utf-8").split("\n", 1)[0]!) as { cwd?: string };
		assert.equal(resumedHeader.cwd, fs.realpathSync.native(childCwd));
	});

	it("background forked runs inherit a parent model outside the registry", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Forked async work" });
		const parentSessionFile = path.join(tempDir, "parent.jsonl");
		const forkedSessionFile = path.join(tempDir, "forked.jsonl");
		const sessionHeader = JSON.stringify({ type: "session", cwd: fs.realpathSync(tempDir) });
		fs.writeFileSync(parentSessionFile, `${sessionHeader}\n`, "utf-8");
		fs.writeFileSync(forkedSessionFile, `${sessionHeader}\n`, "utf-8");
		const ctx = {
			...makeMinimalCtx(tempDir),
			model: { provider: "gateway", id: "parent-model" },
			modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5-mini" }] },
			sessionManager: {
				getSessionId: () => "session-123",
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-current",
				openSession: () => ({ createBranchedSession: () => forkedSessionFile }),
			},
		};
		const launch = await makeAsyncExecutor([makeAgent("worker")]).execute(
			"forked-parent-model",
			{ agent: "worker", task: "Do work", async: true, context: "fork" },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;
		assert.ok(!launch.isError, launch.content[0]?.text);
		assert.ok(launch.details.asyncId);
		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.results[0]?.model, "gateway/parent-model");
	});

	it("background forked runs receive the derived fork cache key", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "cache affinity inspected" });
		const parentSessionFile = path.join(tempDir, "parent-cache.jsonl");
		const forkedSessionFile = path.join(tempDir, "forked-cache.jsonl");
		const sessionHeader = JSON.stringify({ type: "session", cwd: fs.realpathSync(tempDir) });
		fs.writeFileSync(parentSessionFile, `${sessionHeader}\n`, "utf-8");
		fs.writeFileSync(forkedSessionFile, `${sessionHeader}\n`, "utf-8");
		const ctx = {
			...makeMinimalCtx(tempDir),
			sessionManager: {
				getSessionId: () => "session-cache-parent",
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-current",
				openSession: () => ({ createBranchedSession: () => forkedSessionFile }),
			},
		};

		const launch = await makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]).execute(
			"forked-cache-key",
			{ agent: "worker", task: "Inspect cache affinity", async: true, context: "fork" },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;
		assert.ok(!launch.isError, launch.content[0]?.text);
		assert.ok(launch.details.asyncId);

		const payload = await readAsyncPayload(launch.details.asyncId);
		assert.equal(payload.success, true);
		assert.equal((await waitForMockPiRuntime(mockPi, 0)).forkCacheKey, deriveForkPromptCacheKey("session-cache-parent"));
	});

	it("revives an inherited parent model outside the current registry", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Initial async work" });
		const sourceId = `async-revive-parent-model-${Date.now().toString(36)}`;
		const sessionFile = path.join(tempDir, "sessions", "source.jsonl");
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
		executeAsyncSingle(sourceId, {
			agent: "worker",
			task: "Initial work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-123" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			sessionFile,
			modelOverride: "gateway/parent-model",
			modelOverrideFromParent: true,
			maxSubagentDepth: 2,
		});
		await readAsyncPayload(sourceId);
		const descriptor = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, sourceId, "recovery-descriptor.json"), "utf-8"));
		assert.equal(descriptor.modelOverrideFromParent, true);
		assert.equal(descriptor.modelOrigin, "inherited");

		mockPi.onCall({ output: "Revived async work" });
		const result = await makeAsyncExecutor([makeAgent("worker")]).execute(
			"revive-parent-model",
			{ action: "resume", id: sourceId, message: "Continue" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		) as AsyncExecutionResult;
		assert.ok(!result.isError, result.content[0]?.text);
		assert.ok(result.details.asyncId);
		const payload = await readAsyncPayload(result.details.asyncId);
		assert.equal(payload.results[0]?.model, "gateway/parent-model");
	});

	it("reports the retained discovery context when a resumed target agent is missing", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
		const runId = `resume-missing-agent-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const sessionFile = path.join(tempDir, "missing-agent-session.jsonl");
		const visible = makeAgent("visible");
		visible.source = "project";
		const evidenceDir = path.join(tempDir, "request-discovery", "agents");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				sessionId: "session-123",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				cwd: tempDir,
				sessionFile,
				steps: [{ agent: "vanished", status: "complete" }],
			}, null, 2), "utf-8");
			const executor = makeAsyncExecutor([visible], {}, (cwd) => ({
				agents: [visible],
				cwd: path.resolve(cwd),
				scope: "both",
				directories: [{ source: "project", path: evidenceDir, state: "empty" }],
			}));
			const result = await executor.execute(
				"resume-missing-agent",
				{ action: "resume", id: runId, message: "Continue" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			) as AsyncExecutionResult;
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /^Unknown agent for resume: vanished\nEffective cwd: /);
			assert.match(result.content[0]?.text ?? "", new RegExp(evidenceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(result.content[0]?.text ?? "", /visible \(project\)/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("uses the append request discovery context for a missing appended agent", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
		const runId = `append-missing-agent-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const visible = makeAgent("visible");
		visible.source = "project";
		const evidenceDir = path.join(tempDir, "append-request", "agents");
		const storedCwd = path.join(tempDir, "stored-run-cwd");
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				sessionId: "session-123",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				cwd: storedCwd,
				steps: [{ agent: "visible", status: "running" }],
			}, null, 2), "utf-8");
			const executor = makeAsyncExecutor([visible], {}, (cwd) => ({
				agents: [visible],
				cwd: path.resolve(cwd),
				scope: "both",
				directories: [{ source: "project", path: evidenceDir, state: "empty" }],
			}));
			const result = await executor.execute(
				"append-missing-agent",
				{ action: "append-step", id: runId, step: { agent: "vanished", task: "Review" } },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			) as AsyncExecutionResult;
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /^Unknown agent: vanished\nEffective cwd: /);
			assert.match(result.content[0]?.text ?? "", new RegExp(evidenceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(result.content[0]?.text ?? "", /visible \(project\)/);
			assert.doesNotMatch(result.content[0]?.text ?? "", new RegExp(storedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("background chains inherit the parent session model when no step or agent model is set", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-chain-parent-model-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "deepseek",
				currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
		assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("background chains treat empty step models as parent inheritance", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-chain-empty-model-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", model: "" }],
			agents: [makeAgent("worker", { model: "anthropic/claude-sonnet-4-5", thinking: "high" })],
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "openai",
				currentModel: { provider: "openai", id: "gpt-5-mini" },
			},
			availableModels: [
				{ provider: "anthropic", id: "claude-sonnet-4-5", fullId: "anthropic/claude-sonnet-4-5", api: "anthropic-messages" },
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", api: "openai-responses" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "openai/gpt-5-mini:high");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini:high");
	});

	it("background chains keep agent fallback models inherited for scope warnings", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message?: unknown) => warnings.push(String(message));
		try {
			for (const [index, requestedModel] of [undefined, "", "inherit"].entries()) {
				const id = `async-chain-no-parent-${index}-${Date.now().toString(36)}`;
				executeAsyncChain(id, {
					chain: [{ agent: "worker", task: "Do work", ...(requestedModel !== undefined ? { model: requestedModel } : {}) }],
					agents: [makeAgent("worker", { model: "openai/gpt-5-mini", thinking: "high" })],
					ctx: {
						pi: { events: { emit() {} } },
						cwd: tempDir,
						currentSessionId: "session-1",
						modelScope: { enforce: true, allow: ["anthropic/*"] },
					},
					availableModels: [
						{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", api: "openai-responses" },
					],
					artifactConfig: {
						enabled: false,
						includeInput: false,
						includeOutput: false,
						includeJsonl: false,
						includeMetadata: false,
						cleanupDays: 7,
					},
					shareEnabled: false,
					sessionRoot: path.join(tempDir, "sessions"),
					maxSubagentDepth: 2,
				});

				const resultPath = await waitForAsyncResultFile(id, 10_000);
				const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
				assert.equal(payload.success, true);
				assert.equal(payload.results[0].model, "openai/gpt-5-mini:high");
				assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high"]);
				const args = readMockPiArgs(mockPi, index);
				assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini:high");
			}
			assert.equal(warnings.length, 3);
			assert.equal(warnings.every((warning) => warning.includes("outside the configured subagent model scope")), true);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("background runs resolve skills from the effective task cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
		const id = `async-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(taskCwd, "async-task-cwd-skill");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("injects agent-file-relative local skills into background single child prompts", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-local-skill-${Date.now().toString(36)}`;
		const agentFile = path.join(tempDir, "agents", "worker", "worker.md");
		const skillFile = path.join(path.dirname(agentFile), "skills", "local", "SKILL.md");
		fs.mkdirSync(path.dirname(skillFile), { recursive: true });
		fs.writeFileSync(skillFile, "---\ndescription: async local skill\n---\nLocal skill body\n", "utf-8");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { filePath: agentFile, skills: ["local"], skillPath: ["./skills"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id);
		const call = await waitForMockPiCall(mockPi, 0);
		assert.match(call.systemPrompts.map((record) => record.text ?? "").join("\n"), /async local skill/);
	});

	it("isolates agent-local skills between background parallel chain children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "one" });
		mockPi.onCall({ output: "two" });
		const id = `async-parallel-local-skills-${Date.now().toString(36)}`;
		const agents = ["one", "two"].map((name) => {
			const agentFile = path.join(tempDir, "agents", name, `${name}.md`);
			const skillFile = path.join(path.dirname(agentFile), "skills", "local", "SKILL.md");
			fs.mkdirSync(path.dirname(skillFile), { recursive: true });
			fs.writeFileSync(skillFile, `---\ndescription: ${name} async local skill\n---\nbody\n`, "utf-8");
			return makeAgent(name, { filePath: agentFile, skills: ["local"], skillPath: ["./skills"] });
		});

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "one", task: "One" }, { agent: "two", task: "Two" }], concurrency: 2 }],
			resultMode: "parallel",
			agents,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id);
		const prompts = await Promise.all([0, 1].map(async (index) => {
			const call = await waitForMockPiCall(mockPi, index);
			return call.systemPrompts.map((record) => record.text ?? "").join("\n");
		}));
		assert.equal(prompts.filter((prompt) => /one async local skill/.test(prompt) && !/two async local skill/.test(prompt)).length, 1);
		assert.equal(prompts.filter((prompt) => /two async local skill/.test(prompt) && !/one async local skill/.test(prompt)).length, 1);
	});

	it("background single runs report unavailable pi-subagents skill requests", () => {
		const id = `async-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			skills: ["pi-subagents"],
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains report unavailable pi-subagents skill requests", () => {
		const id = `async-chain-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", skill: ["pi-subagents"] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains resolve relative step cwd values against the shared cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const chainCwd = createTempDir("pi-subagent-async-chain-cwd-");
		const id = `async-chain-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(path.join(chainCwd, "packages", "app"), "async-chain-step-skill");
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app", skill: ["async-chain-step-skill"] }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: chainCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.sessionId, "session-1");
			assert.equal(status.sessionId, "session-1");
			assert.deepEqual(status.steps?.[0]?.skills, ["async-chain-step-skill"]);
		} finally {
			removeTempDir(chainCwd);
		}
	});

	it("keeps top-level current tool/path aligned with still-running parallel children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })] },
				{ delay: 900, jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
				{ delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
				{ delay: 700, jsonl: [events.assistantMessage("editor done")] },
			],
		});

		const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "reader", task: "Read" }, { agent: "editor", task: "Edit" }] }],
			agents: [makeAgent("reader"), makeAgent("editor")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		const doneDeadline = Date.now() + 10_000;
		let sawRunningTool = false;
		let invariantViolated = false;
		while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				const runningTools = (status.steps ?? [])
					.filter((step) => step.status === "running" && typeof step.currentTool === "string")
					.map((step) => step.currentTool as string);
				if (runningTools.length > 0) {
					sawRunningTool = true;
					if (!status.currentTool || !runningTools.includes(status.currentTool)) {
						invariantViolated = true;
						break;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fs.existsSync(resultPath)) {
			assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		}
		assert.equal(sawRunningTool, true, "expected at least one polling interval with a running step tool");
		assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
	});

	it("returns a tool error when the detached runner config cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

});
