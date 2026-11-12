import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clearProviderRetry,
	observeProviderDiagnostics,
	sameProviderDiagnostics,
	snapshotProviderDiagnostics,
} from "../../src/shared/provider-diagnostics.ts";

function errorEvent(errorMessage?: string) {
	return { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, content: [] } };
}

const retryStart = { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "secret" };

describe("provider diagnostics", () => {
	it("classifies only explicit throttling, excluding quota/billing/account exhaustion", () => {
		for (const text of ["HTTP 429", "HTTP/1.1 429 Too Many Requests", 'status: 429', 'status_code: 429', "429 retry later", "rate_limit_exceeded", "rate-limited", "Too many requests"]) {
			assert.equal(observeProviderDiagnostics(undefined, errorEvent(text), 10)?.lastError?.kind, "rate_limited", text);
		}
		for (const text of ["HTTP 429 insufficient_quota", "HTTP 429 billing required", "HTTP 429 quota exceeded", "HTTP 429 account limit exceeded", "429 credit exhausted", "HTTP 429 credits exhausted", "429 balance is depleted", "429 insufficient credits", "429 subscription_sharing_usage_limit_exceeded", "429 GoUsageLimitError", "429 FreeUsageLimitError", "429 Monthly usage limit reached", "429 available balance required"]) {
			assert.equal(observeProviderDiagnostics(undefined, errorEvent(text), 10)?.lastError?.kind, "unknown", text);
		}
		for (const text of ["overloaded", "HTTP 503 service unavailable", "fetch failed"]) {
			assert.equal(observeProviderDiagnostics(undefined, errorEvent(text), 10)?.lastError?.kind, "transient_other", text);
		}
		// Pi's retry classifier deliberately excludes status-like digits embedded in identifiers.
		assert.equal(observeProviderDiagnostics(undefined, errorEvent("request id 42901 failed"), 10)?.lastError?.kind, "unknown");
		for (const text of [undefined, "", "Unauthorized", "Unrecognized failure"]) {
			assert.equal(observeProviderDiagnostics(undefined, errorEvent(text), 10)?.lastError?.kind, "unknown", text);
		}
	});

	it("excludes explicit credit and balance exhaustion before throttling evidence", () => {
		for (const text of [
			"HTTP 429: credits are exhausted",
			"HTTP 429: no remaining credits",
			"HTTP 429: credits have been depleted",
			"HTTP 429: no remaining balance",
			'{"type":"rate_limit_error","message":"HTTP 429: credits are exhausted"}',
		]) {
			assert.equal(observeProviderDiagnostics(undefined, errorEvent(text), 10)?.lastError?.kind, "unknown", text);
		}
	});

	it("recognizes the explicit rate_limit_error token without accepting arbitrary suffixes", () => {
		const text = '{"type":"error","error":{"type":"rate_limit_error","message":"Please retry later"}}';
		assert.equal(observeProviderDiagnostics(undefined, errorEvent(text), 10)?.lastError?.kind, "rate_limited");
		assert.equal(observeProviderDiagnostics(undefined, errorEvent("rate_limit_error_extra"), 10)?.lastError?.kind, "transient_other");
	});

	it("counts every failed assistant message including repeats/missing text and never copies secrets", () => {
		let diagnostics;
		for (const text of ["HTTP 429 token=secret\nraw body", "HTTP 429 token=secret\nraw body", undefined]) {
			diagnostics = observeProviderDiagnostics(diagnostics, errorEvent(text), 100);
		}
		assert.deepEqual(diagnostics, { errorCount: 3, lastError: { kind: "unknown", message: "Assistant request failed.", at: 100 } });
		const retry = observeProviderDiagnostics(diagnostics, retryStart, 101);
		assert.equal(retry?.errorCount, 3);
		assert.doesNotMatch(JSON.stringify(retry), /secret|raw body/);
	});

	it("preserves immutable replacement snapshots through backoff, in-flight, recovery and settlement", () => {
		const first = observeProviderDiagnostics(undefined, errorEvent("HTTP 429"), 10)!;
		const backoff = observeProviderDiagnostics(first, retryStart, 20)!;
		const snapshot = snapshotProviderDiagnostics(backoff)!;
		assert.notEqual(snapshot.lastError, backoff.lastError);
		assert.notEqual(snapshot.retry, backoff.retry);
		const inFlight = observeProviderDiagnostics(backoff, { type: "agent_start" }, 30)!;
		assert.equal(inFlight.retry?.phase, "in_flight");
		assert.equal(observeProviderDiagnostics(inFlight, { type: "turn_start" }, 31), inFlight);
		assert.equal(snapshot.retry?.phase, "backoff");
		assert.deepEqual(snapshot.retry, { phase: "backoff", attempt: 1, maxAttempts: 3, delayMs: 1000, scheduledAt: 20 });
		assert.equal(first.retry, undefined);
		const second = observeProviderDiagnostics(inFlight, errorEvent("HTTP 429"), 40)!;
		assert.equal(second.errorCount, 2);
		assert.equal(first.errorCount, 1);
		for (const end of [{ type: "auto_retry_end", success: true }, { type: "auto_retry_end", success: false }, { type: "agent_settled" }]) {
			const terminal = observeProviderDiagnostics(second, end, 50)!;
			assert.equal(terminal.retry, undefined);
			assert.equal(terminal.errorCount, 2);
			assert.equal(terminal.lastError?.at, 40);
		}
		assert.equal(observeProviderDiagnostics(backoff, { type: "turn_start" }, 30)?.retry?.phase, "in_flight");
		assert.equal(clearProviderRetry(backoff)?.retry, undefined);
		assert.equal(sameProviderDiagnostics(backoff, snapshot), true);
		for (const changed of [first, inFlight, second, clearProviderRetry(second), undefined]) {
			assert.equal(sameProviderDiagnostics(backoff, changed), false);
		}
	});

	it("does not invent diagnostics for healthy reasoning, tools, user text, compaction, or aborts", () => {
		for (const event of [
			{ type: "agent_start" }, { type: "turn_start" },
			{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "HTTP 429" } },
			{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "HTTP 429" }] } },
			{ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "HTTP 429" } },
			{ type: "message_end", message: { role: "user", stopReason: "error", errorMessage: "HTTP 429" } },
			{ type: "message_end", message: { role: "toolResult", errorMessage: "HTTP 429", isError: true } },
			{ type: "compaction_start" }, { type: "compaction_end" }, { type: "summarization_retry_scheduled" },
			{ type: "auto_retry_end" }, { type: "agent_settled" },
		]) {
			assert.equal(observeProviderDiagnostics(undefined, event, 10), undefined, event.type);
		}
		const contentOnly = observeProviderDiagnostics(undefined, { type: "message_end", message: { role: "assistant", stopReason: "error", content: [{ type: "text", text: "HTTP 429" }] } }, 10);
		assert.equal(contentOnly?.lastError?.kind, "unknown");
	});
});
