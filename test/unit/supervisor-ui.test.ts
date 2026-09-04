import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderSupervisorReply,
	renderSupervisorRequest,
	type SupervisorReplyEntryData,
	type SupervisorRequestMessageDetails,
} from "../../src/intercom/supervisor-ui.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
};

function renderRequest(details: SupervisorRequestMessageDetails, content: string, width = 100, expanded = true): string[] {
	const component = renderSupervisorRequest({ content, details }, { expanded }, identityTheme as never);
	assert.ok(component);
	return component.render(width);
}

function renderReply(data: SupervisorReplyEntryData, width = 100): string[] {
	const component = renderSupervisorReply({ data }, { expanded: true }, identityTheme as never);
	assert.ok(component);
	return component.render(width);
}

describe("native supervisor UI", () => {
	it("renders request metadata, interview shape, and an exact reply hint", () => {
		const requestId = "request-123456";
		const output = renderRequest({
			id: requestId,
			reason: "interview_request",
			expectsReply: true,
			runId: "run-1845",
			agent: "worker",
			childIndex: 2,
			childTarget: "child-worker",
			replyHint: `subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`,
			interview: { approved: "boolean", rationale: "string" },
			requestBody: "Should this change be applied?",
		}, [
			"Subagent requests a structured supervisor interview.",
			"Run: run-1845",
			"Agent: worker",
			"Child index: 2",
			"Should this change be applied?",
			`Reply with: subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`,
		].join("\n"));
		const text = output.join("\n");

		assert.match(text, /Supervisor interview request/);
		assert.match(text, /Reason: interview_request/);
		assert.match(text, /Run: run-1845/);
		assert.match(text, /Agent: worker/);
		assert.match(text, /Child index: 2/);
		assert.match(text, /Child target: child-worker/);
		assert.match(text, new RegExp(`Request ID: ${requestId}`));
		assert.match(text, new RegExp(`replyTo: "${requestId}"`));
		assert.match(text, /Interview shape:/);
		assert.match(text, /approved/);
		assert.match(text, /Should this change be applied/);
		assert.equal(text.match(/Run: run-1845/g)?.length, 1);
		assert.equal(text.match(/Agent: worker/g)?.length, 1);
		assert.equal(text.match(/Child index: 2/g)?.length, 1);
		assert.equal(text.match(/Reply with:/g)?.length, 1);
	});

	it("omits reply hints for progress updates and renders durable reply metadata", () => {
		const requestOutput = renderRequest({
			id: "progress-1",
			reason: "progress_update",
			expectsReply: false,
			runId: "run-progress",
			agent: "reviewer",
			childIndex: 0,
		}, "Progress is continuing.");
		assert.equal(requestOutput.join("\n").includes("Reply with:"), false);

		const replyOutput = renderReply({
			requestId: "request-1",
			reason: "need_decision",
			runId: "run-1",
			agent: "worker",
			childIndex: 1,
			childTarget: "child-worker",
			message: "Approved; continue.",
			createdAt: 123,
		});
		const text = replyOutput.join("\n");
		assert.match(text, /Supervisor reply to child/);
		assert.match(text, /Reply to: request-1/);
		assert.match(text, /Approved; continue\./);
		assert.match(text, /child-worker/);
	});

	it("ignores malformed request and reply metadata", () => {
		assert.equal(renderSupervisorRequest({ content: "request", details: { id: "request-1", expectsReply: true, replyHint: ["bad"] } }, { expanded: true }, identityTheme as never), undefined);
		assert.equal(renderSupervisorReply({ data: { requestId: "request-1", runId: "run-1", agent: "worker", childIndex: 0, message: ["bad"], createdAt: 123 } }, { expanded: true }, identityTheme as never), undefined);
	});

	it("sanitizes and bounds collapsed untrusted content at narrow widths", () => {
		const output = renderRequest({
			id: "request-long",
			reason: "need_decision",
			expectsReply: true,
			runId: "run-long",
			agent: "worker",
			childIndex: 0,
		}, `\u0001${"untrusted ".repeat(400)}`, 24, false);
		assert.ok(output.length <= 39, `expected bounded rows, got ${output.length}`);
		for (const line of output) assert.ok(visibleWidth(line) <= 24, `line exceeds width: ${line}`);
		const text = output.join("\n");
		assert.match(text, /truncated/);
		assert.equal(text.includes("\u0001"), false);
		assert.match(text, /\[U\+0001\]/);
	});

	it("keeps long blocking requests visible when expanded", () => {
		const content = `${Array.from({ length: 45 }, (_, index) => `decision line ${index + 1}`).join("\n")}\n${"body-detail ".repeat(800)}END_BODY`;
		const output = renderRequest({
			id: "request-expanded",
			reason: "need_decision",
			expectsReply: true,
			runId: "run-expanded",
			agent: "worker",
			childIndex: 0,
			interview: { questions: Array.from({ length: 12 }, (_, index) => ({ id: `q${index + 1}`, question: `${"Question detail ".repeat(40)}${index === 11 ? "END_INTERVIEW" : index + 1}` })) },
		}, content, 120, true);
		const text = output.join("\n");

		assert.ok(output.length > 39, `expected expanded rows, got ${output.length}`);
		assert.match(text, /decision line 45/);
		assert.match(text, /END_BODY/);
		assert.match(text, /END_INTERVIEW/);
		assert.doesNotMatch(text, /\[truncated\]/);
	});
});
