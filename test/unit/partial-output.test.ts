import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPartialOutputTracker, formatPartialOutput } from "../../src/runs/shared/partial-output.ts";
import { toWaitCompletion } from "../../src/runs/background/wait-completions.ts";

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });

describe("partial output tracker", () => {
	it("keeps the latest streamed assistant text", () => {
		const tracker = createPartialOutputTracker();
		tracker.observe({ type: "message_update", message: assistant("one") });
		tracker.observe({ type: "message_update", message: assistant("one two") });
		assert.equal(tracker.text(), "one two");
	});

	it("drops the text once the assistant message completes", () => {
		const tracker = createPartialOutputTracker();
		tracker.observe({ type: "message_update", message: assistant("one two") });
		tracker.observe({ type: "message_end", message: assistant("one two") });
		assert.equal(tracker.text(), undefined);
	});

	it("ignores user and tool-result messages", () => {
		const tracker = createPartialOutputTracker();
		tracker.observe({ type: "message_update", message: assistant("streaming") });
		tracker.observe({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
		tracker.observe({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } });
		assert.equal(tracker.text(), "streaming");
	});

	it("keeps the text of a failed provider message, which final output skips", () => {
		const tracker = createPartialOutputTracker();
		tracker.observe({ type: "message_end", message: assistant("cut off", { stopReason: "error", errorMessage: "overloaded" }) });
		assert.equal(tracker.text(), "cut off");
	});

	it("labels the cause", () => {
		assert.equal(formatPartialOutput("text", "timeout"), "Partial output before timeout:\ntext");
		assert.equal(formatPartialOutput("text", "child error"), "Partial output before child error:\ntext");
	});
});

describe("wait completion projection", () => {
	it("carries the partial flag", () => {
		const completion = toWaitCompletion({ results: [{ agent: "worker", outputState: "present", outputPartial: true }] }, "run-1");
		assert.equal(completion.results?.[0]?.outputPartial, true);
	});

	it("omits the flag when the output is complete", () => {
		const completion = toWaitCompletion({ results: [{ agent: "worker", outputState: "present" }] }, "run-1");
		assert.equal("outputPartial" in (completion.results?.[0] ?? {}), false);
	});
});
