import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	formatStructuredOutputRejectionError,
	INVALID_STRUCTURED_OUTPUT_SCHEMA_ERROR,
	MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES,
	STRUCTURED_OUTPUT_REJECTION_ERROR,
	STRUCTURED_OUTPUT_VALIDATOR_UNAVAILABLE_ERROR,
} from "../../src/runs/shared/structured-output.ts";

function messages(...values: unknown[]): Message[] {
	return values as Message[];
}

describe("structured output rejection evidence", () => {
	it("uses the latest failed result and correlates results without names by toolCallId", () => {
		const result = formatStructuredOutputRejectionError(messages(
			{ role: "assistant", content: [{ type: "toolCall", id: "structured-1", name: "structured_output", arguments: { value: {} } }] },
			{ role: "toolResult", toolCallId: "structured-1", isError: true, content: [{ type: "text", text: "Structured output validation failed: first: is required" }] },
			{ role: "toolResult", toolName: "structured_output", toolCallId: "structured-2", isError: true, content: [{ type: "text", text: "Structured output validation failed: second: is required" }] },
		));

		assert.equal(result, "Structured output validation failed: second: is required");
	});

	it("ignores unrelated failures and returns a truthful fallback", () => {
		const result = formatStructuredOutputRejectionError(messages(
			{ role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "EISDIR" }] },
		));

		assert.equal(result, STRUCTURED_OUTPUT_REJECTION_ERROR);
	});

	it("does not expose schema compiler diagnostics", () => {
		const sentinel = "PRIVATE_SCHEMA_SENTINEL";
		const result = formatStructuredOutputRejectionError(messages(
			{ role: "toolResult", toolName: "structured_output", isError: true, content: [{ type: "text", text: `Structured output validation failed: invalid outputSchema: Invalid regular expression: /${sentinel}_[invalid/u` }] },
		));

		assert.equal(result, INVALID_STRUCTURED_OUTPUT_SCHEMA_ERROR);
		assert.equal(result.includes(sentinel), false);
	});

	it("categorizes unavailable validation without exposing setup details", () => {
		const sentinel = "PRIVATE_SETUP_SENTINEL";
		const result = formatStructuredOutputRejectionError(messages(
			{ role: "toolResult", toolName: "structured_output", isError: true, content: [{ type: "text", text: `Cannot load typebox/compile for structured output validation (direct import failed: ${sentinel} at /private/compiler.ts)` }] },
		));

		assert.equal(result, STRUCTURED_OUTPUT_VALIDATOR_UNAVAILABLE_ERROR);
		assert.equal(result.includes(sentinel), false);
	});

	it("redacts payload and stack details and clamps complete UTF-8 characters", () => {
		const secret = "do-not-leak";
		const oversized = `Structured output validation failed: ${"界".repeat(2_000)}\nsubmitted value: ${secret}\n    at /private/project/file.ts:1:1`;
		const result = formatStructuredOutputRejectionError(messages(
			{ role: "toolResult", toolName: "structured_output", isError: true, content: [{ type: "text", text: oversized }] },
		));

		assert.ok(Buffer.byteLength(result, "utf8") <= MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES);
		assert.equal(result.includes("�"), false);
		assert.equal(result.includes(secret), false);
		assert.equal(result.includes("/private/project"), false);
	});
});
