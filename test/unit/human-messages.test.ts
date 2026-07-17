import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatHumanControlNotice,
	formatHumanSupervisorRequest,
	resolveChildPresentation,
	type SupervisorRequestMessageDetails,
} from "../../src/extension/human-messages.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

function controlEvent(overrides: Partial<ControlEvent> = {}): ControlEvent {
	return {
		type: "needs_attention",
		to: "needs_attention",
		ts: 1,
		runId: "12345678-abcd-4abc-8abc-1234567890ab",
		agent: "worker",
		index: 2,
		message: "No child activity was observed during the attention window.",
		reason: "idle",
		elapsedMs: 125_000,
		currentTool: "bash",
		currentToolDurationMs: 65_000,
		currentPath: "/tmp/project/src/index.ts",
		recentFailureSummary: "npm test exited 1",
		turns: 8,
		tokens: 4321,
		toolCount: 12,
		...overrides,
	};
}

function supervisorDetails(overrides: Partial<SupervisorRequestMessageDetails> = {}): SupervisorRequestMessageDetails {
	return {
		id: "request-123",
		reason: "need_decision",
		expectsReply: true,
		runId: "abcdef12-abcd-4abc-8abc-1234567890ab",
		agent: "worker",
		childIndex: 1,
		label: "Implement API",
		role: "worker",
		logicalStep: 2,
		totalSteps: 4,
		question: "Should the API return 404 or 410?\nThe compatibility contract is ambiguous.",
		...overrides,
	};
}

function presentationState(): Pick<SubagentState, "asyncJobs" | "foregroundRuns"> {
	return {
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
	};
}

describe("compact human message formatting", () => {
	it("renders control notices compact by default without verbose diagnostics", () => {
		const rendered = formatHumanControlNotice({
			label: "Implement API",
			role: "worker",
			logicalStep: 2,
			totalSteps: 4,
			event: controlEvent(),
		}, false, "Ctrl+O");

		assert.equal(rendered, [
			"⚠ Implement API [worker] may be stuck · no activity for 2m 5s",
			"Step 2/4 · run 12345678 · Ctrl+O for details",
		].join("\n"));
		assert.doesNotMatch(rendered, /No child activity|\/tmp\/project|npm test|4321/);
	});

	it("renders complete control diagnostics when expanded", () => {
		const rendered = formatHumanControlNotice({
			label: "Implement API",
			role: "worker",
			logicalStep: 2,
			totalSteps: 4,
			event: controlEvent(),
		}, true, "Ctrl+O");

		assert.match(rendered, /^⚠ Implement API \[worker\] may be stuck/);
		assert.match(rendered, /Implement API \[worker\] · Step 2\/4 · run 12345678/);
		assert.match(rendered, /Observed: No child activity was observed during the attention window\./);
		assert.match(rendered, /Current activity: bash for 1m 5s/);
		assert.match(rendered, /Working in: \/tmp\/project\/src\/index\.ts/);
		assert.match(rendered, /Recent failures: npm test exited 1/);
		assert.match(rendered, /Diagnostics: 8 turns · 4321 tokens · 12 tools/);
		assert.match(rendered, /Recommendation: inspect current status/);
	});

	it("uses safe legacy control content as an expanded structured fallback only", () => {
		const legacyContent = [
			"Subagent needs attention: worker",
			"Run: 12345678-abcd-4abc-8abc-1234567890ab step 3",
			"Signal: The compiler found a compatibility regression in the public API.",
			"Recent failures: npm test failed in compatibility.test.ts",
			"Facts: 9 turns | 17 tools",
			"Hint: Inspect the failing assertion before changing the implementation.",
			'Status: subagent({ action: "status", id: "12345678-abcd-4abc-8abc-1234567890ab" })',
			'Interrupt: subagent({ action: "interrupt", id: "12345678-abcd-4abc-8abc-1234567890ab" })',
			"Direct intercom target: internal-worker-channel",
		].join("\n");
		const details = {
			label: "Implement API",
			role: "worker",
			logicalStep: 2,
			totalSteps: 4,
			event: controlEvent({
				message: "",
				currentTool: undefined,
				currentPath: undefined,
				recentFailureSummary: undefined,
				turns: undefined,
				tokens: undefined,
				toolCount: undefined,
			}),
		};

		const collapsed = formatHumanControlNotice(details, false, "Alt+E", legacyContent);
		const expanded = formatHumanControlNotice(details, true, "Alt+E", legacyContent);

		assert.match(collapsed, /Alt\+E for details/);
		assert.doesNotMatch(collapsed, /compatibility regression|subagent\s*\(|intercom target/i);
		assert.match(expanded, /Observed: The compiler found a compatibility regression in the public API\./);
		assert.match(expanded, /Recent failures: npm test failed in compatibility\.test\.ts/);
		assert.match(expanded, /Diagnostics: 9 turns \| 17 tools/);
		assert.match(expanded, /Recommendation: Inspect the failing assertion/);
		assert.doesNotMatch(expanded, /subagent\s*\(|intercom target|internal-worker-channel|action: "(?:status|interrupt)"/i);
	});

	it("prefers complete structured control fields over lossy legacy summaries", () => {
		const details = {
			label: "Implement API",
			role: "worker",
			logicalStep: 2,
			totalSteps: 4,
			event: controlEvent({
				message: "First observed line.\nSecond observed line.",
				recentFailureSummary: "First failure line.\nSecond failure line.",
			}),
		};
		const legacyContent = [
			"Signal: Truncated legacy observation",
			"Recent failures: Truncated legacy failure",
		].join("\n");

		const expanded = formatHumanControlNotice(details, true, "Ctrl+O", legacyContent);

		assert.match(expanded, /Observed: First observed line\.\nSecond observed line\./);
		assert.match(expanded, /Recent failures: First failure line\.\nSecond failure line\./);
		assert.doesNotMatch(expanded, /Truncated legacy/);
	});

	it("renders supervisor requests compactly and expands the complete question and interview", () => {
		const details = supervisorDetails({
			reason: "interview_request",
			interview: {
				title: "Compatibility choice",
				action: "choose release strategy",
				questions: [{ id: "status", choices: [404, 410] }],
			},
		});
		const collapsed = formatHumanSupervisorRequest(details, false, "Ctrl+O");
		const expanded = formatHumanSupervisorRequest(details, true, "Ctrl+O");

		assert.equal(collapsed, [
			"⚠ Supervisor interview needed · Implement API [worker]",
			"Should the API return 404 or 410? · Step 2/4 · run abcdef12 · Ctrl+O for details",
		].join("\n"));
		assert.doesNotMatch(collapsed, /compatibility contract|Compatibility choice|Choices/);
		assert.match(expanded, /Reply required/);
		assert.match(expanded, /Should the API return 404 or 410\?\nThe compatibility contract is ambiguous\./);
		assert.match(expanded, /Structured interview:\nTitle: Compatibility choice\nAction: choose release strategy/);
		assert.match(expanded, /Questions:\n  - Id: status\n    Choices:\n      - 404\n      - 410/);
	});

	it("extracts complete legacy questions and interviews without rendering commands or raw JSON", () => {
		const legacyContent = [
			"Subagent requests a structured supervisor interview.",
			"Run: abcdef12-abcd-4abc-8abc-1234567890ab",
			"Agent: worker",
			"Child index: 1",
			"Child intercom target: internal-worker-channel",
			"",
			"Which status preserves compatibility?",
			"Include the migration impact in the decision.",
			"",
			"Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.",
			JSON.stringify({
				title: "Compatibility choice",
				questions: [{ id: "status", prompt: "Select the status", choices: [404, 410] }],
			}, null, "\t"),
			"",
			'Reply with: subagent_supervisor({ action: "reply", replyTo: "request-123", message: "..." })',
		].join("\n");
		const details = supervisorDetails({ reason: "interview_request", question: undefined, interview: undefined });

		const collapsed = formatHumanSupervisorRequest(details, false, "Alt+E", legacyContent);
		const expanded = formatHumanSupervisorRequest(details, true, "Alt+E", legacyContent);

		assert.equal(collapsed, [
			"⚠ Supervisor interview needed · Implement API [worker]",
			"Which status preserves compatibility? · Step 2/4 · run abcdef12 · Alt+E for details",
		].join("\n"));
		assert.match(expanded, /Which status preserves compatibility\?\nInclude the migration impact in the decision\./);
		assert.match(expanded, /Structured interview:\nTitle: Compatibility choice/);
		assert.match(expanded, /Prompt: Select the status/);
		assert.match(expanded, /Choices:\n      - 404\n      - 410/);
		assert.doesNotMatch(expanded, /subagent_supervisor\s*\(|replyTo|internal-worker-channel|[{}]|"questions"/i);
	});

	it("keeps progress updates visually informational and marks them as no-reply", () => {
		const rendered = formatHumanSupervisorRequest(supervisorDetails({
			reason: "progress_update",
			expectsReply: false,
			question: "Validation is now passing.",
		}), true, "Ctrl+O");

		assert.match(rendered, /^↗ Implement API \[worker\] · progress update/);
		assert.match(rendered, /No reply required/);
		assert.match(rendered, /Validation is now passing\./);
	});
});

describe("child presentation details", () => {
	it("uses async labels and logical chain positions for flattened parallel children", () => {
		const state = presentationState();
		state.asyncJobs.set("run-chain", {
			asyncId: "run-chain",
			asyncDir: "/tmp/run-chain",
			status: "running",
			mode: "chain",
			chainStepCount: 3,
			parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
			steps: [
				{ index: 0, agent: "scout", label: "Discover", status: "complete" },
				{ index: 1, agent: "reviewer", label: "API review", status: "running" },
				{ index: 2, agent: "worker", label: "Implementation", status: "running" },
				{ index: 3, agent: "tester", label: "Validate", status: "pending" },
			],
		});

		assert.deepEqual(resolveChildPresentation(state, "run-chain", "worker", 2), {
			label: "Implementation",
			role: "worker",
			logicalStep: 2,
			totalSteps: 3,
		});
	});

	it("falls back to stable agent and child-index details when run metadata is unavailable", () => {
		assert.deepEqual(resolveChildPresentation(presentationState(), "missing-run", "worker", 3), {
			label: "worker",
			role: "worker",
			logicalStep: 4,
		});
	});
});
