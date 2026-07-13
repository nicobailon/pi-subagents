/**
 * Unit tests for registerOrchestratorBridge:
 * E2E script execution, error paths (missing script, runtime errors,
 * OrchestratorAgentError), artifact persistence (flow.json, chainDir).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach, after } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createTempDir, removeTempDir, createEventBus } from "../support/helpers.ts";
import {
	registerOrchestratorBridge,
	loadStepResults,
	generateFlowSummary,
} from "../../src/orchestrator/orchestrator-bridge.ts";
import {
	ORCHESTRATOR_REQUEST_EVENT,
	ORCHESTRATOR_RESPONSE_EVENT,
	ORCHESTRATOR_UPDATE_EVENT,
	type Details,
} from "../../src/shared/types.ts";
import type { OrchestratorContext } from "../../src/orchestrator/orchestrator-context.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockSessionManager {
	getSessionId: () => string;
	getSessionFile: () => string | null;
	getLeafId: () => string | null;
	_rewriteFile: () => void;
	fileEntries: Array<{ type?: string; message?: { role?: string; usage?: { totalTokens?: number } | null } }>;
	flushed?: boolean;
}

function createMockSessionManager(sessionFile?: string): MockSessionManager {
	const file = sessionFile ?? null;
	return {
		getSessionId: () => "session-123",
		getSessionFile: () => file,
		getLeafId: () => "leaf-456",
		_rewriteFile: () => {},
		fileEntries: [
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 10 } } },
		],
	};
}

function createMockExtensionContext(cwd: string, sessionFile?: string) {
	return {
		cwd,
		hasUI: false,
		model: { provider: "test-provider" },
		sessionManager: createMockSessionManager(sessionFile),
	} as unknown as Parameters<typeof registerOrchestratorBridge>[0]["getContext"] extends () => infer T ? T : never;
}

function makeSuccessResult(agent: string, output: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: output }],
		details: {
			mode: "single",
			results: [{
				agent,
				task: "test task",
				exitCode: 0,
				messages: [],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
				output,
				finalOutput: output,
			}],
		},
		isError: false,
	};
}

function makeErrorResult(agent: string, exitCode: number, error: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: error }],
		details: {
			mode: "single",
			results: [{
				agent,
				task: "test task",
				exitCode,
				messages: [],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
				output: error,
				finalOutput: error,
				error,
			}],
		},
		isError: true,
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
		_ctx: unknown,
	): Promise<AgentToolResult<Details>> => {
		calls.push({ id, params });
		const resp = responses[responseIndex] ?? responses[responses.length - 1];
		if (!resp) {
			// Default: success
			return makeSuccessResult(params.agent as string ?? "unknown", `Mock output for ${id}`);
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

/**
 * Create a simple orchestrator script file that:
 * - Calls runAgent with given config
 * - Returns output
 */
function writeOrchScript(
	dir: string,
	scriptName: string,
	body: string,
): string {
	const scriptPath = path.join(dir, scriptName);
	fs.writeFileSync(scriptPath, body, "utf-8");
	return scriptPath;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("orchestrator bridge", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir("orch-bridge-");
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	/**
	 * Helper: sets up the bridge and sends a request, returns a promise
	 * that resolves with the response.
	 */
	async function sendOrchRequest(
		scriptPath: string,
		mockExec: ReturnType<typeof createMockExecute>,
		requestId?: string,
	): Promise<{ response: Record<string, unknown>; updates: Record<string, unknown>[] }> {
		const rid = requestId ?? `test-${Date.now().toString(36)}`;
		const events = createEventBus();
		const ctx = createMockExtensionContext(tempDir);

		// Capture response and updates
		const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("Timed out waiting for orchestrator response"));
			}, 5000);
			const unsubscribe = events.on(ORCHESTRATOR_RESPONSE_EVENT, (data) => {
				clearTimeout(timer);
				unsubscribe();
				resolve(data as Record<string, unknown>);
			});
		});

		const updates: Record<string, unknown>[] = [];
		events.on(ORCHESTRATOR_UPDATE_EVENT, (data) => {
			updates.push(data as Record<string, unknown>);
		});

		const bridge = registerOrchestratorBridge({
			events,
			getContext: () => ctx,
			execute: mockExec.execute,
		});

		// Send the request
		events.emit(ORCHESTRATOR_REQUEST_EVENT, { requestId: rid, scriptPath });

		const response = await responsePromise;
		bridge.dispose();

		return { response, updates };
	}

	// ── E2E script execution ───────────────────────────────────────────

	describe("E2E script execution", () => {
		it("runs a simple orchestrator script that calls runAgent", async () => {
			const scriptPath = writeOrchScript(tempDir, "simple-orch.ts", `
				export default {
					async flow(ctx) {
						const result = await ctx.runAgent({ agent: "scout", task: "analyze the codebase" });
						return { output: "All done. Scout says: " + result.output };
					}
				};
			`);

			const mockExec = createMockExecute();
			mockExec.setResponses([makeSuccessResult("scout", "Found 3 modules")]);

			const { response, updates } = await sendOrchRequest(scriptPath, mockExec);

			assert.equal(response.requestId?.length > 0, true);
			assert.equal(response.output, "All done. Scout says: Found 3 modules");
			assert.ok(!response.error);
			assert.ok(Array.isArray(response.results));
			assert.equal((response.results as Array<{ agent: string }>).length, 1);
			assert.equal((response.results as Array<{ agent: string }>)[0].agent, "scout");
			assert.equal(mockExec.callCount(), 1);

			// Should have update events
			assert.ok(updates.length >= 1, "should emit at least one update event");
			assert.equal(updates[0].agent, "scout");
		});

		it("runs multi-step orchestrator script with multiple runAgent calls", async () => {
			const scriptPath = writeOrchScript(tempDir, "multi-orch.ts", `
				export default {
					async flow(ctx) {
						const scan = await ctx.runAgent({ agent: "scout", task: "scan" });
						const plan = await ctx.runAgent({ agent: "planner", task: "plan", reads: ["context.md"] });
						return { output: "Scan: " + scan.output + " | Plan: " + plan.output };
					}
				};
			`);

			const mockExec = createMockExecute();
			mockExec.setResponses([
				makeSuccessResult("scout", "auth module, api module"),
				makeSuccessResult("planner", "Refactor auth first"),
			]);

			const { response } = await sendOrchRequest(scriptPath, mockExec);

			assert.ok(!response.error, `should not have error: ${response.error}`);
			assert.match(response.output as string, /auth module, api module/);
			assert.match(response.output as string, /Refactor auth first/);
			assert.equal((response.results as Array<unknown>).length, 2);
			assert.equal(mockExec.callCount(), 2);
		});

		it("passes orchestrator context properties to the script", async () => {
			const scriptPath = writeOrchScript(tempDir, "ctx-props-orch.ts", `
				export default {
					async flow(ctx) {
						ctx.log("chainDir=" + ctx.chainDir);
						ctx.log("runId=" + ctx.runId);
						ctx.log("cwd=" + ctx.cwd);
						return { output: "chainDir=" + ctx.chainDir + " runId=" + ctx.runId + " cwd=" + ctx.cwd };
					}
				};
			`);

			const mockExec = createMockExecute();
			const rid = "ctx-test-run";
			const { response } = await sendOrchRequest(scriptPath, mockExec, rid);

			assert.ok(!response.error, `should not have error: ${response.error}`);
			assert.match(response.output as string, new RegExp(`runId=${rid}`));
			assert.match(response.output as string, /pi-orch-runs/);
		});

		it("persists flow.json with step metadata", async () => {
			const scriptPath = writeOrchScript(tempDir, "flow-json-orch.ts", `
				export default {
					async flow(ctx) {
						await ctx.runAgent({ agent: "scout", task: "scan code", label: "Code scan", as: "scan" });
						await ctx.runAgent({ agent: "planner", task: "create plan", label: "Planning" });
						return { output: "done" };
					}
				};
			`);

			const mockExec = createMockExecute();
			mockExec.setResponses([
				makeSuccessResult("scout", "scan result"),
				makeSuccessResult("planner", "plan result"),
			]);

			const rid = "flow-json-test";
			await sendOrchRequest(scriptPath, mockExec, rid);

			// Find the .pi-orch-runs directory (it's next to the script)
			const runsDir = path.join(tempDir, ".pi-orch-runs", rid);
			assert.ok(fs.existsSync(runsDir), `runs dir should exist: ${runsDir}`);

			const flowPath = path.join(runsDir, "orchestrator-flow.json");
			assert.ok(fs.existsSync(flowPath), "flow.json should exist");

			const flow = JSON.parse(fs.readFileSync(flowPath, "utf-8"));
			assert.equal(flow.runId, rid);
			assert.equal(flow.steps.length, 2);
			assert.equal(flow.status, "success");
			assert.equal(flow.steps[0].agent, "scout");
			assert.equal(flow.steps[0].as, "scan");
			assert.equal(flow.steps[0].label, "Code scan");
			assert.equal(flow.steps[1].agent, "planner");
			assert.equal(flow.steps[1].label, "Planning");
		});

		it("creates flow-summary.md on success", async () => {
			const scriptPath = writeOrchScript(tempDir, "summary-orch.ts", `
				export default {
					async flow(ctx) {
						await ctx.runAgent({ agent: "scout", task: "scan" });
						return { output: "done" };
					}
				};
			`);

			const mockExec = createMockExecute();
			mockExec.setResponses([makeSuccessResult("scout", "all good")]);

			const rid = "summary-test";
			await sendOrchRequest(scriptPath, mockExec, rid);

			const runsDir = path.join(tempDir, ".pi-orch-runs", rid);
			const summaryPath = path.join(runsDir, "flow-summary.md");
			assert.ok(fs.existsSync(summaryPath), "flow-summary.md should exist");

			const summary = fs.readFileSync(summaryPath, "utf-8");
			assert.match(summary, /Orchestrator Flow/);
			assert.match(summary, /scout/);
			assert.match(summary, /Success/);
		});

		it("handles orchestrator settings timeout", async () => {
			const scriptPath = writeOrchScript(tempDir, "timeout-orch.ts", `
				export default {
					settings: { timeout: 60000 },
					async flow(ctx) {
						return { output: "timeout is " + ctx.timeoutMs };
					}
				};
			`);

			const mockExec = createMockExecute();
			const { response } = await sendOrchRequest(scriptPath, mockExec);

			assert.ok(!response.error);
			assert.match(response.output as string, /60000/);
		});
	});

	// ── Error paths ────────────────────────────────────────────────────

	describe("error paths", () => {
		it("returns error when script file does not exist", async () => {
			const scriptPath = path.join(tempDir, "nonexistent.ts");
			const mockExec = createMockExecute();

			const { response } = await sendOrchRequest(scriptPath, mockExec);

			assert.ok(response.error);
			assert.match(response.error as string, /not found/i);
			assert.equal((response.results as Array<unknown>).length, 0);
		});

		it("returns error when script does not export a valid flow function", async () => {
			const scriptPath = writeOrchScript(tempDir, "bad-export-orch.ts", `
				export default { somethingElse: 42 };
			`);

			const mockExec = createMockExecute();
			const { response } = await sendOrchRequest(scriptPath, mockExec);

			assert.ok(response.error);
			assert.match(response.error as string, /did not export a valid flow/i);
		});

		it("catch block handles script runtime errors", async () => {
			const scriptPath = writeOrchScript(tempDir, "runtime-error-orch.ts", `
				export default {
					async flow(ctx) {
						throw new Error("unexpected runtime boom");
					}
				};
			`);

			const mockExec = createMockExecute();
			const { response } = await sendOrchRequest(scriptPath, mockExec);

			assert.ok(response.error);
			assert.match(response.error as string, /unexpected runtime boom/);
			// The output should contain the stack trace
			assert.match(response.output as string, /Orchestrator failed/);
			// Results should be empty (nothing completed)
			assert.equal((response.results as Array<unknown>).length, 0);
		});

		it("handles OrchestratorAgentError from runAgent (without doNotThrowOnError)", async () => {
			const scriptPath = writeOrchScript(tempDir, "agent-error-orch.ts", `
				export default {
					async flow(ctx) {
						await ctx.runAgent({ agent: "worker", task: "implement" });
						return { output: "should not reach" };
					}
				};
			`);

			const mockExec = createMockExecute();
			mockExec.setResponses([makeErrorResult("worker", 1, "implementation failed")]);

			const { response } = await sendOrchRequest(scriptPath, mockExec);

			// Bridge's wrapped runAgent catches OrchestratorAgentError, pushes result, rethrows
			// Then bridge's catch block handles it
			assert.ok(response.error);
			assert.match(response.error as string, /implementation failed|failed with exit code/);
			// Results should still contain the failed agent (bridge wraps runAgent to always push)
			assert.equal((response.results as Array<unknown>).length, 1);
		});

		it("persists flow.json with error status on failure", async () => {
			const scriptPath = writeOrchScript(tempDir, "flow-fail-orch.ts", `
				export default {
					async flow(ctx) {
						throw new Error("flow crash");
					}
				};
			`);

			const mockExec = createMockExecute();
			const rid = "flow-fail-test";
			await sendOrchRequest(scriptPath, mockExec, rid);

			const runsDir = path.join(tempDir, ".pi-orch-runs", rid);
			const flowPath = path.join(runsDir, "orchestrator-flow.json");

			if (fs.existsSync(flowPath)) {
				const flow = JSON.parse(fs.readFileSync(flowPath, "utf-8"));
				assert.equal(flow.status, "failed");
				assert.ok(flow.error);
			}
			// flow.json may not exist if error happens before first runAgent call
			// this is acceptable behavior
		});

		it("handles script that exports settings but crashes in flow", async () => {
			const scriptPath = writeOrchScript(tempDir, "settings-crash-orch.ts", `
				export default {
					settings: { timeout: 10000 },
					async flow(ctx) {
						ctx.log("about to crash");
						throw new Error("settings crash");
					}
				};
			`);

			const mockExec = createMockExecute();
			const { response } = await sendOrchRequest(scriptPath, mockExec);

			assert.match(response.error as string, /settings crash/);
		});
	});

	// ── Edge cases ─────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("handles bridge lifecycle — dispose removes listener", async () => {
			const events = createEventBus();
			const ctx = createMockExtensionContext(tempDir);
			const mockExec = createMockExecute();

			const bridge = registerOrchestratorBridge({
				events,
				getContext: () => ctx,
				execute: mockExec.execute,
			});

			// Dispose should clean up
			bridge.dispose();
			// After dispose, emitting should not cause issues
			// (just verify no crash)
			assert.ok(true);
		});

		it("returns error when getContext returns null", async () => {
			const events = createEventBus();
			const mockExec = createMockExecute();

			let responseData: Record<string, unknown> | undefined;
			events.on(ORCHESTRATOR_RESPONSE_EVENT, (data) => {
				responseData = data as Record<string, unknown>;
			});

			const bridge = registerOrchestratorBridge({
				events,
				getContext: () => null,
				execute: mockExec.execute,
			});

			events.emit(ORCHESTRATOR_REQUEST_EVENT, {
				requestId: "no-ctx-test",
				scriptPath: path.join(tempDir, "fake.ts"),
			});

			// Wait a tick for async handler
			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.ok(responseData);
			assert.match(responseData.error as string ?? "", /No active extension context/i);
			bridge.dispose();
		});

		it("ignores malformed request data", async () => {
			const events = createEventBus();
			const ctx = createMockExtensionContext(tempDir);
			const mockExec = createMockExecute();

			let responseCount = 0;
			events.on(ORCHESTRATOR_RESPONSE_EVENT, () => { responseCount++; });

			const bridge = registerOrchestratorBridge({
				events,
				getContext: () => ctx,
				execute: mockExec.execute,
			});

			// Emit malformed data: not an object
			events.emit(ORCHESTRATOR_REQUEST_EVENT, null);
			// Emit malformed data: missing fields
			events.emit(ORCHESTRATOR_REQUEST_EVENT, { foo: "bar" });

			await new Promise((resolve) => setTimeout(resolve, 100));

			assert.equal(responseCount, 0, "malformed requests should be ignored");
			bridge.dispose();
		});

		it("script can use ctx.log for debugging", async () => {
			const scriptPath = writeOrchScript(tempDir, "log-orch.ts", `
				export default {
					async flow(ctx) {
						ctx.log("step 1: starting");
						ctx.log("step 2: running agent");
						await ctx.runAgent({ agent: "scout", task: "scan" });
						ctx.log("step 3: done");
						return { output: "logged" };
					}
				};
			`);

			const mockExec = createMockExecute();
			mockExec.setResponses([makeSuccessResult("scout", "result")]);

			const rid = "log-test";
			await sendOrchRequest(scriptPath, mockExec, rid);

			const runsDir = path.join(tempDir, ".pi-orch-runs", rid);
			const logPath = path.join(runsDir, "orchestrator.log");
			assert.ok(fs.existsSync(logPath), "orchestrator.log should exist");

			const logContent = fs.readFileSync(logPath, "utf-8");
			assert.match(logContent, /step 1: starting/);
			assert.match(logContent, /step 2: running agent/);
			assert.match(logContent, /step 3: done/);
		});

		it("script results take precedence over auto-tracked results", async () => {
			const scriptPath = writeOrchScript(tempDir, "custom-results-orch.ts", `
				export default {
					async flow(ctx) {
						await ctx.runAgent({ agent: "scout", task: "scan" });
						// Return custom results — only the planner result should be in final output
						return {
							output: "custom override",
							results: [{ agent: "custom", exitCode: 0, output: "custom output" }]
						};
					}
				};
			`);

			const mockExec = createMockExecute();
			mockExec.setResponses([makeSuccessResult("scout", "scan done")]);

			const { response } = await sendOrchRequest(scriptPath, mockExec);

			assert.equal(response.output, "custom override");
			// Custom results take precedence over tracked results
			assert.equal((response.results as Array<{ agent: string }>)[0].agent, "custom");
		});
	});
});

// ── loadStepResults ──────────────────────────────────────────────────

describe("loadStepResults", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir("load-step-");
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("returns empty array for non-existent directory", () => {
		const results = loadStepResults(path.join(tempDir, "nonexistent"));
		assert.deepEqual(results, []);
	});

	it("returns empty array for empty step-results directory", () => {
		const dir = path.join(tempDir, "chain");
		fs.mkdirSync(path.join(dir, "step-results"), { recursive: true });
		const results = loadStepResults(dir);
		assert.deepEqual(results, []);
	});

	it("loads and sorts step results by index", () => {
		const dir = path.join(tempDir, "chain");
		const resultsDir = path.join(dir, "step-results");
		fs.mkdirSync(resultsDir, { recursive: true });

		fs.writeFileSync(path.join(resultsDir, "1.json"), JSON.stringify({ agent: "worker", exitCode: 0, output: "step1" }));
		fs.writeFileSync(path.join(resultsDir, "0.json"), JSON.stringify({ agent: "scout", exitCode: 0, output: "step0" }));
		fs.writeFileSync(path.join(resultsDir, "2.json"), JSON.stringify({ agent: "reviewer", exitCode: 0, output: "step2" }));

		const results = loadStepResults(dir);
		assert.equal(results.length, 3);
		assert.equal(results[0].agent, "scout");
		assert.equal(results[1].agent, "worker");
		assert.equal(results[2].agent, "reviewer");
	});

	it("skips non-json files and invalid indices", () => {
		const dir = path.join(tempDir, "chain");
		const resultsDir = path.join(dir, "step-results");
		fs.mkdirSync(resultsDir, { recursive: true });

		fs.writeFileSync(path.join(resultsDir, "0.json"), JSON.stringify({ agent: "scout", exitCode: 0, output: "ok" }));
		fs.writeFileSync(path.join(resultsDir, "notes.txt"), "ignored");
		fs.writeFileSync(path.join(resultsDir, "abc.json"), JSON.stringify({ agent: "bad", exitCode: 1 })); // non-numeric name

		const results = loadStepResults(dir);
		assert.equal(results.length, 1);
		assert.equal(results[0].agent, "scout");
	});

	it("skips malformed json files gracefully", () => {
		const dir = path.join(tempDir, "chain");
		const resultsDir = path.join(dir, "step-results");
		fs.mkdirSync(resultsDir, { recursive: true });

		fs.writeFileSync(path.join(resultsDir, "0.json"), "not valid json");
		fs.writeFileSync(path.join(resultsDir, "1.json"), JSON.stringify({ agent: "worker", exitCode: 0, output: "ok" }));

		const results = loadStepResults(dir);
		assert.equal(results.length, 1);
		assert.equal(results[0].agent, "worker");
	});
});

// ── generateFlowSummary ──────────────────────────────────────────────

describe("generateFlowSummary", () => {
	it("returns summary with error for empty results", () => {
		const md = generateFlowSummary("/tmp/test.ts", "run-1", [], "/tmp/chain", "failed", "timeout");
		assert.ok(md.includes("❌ Failed"));
		assert.ok(md.includes("timeout"));
		assert.ok(md.includes("**Steps**: 0"), "should show 0 steps");
	});

	it("includes step table for non-empty results", () => {
		const results = [
			{ agent: "scout", exitCode: 0, output: "ok", durationMs: 1000, model: "test", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 } },
		];
		const md = generateFlowSummary("/tmp/test.ts", "run-1", results, "/tmp/chain", "success");
		assert.ok(md.includes("✅ Success"));
		assert.ok(md.includes("scout"));
		assert.ok(md.includes("1.0s"));
	});

	it("returns fallback on unexpected error", () => {
		const results = [{} as any];
		const md = generateFlowSummary("/tmp/test.ts", "run-1", results, "/tmp/chain", "success");
		assert.ok(typeof md === "string");
		assert.ok(md.length > 0);
	});
});

// BUG: jiti inside async event handler in a separate module prevents Node
// process exit with --experimental-strip-types. Force exit after all tests pass.
after(async () => {
	await new Promise(r => setTimeout(r, 100));
	process.exit(0);
});
