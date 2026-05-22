import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "../../src/shared/utils.ts";

function assistantContent(content: unknown[]): Message {
	return { role: "assistant", content } as unknown as Message;
}

describe("getFinalOutput", () => {
	it("uses the first non-empty text part in the latest assistant message", () => {
		const messages = [assistantContent([
			{ type: "text", text: "" },
			{ type: "text", text: "Summary" },
		])];

		assert.equal(getFinalOutput(messages), "Summary");
	});

	it("falls back to an older assistant message when the latest text is whitespace-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier" }]),
			assistantContent([{ type: "text", text: " \n\t " }]),
		];

		assert.equal(getFinalOutput(messages), "Earlier");
	});

	it("falls back to an older assistant message when the latest assistant message is tool-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier" }]),
			assistantContent([{ type: "toolCall", name: "read", arguments: { path: "README.md" } }]),
		];

		assert.equal(getFinalOutput(messages), "Earlier");
	});

	it("returns empty output when all assistant text is empty or whitespace-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "" }]),
			assistantContent([{ type: "text", text: "\n\t " }]),
		];

		assert.equal(getFinalOutput(messages), "");
	});

	it("does not use provider-error assistant text as fallback output", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "temporary provider failure" }],
				stopReason: "error",
				errorMessage: "provider transport failed",
			} as unknown as Message,
			assistantContent([{ type: "text", text: "" }]),
		];

		assert.equal(getFinalOutput(messages), "");
	});

	it("preserves surrounding whitespace on the selected non-empty text", () => {
		const messages = [assistantContent([{ type: "text", text: " \n Summary \n " }])];

		assert.equal(getFinalOutput(messages), " \n Summary \n ");
	});
});
