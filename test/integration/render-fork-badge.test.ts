import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyText } from "@earendil-works/pi-coding-agent";

type RenderTheme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

type RenderSubagentResult = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details?: {
			mode: "single" | "parallel" | "chain" | "workflow" | "management";
			context?: "fresh" | "fork" | "mixed";
			results: unknown[];
			workflowGraph?: unknown;
		};
	},
	options: { expanded: boolean },
	theme: RenderTheme,
) => { render(width: number): string[] };

type RenderSubagentSummary = (
	result: {
		content: Array<{ type: "text"; text: string }>;
		details?: { mode: "single" | "parallel" | "chain" | "workflow" | "management"; results: unknown[]; progress?: unknown[]; asyncId?: string; workflowGraph?: unknown };
	},
	options: { isPartial?: boolean },
	theme: RenderTheme,
) => { render(width: number): string[] };

let renderSubagentResult: RenderSubagentResult | undefined;
let renderSubagentSummary: RenderSubagentSummary | undefined;
({ renderSubagentResult, renderSubagentSummary } = await import("../../src/tui/render.ts") as {
	renderSubagentResult?: RenderSubagentResult;
	renderSubagentSummary?: RenderSubagentSummary;
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

function withMockedDateNow<T>(now: number, fn: () => T): T {
	const original = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = original;
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
		assert.match(compact, /↳ └─ \[\d{2}:\d{2}:\d{2}\] . compact-terminal-child · complete · Done/);
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
		assert.match(text, /↳ └─ \[\d{2}:\d{2}:\d{2}\] . implement · running · bash/);
	});

	it("shows [fresh] and [fork] on single-result headers", () => {
		for (const context of ["fresh", "fork"] as const) {
			const widget = renderSubagentResult!({
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "single",
					context,
					results: [{
						agent: "reviewer",
						task: "review",
						context,
						exitCode: 0,
						messages: [],
						usage: emptyUsage,
					}],
				},
			}, { expanded: false }, theme);

			const text = widget.render(120).join("\n");
			assert.match(text, new RegExp(`\\[${context}\\]`));
		}
	});

	it("shows [mixed] on mixed runs and per-child context badges", () => {
		const compact = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "parallel",
				context: "mixed",
				results: [
					{ agent: "scout", task: "scan", context: "fresh", exitCode: 0, messages: [], usage: emptyUsage },
					{ agent: "worker", task: "fix", context: "fork", exitCode: 0, messages: [], usage: emptyUsage },
				],
			},
		}, { expanded: false }, theme).render(160).join("\n");

		assert.match(compact, /parallel \[mixed\]/);
		assert.match(compact, /scan \[fresh\]/);
		assert.match(compact, /fix \[fork\]/);

		const expanded = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "parallel",
				context: "mixed",
				results: [
					{ agent: "scout", task: "scan", context: "fresh", exitCode: 0, messages: [], usage: emptyUsage },
					{ agent: "worker", task: "fix", context: "fork", exitCode: 0, messages: [], usage: emptyUsage },
				],
			},
		}, { expanded: true }, theme).render(160).join("\n");

		assert.match(expanded, /parallel \[mixed\]/);
		assert.match(expanded, /scan \[fresh\]/);
		assert.match(expanded, /fix \[fork\]/);
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

	it("uses the same semantic status presentation in compact and expanded single results", () => {
		const cases = [
			{
				name: "running",
				glyph: "⠋",
				label: "running",
				extra: { progress: { index: 0, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 } },
			},
			{
				name: "detached",
				glyph: "■",
				label: "detached",
				extra: {
					detached: true,
					detachedReason: "continuing externally",
					progress: { index: 0, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 1, tokens: 42, durationMs: 1000 },
				},
			},
			{
				name: "stopped",
				glyph: "■",
				label: "stopped",
				extra: {
					stopped: true,
					exitCode: 1,
					progress: { index: 0, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 1, tokens: 42, durationMs: 1000 },
				},
			},
			{
				name: "interrupted",
				glyph: "■",
				label: "paused",
				extra: {
					interrupted: true,
					exitCode: 1,
					progress: { index: 0, agent: "reviewer", status: "running", task: "review", recentTools: [], recentOutput: [], toolCount: 1, tokens: 42, durationMs: 1000 },
				},
			},
			{ name: "failed", glyph: "✗", label: "failed", extra: { exitCode: 1, error: "boom" } },
			{ name: "completed", glyph: "✓", label: "completed", extra: {} },
		] as const;

		for (const testCase of cases) {
			const child = {
				agent: "reviewer",
				task: "review",
				exitCode: 0,
				finalOutput: "review complete",
				messages: [],
				usage: emptyUsage,
				...testCase.extra,
			};
			const result = {
				content: [{ type: "text" as const, text: testCase.name }],
				details: { mode: "single" as const, results: [child] },
			};
			const [compact, expanded] = withMockedDateNow(0, () => [
				renderSubagentResult!(result, { expanded: false }, theme).render(120).join("\n"),
				renderSubagentResult!(result, { expanded: true }, theme).render(120).join("\n"),
			]);

			assert.equal(firstGrapheme(compact), testCase.glyph, `${testCase.name} compact glyph`);
			assert.equal(firstGrapheme(expanded), testCase.glyph, `${testCase.name} expanded glyph`);
			assert.match((expanded.split("\n")[0] ?? "").trimEnd(), new RegExp(`reviewer(?: \\| [^·]+)? · ${testCase.label}$`), `${testCase.name} expanded label`);
			const compactEvidence = { detached: "Detached", stopped: "Stopped", interrupted: "Paused", failed: "Error" }[testCase.name];
			if (compactEvidence) assert.match(compact, new RegExp(`⎿  ${compactEvidence}`), `${testCase.name} compact evidence`);
		}
	});

	it("keeps terminal results terminal in inline summaries with stale progress", () => {
		const progress = {
			index: 0,
			agent: "reviewer",
			status: "running",
			task: "review",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 42,
			durationMs: 1_000,
		};
		const cases = [
			{ name: "detached", state: "paused", flag: { detached: true } },
			{ name: "stopped", state: "stopped", flag: { stopped: true } },
			{ name: "interrupted", state: "paused", flag: { interrupted: true } },
		] as const;

		for (const testCase of cases) {
			const summary = renderSubagentSummary!({
				content: [{ type: "text", text: testCase.name }],
				details: {
					mode: "single",
					asyncId: "async-review",
					progress: [progress],
					results: [{
						agent: "reviewer",
						task: "review",
						exitCode: 0,
						messages: [],
						usage: emptyUsage,
						progress,
						...testCase.flag,
					}],
				},
			}, {}, theme).render(120).join("\n");

			assert.match(summary, new RegExp(`· ${testCase.state}$`), testCase.name);
			assert.doesNotMatch(summary, /running/, testCase.name);
		}
	});

	it("keeps aggregate inline summaries running when another child is terminal", () => {
		const progress = (index: number, agent: string) => ({
			index,
			agent,
			status: "running" as const,
			task: "review",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 42,
			durationMs: 1_000,
		});
		const stoppedProgress = progress(0, "stopped-reviewer");
		const runningProgress = progress(1, "running-reviewer");
		const summary = renderSubagentSummary!({
			content: [{ type: "text", text: "mixed" }],
			details: {
				mode: "parallel",
				asyncId: "async-review",
				progress: [stoppedProgress, runningProgress],
				results: [
					{ agent: "stopped-reviewer", task: "review", exitCode: 1, messages: [], usage: emptyUsage, stopped: true, progress: stoppedProgress },
					{ agent: "running-reviewer", task: "review", exitCode: 0, messages: [], usage: emptyUsage, progress: runningProgress },
				],
			},
		}, {}, theme).render(120).join("\n");

		assert.match(summary, /· running$/);
	});

	it("keeps all-terminal async aggregate inline summaries terminal", () => {
		const progress = (index: number, agent: string) => ({
			index,
			agent,
			status: "running" as const,
			task: "review",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 42,
			durationMs: 1_000,
		});
		const stoppedProgress = progress(0, "stopped-reviewer");
		const pausedProgress = progress(1, "paused-reviewer");
		const detachedProgress = progress(2, "detached-reviewer");
		const summary = renderSubagentSummary!({
			content: [{ type: "text", text: "all terminal" }],
			details: {
				mode: "parallel",
				asyncId: "async-review",
				progress: [stoppedProgress, pausedProgress, detachedProgress],
				results: [
					{ agent: "stopped-reviewer", task: "review", exitCode: 1, messages: [], usage: emptyUsage, stopped: true, progress: stoppedProgress },
					{ agent: "paused-reviewer", task: "review", exitCode: 1, messages: [], usage: emptyUsage, interrupted: true, progress: pausedProgress },
					{ agent: "detached-reviewer", task: "review", exitCode: 0, messages: [], usage: emptyUsage, detached: true, progress: detachedProgress },
				],
			},
		}, {}, theme).render(120).join("\n");

		assert.match(summary, /· stopped$/);
		assert.doesNotMatch(summary, /running/);
	});

	it("keeps all-completed async aggregate inline summaries terminal", () => {
		for (const mode of ["parallel", "chain"] as const) {
			const progress = ["writer", "reviewer"].map((agent, index) => ({
				index,
				agent,
				status: "completed" as const,
				task: "review",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				tokens: 42,
				durationMs: 1_000,
			}));
			const summary = renderSubagentSummary!({
				content: [{ type: "text", text: "done" }],
				details: {
					mode,
					asyncId: `async-${mode}`,
					progress,
					results: progress.map((entry) => ({ agent: entry.agent, task: "review", exitCode: 0, messages: [], usage: emptyUsage, progress: entry })),
				},
			}, {}, theme).render(120).join("\n");

			assert.match(summary, /· completed$/, mode);
			assert.doesNotMatch(summary, /running/, mode);
		}
	});

	it("renders an inconclusive host graph as partial", () => {
		const result = {
			content: [{ type: "text" as const, text: "inconclusive gate" }],
			details: {
				mode: "workflow" as const,
				results: ["worker", "reviewer"].map((agent) => ({ agent, task: "gate", exitCode: 0, messages: [], usage: emptyUsage })),
				workflowGraph: {
					runId: "workflow-partial",
					mode: "workflow" as const,
					phases: [],
					nodes: [{ id: "gate", kind: "host-step" as const, label: "Review gate", status: "partial" as const }],
				},
			},
		};

		const summary = renderSubagentSummary!(result, {}, theme).render(120).join("\n");
		const compact = renderSubagentResult!(result, { expanded: false }, theme).render(120).join("\n");
		const expanded = renderSubagentResult!(result, { expanded: true }, theme).render(120).join("\n");
		assert.match(summary, /■ workflow · partial$/);
		assert.equal(firstGrapheme(compact), "■");
		assert.match(expanded, /■ workflow .*· partial$/m);
	});

	it("keeps all-failed async aggregate inline summaries terminal", () => {
		for (const mode of ["parallel", "chain"] as const) {
			const progress = ["writer", "reviewer"].map((agent, index) => ({
				index,
				agent,
				status: "failed" as const,
				task: "review",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				tokens: 42,
				durationMs: 1_000,
			}));
			const summary = renderSubagentSummary!({
				content: [{ type: "text", text: "failed" }],
				details: {
					mode,
					asyncId: `async-${mode}`,
					progress,
					results: progress.map((entry) => ({ agent: entry.agent, task: "review", exitCode: 1, error: "boom", messages: [], usage: emptyUsage, progress: entry })),
				},
			}, {}, theme).render(120).join("\n");

			assert.match(summary, /· failed$/, mode);
			assert.doesNotMatch(summary, /running/, mode);
		}
	});

	it("uses shared semantic status presentation for expanded multi-result rows", () => {
		const results = [
			{
				agent: "detached-agent",
				task: "one",
				exitCode: 0,
				detached: true,
				finalOutput: "output",
				messages: [],
				usage: emptyUsage,
				progress: { index: 0, agent: "detached-agent", status: "running" as const, task: "one", recentTools: [], recentOutput: [], toolCount: 1, tokens: 42, durationMs: 1000 },
			},
			{
				agent: "stopped-agent",
				task: "two",
				exitCode: 1,
				stopped: true,
				finalOutput: "output",
				messages: [],
				usage: emptyUsage,
				progress: { index: 1, agent: "stopped-agent", status: "running" as const, task: "two", recentTools: [], recentOutput: [], toolCount: 1, tokens: 42, durationMs: 1000 },
			},
			{
				agent: "paused-agent",
				task: "three",
				exitCode: 1,
				interrupted: true,
				finalOutput: "Interrupted. Waiting for explicit next action.",
				messages: [],
				usage: emptyUsage,
				progress: { index: 2, agent: "paused-agent", status: "running" as const, task: "three", recentTools: [], recentOutput: [], toolCount: 1, tokens: 42, durationMs: 1000 },
			},
			{ agent: "failed-agent", task: "four", exitCode: 1, error: "boom", finalOutput: "output", messages: [], usage: emptyUsage },
			{ agent: "completed-agent", task: "five", exitCode: 0, finalOutput: "output", messages: [], usage: emptyUsage },
		];
		const result = {
			content: [{ type: "text" as const, text: "mixed" }],
			details: { mode: "parallel" as const, totalSteps: results.length, results },
		};
		const compact = renderSubagentResult!(result, { expanded: false }, theme).render(160).join("\n");
		const expanded = renderSubagentResult!(result, { expanded: true }, theme).render(160).join("\n");

		assert.match(compact, /^■ parallel/);
		assert.match(compact, /■ three/);
		assert.doesNotMatch(compact, /running agent/);
		assert.match(expanded, /^■ parallel[^\n]* · detached/);
		assert.match(expanded, /■ one[^\n]* · detached/);
		assert.match(expanded, /■ two[^\n]* · stopped/);
		assert.match(expanded, /■ three[^\n]* · paused/);
		assert.doesNotMatch(expanded, /running agent/);
		assert.match(expanded, /✗ four · failed/);
		assert.match(expanded, /✓ five · completed/);
	});

	it("renders a stale-running interrupted aggregate as paused", () => {
		const result = {
			content: [{ type: "text" as const, text: "paused" }],
			details: {
				mode: "parallel" as const,
				totalSteps: 1,
				results: [{
					agent: "paused-agent",
					task: "pause",
					exitCode: 1,
					interrupted: true,
					finalOutput: "Interrupted. Waiting for explicit next action.",
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "paused-agent", status: "running" as const, task: "pause", recentTools: [], recentOutput: [], toolCount: 1, tokens: 42, durationMs: 1000 },
				}],
			},
		};

		const compact = renderSubagentResult!(result, { expanded: false }, theme).render(160).join("\n");
		const expanded = renderSubagentResult!(result, { expanded: true }, theme).render(160).join("\n");

		assert.match(compact, /^■ parallel/);
		assert.match(expanded, /^■ parallel[^\n]* · paused/);
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

	it("shows model and thinking on running compact single and multi rows", () => {
		const single = renderSubagentResult!({
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
						model: "openai-codex/gpt-5.5",
						thinking: "high",
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						tokens: 42,
						durationMs: 3_000,
					},
				}],
			},
		}, { expanded: false }, theme).render(160).join("\n");
		assert.match(single, /reviewer \(gpt-5\.5 · thinking high\)/);

		const multi = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				totalSteps: 2,
				results: [
					{ agent: "scout", task: "scan", exitCode: 0, messages: [], usage: emptyUsage, model: "anthropic/claude-haiku-4-5", thinking: "low", progress: { index: 0, agent: "scout", status: "running", task: "scan", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 } },
					{ agent: "worker", task: "fix", exitCode: 0, messages: [], usage: emptyUsage, progress: { index: 1, agent: "worker", status: "running", task: "fix", model: "openai/gpt-5-mini", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 } },
				],
			},
		}, { expanded: false }, theme).render(160).join("\n");
		assert.match(multi, /scan \(claude-haiku-4-5 · thinking low\)/);
		assert.match(multi, /fix \(gpt-5-mini\)/);

		const expanded = renderSubagentResult!({
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "parallel",
				totalSteps: 1,
				results: [{
					agent: "reviewer",
					task: "review",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progressSummary: { toolCount: 1, tokens: 42, durationMs: 3_000, model: "openai-codex/gpt-5.5", thinking: "high" },
				}],
			},
		}, { expanded: true }, theme).render(160).join("\n");
		assert.match(expanded, /review \(gpt-5\.5 · thinking high\)/);
	});

	it("strips repeated agent prefixes in expanded running multi-result rows", () => {
		const sessionName = "reviewer: Review the diff";
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "(running...)" }],
			details: {
				mode: "parallel",
				totalSteps: 1,
				results: [{
					agent: "reviewer",
					sessionName,
					task: "Review the diff",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
					progress: { index: 0, agent: "reviewer", sessionName, status: "running", task: "Review the diff", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
				}],
			},
		}, { expanded: true }, theme);

		const text = widget.render(160).join("\n");
		assert.match(text, /Review the diff[^\n]* · running/);
		assert.doesNotMatch(text, /reviewer:\s+Review the diff/);
	});

	it("keeps running compact result output stable at the same render clock when progress is unchanged", () => {
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
		const [first, second] = withMockedDateNow(0, () => [
			renderSubagentResult!(result, { expanded: false }, theme).render(120),
			renderSubagentResult!(result, { expanded: false }, theme).render(120),
		]);

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
		const pendingIndex = lines.findIndex((line) => /Step 2\/2: second/.test(line));
		assert.notEqual(pendingIndex, -1);
		assert.match(lines[pendingIndex]!, /◦ Step 2\/2: second · pending/);
		assert.doesNotMatch(lines[pendingIndex]!, /0ms/);
		assert.doesNotMatch(lines[pendingIndex + 1] ?? "", /Done \(no text output\)/);
	});

	it("uses running/done wording and readable labels for live parallel rendering", () => {
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
		assert.match(text, /third task/);
		assert.doesNotMatch(text, /Step 3\/3: worker/);
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

	it("labels active chain parallel groups with chain step and readable candidates", () => {
		const widget = renderSubagentResult!({
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				currentStepIndex: 0,
				chainAgents: ["[scout+reviewer+worker]", "planner", "writer"],
				results: [{
					agent: "scout",
					sessionName: "  scout: Scan the repository  ",
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
		assert.match(text, /Scan the repository/);
		assert.match(text, /review/);
		assert.match(text, /Agent 3: agent-3 · pending/);
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
		assert.match(text, /scan/);
		assert.match(text, /review/);
		assert.doesNotMatch(text, /planner/);
		assert.doesNotMatch(text, /Agent 1\/2: planner/);
	});

	it("uses logical chain progress and readable labels for completed mixed chains", () => {
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
					...(entry.agent === "scout" ? { sessionName: "  scout: Scan completed targets  " } : {}),
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
		assert.match(text, /Step 1\/3: plan/);
		assert.match(text, /Step 2\/3: parallel group/);
		assert.match(text, /Scan completed targets/);
		assert.match(text, /Step 3\/3: write/);
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
		assert.match(text, /Step 1\/3: scan/);
		assert.doesNotMatch(text, /parallel group:/);
	});

	it("keeps single-child foreground labels aligned across summary and result views", () => {
		const result = {
			content: [{ type: "text" as const, text: "done" }],
			details: {
				mode: "single" as const,
				results: [{
					agent: "reviewer",
					sessionName: "reviewer: Review the current docs",
					task: "Review the current docs",
					exitCode: 0,
					messages: [],
					usage: emptyUsage,
				}],
			},
		};

		const summary = renderSubagentSummary!(result, {}, theme).render(180).join("\n");
		assert.match(summary, /reviewer/);
		assert.doesNotMatch(summary, /Step 1\/1/);
		assert.doesNotMatch(summary, /Agent 1\/1/);
		assert.doesNotMatch(summary, /reviewer:\s+Review the current docs/);

		for (const expanded of [false, true]) {
			const text = renderSubagentResult!(result, { expanded }, theme).render(180).join("\n");
			assert.match(text, /reviewer/, expanded ? "expanded final result" : "compact final result");
			assert.doesNotMatch(text, /Step 1\/1/);
			assert.doesNotMatch(text, /Agent 1\/1/);
			assert.doesNotMatch(text, /reviewer:\s+Review the current docs/);
		}
	});

	it("renders foreground top-level parallel results with readable group labels", () => {
		const result = {
			content: [{ type: "text" as const, text: "running" }],
			details: {
				mode: "parallel" as const,
				totalSteps: 2,
				results: [
					{
						agent: "scout",
						sessionName: "scout: Gather context",
						task: "Gather context",
						exitCode: 0,
						messages: [],
						usage: emptyUsage,
						progress: { index: 0, agent: "scout", status: "running" as const, task: "Gather context", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
					},
					{
						agent: "reviewer",
						sessionName: "reviewer · Review diff",
						task: "Review diff",
						exitCode: 0,
						messages: [],
						usage: emptyUsage,
						progress: { index: 1, agent: "reviewer", status: "running" as const, task: "Review diff", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
					},
				],
			},
		};

		for (const expanded of [false, true]) {
			const text = renderSubagentResult!(result, { expanded }, theme).render(220).join("\n");
			assert.match(text, /Gather context/);
			assert.match(text, /Review diff/);
			assert.doesNotMatch(text, /Agent \d+\/2:/);
			assert.doesNotMatch(text, /scout:\s+Gather context/);
			assert.doesNotMatch(text, /reviewer\s*[·:]\s+Review diff/);
		}
	});

	it("keeps logical Step n\/m labels for foreground chain parallel groups", () => {
		const result = {
			content: [{ type: "text" as const, text: "done" }],
			details: {
				mode: "chain" as const,
				chainAgents: ["planner", "[scout+reviewer]", "writer"],
				totalSteps: 3,
				results: [
					{ agent: "planner", task: "Plan", exitCode: 0, messages: [], usage: emptyUsage },
					{ agent: "scout", sessionName: "scout: Gather context", task: "Gather context", exitCode: 0, messages: [], usage: emptyUsage },
					{ agent: "reviewer", sessionName: "reviewer: Review diff", task: "Review diff", exitCode: 0, messages: [], usage: emptyUsage },
					{ agent: "writer", task: "Write", exitCode: 0, messages: [], usage: emptyUsage },
				],
			},
		};

		for (const expanded of [false, true]) {
			const text = renderSubagentResult!(result, { expanded }, theme).render(220).join("\n");
			assert.match(text, /Step 2\/3: parallel group/);
			assert.match(text, /Gather context/);
			assert.match(text, /Review diff/);
			assert.doesNotMatch(text, /scout:\s+Gather context/);
			assert.doesNotMatch(text, /reviewer:\s+Review diff/);
		}
	});

	it("keeps duplicate unlabeled foreground agents distinguishable", () => {
		const result = {
			content: [{ type: "text" as const, text: "done" }],
			details: {
				mode: "parallel" as const,
				totalSteps: 2,
				results: [
					{ agent: "reviewer", task: "Inspect the same files", exitCode: 0, messages: [], usage: emptyUsage },
					{ agent: "reviewer", task: "Inspect the same files", exitCode: 0, messages: [], usage: emptyUsage },
				],
			},
		};

		for (const expanded of [false, true]) {
			const text = renderSubagentResult!(result, { expanded }, theme).render(180).join("\n");
			const rows = text.split("\n").filter((line) => /Inspect the same files/.test(line) && !/task:/.test(line));
			assert.equal(rows.length, 2);
			assert.notEqual(rows[0], rows[1], "duplicate unlabeled rows need stable disambiguators");
			for (const row of rows) {
				assert.equal(row.match(/Inspect the same files/g)?.length, 1, "duplicate rows should render the candidate only once");
			}
		}
	});

	it("keeps final-result failure and output evidence on dedicated lines", () => {
		const result = {
			content: [{ type: "text" as const, text: "failed" }],
			details: {
				mode: "parallel" as const,
				totalSteps: 1,
				results: [{
					agent: "reviewer",
					sessionName: "reviewer: Review the current docs",
					task: "[Write to: /tmp/review.md] Review the current docs",
					exitCode: 1,
					error: "Review failed after checking the current docs",
					messages: [],
					usage: emptyUsage,
					artifactPaths: { outputPath: "/tmp/review-artifact.md" },
					children: [nestedChild("failed-child", "failed")],
				}],
			},
		};

		for (const expanded of [false, true]) {
			const lines = renderSubagentResult!(result, { expanded }, theme).render(180);
			const text = lines.join("\n");
			assert.ok(lines.some((line) => /^\s+output: \/tmp\/review\.md$/.test(line)), "output evidence should be its own line");
			assert.ok(lines.some((line) => new RegExp(`^\\s+${expanded ? "artifacts" : "output"}: \/tmp\/review-artifact\\.md$`).test(line)), "artifact evidence should be its own line");
			if (expanded) assert.match(text, /failed-child · failed/, "nested failure evidence should remain visible");
			assert.ok(lines.some((line) => /(?:Error|error): Review failed after checking the current docs/.test(line)), expanded ? "expanded result should keep failure evidence" : "compact result should keep failure evidence");
			assert.doesNotMatch(text, /Agent 1\/1: reviewer.*(?:Error|error):/);
		}
	});

});
