import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCEPTANCE_PREVIEW_MARKERS, appendStreamingAcceptancePreview, appendToolActivity, emptyStreamingAcceptancePreviewState, finalizeStreamingAcceptancePreview, sanitizeObservableText, suppressStreamingAcceptanceProtocol, visibleAssistantText } from "../../src/runs/background/live-observability.ts";

describe("async live observability", () => {
	it("accepts only explicitly visible assistant text and sanitizes controls", () => {
		assert.equal(visibleAssistantText({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hi\u001b]0;bad\u0007\nthere" } }), "hi there");
		assert.equal(visibleAssistantText({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "secret" } }), undefined);
		assert.equal(visibleAssistantText({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", text: "secret" }] } }), undefined);
		assert.equal(visibleAssistantText({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "no" }] } }), undefined);
	});
	it("suppresses both acceptance markers at every streaming split position", () => {
		for (const marker of ACCEPTANCE_PREVIEW_MARKERS) {
			for (let split = 1; split < marker.length; split++) {
				let state = appendStreamingAcceptancePreview(emptyStreamingAcceptancePreviewState(), `useful ${marker.slice(0, split)}`);
				assert.equal(state.visibleText, "useful ", `${marker} split ${split} exposed its prefix`);
				assert.equal(state.pendingMarker, marker.slice(0, split));
				state = appendStreamingAcceptancePreview(state, `${marker.slice(split)} private`);
				assert.equal(state.protocolOpen, true, `${marker} split ${split} did not open the protocol`);
				assert.equal(state.visibleText, "useful");
			}
		}
		assert.equal(suppressStreamingAcceptanceProtocol("```accept"), "```accept");
		assert.equal(suppressStreamingAcceptanceProtocol("```acceptance-report"), "");
		assert.equal(suppressStreamingAcceptanceProtocol("useful text ```acceptance-report { protocol"), "useful text");
		assert.equal(suppressStreamingAcceptanceProtocol("ordinary visible text"), "ordinary visible text");
	});
	it("keeps every opened marker bounded through long tails and safely finalizes unresolved carry", () => {
		for (const marker of ACCEPTANCE_PREVIEW_MARKERS) {
			let state = emptyStreamingAcceptancePreviewState();
			state = appendStreamingAcceptancePreview(state, `useful ${marker.slice(0, 1)}`);
			state = appendStreamingAcceptancePreview(state, marker.slice(1));
			for (let index = 0; index < 100; index++) state = appendStreamingAcceptancePreview(state, "private protocol tail ".repeat(20));
			assert.equal(state.protocolOpen, true);
			assert.equal(state.visibleText, "useful");
			assert.ok(state.visibleText.length <= 4_000);
			assert.ok(state.pendingMarker.length < marker.length);
		}

		for (const marker of ACCEPTANCE_PREVIEW_MARKERS) {
			for (let length = 1; length < marker.length; length++) {
				const partial = `ordinary ${marker.slice(0, length)}`;
				const finalized = finalizeStreamingAcceptancePreview(appendStreamingAcceptancePreview(emptyStreamingAcceptancePreviewState(), partial));
				assert.equal(finalized.visibleText, partial);
				assert.equal(finalized.pendingMarker, "");
				assert.equal(finalized.protocolOpen, false);
			}
		}
		const bounded = finalizeStreamingAcceptancePreview(appendStreamingAcceptancePreview(emptyStreamingAcceptancePreviewState(), `${"x".repeat(10_000)}A`));
		assert.equal(bounded.visibleText.length, 4_000);
		assert.ok(bounded.visibleText.endsWith("A"));
	});
	it("bounds display strings and completed tool history", () => {
		assert.equal(Array.from(sanitizeObservableText("x".repeat(500)) ?? "").length, 240);
		let history = undefined;
		for (let i = 0; i < 7; i++) history = appendToolActivity(history, { tool: "read", endMs: i, outcome: "success", toolCallId: String(i) });
		assert.deepEqual(history?.map((item) => item.endMs), [2, 3, 4, 5, 6]);
	});
});
