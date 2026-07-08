import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatWatchdogReviewMessage, formatWatchdogTurnDelta } from "../../src/watchdog/turn-delta.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../src/watchdog/types.ts";

describe("watchdog turn delta formatter", () => {
	it("formats user prompt, assistant text, thinking, tool calls, and tool results", () => {
		const delta = formatWatchdogTurnDelta({
			includeUserPrompt: true,
			userPrompt: "Implement the parser.",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the settings." },
						{ type: "thinking", thinking: "The settings parser is the risky part." },
						{ type: "toolCall", name: "bash", arguments: { command: "printf 'a\\nb'" } },
					],
				},
			],
			events: [
				{
					type: "tool_execution_end",
					toolName: "bash",
					result: { content: [{ type: "text", text: "a\nb" }] },
					isError: false,
				},
			],
		});

		assert.match(delta, /User prompt:\nImplement the parser\./);
		assert.match(delta, /Assistant:\nI will inspect the settings\./);
		assert.match(delta, /Thinking:\nThe settings parser is the risky part\./);
		assert.match(delta, /Tool call: bash\nArguments:\ncommand:/);
		assert.match(delta, /printf 'a\\nb'/);
		assert.match(delta, /Tool result: bash\nResult:\na\nb/);
	});

	it("uses a successful tool diff instead of noisy raw edit blobs", () => {
		const delta = formatWatchdogTurnDelta({
			messages: [
				{
					role: "assistant",
					content: [{
						type: "toolCall",
						name: "edit",
						arguments: {
							path: "src/file.ts",
							oldText: "huge old text",
							newText: "huge new text",
							edits: [{ oldText: "nested old text", newText: "nested new text" }],
						},
					}],
				},
				{
					role: "toolResult",
					toolName: "edit",
					content: "oldText: huge\nnewText: huge",
					details: { diff: "--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new" },
					isError: false,
				},
			],
		});

		assert.match(delta, /Tool result: edit\nDiff:\n--- a\/file\.ts/);
		assert.match(delta, /oldText: \[omitted 13 chars; use tool result diff\]/);
		assert.match(delta, /newText: \[omitted 13 chars; use tool result diff\]/);
		assert.match(delta, /oldText: \[omitted 15 chars; use tool result diff\]/);
		assert.match(delta, /newText: \[omitted 15 chars; use tool result diff\]/);
		assert.doesNotMatch(delta, /huge old text/);
		assert.doesNotMatch(delta, /huge new text/);
		assert.doesNotMatch(delta, /nested old text/);
		assert.doesNotMatch(delta, /nested new text/);
		assert.doesNotMatch(delta, /oldText: huge/);
	});

	it("marks failed tool results from isError and does not replace them with diffs", () => {
		const delta = formatWatchdogTurnDelta({
			messages: [{ role: "toolResult", toolName: "edit", isError: true, content: [{ type: "text", text: "edit failed" }], details: { diff: "should not render" } }],
		});

		assert.match(delta, /Tool result: edit\nError: tool reported an error\nOutput:\nedit failed/);
		assert.doesNotMatch(delta, /should not render/);
	});

	it("formats turn_end events with assistant message and tool results", () => {
		const delta = formatWatchdogTurnDelta({
			events: [
				{
					 type: "turn_end",
					 message: {
						 role: "assistant",
						 content: [
							{ type: "text", text: "I will run a check." },
							{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
						 ],
					 },
					 toolResults: [
						 { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "tests failed" }] },
					 ],
				},
			],
		});

		assert.match(delta, /Assistant:\nI will run a check\./);
		assert.match(delta, /Tool call: bash\nArguments:\ncommand: npm test/);
		assert.match(delta, /Tool result: bash\nError: tool reported an error\nOutput:\ntests failed/);
	});

	it("filters watchdog warning custom messages from its own review stream", () => {
		const warningMessage = {
			role: "custom",
			customType: SUBAGENT_WATCHDOG_WARNING_TYPE,
			content: "prior watchdog warning",
		};

		assert.equal(formatWatchdogReviewMessage(warningMessage), undefined);
		assert.equal(formatWatchdogTurnDelta({ messages: [warningMessage] }), "");
	});

	it("marks final assistant stop when represented", () => {
		const delta = formatWatchdogTurnDelta({
			messages: [{ role: "assistant", content: "Done.", stopReason: "stop" }],
			finalAssistantStop: true,
		});

		assert.match(delta, /Assistant stop: stop/);
		assert.match(delta, /Final assistant stop: stop without tool call/);
	});
});
