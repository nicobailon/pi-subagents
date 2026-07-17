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
	report: {
		criteria: [{ id: "criterion-1", must: "Verify the result", evidence: ["validation-output"], severity: "required" }],
		evidence: ["commands-run", "validation-output"],
	},
	verify: [{ id: "test", command: "npm test", timeoutMs: 1_000, cwd: "/repo", env: { CI: "true" }, allowFailure: false }],
	review: { agent: "reviewer", focus: "correctness", required: false },
	onFailure: "warn",
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
			[{ ...request, skill: [] }, /skill must/],
			[{ ...request, output: "" }, /output must/],
			[{ ...request, output: false, outputMode: "file-only" }, /outputMode.*output.*path/],
			[{ ...request, acceptance: { report: false, level: "checked" } }, /cannot mix legacy and canonical/],
			[{ ...request, acceptance: { report: false, surprise: true } }, /surprise is not supported/],
			[{ ...request, artifacts: "yes" }, /artifacts must be a boolean/],
		] as const;
		for (const [input, expected] of malformed) {
			const parsed = parseSubagentDelegationRequest(input);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, expected);
		}
	});

	it("accepts false and deprecated bare none as disabled acceptance", () => {
		assert.equal(parseSubagentDelegationRequest({ ...request, acceptance: false }).ok, true);
		assert.equal(parseSubagentDelegationRequest({ ...request, acceptance: "none" }).ok, true);
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

	it("returns correlated invalid-request and unavailable-context statuses without executing", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
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

		const unavailablePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "unavailable-1" });
		const unavailable = await unavailablePromise as SubagentDelegationResponse;
		assert.equal(unavailable.status, "unavailable_context");
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("maps terminal executor outcomes using the acceptance failure policy", async () => {
		const rejected = (explicit: boolean, onFailure: "fail" | "warn", deprecationWarnings: string[] = []) => ({
			status: "rejected" as const,
			explicit,
			effectiveAcceptance: { onFailure, deprecationWarnings },
		});
		const cases = [
			[{ timedOut: true }, "timed_out"],
			[{ interrupted: true }, "interrupted"],
			[{ stopped: true }, "interrupted"],
			[{ turnBudgetExceeded: true }, "turn_budget_exhausted"],
			[{ toolBudgetBlocked: true }, "tool_budget_exhausted"],
			[{ acceptance: rejected(true, "fail") }, "acceptance_failed"],
			[{ acceptance: rejected(true, "warn", ['Acceptance level "none" is deprecated; use acceptance: false.']) }, "completed"],
			[{ acceptance: rejected(false, "fail") }, "completed"],
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
			const response = await responsePromise as SubagentDelegationResponse;
			assert.equal(response.status, expectedStatus);
			if ("acceptance" in child && child.acceptance?.effectiveAcceptance.deprecationWarnings.length) {
				assert.deepEqual(response.warnings, child.acceptance.effectiveAcceptance.deprecationWarnings);
			}
			bridge.dispose();
		}
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
