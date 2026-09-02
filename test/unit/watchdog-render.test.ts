import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatWatchdogWarningRenderText } from "../../src/watchdog/render.ts";
import { createWatchdogWarningMessage, formatWatchdogWarningContent } from "../../src/watchdog/warning-format.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE, type WatchdogWarningDetails } from "../../src/watchdog/types.ts";

describe("watchdog warning formatting and rendering", () => {
	it("puts all LLM-needed warning fields in custom message content", () => {
		const content = formatWatchdogWarningContent({
			severity: "blocker",
			category: "correctness",
			source: "main",
			summary: "Fix <bug>",
			evidence: "The failing assertion says A & B differ.",
			recommendedAction: "Update the parser before finalizing.",
			confidence: "high",
			agent: "main",
			runId: "run-1",
			stale: true,
		});

		assert.match(content, /^<subagent_watchdog severity="blocker" category="correctness" source="main" guidance="weigh, don't blindly obey">/);
		assert.match(content, /<summary>Fix &lt;bug&gt;<\/summary>/);
		assert.match(content, /<evidence>The failing assertion says A &amp; B differ\.<\/evidence>/);
		assert.match(content, /<recommended_action>Update the parser before finalizing\.<\/recommended_action>/);
		assert.match(content, /<confidence>high<\/confidence>/);
		assert.match(content, /<agent>main<\/agent>/);
		assert.match(content, /<run_id>run-1<\/run_id>/);
		assert.match(content, /<stale>true<\/stale>/);
		assert.doesNotMatch(content, /auto_follow/);
		assert.match(content, /<blocker_guidance>/);
	});

	it("keeps structured details alongside the LLM-visible content", () => {
		const message = createWatchdogWarningMessage({
			severity: "concern",
			summary: "Missing focused test",
			evidence: "The parser changed without a unit test.",
			recommendedAction: "Add a parser regression test.",
		});

		assert.equal(message.customType, SUBAGENT_WATCHDOG_WARNING_TYPE);
		assert.equal(message.display, true);
		assert.equal(message.details.category, "other");
		assert.equal(message.details.source, "main");
		assert.match(message.content, /<summary>Missing focused test<\/summary>/);
		assert.match(message.content, /<recommended_action>Add a parser regression test\.<\/recommended_action>/);
	});

	it("renders concern, blocker, stale, failed, and stalemate states in text", () => {
		const base: WatchdogWarningDetails = {
			severity: "blocker",
			category: "loop-risk",
			source: "main",
			summary: "Repeated blocker",
			evidence: "The same issue survived another continuation.",
			recommendedAction: "Ask for user review.",
			state: "stalemate",
			stalemateRepeats: 3,
		};

		const stalemate = formatWatchdogWarningRenderText(base);
		const stale = formatWatchdogWarningRenderText({ ...base, severity: "concern", state: "stale", stale: true });
		const failed = formatWatchdogWarningRenderText({ ...base, state: "failed", error: "provider aborted" });
		const displayed = formatWatchdogWarningRenderText({ ...base, state: "displayed" });

		assert.match(stalemate, /Subagent watchdog Blocker \(stalemate\): Repeated blocker/);
		assert.match(stalemate, /Same warning 3 times in a row; the watchdog stopped continuing the run\./);
		assert.match(stale, /Subagent watchdog Concern \(stale\): Repeated blocker/);
		assert.match(stale, /arrived after the watchdog catch-up timeout\./);
		assert.match(failed, /failed review/);
		assert.match(failed, /Failure: provider aborted/);
		assert.match(displayed, /Subagent watchdog Blocker \(displayed\): Repeated blocker/);
	});
});
