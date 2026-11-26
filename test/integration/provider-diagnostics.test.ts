import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_UPDATE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationUpdate,
} from "../../src/api/delegation.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { toSubagentDelegationResponse, toSubagentDelegationUpdate } from "../../src/slash/delegation-adapters.ts";
import { registerPromptTemplateDelegationBridge } from "../../src/slash/prompt-template-bridge.ts";
import type { MockPiResponse } from "../support/mock-pi.ts";
import { makeAgent } from "../support/helpers.ts";
import { available, installAsyncExecutionHooks, mockPi, tempDir } from "../support/async-execution-fixture.ts";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
function assistant(stopReason: string, errorMessage?: string, text = "") {
	return { type: "message_end", message: {
		role: "assistant", model: "mock/test-model", stopReason, errorMessage,
		content: text ? [{ type: "text", text }] : [], usage: zeroUsage,
	} };
}
const failed = () => assistant("error", "HTTP 429 secret-provider-body");
const backoff = (attempt = 1) => ({ type: "auto_retry_start", attempt, maxAttempts: 2, delayMs: 2000, errorMessage: "secret-provider-body" });

async function runFixture(response: MockPiResponse, options: { cancel?: boolean; timeoutMs?: number; sessionFile?: string; recoveryResponse?: MockPiResponse } = {}) {
	mockPi.onCall(response);
	if (options.recoveryResponse) mockPi.onCall(options.recoveryResponse);
	const agent = makeAgent("diagnostics-fixture");
	const request: SubagentDelegationRequest = {
		requestId: "observations", ownerRunId: "owner", nodeId: "leaf", agent: agent.name,
		task: "Observe scripted assistant requests", context: "fresh", cwd: tempDir, result: { kind: "text" },
	};
	const updates: SubagentDelegationUpdate[] = [];
	const controller = new AbortController();
	const result = await runSync(tempDir, [agent], agent.name, request.task, {
		acceptance: false, suppressUnchangedDelegationUpdates: true,
		signal: controller.signal, timeoutMs: options.timeoutMs, sessionFile: options.sessionFile,
		onUpdate(update) {
			const projected = toSubagentDelegationUpdate(request, update);
			if (projected) updates.push(projected);
			if (options.cancel && projected?.providerDiagnostics?.retry?.phase === "backoff") controller.abort();
		},
	});
	const terminal = toSubagentDelegationResponse(request, { details: { mode: "single", results: [result] } }, controller.signal.aborted);
	if (terminal.status === "invalid_request") assert.fail("expected terminal response");
	return { result, updates, terminal };
}

describe("foreground provider diagnostics propagation", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("immediately projects zero-output errors, preserves history and snapshots through Pi retry recovery", async () => {
		const { result, updates, terminal } = await runFixture({ jsonl: [
			failed(), backoff(), { type: "agent_start" }, { type: "turn_start" },
			failed(), backoff(2), { type: "turn_start" },
			{ type: "tool_execution_start", toolName: "read", args: { path: "file" } },
			{ type: "tool_execution_end", toolName: "read" },
			assistant("stop", undefined, "Recovered"), { type: "auto_retry_end", success: true, attempt: 2 },
		] });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(terminal.status, "completed");
		assert.deepEqual(terminal.result, { kind: "text", text: "Recovered" });
		const firstIndex = updates.findIndex((update) => update.providerDiagnostics);
		const first = updates[firstIndex]!;
		assert.equal(first.tokens, 0);
		assert.equal(first.recentOutput, undefined);
		assert.equal(first.providerDiagnostics?.errorCount, 1);
		assert.equal(first.providerDiagnostics?.lastError?.kind, "rate_limited");
		assert.equal(first.providerDiagnostics?.retry, undefined, "error must be visible before scheduling retry");
		const scheduled = updates.find((update) => update.providerDiagnostics?.retry?.phase === "backoff")!;
		const inFlight = updates.find((update) => update.providerDiagnostics?.retry?.phase === "in_flight")!;
		assert.equal(scheduled.providerDiagnostics?.errorCount, 1, "scheduling does not double-count");
		assert.equal(scheduled.providerDiagnostics?.retry?.attempt, 1);
		assert.equal(scheduled.providerDiagnostics?.retry?.maxAttempts, 2);
		assert.equal(scheduled.providerDiagnostics?.retry?.delayMs, 2000);
		assert.ok(scheduled.providerDiagnostics!.retry!.scheduledAt >= first.providerDiagnostics!.lastError!.at);
		assert.equal(inFlight.providerDiagnostics?.retry?.scheduledAt, scheduled.providerDiagnostics?.retry?.scheduledAt);
		assert.notEqual(scheduled.providerDiagnostics?.lastError, inFlight.providerDiagnostics?.lastError);
		assert.notEqual(scheduled.providerDiagnostics?.retry, inFlight.providerDiagnostics?.retry);
		assert.equal(updates.find((update) => update.currentTool === "read")?.providerDiagnostics?.errorCount, 2, "unrelated updates retain cumulative diagnostics");
		assert.equal(terminal.providerDiagnostics?.errorCount, 2);
		assert.equal(terminal.providerDiagnostics?.retry, undefined);
		assert.ok(updates.some((update) => update.recentOutput === "Recovered" && update.providerDiagnostics?.retry?.phase === "in_flight"), "successful message_end precedes auto_retry_end; retry remains in flight until sequence end");
		assert.equal(updates.at(-1)?.providerDiagnostics?.retry, undefined);
		assert.doesNotMatch(JSON.stringify(updates.map((update) => update.providerDiagnostics)), /secret-provider-body/);
		assert.notEqual(terminal.providerDiagnostics?.lastError, result.providerDiagnostics?.lastError);
	});

	it("delivers scripted child diagnostics through the registered bridge and both progress filters", async () => {
		const rateLimitError = '{"type":"error","error":{"type":"rate_limit_error","message":"Please retry later"}}';
		mockPi.onCall({ jsonl: [
			assistant("error", rateLimitError), backoff(), { type: "agent_start" }, { type: "turn_start" },
			assistant("stop", undefined, "Recovered"), { type: "auto_retry_end", success: true, attempt: 1 },
		] });
		const agent = makeAgent("diagnostics-bridge-fixture");
		const request: SubagentDelegationRequest = {
			requestId: "bridge-observations", ownerRunId: "owner", nodeId: "leaf", agent: agent.name,
			task: "Observe scripted assistant requests through the bridge", context: "fresh", cwd: tempDir, result: { kind: "text" },
		};
		const transport = new EventEmitter();
		const updates: SubagentDelegationUpdate[] = [];
		transport.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (update: SubagentDelegationUpdate) => updates.push(update));
		const bridge = registerPromptTemplateDelegationBridge({
			events: {
				on(event, handler) {
					transport.on(event, handler);
					return () => { transport.off(event, handler); };
				},
				emit(event, data) { transport.emit(event, data); },
			},
			getContext: () => ({ cwd: tempDir }),
			execute: async () => { throw new Error("legacy executor must remain separate"); },
			executeStructured: async (_id, params, signal, ctx, onUpdate) => {
				const result = await runSync(ctx.cwd, [agent], params.agent!, params.task!, {
					cwd: params.cwd, signal, onUpdate, suppressUnchangedDelegationUpdates: true,
					acceptance: false,
				});
				return { details: { mode: "single", results: [result] } };
			},
		});
		try {
			const responsePromise = once(transport, SUBAGENT_DELEGATION_RESPONSE_EVENT);
			transport.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
			const [terminal] = await responsePromise as [SubagentDelegationResponse];
			assert.equal(mockPi.callCount(), 1);
			assert.equal(terminal.status, "completed");
			if (terminal.status === "invalid_request") assert.fail("expected terminal response");
			assert.deepEqual(terminal.result, { kind: "text", text: "Recovered" });
			const observed = updates.filter((update) => update.providerDiagnostics);
			assert.deepEqual(observed.map((update) => update.providerDiagnostics?.retry?.phase), [
				undefined, "backoff", "in_flight", "in_flight", undefined,
			]);
			assert.equal(observed[0]?.tokens, 0);
			assert.equal(observed[0]?.recentOutput, undefined);
			assert.equal(observed[0]?.providerDiagnostics?.lastError?.kind, "rate_limited");
			assert.ok(observed.every((update) => update.providerDiagnostics?.errorCount === 1));
			assert.ok(observed.every((update) => update.providerDiagnostics?.lastError?.at === observed[0]?.providerDiagnostics?.lastError?.at));
			const withoutDiagnosticsOrDuration = ({ providerDiagnostics: _diagnostics, durationMs: _duration, ...progress }: SubagentDelegationUpdate) => progress;
			assert.deepEqual(withoutDiagnosticsOrDuration(observed[0]!), withoutDiagnosticsOrDuration(observed[1]!), "backoff is a diagnostics-only public transition");
			assert.deepEqual(withoutDiagnosticsOrDuration(observed[1]!), withoutDiagnosticsOrDuration(observed[2]!), "in-flight is a diagnostics-only public transition");
			assert.equal(observed[3]?.recentOutput, "Recovered");
			assert.deepEqual(withoutDiagnosticsOrDuration(observed[3]!), withoutDiagnosticsOrDuration(observed[4]!), "retry end is a diagnostics-only public transition");
			assert.equal(terminal.providerDiagnostics?.errorCount, 1);
			assert.equal(terminal.providerDiagnostics?.retry, undefined);
			assert.deepEqual(terminal.providerDiagnostics?.lastError, observed[0]?.providerDiagnostics?.lastError);
			assert.doesNotMatch(JSON.stringify(terminal.providerDiagnostics), /rate_limit_error|Please retry later|secret-provider-body/);
		} finally {
			bridge.dispose();
		}
	});

	it("retains observed errors across the existing retained-session compaction recovery", async () => {
		const sessionFile = path.join(tempDir, "diagnostics-retained.jsonl");
		const { terminal, updates } = await runFixture({
			jsonl: [assistant("stop", undefined, "Useful progress"), { type: "compaction_start" }, assistant("error", "provider transport aborted"), { type: "agent_settled" }],
			omitImplicitFinalEvents: true,
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
		}, { sessionFile, recoveryResponse: { output: "Recovered retained session" } });
		assert.equal(mockPi.callCount(), 2);
		assert.equal(terminal.status, "completed");
		assert.equal(terminal.providerDiagnostics?.errorCount, 1);
		const firstObservation = updates.findIndex((update) => update.providerDiagnostics);
		assert.ok(firstObservation >= 0);
		assert.ok(updates.slice(firstObservation).every((update) => update.providerDiagnostics?.errorCount === 1));
	});

	it("retains errors after exhaustion without changing the existing terminal error", async () => {
		const { result, terminal } = await runFixture({ jsonl: [
			failed(), backoff(), { type: "agent_start" }, failed(),
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "secret-provider-body" },
		] });
		assert.equal(terminal.status, "failed");
		assert.match(result.error ?? "", /HTTP 429 secret-provider-body/);
		assert.equal(terminal.error, result.error);
		assert.equal(terminal.providerDiagnostics?.errorCount, 2);
		assert.equal(terminal.providerDiagnostics?.retry, undefined);
	});

	for (const mode of ["cancel", "timeout"] as const) {
		it(`clears active retry on ${mode} even when Pi supplies no auto_retry_end`, async () => {
			const { result, terminal } = await runFixture({
				steps: [{ jsonl: [failed(), backoff()] }, { delay: 5000, jsonl: [assistant("stop", undefined, "Too late")] }],
			}, mode === "cancel" ? { cancel: true } : { timeoutMs: 500 });
			assert.equal(terminal.status, mode === "cancel" ? "cancelled" : "timed_out");
			assert.equal(terminal.providerDiagnostics?.errorCount, 1);
			assert.equal(terminal.providerDiagnostics?.retry, undefined);
			assert.equal(result.providerDiagnostics?.retry, undefined);
			assert.equal(result.progress?.providerDiagnostics?.retry, undefined);
		});
	}

	it("counts an error with no errorMessage without classifying content", async () => {
		const { updates, terminal } = await runFixture({ jsonl: [
			assistant("error", undefined, "HTTP 429 is only assistant text"), assistant("stop", undefined, "Recovered"),
		] });
		assert.equal(terminal.status, "completed");
		assert.equal(terminal.providerDiagnostics?.errorCount, 1);
		assert.equal(terminal.providerDiagnostics?.lastError?.kind, "unknown");
		assert.ok(updates.some((update) => update.providerDiagnostics?.errorCount === 1));
	});

	it("does not invent diagnostics during healthy reasoning or compaction", async () => {
		const { updates, terminal } = await runFixture({ jsonl: [
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Considering HTTP 429" } },
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "HTTP 429" }] } },
			{ type: "compaction_start" }, { type: "compaction_end", willRetry: true },
			assistant("stop", undefined, "Done"),
		] });
		assert.equal(terminal.status, "completed");
		assert.equal(terminal.providerDiagnostics, undefined);
		assert.ok(updates.every((update) => update.providerDiagnostics === undefined));
	});
});
