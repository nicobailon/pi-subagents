import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationAcceptance,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationV2InvalidResponse,
	type SubagentDelegationV2Request,
	type SubagentDelegationV2Response,
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

const v2Request: SubagentDelegationV2Request = {
	version: 2,
	requestId: "attempt-1",
	ownerRunId: "owner-1",
	nodeId: "node-1",
	agent: "reviewer",
	task: "Review evidence",
	context: "fresh",
	cwd: "/repo",
	model: "openai/gpt-5",
	thinking: "high",
	timeoutMs: 1_000,
	turnBudget: { maxTurns: 4, graceTurns: 1 },
	toolBudget: { soft: 3, hard: 5, block: "*" },
	skill: ["review"],
	artifacts: true,
	result: { kind: "structured", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
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
	outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
	agentContract: { version: 1 },
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

	it("strictly parses the complete v2 request and enforces its independent allowlists and bounds", () => {
		assert.equal(SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION, 2);
		assert.deepEqual(parseSubagentDelegationRequest(v2Request), { ok: true, request: v2Request });
		const malformed = [
			[{ ...v2Request, ownerRunId: "bad\nowner" }, /ownerRunId.*256 characters without newlines/],
			[{ ...v2Request, nodeId: "x".repeat(257) }, /nodeId.*256 characters without newlines/],
			[{ ...v2Request, thinking: "extreme" }, /thinking must be one of/],
			[{ ...v2Request, output: false }, /Unsupported delegation field: output/],
			[{ ...v2Request, outputMode: "inline" }, /Unsupported delegation field: outputMode/],
			[{ ...v2Request, agentContract: { version: 1 } }, /Unsupported delegation field: agentContract/],
			[{ ...v2Request, acceptance: false }, /Unsupported delegation field: acceptance/],
			[{ ...v2Request, result: { kind: "text", schema: {} } }, /result.schema is not supported/],
			[{ ...v2Request, result: { kind: "structured" } }, /result.schema must be a JSON Schema object/],
			[{ ...v2Request, task: "é".repeat(524_289) }, /task exceeds 1 MiB/],
			[{ ...v2Request, cwd: "é".repeat(16_385) }, /cwd exceeds 32 KiB/],
			[{ ...v2Request, agent: "é".repeat(513) }, /agent exceeds 1 KiB/],
			[{ ...v2Request, model: "é".repeat(513) }, /model exceeds 1 KiB/],
			[{ ...v2Request, skill: "é".repeat(513) }, /skill entry exceeds 1 KiB/],
			[{ ...v2Request, skill: Array.from({ length: 257 }, () => "x") }, /skill supports at most 256 entries/],
			[{ ...v2Request, skill: Array.from({ length: 256 }, () => "x".repeat(257)) }, /skill entries exceed 64 KiB in aggregate/],
			[{ ...v2Request, result: { kind: "structured", schema: { value: "x".repeat(65_536) } } }, /result.schema exceeds 64 KiB/],
			[{ ...v2Request, timeoutMs: 2_147_483_648 }, /timeoutMs must be <= 2147483647 for delegation v2/],
		] as const;
		for (const [input, expected] of malformed) {
			const parsed = parseSubagentDelegationRequest(input);
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, expected);
		}
	});

	it("accepts an exact zero tool budget only for v2", () => {
		const zeroBudget = { hard: 0, block: "*" as const };
		const parsedV2 = parseSubagentDelegationRequest({ ...v2Request, toolBudget: zeroBudget });
		assert.equal(parsedV2.ok, true);
		if (parsedV2.ok) assert.deepEqual(parsedV2.request.toolBudget, zeroBudget);

		const parsedV1 = parseSubagentDelegationRequest({ ...request, toolBudget: zeroBudget });
		assert.equal(parsedV1.ok, false);
		if (!parsedV1.ok) assert.equal(parsedV1.error, "toolBudget.hard must be an integer >= 1.");
		for (const soft of [0, 1]) {
			assert.equal(parseSubagentDelegationRequest({ ...v2Request, toolBudget: { ...zeroBudget, soft } }).ok, false);
		}
	});

	it("rejects non-JSON v2 schemas without executing toJSON hooks", () => {
		let calls = 0;
		const parsed = parseSubagentDelegationRequest({
			...v2Request,
			result: {
				kind: "structured",
				schema: { toJSON: () => { calls++; return {}; } },
			},
		});
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /result.schema must be plain JSON data/);
		assert.equal(calls, 0);
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
			[{ ...request, outputSchema: [] }, /outputSchema must be a JSON Schema object/],
			[{ ...request, agentContract: { version: 2 } }, /agentContract must be \{ version: 1 \}/],
			[{ ...request, agentContract: { version: 1, extra: true } }, /agentContract must be \{ version: 1 \}/],
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

	it("runs v2 through the versioned executor and preserves literal text with full effective metadata", async () => {
		const events = new FakeEvents();
		let ordinaryCalls = 0;
		let observedParams: Record<string, unknown> | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				ordinaryCalls++;
				return { details: { mode: "single", results: [] } };
			},
			executeVersioned: async (_id, params, _signal, _ctx, onUpdate) => {
				observedParams = params as unknown as Record<string, unknown>;
				onUpdate({ details: { mode: "single", results: [{ agent: "reviewer", model: "openai/gpt-5", thinking: "high" }], progress: [{ currentTool: "read" }] } });
				return {
					details: {
						mode: "single",
						runId: "run-v2",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							model: "openai/gpt-5",
							thinking: "high",
							finalOutput: '{"looks":"json"}',
							usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.01, turns: 2 },
							progressSummary: { toolCount: 6, tokens: 5, durationMs: 7 },
						}],
					},
				};
			},
		});
		const textRequest = { ...v2Request, result: { kind: "text" as const } };
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		const updatePromise = once(events, SUBAGENT_DELEGATION_UPDATE_EVENT);
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, textRequest);
		assert.deepEqual(await startedPromise, { version: 2, requestId: "attempt-1", ownerRunId: "owner-1", nodeId: "node-1" });
		assert.deepEqual(await updatePromise, { version: 2, requestId: "attempt-1", ownerRunId: "owner-1", nodeId: "node-1", currentTool: "read", model: "openai/gpt-5" });
		assert.deepEqual(await responsePromise, {
			version: 2,
			requestId: "attempt-1",
			ownerRunId: "owner-1",
			nodeId: "node-1",
			status: "completed",
			runId: "run-v2",
			agent: "reviewer",
			model: "openai/gpt-5",
			thinking: "high",
			exitCode: 0,
			result: { kind: "text", text: '{"looks":"json"}' },
			usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.01, turns: 2, toolCalls: 6, durationMs: 7 },
		} satisfies SubagentDelegationV2Response);
		assert.equal(ordinaryCalls, 0);
		assert.deepEqual(observedParams, {
			agent: "reviewer",
			task: "Review evidence",
			context: "fresh",
			cwd: "/repo",
			model: "openai/gpt-5",
			timeoutMs: 1_000,
			turnBudget: { maxTurns: 4, graceTurns: 1 },
			toolBudget: { soft: 3, hard: 5, block: "*" },
			skill: ["review"],
			output: false,
			acceptance: false,
			artifacts: true,
			delegatedThinkingOverride: "high",
			delegatedAllowZeroToolBudget: true,
			async: false,
			foregroundOnly: true,
			clarify: false,
		});
		bridge.dispose();
	});

	it("projects structured v2 values and fails missing or oversized captures", async () => {
		const cases = [
			[{ ok: true }, "completed", { kind: "structured", value: { ok: true } }],
			[undefined, "failed", undefined],
			[{ value: "x".repeat(1024 * 1024) }, "failed", undefined],
		] as const;
		for (const [structuredOutput, expectedStatus, expectedResult] of cases) {
			const events = new FakeEvents();
			const bridge = registerPromptTemplateDelegationBridge({
				events,
				getContext: () => ({ cwd: "/repo" }),
				execute: async () => { throw new Error("ordinary executor must remain separate"); },
				executeVersioned: async () => ({
					details: {
						mode: "single",
						results: [{
							agent: "reviewer",
							exitCode: 0,
							...(structuredOutput === undefined ? {} : { structuredOutput }),
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						}],
					},
				}),
			});
			const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: `structured-${expectedStatus}-${Math.random()}` });
			const response = await responsePromise as SubagentDelegationV2Response;
			assert.equal(response.status, expectedStatus);
			assert.deepEqual(response.result, expectedResult);
			if (expectedStatus === "failed") assert.match(response.error ?? "", /structured result/);
			bridge.dispose();
		}
	});

	it("rejects non-JSON structured results without executing toJSON hooks", async () => {
		let calls = 0;
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async () => ({
				details: {
					mode: "single",
					results: [{
						agent: "reviewer",
						exitCode: 0,
						structuredOutput: { toJSON: () => { calls++; return {}; } },
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					}],
				},
			}),
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "unsafe-structured" });
		const response = await responsePromise as SubagentDelegationV2Response;
		assert.equal(response.status, "failed");
		assert.match(response.error ?? "", /structured result is not plain JSON data/);
		assert.equal(calls, 0);
		bridge.dispose();
	});

	it("rejects v2 text results exceeding 1 MiB when UTF-8 encoded", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async () => ({
				details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, finalOutput: "é".repeat(524_289) }] },
			}),
		});
		const responsePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "oversized-text", result: { kind: "text" } });
		const response = await responsePromise as SubagentDelegationV2Response;
		assert.equal(response.status, "failed");
		assert.match(response.error ?? "", /text result exceeds 1 MiB/);
		assert.equal("result" in response, false);
		bridge.dispose();
	});

	it("isolates v2 logical-node ownership, exact cancellation, pre-cancellation, and reuse", async () => {
		const events = new FakeEvents();
		const releases = new Map<string, () => void>();
		const responses: SubagentDelegationV2Response[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationV2Response));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async (id, params, signal) => await new Promise((resolve, reject) => {
				releases.set(id, () => resolve({ details: { mode: "single", results: [{ agent: params.agent, exitCode: 0, finalOutput: id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } }] } }));
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		});
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "owner-a", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "owner-b", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "owner-b", result: { kind: "text" } });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "other-node", nodeId: "node-2", result: { kind: "text" } });
		while (!releases.has("owner-a") || !releases.has("other-node")) await tick();
		await tick();
		assert.equal(responses.find((entry) => entry.requestId === "owner-b")?.status, "duplicate_node");
		assert.equal(responses.filter((entry) => entry.requestId === "owner-b").length, 1);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "owner-a", ownerRunId: "wrong", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "owner-a", ownerRunId: "owner-1", nodeId: "wrong" });
		await tick();
		assert.equal(responses.some((entry) => entry.requestId === "owner-a"), false);
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "owner-a", ownerRunId: "owner-1", nodeId: "node-1" });
		while (!responses.some((entry) => entry.requestId === "owner-a")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "owner-a")?.status, "cancelled");
		releases.get("other-node")?.();
		while (!responses.some((entry) => entry.requestId === "other-node")) await tick();

		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "pre", ownerRunId: "owner-1", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "pre", result: { kind: "text" } });
		while (!responses.some((entry) => entry.requestId === "pre")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "pre")?.status, "cancelled");

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "reuse", result: { kind: "text" } });
		while (!releases.has("reuse")) await tick();
		releases.get("reuse")?.();
		while (!responses.some((entry) => entry.requestId === "reuse")) await tick();
		assert.equal(responses.find((entry) => entry.requestId === "reuse")?.status, "completed");
		bridge.dispose();
	});

	it("keys concurrent v2 attempts and retransmissions by the full identity tuple", async () => {
		const events = new FakeEvents();
		const releases = new Map<string, () => void>();
		const responses: SubagentDelegationV2Response[] = [];
		let executeCalls = 0;
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationV2Response));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async (_id, params) => {
				executeCalls++;
				if (typeof params.task !== "string") throw new Error("expected a single delegated task");
				const task = params.task;
				await new Promise<void>((resolve) => releases.set(task, resolve));
				return { details: { mode: "single", results: [{ agent: params.agent, exitCode: 0, finalOutput: task }] } };
			},
		});
		const first = { ...v2Request, requestId: "shared-attempt", task: "first", result: { kind: "text" as const } };
		const second = { ...first, ownerRunId: "owner-2", nodeId: "node-2", task: "second" };
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, first);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, second);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, first);
		for (let index = 0; index < 5 && releases.size < 2; index++) await tick();
		assert.equal(releases.size, 2);
		assert.equal(executeCalls, 2);
		releases.get("first")?.();
		releases.get("second")?.();
		while (responses.length < 2) await tick();
		assert.deepEqual(responses.map(({ ownerRunId, nodeId, status }) => ({ ownerRunId, nodeId, status })).sort((a, b) => (a.ownerRunId ?? "").localeCompare(b.ownerRunId ?? "")), [
			{ ownerRunId: "owner-1", nodeId: "node-1", status: "completed" },
			{ ownerRunId: "owner-2", nodeId: "node-2", status: "completed" },
		]);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, first);
		await tick();
		assert.equal(executeCalls, 2);
		assert.equal(responses.length, 2);
		bridge.dispose();
	});

	it("applies exact v2 pre-cancellation despite logical-node and bare-id conflicts", async () => {
		const events = new FakeEvents();
		const releases = new Map<string, () => void>();
		const activeSignals = new Map<string, AbortSignal>();
		const responses: SubagentDelegationV2Response[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationV2Response));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async (_id, params, signal) => {
				if (typeof params.task !== "string") throw new Error("expected a single delegated task");
				const task = params.task;
				activeSignals.set(task, signal);
				await new Promise<void>((resolve) => releases.set(task, resolve));
				return { details: { mode: "single", results: [{ agent: params.agent, exitCode: 0, finalOutput: task }] } };
			},
		});

		const logicalOwner = { ...v2Request, requestId: "logical-owner", task: "logical-owner", result: { kind: "text" as const } };
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, logicalOwner);
		while (!releases.has("logical-owner")) await tick();
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "logical-pre", ownerRunId: "owner-1", nodeId: "node-1" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...logicalOwner, requestId: "logical-pre", task: "must-not-run" });
		await tick();
		assert.equal(responses.find((entry) => entry.requestId === "logical-pre")?.status, "cancelled");
		assert.equal(activeSignals.get("logical-owner")?.aborted, false);
		assert.equal(releases.has("must-not-run"), false);

		const bareOwner = { ...v2Request, requestId: "shared-bare", ownerRunId: "owner-2", nodeId: "node-2", task: "bare-owner", result: { kind: "text" as const } };
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, bareOwner);
		while (!releases.has("bare-owner")) await tick();
		events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId: "shared-bare", ownerRunId: "owner-3", nodeId: "node-3" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...bareOwner, ownerRunId: "owner-3", nodeId: "node-3", task: "also-must-not-run" });
		await tick();
		assert.equal(responses.find((entry) => entry.ownerRunId === "owner-3")?.status, "cancelled");
		assert.equal(activeSignals.get("bare-owner")?.aborted, false);
		assert.equal(releases.has("also-must-not-run"), false);

		releases.get("logical-owner")?.();
		releases.get("bare-owner")?.();
		bridge.dispose();
	});

	it("suppresses v2 terminal events after disposal", async () => {
		const events = new FakeEvents();
		const responses: unknown[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload));
		let rejectExecution: ((error: Error) => void) | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must remain separate"); },
			executeVersioned: async () => await new Promise((_resolve, reject) => { rejectExecution = reject; }),
		});
		const startedPromise = once(events, SUBAGENT_DELEGATION_STARTED_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...v2Request, requestId: "dispose-v2", result: { kind: "text" } });
		await startedPromise;
		bridge.dispose();
		rejectExecution?.(new Error("aborted"));
		await tick();
		assert.deepEqual(responses, []);
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
							agentContract: { version: 1 },
							execution: { status: "completed", success: true, exitCode: 0 },
							acceptance: { status: "checked", explicit: true },
							review: { status: "not-requested" },
							effects: { fileMutation: { status: "missing", expected: true, attempted: false } },
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
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
			agentContract: { version: 1 },
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
		assert.deepEqual(response.execution, { status: "completed", success: true, exitCode: 0 });
		assert.deepEqual(response.review, { status: "not-requested" });
		assert.deepEqual(response.effects, { fileMutation: { status: "missing", expected: true, attempted: false } });
		assert.equal(response.turns, 2);
		assert.equal(response.toolCount, 4);
		assert.equal(response.tokens, 5);
		assert.deepEqual(response.acceptance, { status: "checked", explicit: true });
		assert.deepEqual(response.warnings, ["Skills not found: review"]);
		bridge.dispose();
	});

	it("routes independent v1 requests through the concurrent-safe delegated executor", async () => {
		const events = new FakeEvents();
		let ordinaryCalls = 0;
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		const responses: SubagentDelegationResponse[] = [];
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (value) => responses.push(value as SubagentDelegationResponse));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				ordinaryCalls++;
				return { details: { mode: "single", results: [] } };
			},
			executeVersioned: async (_id, params) => {
				active++;
				started++;
				maxActive = Math.max(maxActive, active);
				await barrier;
				active--;
				return {
					details: {
						mode: "single",
						results: [{
							agent: params.agent,
							exitCode: 0,
							finalOutput: params.task,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						}],
					},
				};
			},
		});
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "parallel-a", task: "A" });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "parallel-b", task: "B" });
		while (started < 2) await tick();
		assert.equal(maxActive, 2);
		assert.equal(ordinaryCalls, 0);
		release();
		while (responses.length < 2) await tick();
		assert.deepEqual(responses.map((response) => response.requestId).sort(), ["parallel-a", "parallel-b"]);
		assert.ok(responses.every((response) => response.status === "completed"));
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
			version: 2,
			requestId: "invalid-1",
			status: "invalid_request",
			error: "Unsupported delegation protocol version: 2.",
		} satisfies SubagentDelegationV2InvalidResponse);

		const unavailablePromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, { ...request, requestId: "unavailable-1" });
		const unavailable = await unavailablePromise as SubagentDelegationResponse;
		assert.equal(unavailable.status, "unavailable_context");
		assert.equal(executeCalls, 0);
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
			[{ agentContract: { version: 1 }, acceptance: { status: "rejected", explicit: true } }, "completed"],
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

	it("ignores malformed versioned cancellation without aborting the owner", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => { throw new Error("ordinary executor must not own a strict v1 request"); },
			executeVersioned: async (_id, _params, signal) => await new Promise((_resolve, reject) => {
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

	it("fails closed instead of evicting exact v2 cancellation identity", async () => {
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
		for (let index = 0; index < 8_192; index++) {
			events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
				version: 2,
				requestId: `attempt-${index}`,
				ownerRunId: "saturated-owner",
				nodeId: `node-${index}`,
			});
		}

		const retainedPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...v2Request,
			requestId: "attempt-0",
			ownerRunId: "saturated-owner",
			nodeId: "node-0",
		});
		assert.equal((await retainedPromise as SubagentDelegationV2Response).status, "cancelled");

		const overflowPromise = once(events, SUBAGENT_DELEGATION_RESPONSE_EVENT);
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...v2Request,
			requestId: "overflow-attempt",
			ownerRunId: "saturated-owner",
			nodeId: "overflow-node",
		});
		const overflow = await overflowPromise as SubagentDelegationV2Response;
		assert.equal(overflow.status, "unavailable_context");
		assert.match(overflow.error ?? "", /identity capacity/i);
		assert.equal(executeCalls, 0);
		bridge.dispose();
	});

	it("fails closed when settled v2 identity history reaches capacity", async () => {
		const events = new FakeEvents();
		const responses: SubagentDelegationV2Response[] = [];
		let executeCalls = 0;
		events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => responses.push(payload as SubagentDelegationV2Response));
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (requestId) => {
				executeCalls++;
				return { details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0, finalOutput: requestId }] } };
			},
		});
		for (let index = 0; index < 8_192; index++) {
			events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
				...v2Request,
				requestId: `settled-${index}`,
				ownerRunId: "settled-owner",
				nodeId: `settled-node-${index}`,
				result: { kind: "text" },
			});
		}
		for (let attempt = 0; responses.length < 8_192 && attempt < 100; attempt++) await tick();
		assert.equal(responses.length, 8_192);
		assert.equal(executeCalls, 8_192);

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...v2Request,
			requestId: "settled-overflow",
			ownerRunId: "settled-owner",
			nodeId: "settled-overflow-node",
			result: { kind: "text" },
		});
		await tick();
		assert.equal(responses.at(-1)?.status, "unavailable_context");
		assert.equal(executeCalls, 8_192);

		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
			...v2Request,
			requestId: "settled-0",
			ownerRunId: "settled-owner",
			nodeId: "settled-node-0",
			result: { kind: "text" },
		});
		await tick();
		assert.equal(responses.length, 8_193);
		assert.equal(executeCalls, 8_192);
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
