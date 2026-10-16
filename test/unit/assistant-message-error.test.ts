import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantMessageError } from "../../src/shared/utils.ts";
import { isContextOverflow } from "../../src/runs/shared/model-resolution.ts";
import { formatResumeFirstFailedRunDetail } from "../../src/runs/background/resume-guidance.ts";
import type { AsyncRunSummary } from "../../src/runs/background/async-status.ts";

const refusal = "This request was blocked by the provider's usage policy.";

describe("assistantMessageError", () => {
	it("keeps the provider's explanation next to a provider stop code", () => {
		const error = assistantMessageError({
			errorMessage: "Provider finish_reason: content_filter",
			rawStopReason: "content_filter",
			content: [{ type: "text", text: refusal }],
		});
		assert.equal(error, `Provider finish_reason: content_filter\nReply text: ${refusal}`);
	});

	it("classifies the error without the reply text", () => {
		const error = assistantMessageError({ errorMessage: "Provider finish_reason: content_filter", rawStopReason: "content_filter", content: [{ type: "text", text: "I cannot help bypass the token limit on that service." }] });
		assert.match(error ?? "", /token limit/);
		assert.equal(isContextOverflow(error), false);
		assert.equal(isContextOverflow("maximum context length exceeded\nReply text: unrelated"), true);
	});

	it("caps a long provider message", () => {
		const error = assistantMessageError({ errorMessage: "Provider finish_reason: content_filter", rawStopReason: "content_filter", content: [{ type: "text", text: "x".repeat(2000) }] }) ?? "";
		assert.ok(error.length < 600, `${error.length}`);
		assert.match(error, /…$/);
	});

	it("leaves an error without a provider stop reason unchanged, so partial text is not reported as an explanation", () => {
		assert.equal(assistantMessageError({ errorMessage: "overloaded", content: [{ type: "text", text: "text before the provider error" }] }), "overloaded");
	});

	it("does not repeat text the error already contains, and handles a message without text", () => {
		assert.equal(assistantMessageError({ errorMessage: `The model refused: ${refusal}`, rawStopReason: "refusal", content: [{ type: "text", text: refusal }] }), `The model refused: ${refusal}`);
		assert.equal(assistantMessageError({ errorMessage: "Provider finish_reason: content_filter", rawStopReason: "content_filter", content: [] }), "Provider finish_reason: content_filter");
		assert.equal(assistantMessageError({ content: [{ type: "text", text: "fine" }] }), undefined);
	});
});

describe("resume guidance with reply text", () => {
	it("does not read appended reply text as an intercom detach", () => {
		const replyMentioningDetach = assistantMessageError({ errorMessage: "Provider finish_reason: content_filter", rawStopReason: "content_filter", content: [{ type: "text", text: "The earlier run was detached for intercom coordination." }] });
		const run = { id: "run-1", state: "failed", asyncDir: "missing-dir", steps: [{ index: 0, agent: "worker", status: "failed", error: replyMentioningDetach }], error: replyMentioningDetach } as unknown as AsyncRunSummary;
		assert.equal(formatResumeFirstFailedRunDetail(run), undefined);
		const detached = { ...run, steps: [{ ...run.steps[0], error: "Run 'x' detached for intercom coordination." }] } as unknown as AsyncRunSummary;
		assert.match(formatResumeFirstFailedRunDetail(detached) ?? "", /Reply to the supervisor request first/);
	});
});
