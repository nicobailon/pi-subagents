import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationAcceptance,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../../src/api/delegation.ts";
import { parseSubagentDelegationRequest } from "../../src/slash/delegation-request.ts";
import {
	registerPromptTemplateDelegationBridge,
	type PromptTemplateBridgeEvents,
} from "../../src/slash/prompt-template-bridge.ts";

class FakeEvents implements PromptTemplateBridgeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => this.handlers.set(event, (this.handlers.get(event) ?? []).filter((entry) => entry !== handler));
	}

	emit(event: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const acceptance: SubagentDelegationAcceptance = {
	level: "verified",
	criteria: [{ id: "criterion-1", must: "Verify the result", evidence: ["validation-output"], severity: "required" }],
	evidence: ["commands-run", "validation-output"],
	verify: [{ id: "test", command: "npm test", timeoutMs: 1_000, cwd: "/repo", env: { CI: "true" }, allowFailure: false }],
	review: { agent: "reviewer", focus: "correctness", required: false },
	stopRules: ["Stop on verification failure"],
	reason: "Explicit verification contract",
};

const request: SubagentDelegationRequest = {
	version: 1,
	requestId: "delegation-1",
	agent: "reviewer",
	task: "Review evidence",
	context: "fresh",
	cwd: "/repo",
	model: "openai/gpt-5",
	timeoutMs: 1_000,
	turnBudget: { maxTurns: 4, graceTurns: 1 },
	toolBudget: { soft: 3, hard: 5, block: "*" },
	skill: ["review"],
	output: "result.md",
	outputMode: "file-only",
	acceptance: "checked",
	artifacts: true,
};

const outputSchema = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["ok"] },
		findings: { type: "array", items: { type: "string" } },
	},
	required: ["status", "findings"],
	additionalProperties: false,
};

describe("public subagent delegation contract", () => {
	it("uses the existing prompt-template event family as the only transport", () => {
		assert.equal(SUBAGENT_DELEGATION_PROTOCOL_VERSION, 1);
		assert.equal(SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
		assert.equal(SUBAGENT_DELEGATION_STARTED_EVENT, "prompt-template:subagent:started");
		assert.equal(SUBAGENT_DELEGATION_UPDATE_EVENT, "prompt-template:subagent:update");
		assert.equal(SUBAGENT_DELEGATION_RESPONSE_EVENT, "prompt-template:subagent:response");
		assert.equal(SUBAGENT_DELEGATION_CANCEL_EVENT, "prompt-template:subagent:cancel");
	});

	it("strictly parses the complete v1 request", () => {
		assert.deepEqual(parseSubagentDelegationRequest(request), { ok: true, request });
		const requestWithAcceptance = { ...request, acceptance };
		assert.deepEqual(parseSubagentDelegationRequest(requestWithAcceptance), { ok: true, request: requestWithAcceptance });
	});

	it("accepts a caller-owned output schema on the public foreground request", () => {
		const structuredRequest = { ...request, outputSchema };
		assert.deepEqual(parseSubagentDelegationRequest(structuredRequest), {
			ok: true,
			request: structuredRequest,
		});
	});

	it("rejects unsupported versions, unknown fields, aliases, and malformed controls", () => {
		const malformed = [
			[{ ...request, version: 2 }, /Unsupported delegation protocol version/],
			[{ ...request, tools: ["write"] }, /Unsupported delegation field: tools/],
			[{ ...request, maxRuntimeMs: 1_000 }, /Unsupported delegation field: maxRuntimeMs/],
			[{ ...request, timeoutMs: 0 }, /timeoutMs must be an integer >= 1/],
			[{ ...request, turnBudget: { maxTurns: 0 } }, /turnBudget.maxTurns/],
			[{ ...request, turnBudget: { maxTurns: 1, extra: true } }, /turnBudget.extra is not supported/],
			[{ ...request, toolBudget: { hard: 1, soft: 2 } }, /toolBudget.soft must be <=/],
			[{ ...request, toolBudget: { hard: 1, extra: true } }, /toolBudget.extra is not supported/],
			[{ ...request, outputSchema: { type: "not-a-json-schema-type" } }, /invalid outputSchema/],
			[{ ...request, outputSchema: { type: "string", enum: "ok" } }, /outputSchema\.enum must be a non-empty array/],
			[{ ...request, outputSchema: { type: "object", required: "id" } }, /outputSchema\.required must be an array of unique strings/],
			[{ ...request, outputSchema: { type: "array", minItems: -1 } }, /outputSchema\.minItems must be a non-negative integer/],
			[{ ...request, outputSchema: { type: "array", uniqueItems: "yes" } }, /outputSchema\.uniqueItems must be a boolean/],
			[{ ...request, outputSchema: { type: "string", pattern: "[" } }, /outputSchema\.pattern must be a valid regular expression/],
			[{ ...request, outputSchema: { type: "object", properties: { value: { type: "string", enum: "ok" } } } }, /outputSchema\.properties\.value\.enum/],
			[{ ...request, skill: [] }, /skill must/],
			[{ ...request, output: "" }, /output must/],
			[{ ...request, output: false, outputMode: "file-only" }, /outputMode.*output.*path/],
			[{ ...request, acceptance: "none" }, /level "none" requires a reason/],
			[{ ...request, acceptance: { level: "none" } }, /reason is required/],
			[{ ...request, artifacts: "yes" }, /artifacts must be a boolean/],
		] as const;
		for (const [input, expected] of malformed) {
			const parsed = parseSubagentDelegationRequest(input);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, expected);
		}
	});

	it("runs one v1 request through the existing executor and returns structured metadata", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		let observedRequest: unknown;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, delegatedRequest, _signal, _ctx, onUpdate) => {
				executeCalls++;
				observedRequest = delegatedRequest;
				onUpdate({
					details: {
						mode: "single",
						results: [{ agent: "reviewer", model: "openai/gpt-5" }],
						progress: [{ index: 0, agent: "reviewer", currentTool: "read", recentOutput: ["line 1"], recentTools: [], toolCount: 1, tokens: 42, durationMs: 10 }],
					},
				});
				return {
					details: {
						mode: "single",
						runId: "run-1",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							model: "openai/gpt-5",
							finalOutput: "done",
							savedOutputPath: "/repo/result.md",
							sessionFile: "/tmp/session.jsonl",
							usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 },
							progressSummary: { toolCount: 4, tokens: 5, durationMs: 6 },
							acceptance: { status: "checked", explicit: true },
							skillsWarning: "Skills not found: review",
						}],
					},
				};
			},
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		const updatePromise = once(events, SUBAGENT_DELEGATION_UPDATE_EVENT);
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);

		assert.deepEqual(await startedPromise, { version: 1, requestId: "delegation-1" });
		assert.deepEqual(await updatePromise, {
			version: 1,
			requestId: "delegation-1",
			currentTool: "read",
			recentOutput: "line 1",
			recentOutputLines: ["line 1"],
			model: "openai/gpt-5",
			toolCount: 1,
			durationMs: 10,
			tokens: 42,
		});
		const response = await responsePromise as SubagentDelegationResponse;
		assert.equal(executeCalls, 1);
		assert.deepEqual(observedRequest, {
			agent: "reviewer",
			task: "Review evidence",
			context: "fresh",
			cwd: "/repo",
			model: "openai/gpt-5",
			timeoutMs: 1_000,
			turnBudget: { maxTurns: 4, graceTurns: 1 },
			enforceHardTurnLimit: true,
			toolBudget: { soft: 3, hard: 5, block: "*" },
			skill: ["review"],
			output: "result.md",
			outputMode: "file-only",
			acceptance: "checked",
			artifacts: true,
			async: false,
			foregroundOnly: true,
			clarify: false,
		});
		assert.equal(response.status, "completed");
		assert.equal(response.runId, "run-1");
		assert.equal(response.agent, "reviewer");
		assert.equal(response.output, "done");
		assert.equal(response.outputPath, "/repo/result.md");
		assert.equal(response.sessionFile, "/tmp/session.jsonl");
		assert.equal(response.turns, 2);
		assert.equal(response.toolCount, 4);
		assert.equal(response.tokens, 5);
		assert.deepEqual(response.acceptance, { status: "checked", explicit: true });
		assert.deepEqual(response.warnings, ["Skills not found: review"]);
		bridge.dispose();
	});

	it("returns the runtime-validated structured value through the public response", async () => {
		const events = new FakeEvents();
		let observedRequest: unknown;
		const value = { status: "ok", findings: ["contract preserved"] };
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, delegatedRequest) => {
				observedRequest = delegatedRequest;
				return {
					details: {
						mode: "single",
						runId: "structured-run",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							finalOutput: "Structured output captured.",
							structuredOutput: value,
							usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cost: 0.01, turns: 2 },
							progressSummary: { toolCount: 1, tokens: 18, durationMs: 20 },
						}],
					},
				};
			},
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "structured-1", outputSchema });
		const response = await responsePromise as SubagentDelegationResponse & {
			structuredOutput?: unknown;
			usage?: Record<string, number>;
		};

		assert.deepEqual((observedRequest as { outputSchema?: unknown }).outputSchema, outputSchema);
		assert.equal(response.status, "completed");
		assert.deepEqual(response.structuredOutput, value);
		assert.deepEqual(response.usage, {
			inputTokens: 11,
			outputTokens: 7,
			cacheReadTokens: 5,
			cacheWriteTokens: 3,
			costUsd: 0.01,
			turns: 2,
			toolCalls: 1,
		});
		bridge.dispose();
	});

	it("returns a dedicated terminal failure for invalid or missing structured output", async () => {
		for (const error of [
			"Structured output validation failed: status: Expected required property",
			"Missing structured_output call; this step has outputSchema and must finish by calling structured_output.",
		]) {
			const events = new FakeEvents();
			const bridge = registerPromptTemplateDelegationBridge({
				events,
				getContext: () => ({ cwd: "/repo" }),
				execute: async () => ({
					isError: true,
					details: {
						mode: "single",
						results: [{
							agent: "reviewer",
							exitCode: 1,
							error,
							structuredOutputFailed: true,
							usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cost: 0.01, turns: 2 },
							progressSummary: { toolCount: 0, tokens: 18, durationMs: 20 },
						}],
					},
				}),
			});
			const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: `structured-failure-${Math.random()}`, outputSchema });
			const response = await responsePromise as SubagentDelegationResponse;
			assert.equal(response.status, "structured_output_failed");
			assert.equal(response.error, error);
			assert.notEqual(response.status, "completed");
			bridge.dispose();
		}
	});

	it("returns correlated invalid-request and unavailable-context statuses without executing", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		let startedCount = 0;
		events.on(SUBAGENT_DELEGATION_STARTED_EVENT, () => { startedCount++; });
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => null,
			execute: async () => {
				executeCalls++;
				return { details: { mode: "single", results: [] } };
			},
		});
		const invalidPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, version: 2, requestId: "invalid-1" });
		assert.deepEqual(await invalidPromise, {
			version: 1,
			requestId: "invalid-1",
			status: "invalid_request",
			error: "Unsupported delegation protocol version: 2.",
		});

		for (const [index, outputSchema] of [{ type: "string", enum: "ok" }, { type: "object", required: "id" }].entries()) {
			const malformedPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: `malformed-schema-${index}`, outputSchema });
			const malformed = await malformedPromise as SubagentDelegationResponse;
			assert.equal(malformed.status, "invalid_request");
		}

		const unavailablePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "unavailable-1" });
		const unavailable = await unavailablePromise as SubagentDelegationResponse;
		assert.equal(unavailable.status, "unavailable_context");
		assert.equal(executeCalls, 0);
		assert.equal(startedCount, 0);
		bridge.dispose();
	});

	it("maps terminal executor outcomes without failing inferred acceptance", async () => {
		const cases = [
			[{ timedOut: true }, "timed_out"],
			[{ interrupted: true }, "interrupted"],
			[{ stopped: true }, "interrupted"],
			[{ turnBudgetExceeded: true }, "turn_budget_exhausted"],
			[{ toolBudgetBlocked: true }, "tool_budget_exhausted"],
			[{ acceptance: { status: "rejected", explicit: true } }, "acceptance_failed"],
			[{ acceptance: { status: "rejected", explicit: false } }, "completed"],
			[{ exitCode: 1, error: "failed" }, "failed"],
		] as const;
		for (const [child, expectedStatus] of cases) {
			const events = new FakeEvents();
			const bridge = registerPromptTemplateDelegationBridge({
				events,
				getContext: () => ({ cwd: "/repo" }),
				execute: async () => ({
					isError: expectedStatus !== "completed",
					details: {
						mode: "single",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							...child,
						}],
					},
				}),
			});
			const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: `case-${expectedStatus}-${Math.random()}` });
			assert.equal((await responsePromise as SubagentDelegationResponse).status, expectedStatus);
			bridge.dispose();
		}
	});

	it("preserves terminal evidence for turn and tool budget exhaustion", async () => {
		for (const [child, expectedStatus] of [
			[{ turnBudgetExceeded: true, error: "turn limit reached" }, "turn_budget_exhausted"],
			[{ toolBudgetBlocked: true, error: "tool limit reached" }, "tool_budget_exhausted"],
		] as const) {
			const events = new FakeEvents();
			const bridge = registerPromptTemplateDelegationBridge({
				events,
				getContext: () => ({ cwd: "/repo" }),
				execute: async () => ({
					isError: true,
					details: {
						mode: "single",
						runId: `run-${expectedStatus}`,
						results: [{
							agent: "reviewer",
							exitCode: 1,
							finalOutput: "partial output",
							sessionFile: "/tmp/session.jsonl",
							usage: { input: 13, output: 8, cacheRead: 5, cacheWrite: 2, cost: 0.02, turns: 3 },
							progressSummary: { toolCount: 4, tokens: 21, durationMs: 30 },
							skillsWarning: "warning retained",
							...child,
						}],
					},
				}),
			});
			const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: `budget-${expectedStatus}` });
			const response = await responsePromise as SubagentDelegationResponse & { usage?: Record<string, number> };
			assert.equal(response.status, expectedStatus);
			assert.equal(response.output, "partial output");
			assert.equal(response.sessionFile, "/tmp/session.jsonl");
			assert.deepEqual(response.warnings, ["warning retained"]);
			assert.equal(response.usage?.cacheReadTokens, 5);
			assert.equal(response.usage?.cacheWriteTokens, 2);
			bridge.dispose();
		}
	});

	it("emits exactly one correlated terminal event and suppresses late updates", async () => {
		const events = new FakeEvents();
		const started: unknown[] = [];
		const updates: unknown[] = [];
		const terminals: unknown[] = [];
		let lateUpdate: ((result: { details: { mode: "single"; progress: Array<{ agent: string; toolCount: number }> } }) => void) | undefined;
		events.on(SUBAGENT_DELEGATION_STARTED_EVENT, (payload) => started.push(payload));
		events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (payload) => updates.push(payload));
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => terminals.push(payload));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, _params, _signal, _ctx, onUpdate) => {
				lateUpdate = onUpdate as typeof lateUpdate;
				return { details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, finalOutput: "done" }] } };
			},
		});
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "terminal-once" });
		await tick();
		lateUpdate?.({ details: { mode: "single", progress: [{ agent: "reviewer", toolCount: 99 }] } });
		await tick();

		assert.deepEqual(started, [{ version: 1, requestId: "terminal-once" }]);
		assert.equal(terminals.length, 1);
		assert.equal((terminals[0] as SubagentDelegationResponse).requestId, "terminal-once");
		assert.equal(updates.length, 0);
		bridge.dispose();
	});

	it("ignores malformed versioned cancellation without aborting the owner", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_id, _params, signal) => await new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		const responses: unknown[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload));
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "strict-cancel-1" });
		await startedPromise;
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "strict-cancel-1" });
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: "strict-cancel-1", reason: "extra" });
		await tick();
		assert.deepEqual(responses, []);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: "strict-cancel-1" });
		await tick();
		assert.equal((responses[0] as SubagentDelegationResponse).status, "cancelled");
		bridge.dispose();
	});

	it("preserves active request ownership when a duplicate requestId arrives", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		let finish: (() => void) | undefined;
		const responses: unknown[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				executeCalls++;
				await new Promise<void>((resolve) => { finish = resolve; });
				return { details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] } };
			},
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "duplicate-1" });
		await startedPromise;
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "duplicate-1" });
		await tick();
		assert.equal(executeCalls, 1);
		assert.equal(responses.length, 0);
		finish?.();
		await tick();
		assert.equal(responses.length, 1);
		assert.equal((responses[0] as SubagentDelegationResponse).status, "completed");
		bridge.dispose();
	});

	it("bounds pending cancellation IDs and applies retained pre-cancellation once", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				executeCalls++;
				return { details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }] } };
			},
		});
		for (let index = 0; index < 300; index++) {
			events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: `cancel-${index}` });
		}

		const evictedPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "cancel-0" });
		assert.equal((await evictedPromise as SubagentDelegationResponse).status, "completed");

		const retainedPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "cancel-299" });
		assert.equal((await retainedPromise as SubagentDelegationResponse).status, "cancelled");
		assert.equal(executeCalls, 1);
		bridge.dispose();
	});

	it("suppresses stale terminal events after disposal", async () => {
		const events = new FakeEvents();
		const responses: unknown[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload));
		let rejectExecution: ((error: Error) => void) | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => await new Promise((_resolve, reject) => { rejectExecution = reject; }),
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "dispose-1" });
		await startedPromise;
		bridge.dispose();
		rejectExecution?.(new Error("aborted"));
		await tick();
		assert.deepEqual(responses, []);
	});
});
