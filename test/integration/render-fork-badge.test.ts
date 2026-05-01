import assert from "node:assert/strict";
import { describe, it } from "node:test";

type RenderSubagentResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		details?: {
			mode: "single" | "parallel" | "chain" | "management";
			context?: "fresh" | "fork";
			results: unknown[];
		};
	},
	options: { expanded: boolean },
	theme: {
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
) => { render(width: number): string[] };

let renderSubagentResult: RenderSubagentResult | undefined;
({ renderSubagentResult } = await import("../../src/tui/render.ts") as {
	renderSubagentResult?: RenderSubagentResult;
});

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function withTerminalWidth<T>(columns: number, fn: () => T): T {
	const original = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process.stdout, "columns", {
			value: original,
			configurable: true,
		});
	}
}

describe("renderSubagentResult fork indicator", () => {
	it("shows [fork] when details are empty but context is fork", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "Async: reviewer [abc123]" }],
			details: { mode: "single", context: "fork", results: [] },
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("shows [fork] on single-result header", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				context: "fork",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("uses compacted tool-call summaries when messages were stripped", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: undefined,
					toolCalls: [{
						text: "$ npm test -- --watch...",
						expandedText: "$ npm test -- --watch --runInBand --reporter=dot",
					}],
					usage: emptyUsage,
				}],
			},
		}, { expanded: true }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /npm test -- --watch --runInBand --reporter=dot/);
	});

	it("shows actual and requested models when they differ", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: { ...emptyUsage, turns: 1, input: 10, output: 5 },
					model: "anthropic/claude-sonnet-4-actual",
					preferredModel: "openai/gpt-4o",
				}],
			},
		}, { expanded: true }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /anthropic\/claude-sonnet-4-actual \(requested openai\/gpt-4o\)/);
	});

	it("shows the full task in expanded mode", () => {
		const longTask = "Review the auth flow, trace the race condition, and document the precise failing tool sequence at the end.";
		const collapsed = withTerminalWidth(40, () => renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: longTask,
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme).render(40).join("\n"));

		const expanded = withTerminalWidth(40, () => renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: longTask,
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: true }, theme).render(40).join("\n"));

		const unwrap = (text: string) => text.replace(/\s+/g, "");
		assert.doesNotMatch(unwrap(collapsed), /precisefailingtoolsequenceattheend\./);
		assert.match(unwrap(expanded), /precisefailingtoolsequenceattheend\./);
	});

	it("uses glyph-first compact rendering for completed subagents", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: { ...emptyUsage, turns: 2 },
					progressSummary: { toolCount: 3, tokens: 1200, durationMs: 1500 },
					sessionFile: "/tmp/session.jsonl",
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /^✓ reviewer/);
		assert.match(text, /⟳2/);
		assert.match(text, /3 tool uses/);
		assert.match(text, /1\.2k token/);
		assert.match(text, /⎿  Done/);
		assert.match(text, /session: \/tmp\/session\.jsonl/);
	});

	it("keeps failure reasons visible in compact rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "failed" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 1,
					error: "boom",
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /^✗ reviewer/);
		assert.match(text, /⎿  Error: boom/);
	});

	it("shows live detail hints for running subagents", () => {
		const now = Date.now();
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					artifactPaths: {
						outputPath: "/tmp/reviewer_output.md",
					},
					usage: emptyUsage,
					progress: {
						index: 0,
						agent: "reviewer",
						status: "running",
						task: "review",
						lastActivityAt: now - 2_000,
						currentTool: "read",
						currentToolArgs: "package.json",
						currentToolStartedAt: now - 3_000,
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 42,
						durationMs: 3_000,
					},
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /Press Ctrl\+O for live detail/);
		assert.match(text, /active 2s ago/);
		assert.match(text, /⎿  read: package\.json \| 3\.0s/);
		assert.match(text, /output: \/tmp\/reviewer_output\.md/);
	});

	it("keeps paused multi-result runs visible in the compact headline", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "paused" }],
			details: {
				mode: "chain",
				chainAgents: ["worker"],
				results: [{
					agent: "worker",
					task: "pause",
					exitCode: 0,
					interrupted: true,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /^■ chain/);
		assert.match(text, /⎿  Paused/);
	});

	it("keeps empty-output warnings visible in compact multi-result rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "chain",
				chainAgents: ["worker"],
				results: [{
					agent: "worker",
					task: "check without output target",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /⎿  Done \(no text output\)/);
		assert.doesNotMatch(text, /0ms/);
	});

	it("keeps pending placeholder steps pending in compact rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				chainAgents: ["a", "b"],
				totalSteps: 2,
				currentStepIndex: 0,
				results: [{
					agent: "a",
					task: "first",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "a", status: "running", task: "first", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "b",
					task: "second",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "b", status: "pending", task: "second", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
			},
		}, { expanded: false }, theme);

		const lines = widget.render(120);
		const pendingIndex = lines.findIndex((line) => /Step 2: b/.test(line));
		assert.notEqual(pendingIndex, -1);
		assert.match(lines[pendingIndex]!, /◦ Step 2: b · pending/);
		assert.doesNotMatch(lines[pendingIndex]!, /0ms/);
		assert.doesNotMatch(lines[pendingIndex + 1] ?? "", /Done \(no text output\)/);
	});

	it("uses running/done wording and agent fractions for live parallel rendering", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				totalSteps: 3,
				results: [{
					agent: "worker",
					task: "third task",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: {
						index: 2,
						agent: "worker",
						status: "running",
						task: "third task",
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 0,
						durationMs: 10,
					},
				}],
				progress: [{
					index: 0,
					agent: "scout",
					status: "running",
					task: "first",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					tokens: 0,
					durationMs: 10,
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /parallel · 2 agents running · 0\/3 done/);
		assert.match(text, /Agent 3\/3: worker/);
		assert.doesNotMatch(text, /Step 3: worker/);
		assert.doesNotMatch(text, /Agent 1: worker/);
	});

	it("shows mixed done/running counters for top-level parallel mode", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				totalSteps: 3,
				results: [{
					agent: "scout",
					task: "first",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "scout", status: "completed", task: "first", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 },
				}, {
					agent: "reviewer",
					task: "second",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "reviewer", status: "running", task: "second", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 },
				}],
				progress: [{ index: 0, agent: "scout", status: "completed", task: "first", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 }, { index: 1, agent: "reviewer", status: "running", task: "second", recentTools: [], recentOutput: [], toolCount: 1, tokens: 0, durationMs: 10 }],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /parallel · 1 agent running · 1\/3 done/);
	});

	it("labels active chain parallel groups with chain step and agent fractions", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				currentStepIndex: 0,
				chainAgents: ["[scout+reviewer+worker]", "planner", "writer"],
				results: [{
					agent: "scout",
					task: "scan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
				progress: [{ index: 0, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 }, { index: 1, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 }],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 1\/3 · parallel group: 2 agents running · 0\/3 done/);
		assert.match(text, /Agent 1\/3: scout/);
		assert.match(text, /Agent 2\/3: reviewer/);
		assert.doesNotMatch(text, /Step 1: scout/);
	});

	it("shows only the active parallel group for mixed chains after a serial step", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				currentStepIndex: 1,
				chainAgents: ["planner", "[scout+reviewer]", "writer"],
				results: [{
					agent: "planner",
					task: "plan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "planner", status: "completed", task: "plan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "scout",
					task: "scan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 1, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}, {
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 2, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
				progress: [
					{ index: 0, agent: "planner", status: "completed", task: "plan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
					{ index: 1, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
					{ index: 2, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 2\/3 · parallel group: 2 agents running · 0\/2 done/);
		assert.match(text, /Agent 1\/2: scout/);
		assert.match(text, /Agent 2\/2: reviewer/);
		assert.doesNotMatch(text, /planner/);
		assert.doesNotMatch(text, /Agent 1\/2: planner/);
	});

	it("uses logical chain progress and agent labels for completed mixed chains", () => {
		const progress = [
			{ index: 0, agent: "planner", status: "completed" as const, task: "plan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
			{ index: 1, agent: "scout", status: "completed" as const, task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
			{ index: 2, agent: "reviewer", status: "completed" as const, task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
			{ index: 3, agent: "writer", status: "completed" as const, task: "write", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 1 },
		];
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				chainAgents: ["planner", "[scout+reviewer]", "writer"],
				results: progress.map((entry) => ({
					agent: entry.agent,
					task: entry.task,
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progressSummary: { toolCount: 0, tokens: 0, durationMs: 1 },
				})),
				progress,
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 3\/3/);
		assert.match(text, /Step 1: planner/);
		assert.match(text, /Agent 1\/2: scout/);
		assert.match(text, /Agent 2\/2: reviewer/);
		assert.match(text, /Step 3: writer/);
		assert.doesNotMatch(text, /step 4\/4/);
	});

	it("keeps serial chain wording for non-parallel steps", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				currentStepIndex: 0,
				chainAgents: ["scout", "reviewer", "worker"],
				results: [{
					agent: "scout",
					task: "scan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /chain · step 1\/3/);
		assert.match(text, /Step 1: scout/);
		assert.doesNotMatch(text, /parallel group:/);
	});
});
