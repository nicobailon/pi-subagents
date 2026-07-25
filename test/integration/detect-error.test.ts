import assert from "node:assert/strict";
import { describe, it } from "node:test";

interface DetectErrorResult {
	hasError: boolean;
	errorType?: string;
	details?: string;
	exitCode?: number;
}

type DetectSubagentError = (messages: unknown[]) => DetectErrorResult;

let detectSubagentError: DetectSubagentError | undefined;
let available = true;
try {
	({ detectSubagentError } = await import("../../src/shared/utils.ts"));
} catch {
	// Skip in lean unit mode when runtime-only imports are unavailable.
	available = false;
}

/**
 * Helper to create a tool result message (success or error).
 */
function toolResult(toolName: string, text: string, isError = false): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
		toolName,
		content: [{ type: "text", text }],
		isError,
	};
}

function assistantMsg(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
	};
}

/** Assistant message with only a tool call, no text content */
function assistantToolCall(toolName: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name: toolName, input: {} }],
		api: "test",
		provider: "test",
		model: "test",
	};
}

describe("detectSubagentError", { skip: !available ? "utils not importable" : undefined }, () => {
	// ---- Basic detection (must still work) ----

	it("returns no error for empty messages", () => {
		assert.equal(detectSubagentError([]).hasError, false);
	});

	it("returns no error when all tool results succeed", () => {
		const messages = [
			toolResult("read", "file contents here"),
			toolResult("bash", "ls output"),
			toolResult("read", "more contents"),
		];
		assert.equal(detectSubagentError(messages).hasError, false);
	});

	it("does not infer failure from successful bash output", () => {
		const messages = [
			toolResult("bash", "diff --git a/src/queue.ts b/src/queue.ts\n+ await new Promise((resolve) => setTimeout(resolve, 0))"),
		];
		assert.equal(detectSubagentError(messages).hasError, false);
	});

	it("detects isError tool result as failure (no assistant response)", () => {
		const messages = [
			toolResult("read", "file contents"),
			toolResult("read", "EISDIR: illegal operation on a directory, read", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "read");
		assert.match(result.details!, /EISDIR/);
	});

	it("detects bash error (permission denied, no assistant response)", () => {
		const messages = [
			toolResult("bash", "ls: permission denied: /root/secret", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "bash");
	});

	it("extracts a bash exit code from error output", () => {
		const messages = [
			toolResult("bash", "error: process exited with code 127", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.exitCode, 127);
	});

	// ---- Recovery: errors before the agent's final response are forgiven ----

	it("ignores error when agent recovered and continued", () => {
		const messages = [
			toolResult("read", "file contents"),
			toolResult("bash", "ok"),
			toolResult("read", "EISDIR: illegal operation on a directory", true),
			toolResult("bash", "directory listing via bash"),
			assistantMsg("Here is my complete review..."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"error before agent's final text response should be ignored");
	});

	it("ignores error as final tool result when agent produced text response after", () => {
		// The exact scenario from our review run: agent did all work, last tool
		// call was read on directory → EISDIR, but agent produced 13.5KB review.
		const messages = [
			toolResult("read", "file contents of index.ts"),
			toolResult("read", "file contents of utils.ts"),
			toolResult("bash", "npm test output: 46 pass"),
			toolResult("read", "file contents of settings.ts"),
			toolResult("read", "EISDIR: illegal operation on a directory, read", true),
			assistantMsg("## Complete Review\n\nHere are all my findings..."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"agent produced substantive output after error — not a failure");
	});

	it("ignores bash error when agent responded after", () => {
		const messages = [
			toolResult("bash", "ls: permission denied: /root/secret", true),
			assistantMsg("I couldn't access /root/secret, but I found the data elsewhere."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"fatal pattern before agent's text response = recovered");
	});

	// ---- Errors AFTER the last assistant text response are still caught ----

	it("detects error after agent's last text response", () => {
		const messages = [
			assistantMsg("Here is my analysis..."),
			toolResult("bash", "rm -rf /important", false),
			toolResult("bash", "error: process exited with code 1", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.exitCode, 1);
	});

	it("detects isError after agent's last text response", () => {
		const messages = [
			toolResult("read", "file ok"),
			assistantMsg("Let me try one more thing..."),
			toolResult("write", "Permission denied", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "write");
	});

	// ---- Edge cases ----

	it("flags error when no assistant messages at all", () => {
		const messages = [
			toolResult("read", "ok"),
			toolResult("bash", "segmentation fault", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true,
			"no assistant response = no recovery evidence");
	});

	it("does not treat tool-call-only assistant message as recovery", () => {
		// Assistant message that only contains a tool call, no text.
		// The error at index 0 should still be detected because the tool-call-only
		// assistant message doesn't count as recovery. The final tool result is
		// successful to ensure this test actually distinguishes correct behavior.
		const messages = [
			toolResult("bash", "permission denied: /etc/shadow", true),
			assistantToolCall("bash"),
			toolResult("bash", "command succeeded"),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true,
			"tool-call assistant message without text is not a recovery");
	});

	it("does not treat empty/whitespace assistant message as recovery", () => {
		const messages = [
			toolResult("read", "EISDIR: illegal operation on a directory", true),
			assistantMsg("   "),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true,
			"whitespace-only assistant message is not a recovery");
	});

	it("returns no error when only assistant messages (no tool results)", () => {
		const messages = [
			assistantMsg("Hello, I'm ready to help."),
			assistantMsg("Here's my analysis."),
		];
		assert.equal(detectSubagentError(messages).hasError, false);
	});

	it("handles multiple errors with recovery between them", () => {
		// Error → recovery → error → recovery
		const messages = [
			toolResult("read", "ENOENT: no such file", true),
			assistantMsg("File not found, trying alternative..."),
			toolResult("read", "file contents"),
			toolResult("read", "EISDIR: illegal operation on a directory", true),
			assistantMsg("Got what I needed. Here's the full review."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"all errors have recovery — agent completed successfully");
	});

	// ---- Real-world regression test ----

	it("real-world: 19-read review run with trailing EISDIR", () => {
		// Simulate the actual _impl-reviewer run that produced a false positive
		const readResults = Array.from({ length: 18 }, (_, i) =>
			toolResult("read", `contents of file ${i + 1}`),
		);
		const messages = [
			...readResults,
			toolResult("bash", "npm test\n46 pass\n2 fail\nTests 48"),
			toolResult("read", "EISDIR: illegal operation on a directory, read", true),
			assistantMsg("## Implementation Review\n\n" + "x".repeat(13000)),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"complete review with trailing EISDIR must not be flagged as failure");
	});
});
