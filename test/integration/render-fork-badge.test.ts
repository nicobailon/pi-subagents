import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyText } from "@earendil-works/pi-coding-agent";

type RenderSubagentResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
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
const expandKey = keyText("app.tools.expand");
const expandHint = `Press ${expandKey} for full output`;

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function nestedChild(id: string, state: "running" | "complete" | "failed" = "running") {
	return {
		id,
		parentRunId: "root",
		parentStepIndex: 0,
		depth: 1,
		path: [{ runId: "root", stepIndex: 0, agent: "owner" }],
		state,
		agent: id,
		lastUpdate: 1_700_000_002_000,
		...(state === "running" ? { currentTool: "bash" } : {}),
	};
}

function firstGrapheme(text: string): string {
	return Array.from(text.trimStart())[0] ?? "";
}

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
	it("renders result-owned nested children for foreground single, parallel, and chain runs", () => {
		const cases = [
			{
				mode: "single" as const,
				results: [{ agent: "single", task: "run", exitCode: 0, messages: [], usage: emptyUsage, children: [nestedChild("single-child")] }],
			},
			{
				mode: "parallel" as const,
				totalSteps: 2,
				results: [
					{ agent: "parallel-a", task: "run", exitCode: 0, messages: [], usage: emptyUsage, progress: { status: "running", index: 0, agent: "parallel-a", toolCount: 0, tokens: 0, durationMs: 0 }, children: [nestedChild("parallel-child-a")] },
					{ agent: "parallel-b", task: "run", exitCode: 0, messages: [], usage: emptyUsage, progress: { status: "running", index: 1, agent: "parallel-b", toolCount: 0, tokens: 0, durationMs: 0 }, children: [nestedChild("parallel-child-b")] },
				],
			},
			{
				mode: "chain" as const,
				chainAgents: ["chain-a", "chain-b"],
				results: [
					{ agent: "chain-a", task: "run", exitCode: 0, messages: [], usage: emptyUsage, progress: { status: "running", index: 0, agent: "chain-a", toolCount: 0, tokens: 0, durationMs: 0 }, children: [nestedChild("chain-child-a")] },
					{ agent: "chain-b", task: "run", exitCode: 0, messages: [], usage: emptyUsage, progress: { status: "running", index: 1, agent: "chain-b", toolCount: 0, tokens: 0, durationMs: 0 }, children: [nestedChild("chain-child-b")] },
				],
			},
		];

		for (const details of cases) {
			const widget = renderSubagentResult!({ content: [{ type: "text", text: "running" }], details }, { expanded: true }, theme);
			const text = widget.render(160).join("\n");
			for (const result of details.results) {
				assert.match(text, new RegExp(`${result.children[0].id} · running`));
			}
		}
	});

	it("renders result-owned nested children for terminal foreground results", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "failed" }],
			details: {
				mode: "parallel",
				totalSteps: 1,
				results: [{
					agent: "owner",
					task: "run",
					exitCode: 1,
					error: "failed",
					messages: [],
					usage: emptyUsage,
					children: [nestedChild("terminal-child", "failed")],
				}],
			},
		}, { expanded: true }, theme);

		assert.match(widget.render(160).join("\n"), /terminal-child · failed/);

		const compact = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [{
					agent: "owner",
					task: "run",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					children: [nestedChild("compact-terminal-child", "complete")],
				}],
			},
		}, { expanded: false }, theme).render(160).join("\n");
		assert.match(compact, /↳ \[\d{2}:\d{2}:\d{2}\] \+1 nested run \(1 complete\)/);
		assert.doesNotMatch(compact, /compact-terminal-child · complete/);
	});
	it("collapses multiline structured management output to a first-line summary", () => {
		const output = `\n${"Managed agents: ".padEnd(220, "x")}\n- reviewer\n- writer`;
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: output }],
			details: { mode: "management", context: "fork", results: [] },
		}, { expanded: false }, theme);

		const lines = widget.render(120).map((line) => line.trimEnd());
		assert.match(lines[0]!, /^\[fork\] Managed agents:/);
		assert.match(lines[0]!, /…$/);
		const hintLineIndex = lines.findIndex((line) => line.includes(expandHint) || (expandKey === "" && line.includes("Press ") && line.includes(" for full output")));
		assert.ok(hintLineIndex > 0);
		assert.doesNotMatch(lines[0]!, /reviewer/);
	});

	it("keeps multiline structured zero-result errors visible", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "Error: management failed\nfirst diagnostic\nsecond diagnostic" }],
			isError: true,
			details: { mode: "management", results: [] },
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /Error: management failed/);
		assert.match(text, /first diagnostic/);
		assert.match(text, /second diagnostic/);
		assert.ok(!text.includes(expandHint));
	});

	it("keeps full multiline structured output when expanded", () => {
		const output = "Managed agents:\n- reviewer\n- writer";
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: output }],
			details: { mode: "management", results: [] },
		}, { expanded: true }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /Managed agents:/);
		assert.match(text, /- reviewer/);
		assert.match(text, /- writer/);
		assert.ok(!text.includes(expandHint));
	});

	it("collapses multiline structured single output using the same contract", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "Run status:\nState: running\nTranscript: available" }],
			details: { mode: "single", results: [] },
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /^Run status:/);
		assert.match(text, /3 lines/);
		assert.ok(text.includes(expandHint) || (expandKey === "" && text.includes("Press ") && text.includes(" for full output")));
		assert.doesNotMatch(text, /State: running/);
	});

	it("preserves unstructured multiline and structured single-line output", () => {
		const unstructured = renderSubagentResult!({
			content: [{ type: "text", text: "Error:\nfirst detail\nsecond detail" }],
		}, { expanded: false }, theme).render(120).join("\n");
		assert.match(unstructured, /first detail/);
		assert.match(unstructured, /second detail/);
		assert.ok(!unstructured.includes(expandHint));

		const singleLine = renderSubagentResult!({
			content: [{ type: "text", text: "No active async run transcript is available." }],
			details: { mode: "single", results: [] },
		}, { expanded: false }, theme).render(120).map((line) => line.trimEnd()).join("\n");
		assert.equal(singleLine, "No active async run transcript is available.");
		assert.ok(!singleLine.includes(expandHint));
	});

	it("shows [fork] when details are empty but context is fork", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "Async: reviewer [abc123]" }],
			details: { mode: "single", context: "fork", results: [] },
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /\[fork\]/);
	});

	it("shows nested foreground children with timestamps on running single results", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "single",
				results: [{
					agent: "execute",
					task: "run plan",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { status: "running", index: 0, agent: "execute", toolCount: 1, tokens: 10, durationMs: 1_000, lastActivityAt: 1_700_000_001_000 },
					children: [{
						id: "impl-1",
						parentRunId: "root",
						parentStepIndex: 0,
						depth: 1,
						path: [{ runId: "root", stepIndex: 0, agent: "execute" }],
						state: "running",
						agent: "implement",
						lastUpdate: 1_700_000_002_000,
						currentTool: "bash",
					}],
				}],
			},
		}, { expanded: false }, theme);

		const text = widget.render(120).join("\n");
		assert.match(text, /↳ \[\d{2}:\d{2}:\d{2}\] \+1 nested run \(1 running\)/);
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
		assert.match(text, /⟳ 2/);
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
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.match(text, /active 2s ago/);
		assert.match(text, /⎿  read: package\.json \| 3\.0s/);
		assert.match(text, /output: \/tmp\/reviewer_output\.md/);
	});

	it("keeps running compact result output stable when progress is unchanged", async () => {
		const result = {
			content: [{ type: "text" as const, text: "(running...)" }],
			details: {
				mode: "single" as const,
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: {
						index: 0,
						agent: "reviewer",
						status: "running" as const,
						task: "review",
						lastActivityAt: 2_000,
						currentTool: "read",
						currentToolArgs: "package.json",
						currentToolStartedAt: 1_000,
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 42,
						durationMs: 3_000,
					},
				}],
			},
		};
		const first = renderSubagentResult!(result, { expanded: false }, theme).render(120);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = renderSubagentResult!(result, { expanded: false }, theme).render(120);

		assert.deepEqual(second, first);
	});

	it("advances running compact result glyphs when progress changes", () => {
		const renderGlyph = (toolCount: number) => firstGrapheme(renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "single",
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: {
						index: 0,
						agent: "reviewer",
						status: "running",
						task: "review",
						recentTools: [],
						recentOutput: [],
						toolCount,
						tokens: 0,
						durationMs: 0,
					},
				}],
			},
		}, { expanded: false }, theme).render(120)[0] ?? "");

		assert.notEqual(renderGlyph(1), renderGlyph(2));
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
