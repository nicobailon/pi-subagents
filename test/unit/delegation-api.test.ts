import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
} from "../../src/api/delegation.mjs";
import {
	registerPromptTemplateDelegationBridge,
	toSubagentDelegationExecutionParams,
	type PromptTemplateBridgeEvents,
} from "../../src/slash/prompt-template-bridge.ts";

class FakeEvents implements PromptTemplateBridgeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
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

const request: SubagentDelegationRequest = {
	version: 1,
	requestId: "general-1",
	agent: "reviewer",
	task: "Review evidence",
	context: "fresh",
	cwd: "/repo",
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
	it("maps every bounded request field to the existing executor", () => {
		assert.deepEqual(toSubagentDelegationExecutionParams(request), {
			agent: "reviewer", task: "Review evidence", context: "fresh", cwd: "/repo", model: undefined,
			timeoutMs: 1_000, maxRuntimeMs: undefined,
			turnBudget: { maxTurns: 4, graceTurns: 1 },
			toolBudget: { soft: 3, hard: 5, block: "*" },
			skill: ["review"], output: "result.md", outputMode: "file-only",
			acceptance: "checked", artifacts: true, async: false, clarify: false,
		});
	});

	it("runs one versioned request through the existing bridge and returns structured metadata", async () => {
		const events = new FakeEvents();
		let observedRequest: SubagentDelegationRequest | undefined;
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, delegatedRequest, _signal, _ctx, onUpdate) => {
				executeCalls++;
				observedRequest = delegatedRequest as SubagentDelegationRequest;
				onUpdate({ details: { results: [{ agent: "reviewer", model: "openai/gpt-5" }], progress: [{ currentTool: "read", toolCount: 1 }] } });
				return {
					details: {
						runId: "run-1",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							model: "openai/gpt-5",
							finalOutput: "done",
							savedOutputPath: "/repo/result.md",
							sessionFile: "/tmp/session.jsonl",
							usage: { turns: 2 },
						}],
					},
				};
			},
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		const updatePromise = once(events, SUBAGENT_DELEGATION_UPDATE_EVENT);
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);

		assert.deepEqual(await startedPromise, { version: 1, requestId: "general-1" });
		const update = await updatePromise as { version: number; requestId: string; currentTool?: string; toolCount?: number; model?: string };
		assert.equal(update.version, 1);
		assert.equal(update.requestId, "general-1");
		assert.equal(update.currentTool, "read");
		assert.equal(update.toolCount, 1);
		assert.equal(update.model, "openai/gpt-5");
		const response = await responsePromise as SubagentDelegationResponse;
		assert.equal(executeCalls, 1);
		assert.deepEqual(observedRequest, request);
		assert.equal(response.status, "completed");
		assert.equal(response.runId, "run-1");
		assert.equal(response.agent, "reviewer");
		assert.equal(response.output, "done");
		assert.equal(response.outputPath, "/repo/result.md");
		assert.equal(response.sessionFile, "/tmp/session.jsonl");
		assert.equal(response.turns, 2);
		assert.equal("acceptance" in response, false);
		assert.equal("warnings" in response, false);
		bridge.dispose();
	});

	it("returns correlated typed failures before execution", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => null,
			execute: async () => {
				executeCalls++;
				return {};
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

		const unsupportedFieldPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "tools-1", tools: ["write"] });
		assert.equal((await unsupportedFieldPromise as SubagentDelegationResponse).status, "invalid_request");

		const malformedRequests = [
			{ timeoutMs: "slow" },
			{ timeoutMs: -1 },
			{ timeoutMs: 10, maxRuntimeMs: 20 },
			{ turnBudget: { maxTurns: 0 } },
			{ toolBudget: { hard: 1, soft: 2 } },
			{ toolBudget: { hard: 1, block: [""] } },
			{ skill: {} },
			{ output: "" },
			{ outputMode: "stream" },
			{ acceptance: "none" },
			{ artifacts: "yes" },
		];
		for (const [index, malformed] of malformedRequests.entries()) {
			const malformedPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
				...request,
				...malformed,
				requestId: `malformed-${index}`,
			});
			assert.equal((await malformedPromise as SubagentDelegationResponse).status, "invalid_request");
		}

		const malformedRequiredPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "malformed-agent", agent: "" });
		assert.equal((await malformedRequiredPromise as SubagentDelegationResponse).status, "invalid_request");

		const unavailablePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "unavailable-1" });
		const unavailable = await unavailablePromise as SubagentDelegationResponse;
		assert.equal(unavailable.status, "unavailable_context");
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("rejects a duplicate active requestId and keeps cancellation ownership", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_id, _request, signal) => {
				executeCalls++;
				return await new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			},
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "duplicate-1" });
		await startedPromise;

		const duplicateResponse = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "duplicate-1" });
		const duplicate = await duplicateResponse as SubagentDelegationResponse;
		assert.equal(duplicate.status, "invalid_request");
		assert.equal(executeCalls, 1);

		const cancelledResponse = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: "duplicate-1" });
		assert.equal((await cancelledResponse as SubagentDelegationResponse).status, "cancelled");
		bridge.dispose();
	});

	it("keeps legacy and versioned cancellation namespaces separate", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				executeCalls++;
				return { details: { results: [{ agent: "reviewer", exitCode: 0 }] } };
			},
		});
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: "shared-1" });
		const legacyResponse = once(events, "prompt-template:subagent:response");
		events.emit("prompt-template:subagent:request", {
			requestId: "shared-1", agent: "reviewer", task: "legacy", context: "fresh", model: "test", cwd: "/repo",
		});
		assert.equal((await legacyResponse as { isError: boolean }).isError, false);

		const versionedResponse = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "shared-1" });
		assert.equal((await versionedResponse as SubagentDelegationResponse).status, "cancelled");
		assert.equal(executeCalls, 1);
		bridge.dispose();
	});

	it("maps cancellation and terminal executor outcomes", async () => {
		const cases = [
			[{ timedOut: true }, "timed_out"],
			[{ interrupted: true }, "interrupted"],
			[{ turnBudgetExceeded: true }, "turn_budget_exhausted"],
			[{ toolBudgetBlocked: true }, "tool_budget_exhausted"],
			[{ acceptance: { status: "rejected" } }, "acceptance_failed"],
			[{ exitCode: 1, error: "failed" }, "failed"],
		] as const;
		for (const [result, expectedStatus] of cases) {
			const events = new FakeEvents();
			const bridge = registerPromptTemplateDelegationBridge({
				events,
				getContext: () => ({ cwd: "/repo" }),
				execute: async () => ({ details: { results: [{ agent: "reviewer", exitCode: 0, ...result }] } }),
			});
			const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: `case-${expectedStatus}` });
			assert.equal((await responsePromise as SubagentDelegationResponse).status, expectedStatus);
			bridge.dispose();
		}

		const preEvents = new FakeEvents();
		let preCalls = 0;
		const preBridge = registerPromptTemplateDelegationBridge({
			events: preEvents, getContext: () => ({ cwd: "/repo" }),
			execute: async () => { preCalls++; return {}; },
		});
		preEvents.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: "pre-cancel-1" });
		const preResponse = once(preEvents, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		preEvents.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "pre-cancel-1" });
		assert.equal((await preResponse as SubagentDelegationResponse).status, "cancelled");
		assert.equal(preCalls, 0);
		preBridge.dispose();

		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_id, _request, signal) => await new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "cancel-1" });
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 1, requestId: "cancel-1" });
		assert.equal((await responsePromise as SubagentDelegationResponse).status, "cancelled");
		bridge.dispose();
	});
});
