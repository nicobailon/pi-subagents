import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "../../src/shared/utils.ts";

function assistantContent(content: unknown[]): Message {
	return { role: "assistant", content } as unknown as Message;
}

describe("getFinalOutput", () => {
	it("uses the last non-empty text part in the latest assistant message", () => {
		const messages = [assistantContent([
			{ type: "text", text: "" },
			{ type: "text", text: "Summary" },
		])];

		assert.equal(getFinalOutput(messages), "Summary");
	});

	it("prefers final text over progress text in a multi-part assistant message", () => {
		const messages = [assistantContent([
			{ type: "text", text: "Working on the fix..." },
			{ type: "thinking", thinking: "Cursor shell: shell $ npm test" },
			{ type: "text", text: "Implemented: patch applied." },
		])];

		assert.equal(getFinalOutput(messages), "Implemented: patch applied.");
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

	it("prefers an earlier explicit acceptance report over later summary-only text", () => {
		const report = [
			"Done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified" }],
				changedFiles: ["src/file.ts"],
			}),
			"```",
		].join("\n");
		const messages = [
			assistantContent([{ type: "text", text: report }]),
			assistantContent([{ type: "text", text: "Done." }]),
		];

		assert.equal(getFinalOutput(messages), report);
	});

	it("prefers an earlier json-fenced acceptance report over later summary-only text", () => {
		const report = [
			"Done",
			"```json",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified" }],
				validationOutput: ["tests passed"],
			}),
			"```",
		].join("\n");
		const messages = [
			assistantContent([{ type: "text", text: report }]),
			assistantContent([{ type: "text", text: "Done." }]),
		];

		assert.equal(getFinalOutput(messages), report);
	});

	it("preserves prose from a sibling text part when selecting an acceptance report", () => {
		const report = "```acceptance-report\n{}\n```";
		const messages = [assistantContent([
			{ type: "text", text: "Human-readable answer." },
			{ type: "text", text: report },
		])];

		assert.equal(getFinalOutput(messages), `Human-readable answer.\n${report}`);
	});

	it("recognizes underscore fences and snake_case generic report keys", () => {
		for (const report of [
			"```acceptance_report\n{}\n```",
			`\`\`\`json\n${JSON.stringify({ criteria_satisfied: [], validation_output: ["passed"] })}\n\`\`\``,
		]) {
			const messages = [
				assistantContent([{ type: "text", text: report }]),
				assistantContent([{ type: "text", text: "Later summary." }]),
			];
			assert.equal(getFinalOutput(messages), report);
		}
	});

	it("does not prefer provider-error acceptance reports", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "```acceptance-report\n{}\n```" }],
				stopReason: "error",
				errorMessage: "provider transport failed",
			} as unknown as Message,
			assistantContent([{ type: "text", text: "Done." }]),
		];

		assert.equal(getFinalOutput(messages), "Done.");
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
