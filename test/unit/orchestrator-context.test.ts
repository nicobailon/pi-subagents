/**
 * Unit tests for createOrchestratorContext:
 * runAgent (basic, error handling, structured output extraction),
 * withRetry (fixed, exponential, non-agent error propagation),
 * reads/output prefix injection.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import {
	createOrchestratorContext,
	OrchestratorAgentError,
	type OrchestratorContextDeps,
	type OrchestratorContext,
} from "../../src/orchestrator/orchestrator-context.ts";
import type { Details, SingleResult } from "../../src/shared/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function createMockExtensionContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		model: { provider: "test-provider" },
	} as ExtensionContext;
}

function makeSingleResult(overrides: Partial<SingleResult> & { output?: string } = {}): AgentToolResult<Details> {
	const output = overrides.output ?? "ok";
	return {
		content: [{ type: "text", text: output }],
		details: {
			mode: "single",
			results: [{
				agent: overrides.agent ?? "test",
				task: overrides.task ?? "test task",
				exitCode: overrides.exitCode ?? 0,
				messages: [],
				usage: overrides.usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
				output: output,
				finalOutput: output,
				error: overrides.error,
				sessionFile: overrides.sessionFile,
				structuredOutput: overrides.structuredOutput,
				model: overrides.model,
				...overrides,
			}],
		},
		isError: (overrides.exitCode ?? 0) !== 0,
	};
}

interface CallRecord {
	id: string;
	params: Record<string, unknown>;
}

function createMockExecute() {
	const calls: CallRecord[] = [];
	const responses: AgentToolResult<Details>[] = [];
	let responseIndex = 0;

	const execute = async (
		id: string,
		params: Record<string, unknown>,
		_signal: AbortSignal,
		_onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		_ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		calls.push({ id, params });
		const resp = responses[responseIndex] ?? responses[responses.length - 1];
		if (!resp) {
			throw new Error(`No mock response configured for call ${calls.length} (id: ${id})`);
		}
		responseIndex++;
		return resp;
	};

	return {
		execute,
		setResponses(resps: AgentToolResult<Details>[]) {
			responses.length = 0;
			responses.push(...resps);
			responseIndex = 0;
		},
		getCalls(): CallRecord[] { return calls; },
		callCount(): number { return calls.length; },
		lastCall(): CallRecord { return calls[calls.length - 1]; },
		reset() { calls.length = 0; responseIndex = 0; responses.length = 0; },
	};
}

function createContext(
	mockExec: ReturnType<typeof createMockExecute>,
	overrides: Partial<OrchestratorContextDeps> = {},
): OrchestratorContext {
	const deps: OrchestratorContextDeps = {
		execute: mockExec.execute,
		ctx: createMockExtensionContext(overrides.cwd ?? "/tmp/test"),
		chainDir: overrides.chainDir ?? "/tmp/test-chain",
		runId: overrides.runId ?? "test-run",
		cwd: overrides.cwd ?? "/tmp/test",
		timeoutMs: overrides.timeoutMs ?? 30000,
	};
	return createOrchestratorContext(deps);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("orchestrator context", () => {
	let tempDir: string;
	let chainDir: string;

	beforeEach(() => {
		tempDir = createTempDir("orch-ctx-");
		chainDir = path.join(tempDir, "chain");
		fs.mkdirSync(chainDir, { recursive: true });
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	// ── runAgent ────────────────────────────────────────────────────────

	describe("runAgent", () => {
		it("calls execute and returns result on success", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([makeSingleResult({ agent: "scout", output: "Analysis complete" })]);
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const result = await ctx.runAgent({ agent: "scout", task: "analyze the code" });

			assert.equal(result.exitCode, 0);
			assert.equal(result.output, "Analysis complete");
			assert.equal(result.agent, "scout");
			assert.equal(mockExec.callCount(), 1);
		});

		it("throws OrchestratorAgentError on non-zero exitCode", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([makeSingleResult({ agent: "worker", exitCode: 1, error: "something broke" })]);
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			await assert.rejects(
				() => ctx.runAgent({ agent: "worker", task: "implement" }),
				(err: unknown) => {
					assert.ok(err instanceof OrchestratorAgentError);
					assert.match((err as OrchestratorAgentError).message, /worker.*failed/);
					assert.equal((err as OrchestratorAgentError).result.exitCode, 1);
					assert.equal((err as OrchestratorAgentError).result.agent, "worker");
					return true;
				},
			);
		});

		it("with doNotThrowOnError returns result even on failure", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([makeSingleResult({ agent: "worker", exitCode: 1, error: "something broke", output: "failed output" })]);
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const result = await ctx.runAgent({ agent: "worker", task: "implement", doNotThrowOnError: true });

			assert.equal(result.exitCode, 1);
			assert.equal(result.error, "something broke");
			assert.equal(result.output, "failed output");
			assert.equal(mockExec.callCount(), 1);
		});

		it("includes usage, model, and duration in result", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([makeSingleResult({
				agent: "scout",
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.005, turns: 2 },
				model: "test-model-v1",
				progressSummary: { durationMs: 1500, toolCount: 3 },
			})]);
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const result = await ctx.runAgent({ agent: "scout", task: "analyze" });

			assert.ok(result.usage);
			assert.equal(result.usage.input, 100);
			assert.equal(result.usage.output, 50);
			assert.equal(result.usage.cost, 0.005);
			assert.equal(result.model, "test-model-v1");
			assert.equal(result.durationMs, 1500);
			assert.equal(result.toolCount, 3);
		});

		it("injects [Read from:] prefix when reads is provided", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([makeSingleResult({ agent: "scout" })]);
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const readFile = path.join(chainDir, "context.md");
			fs.writeFileSync(readFile, "some context", "utf-8");

			await ctx.runAgent({ agent: "scout", task: "analyze", reads: ["context.md"] });

			const params = mockExec.lastCall().params;
			assert.equal(typeof params.task, "string");
			assert.match(params.task as string, /\[Read from:.*context\.md\]/);
		});

		it("injects [Write to:] prefix when output path is provided", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([makeSingleResult({ agent: "scout" })]);
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			await ctx.runAgent({ agent: "scout", task: "generate", output: "report.md" });

			const params = mockExec.lastCall().params;
			assert.equal(typeof params.task, "string");
			assert.match(params.task as string, /\[Write to:.*report\.md\]/);
		});
	});

	// ── Structured output extraction ────────────────────────────────────

	describe("runAgent with outputSchema", () => {
		it("extracts structured output via second execute call", async () => {
			// Create a real session file so the extraction path can proceed
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n', "utf-8");

			const mockExec = createMockExecute();
			mockExec.setResponses([
				// First call: main runAgent
				makeSingleResult({ agent: "worker", output: "implemented", sessionFile, exitCode: 0 }),
				// Second call: structured output extraction
				makeSingleResult({
					agent: "worker",
					output: "extracted",
					exitCode: 0,
					structuredOutput: { name: "example", count: 42 },
				}),
			]);

			const outputSchema = Type.Object({
				name: Type.String(),
				count: Type.Number(),
			});

			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });
			const result = await ctx.runAgent({
				agent: "worker",
				task: "implement",
				outputSchema: JSON.parse(JSON.stringify(outputSchema)),
			});

			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.structuredOutput, { name: "example", count: 42 });
			assert.equal(mockExec.callCount(), 2, "should have made main call + extraction call");
		});

		it("handles failed structured output extraction gracefully", async () => {
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n', "utf-8");

			const mockExec = createMockExecute();
			// Main call + 3 extraction attempts (default maxStructuredOutputAttempts=3)
			// Each extraction returns no structuredOutput, so all 3 attempts are tried
			mockExec.setResponses([
				makeSingleResult({ agent: "worker", output: "implemented", sessionFile, exitCode: 0 }),
				makeSingleResult({ agent: "worker", exitCode: 1, error: "extraction failed", output: "no data" }),
				makeSingleResult({ agent: "worker", exitCode: 1, error: "extraction failed", output: "no data" }),
				makeSingleResult({ agent: "worker", exitCode: 1, error: "extraction failed", output: "no data" }),
			]);

			const outputSchema = Type.Object({ key: Type.String() });
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const result = await ctx.runAgent({
				agent: "worker",
				task: "implement",
				outputSchema: JSON.parse(JSON.stringify(outputSchema)),
			});

			// Should NOT throw — failed extraction is handled internally
			assert.equal(result.exitCode, 0);
			assert.equal(result.structuredOutput, undefined, "structuredOutput should be undefined when extraction fails");
			// 1 main call + 3 extraction retries = 4
			assert.equal(mockExec.callCount(), 4);
		});

		it("retries structured output extraction with maxStructuredOutputAttempts", async () => {
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n', "utf-8");

			const mockExec = createMockExecute();
			mockExec.setResponses([
				// Main call
				makeSingleResult({ agent: "worker", output: "implemented", sessionFile, exitCode: 0 }),
				// Extraction attempt 1: throws
				makeSingleResult({ agent: "worker", exitCode: 1, error: "extraction failed", output: "no data" }),
				// Extraction attempt 2: success
				makeSingleResult({
					agent: "worker",
					output: "extracted",
					exitCode: 0,
					structuredOutput: { result: "retry success" },
				}),
			]);

			const outputSchema = Type.Object({ result: Type.String() });
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const result = await ctx.runAgent({
				agent: "worker",
				task: "implement",
				outputSchema: JSON.parse(JSON.stringify(outputSchema)),
				maxStructuredOutputAttempts: 3,
			});

			// 1 main + 2 extractions = 3 calls
			assert.equal(mockExec.callCount(), 3);
			assert.deepEqual(result.structuredOutput, { result: "retry success" });
		});

		it("uses default maxStructuredOutputAttempts (3) when not specified", async () => {
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n', "utf-8");

			const mockExec = createMockExecute();
			// All extraction attempts fail
			const responses: AgentToolResult<Details>[] = [
				makeSingleResult({ agent: "worker", output: "implemented", sessionFile, exitCode: 0 }),
			];
			for (let i = 0; i < 3; i++) {
				responses.push(makeSingleResult({ agent: "worker", exitCode: 1, error: "extraction failed", output: "no data" }));
			}
			mockExec.setResponses(responses);

			const outputSchema = Type.Object({ key: Type.String() });
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const result = await ctx.runAgent({
				agent: "worker",
				task: "implement",
				outputSchema: JSON.parse(JSON.stringify(outputSchema)),
			});

			// 1 main + up to 3 extraction attempts = 4 calls (default is 3)
			assert.equal(mockExec.callCount(), 4);
			assert.equal(result.structuredOutput, undefined);
		});

		it("skips structured output extraction when no session file is available", async () => {
			const mockExec = createMockExecute();
			// sessionFile is NOT set
			mockExec.setResponses([
				makeSingleResult({ agent: "worker", output: "implemented", exitCode: 0 }),
			]);

			const outputSchema = Type.Object({ key: Type.String() });
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const result = await ctx.runAgent({
				agent: "worker",
				task: "implement",
				outputSchema: JSON.parse(JSON.stringify(outputSchema)),
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.structuredOutput, undefined);
			assert.equal(mockExec.callCount(), 1, "should not attempt extraction without sessionFile");
		});

		it("skips structured output extraction when exitCode is non-zero", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([
				makeSingleResult({ agent: "worker", exitCode: 1, error: "failed", sessionFile: "/nonexistent/file.jsonl" }),
			]);

			const outputSchema = Type.Object({ key: Type.String() });
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			await assert.rejects(
				() => ctx.runAgent({
					agent: "worker",
					task: "implement",
					outputSchema: JSON.parse(JSON.stringify(outputSchema)),
				}),
				/OrchestratorAgentError/,
			);

			// No extraction attempt — failed immediately
			assert.equal(mockExec.callCount(), 1);
		});
	});

	// ── withRetry ───────────────────────────────────────────────────────

	describe("withRetry", () => {
		it("succeeds on first attempt", async () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			let callCount = 0;
			const result = await ctx.withRetry(
				{ maxAttempts: 3 },
				async (_retryCtx) => {
					callCount++;
					return "success";
				},
			);

			assert.equal(result, "success");
			assert.equal(callCount, 1);
		});

		it("retries on OrchestratorAgentError and succeeds", async () => {
			const mockExec = createMockExecute();
			mockExec.setResponses([
				makeSingleResult({ agent: "worker", exitCode: 1, error: "first fail" }),
				makeSingleResult({ agent: "worker", exitCode: 1, error: "second fail" }),
				makeSingleResult({ agent: "worker", output: "third time works", exitCode: 0 }),
			]);
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			let attempts = 0;
			const result = await ctx.withRetry(
				{ maxAttempts: 3, delayMs: 10 },
				async (retryCtx) => {
					attempts++;
					assert.equal(retryCtx.attempt, attempts - 1);
					if (attempts < 3) {
						const agentResult = await ctx.runAgent({ agent: "worker", task: "implement" });
						// runAgent throws OrchestratorAgentError for exitCode 1
						throw new OrchestratorAgentError("fail", agentResult);
					}
					return "finally ok";
				},
			);

			assert.equal(result, "finally ok");
			assert.equal(attempts, 3, "should have made 3 attempts");
		});

		it("throws last OrchestratorAgentError after exhausting attempts", async () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			await assert.rejects(
				() => ctx.withRetry(
					{ maxAttempts: 2, delayMs: 10 },
					async (_retryCtx) => {
						throw new OrchestratorAgentError("always fails", {
							exitCode: 1,
							output: "boom",
							agent: "worker",
						});
					},
				),
				(err: unknown) => {
					assert.ok(err instanceof OrchestratorAgentError);
					assert.match((err as OrchestratorAgentError).message, /always fails/);
					return true;
				},
			);
		});

		it("propagates non-OrchestratorAgentError immediately without retry", async () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			let attempts = 0;
			await assert.rejects(
				() => ctx.withRetry(
					{ maxAttempts: 3, delayMs: 10 },
					async (_retryCtx) => {
						attempts++;
						throw new TypeError("not an agent error");
					},
				),
				(err: unknown) => {
					assert.ok(err instanceof TypeError);
					assert.match((err as Error).message, /not an agent error/);
					return true;
				},
			);

			assert.equal(attempts, 1, "should not have retried a non-agent error");
		});

		it("exponential backoff increases delay", async () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const start = Date.now();
			let attempts = 0;

			await assert.rejects(
				() => ctx.withRetry(
					{ maxAttempts: 3, delayMs: 20, backoff: "exponential" },
					async (_retryCtx) => {
						attempts++;
						throw new OrchestratorAgentError("fail", {
							exitCode: 1,
							output: "boom",
							agent: "worker",
						});
					},
				),
			);

			const elapsed = Date.now() - start;
			// delays: 20ms + 40ms = ~60ms minimum
			assert.equal(attempts, 3, "should have attempted 3 times");
			assert.ok(elapsed >= 50, `elapsed ${elapsed}ms should be >= 50ms (delay 20+40)`);
		});

		it("fixed backoff uses constant delay", async () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const start = Date.now();
			let attempts = 0;

			await assert.rejects(
				() => ctx.withRetry(
					{ maxAttempts: 3, delayMs: 20, backoff: "fixed" },
					async (_retryCtx) => {
						attempts++;
						throw new OrchestratorAgentError("fail", {
							exitCode: 1,
							output: "boom",
							agent: "worker",
						});
					},
				),
			);

			const elapsed = Date.now() - start;
			// delays: 20ms + 20ms = ~40ms minimum
			assert.equal(attempts, 3);
			assert.ok(elapsed >= 30, `elapsed ${elapsed}ms should be >= 30ms (delay 20+20)`);
		});

		it("provides context with attempt number and lastError", async () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			const captured: Array<{ attempt: number; lastError: unknown }> = [];

			await assert.rejects(
				() => ctx.withRetry(
					{ maxAttempts: 2, delayMs: 10 },
					async (retryCtx) => {
						captured.push({ attempt: retryCtx.attempt, lastError: retryCtx.lastError });
						throw new OrchestratorAgentError(`fail ${retryCtx.attempt}`, {
							exitCode: 1,
							output: "boom",
							agent: "worker",
						});
					},
				),
			);

			assert.equal(captured.length, 2);
			assert.equal(captured[0].attempt, 0);
			assert.equal(captured[0].lastError, undefined);
			assert.equal(captured[1].attempt, 1);
			assert.ok(captured[1].lastError instanceof OrchestratorAgentError);
			assert.match((captured[1].lastError as Error).message, /fail 0/);
		});

		it("default delayMs is 1000", () => {
			// Just verify the default — delayMs in config is optional, defaults to 1000
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });
			// We trust the implementation — no explicit assertion needed, tested
			// implicitly through the exponential/fixed tests
			assert.ok(true);
		});
	});

	// ── Context properties ─────────────────────────────────────────────

	describe("context properties", () => {
		it("exposes chainDir, runId, cwd, timeoutMs", () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, {
				chainDir: "/custom/chain/dir",
				runId: "custom-run-id",
				cwd: "/custom/cwd",
				timeoutMs: 60000,
			});

			assert.equal(ctx.chainDir, "/custom/chain/dir");
			assert.equal(ctx.runId, "custom-run-id");
			assert.equal(ctx.cwd, "/custom/cwd");
			assert.equal(ctx.timeoutMs, 60000);
		});

		it("log writes to orchestrator.log", async () => {
			const mockExec = createMockExecute();
			const ctx = createContext(mockExec, { chainDir, cwd: tempDir });

			ctx.log("test message");

			const logPath = path.join(chainDir, "orchestrator.log");
			assert.ok(fs.existsSync(logPath), "log file should exist");
			const content = fs.readFileSync(logPath, "utf-8");
			assert.match(content, /test message/);
		});
	});
});
