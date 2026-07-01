import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildWidgetLines, clearLegacyResultAnimationTimer, renderWidget } = await import("../../src/tui/render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number, expanded?: boolean) => string[];
	clearLegacyResultAnimationTimer: (context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } }) => void;
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const runningGlyphPattern = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outputPathPattern(posixPath: string): RegExp {
	return new RegExp(`output: ${posixPath.split("/").map(escapeRegExp).join("[\\\\/]")}`);
}

function firstGrapheme(text: string): string {
	return Array.from(text.trimStart())[0] ?? "";
}

function firstRunningGlyph(text: string): string {
	return text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/)?.[0] ?? "";
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		widgets,
		get renderRequests() {
			return renderRequests;
		},
	};
}

function renderWidgetLines(widget: unknown, width = 180): string[] {
	return (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, theme).render(width);
}

function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	Reflect.deleteProperty(target, key);
}

function withStdoutSize<T>(rows: number, columns: number, fn: () => T): T {
	const stdout = process.stdout as NodeJS.WriteStream & { rows?: number; columns?: number };
	const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
	const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
	Object.defineProperty(stdout, "rows", { configurable: true, value: rows });
	Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
	try {
		return fn();
	} finally {
		restoreDescriptor(stdout, "rows", rowsDescriptor);
		restoreDescriptor(stdout, "columns", columnsDescriptor);
	}
}

function resetWidgetLayout(): void {
	renderWidget(createUiContext().ctx as never, []);
}

describe("subagent async widget rendering", () => {
	it("orders running jobs before queued summaries and completions", () => {
		const lines = buildWidgetLines([
			{ asyncId: "done-1", asyncDir: "/tmp/done", status: "complete", agents: ["reviewer"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "queued-1", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "run-1", asyncDir: "/tmp/run", status: "running", agents: ["scout"], currentStep: 0, stepsTotal: 2, startedAt: Date.now() - 1000, updatedAt: Date.now(), currentTool: "read", currentToolStartedAt: Date.now() - 500 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, new RegExp(`^${runningGlyphPattern} Async agents · background`));
		assert.ok(text.indexOf("scout") < text.indexOf("queued"), "running row should precede queued summary");
		assert.ok(text.indexOf("queued") < text.indexOf("reviewer"), "queued summary should precede completions");
		assert.match(text, /⎿  read/);
	});

	it("uses parallel running/done wording for async jobs with parallel groups", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["scout", "reviewer", "worker"], hasParallelGroups: true, activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · 3 agents running · 0\/3 done/);
		assert.match(text, /⎿  thinking…/);
		assert.doesNotMatch(text, /parallel · scout, reviewer, worker/);
		assert.doesNotMatch(text, /step 1\/3/);
	});

	it("collapses repeated async parallel agent names", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["reviewer", "reviewer", "reviewer"], activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · 3 agents running/);
		assert.doesNotMatch(text, /parallel · reviewer ×3/);
		assert.doesNotMatch(text, /reviewer → reviewer → reviewer/);
	});

	it("renders a compact component widget for three active parallel agents without core truncation", () => {
		const now = Date.now();
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [{
			asyncId: "run-1",
			asyncDir: "/tmp/1",
			status: "running",
			mode: "parallel",
			agents: ["reviewer", "reviewer", "reviewer"],
			activeParallelGroup: true,
			runningSteps: 3,
			completedSteps: 0,
			stepsTotal: 3,
			updatedAt: now,
			steps: [
				{ index: 0, agent: "reviewer", status: "running", lastActivityAt: now, turnCount: 5, toolCount: 18, tokens: { input: 30_000, output: 10_000, cache: 4_000, total: 44_000 } },
				{ index: 1, agent: "reviewer", status: "running", lastActivityAt: now - 2000, turnCount: 4, toolCount: 13, tokens: { input: 16_000, output: 4_000, cache: 2_000, total: 22_000 } },
				{ index: 2, agent: "reviewer", status: "running", currentTool: "grep", currentToolStartedAt: now - 1000, turnCount: 3, toolCount: 11, tokens: { input: 14_000, output: 3_000, cache: 2_000, total: 19_000 } },
			],
		}]);
		const widget = ui.widgets.at(-1);
		assert.equal(typeof widget, "function", "renderWidget should install a component widget, not a capped string-array widget");
		const lines = (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, theme).render(180).map((line) => line.trimEnd());
		const text = lines.join("\n");
		assert.match(text, /async subagent parallel \(3\) · background/);
		assert.match(text, /Agent 1\/3: reviewer · running · active now · 5 turns · 18 tool uses · 44k token/);
		assert.match(text, /Agent 2\/3: reviewer · running · active 2s ago · 4 turns · 13 tool uses · 22k token/);
		assert.match(text, /Agent 3\/3: reviewer · running · grep \| 1\.0s · 3 turns · 11 tool uses · 19k token/);
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.doesNotMatch(text, /widget truncated/);
		assert.ok(lines.length <= 10, "collapsed component should stay under Pi's string-widget cap even though it bypasses it");
	});

	it("locks crowded collapsed widget height for the current terminal session", () => {
		resetWidgetLayout();
		withStdoutSize(30, 120, () => {
			const now = 20_000;
			const crowdedJobs = Array.from({ length: 3 }, (_, jobIndex) => ({
				asyncId: `run-${jobIndex + 1}`,
				asyncDir: `/tmp/run-${jobIndex + 1}`,
				status: "running",
				mode: "parallel",
				agents: ["scout", "reviewer"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 0,
				stepsTotal: 2,
				updatedAt: now + jobIndex,
				steps: [
					{ index: 0, agent: "scout", status: "running", currentTool: "read", currentToolStartedAt: now - 1000 },
					{ index: 1, agent: "reviewer", status: "running", currentTool: "grep", currentToolStartedAt: now - 2000 },
				],
			}));
			const ui = createUiContext();

			renderWidget(ui.ctx as never, crowdedJobs);
			const crowdedLines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(crowdedLines.length, 10, "30 terminal rows should keep the compact widget cap while locking height");
			assert.match(crowdedLines.join("\n"), /Async agents · 3 agents running/);

			renderWidget(ui.ctx as never, [{
				...crowdedJobs[0]!,
				status: "complete",
				runningSteps: 0,
				completedSteps: 2,
				steps: [
					{ index: 0, agent: "scout", status: "complete" },
					{ index: 1, agent: "reviewer", status: "complete" },
				],
			}]);
			const settledLines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(settledLines.length, 10, "collapsed widget keeps its locked row count until cleared or resized");
			assert.match(settledLines.join("\n"), /parallel · done/);

			renderWidget(ui.ctx as never, []);
			renderWidget(ui.ctx as never, [{ asyncId: "small", asyncDir: "/tmp/small", status: "running", agents: ["worker"], currentTool: "read" }]);
			const resetLines = renderWidgetLines(ui.widgets.at(-1));
			assert.ok(resetLines.length < 10, "clearing the widget starts a fresh layout session");
		});
		resetWidgetLayout();
	});

	it("keeps medium terminal progressive fallback within the compact cap", () => {
		resetWidgetLayout();
		withStdoutSize(50, 120, () => {
			const ui = createUiContext();
			const jobs = [{
				asyncId: "run-wide",
				asyncDir: "/tmp/run-wide",
				status: "running",
				mode: "parallel",
				agents: Array.from({ length: 40 }, (_, index) => `agent-${index}`),
				activeParallelGroup: true,
				runningSteps: 40,
				completedSteps: 0,
				stepsTotal: 40,
				steps: Array.from({ length: 40 }, (_, index) => ({ index, agent: `agent-${index}`, status: "running", currentTool: "read" })),
			}];

			renderWidget(ui.ctx as never, jobs);
			const lines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(lines.length, 14);
			assert.match(lines.join("\n"), /parallel · running/);
		});
		resetWidgetLayout();
	});

	it("keeps constrained progressive slots focused on active jobs", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const ui = createUiContext();
			const jobs = [
				{ asyncId: "run-1", asyncDir: "/tmp/run-1", status: "running", mode: "single", agents: ["first"], currentTool: "read" },
				{ asyncId: "run-2", asyncDir: "/tmp/run-2", status: "running", mode: "single", agents: ["second"], currentTool: "grep" },
				{ asyncId: "run-3", asyncDir: "/tmp/run-3", status: "running", mode: "single", agents: ["third"], currentTool: "edit" },
			];
			renderWidget(ui.ctx as never, jobs);
			const firstText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(firstText, /first/);
			assert.match(firstText, /\+2 more/);

			renderWidget(ui.ctx as never, [
				{ ...jobs[0]!, status: "complete", currentTool: undefined },
				jobs[1]!,
				jobs[2]!,
			]);
			const updatedText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(updatedText, /second/);
			assert.doesNotMatch(updatedText, /first · done/);
			assert.match(updatedText, /\+2 more/);
		});
		resetWidgetLayout();
	});

	it("uses a single collapsed widget line when the terminal has almost no spare rows", () => {
		resetWidgetLayout();
		withStdoutSize(20, 120, () => {
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [{
				asyncId: "run-tiny",
				asyncDir: "/tmp/run-tiny",
				status: "running",
				agents: ["worker"],
				currentTool: "read",
			}]);

			const lines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /subagents \(1\/1 running\)/);
		});
		resetWidgetLayout();
	});

	it("keeps expanded async widgets on the full-detail path", () => {
		resetWidgetLayout();
		withStdoutSize(20, 120, () => {
			const ui = createUiContext();
			ui.ctx.ui.getToolsExpanded = () => true;
			renderWidget(ui.ctx as never, [{
				asyncId: "run-expanded",
				asyncDir: "/tmp/run-expanded",
				status: "running",
				mode: "parallel",
				agents: ["reviewer"],
				activeParallelGroup: true,
				runningSteps: 1,
				completedSteps: 0,
				stepsTotal: 1,
				steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
			}]);

			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(text, /async subagent parallel · background/);
			assert.match(text, /Agent 1\/1: reviewer · running/);
			assert.doesNotMatch(text, /subagents \(1\/1 running\)/);
		});
		resetWidgetLayout();
	});

	it("shows per-agent detail for active async parallel widget rows", () => {
		const now = Date.now();
		const lines = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer", "reviewer", "reviewer"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 1,
				stepsTotal: 3,
				updatedAt: now,
				steps: [
					{ agent: "reviewer", status: "running", lastActivityAt: now, toolCount: 2 },
					{ agent: "reviewer", status: "running", currentTool: "read", currentToolStartedAt: now - 2000 },
					{ agent: "reviewer", status: "complete", tokens: { input: 1000, output: 500, cache: 0, total: 1500 } },
				],
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /async subagent parallel \(3\) · background/);
		assert.match(text, /parallel · 2 agents running · 1\/3 done/);
		assert.match(text, /Agent 1\/3: reviewer · running · 2 tool uses/);
		assert.match(text, /⎿  active now/);
		assert.match(text, /Agent 2\/3: reviewer · running\n\s+⎿  read \| 2\.0s/);
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.match(text, /Agent 3\/3: reviewer · complete · 1\.5k token/);
	});

	it("shows model and thinking for active async widget rows", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer", "scout"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 0,
				stepsTotal: 2,
				steps: [
					{ agent: "reviewer", status: "running", model: "openai-codex/gpt-5.5:high" },
					{ agent: "scout", status: "running", model: "anthropic/claude-haiku-4-5", thinking: "low" },
				],
			},
		], theme, 180);

		const text = lines.join("\n");
		assert.match(text, /Agent 1\/2: reviewer · running \(gpt-5\.5 · thinking high\)/);
		assert.match(text, /Agent 2\/2: scout · running \(claude-haiku-4-5 · thinking low\)/);
		assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
		assert.doesNotMatch(text, /gpt-5\.5:high/);
	});

	it("keeps async row status visible before long model badges on narrow widgets", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer"],
				activeParallelGroup: true,
				runningSteps: 1,
				completedSteps: 0,
				stepsTotal: 1,
				steps: [
					{ agent: "reviewer", status: "running", model: "anthropic/claude-opus-4-5-20260501-super-long-model-name:high" },
				],
			},
		], theme, 68);

		const row = lines.find((line) => line.includes("Agent 1/1")) ?? "";
		assert.match(row, /Agent 1\/1: reviewer · running/);
		assert.doesNotMatch(row, /Agent 1\/1: reviewer \(/);
	});

	it("shows inline live detail for expanded async parallel widget rows", () => {
		const now = Date.now();
		const job = {
			asyncId: "run-1",
			asyncDir: "/tmp/1",
			status: "running",
			mode: "parallel",
			agents: ["reviewer"],
			activeParallelGroup: true,
			runningSteps: 1,
			completedSteps: 0,
			stepsTotal: 1,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "reviewer",
					status: "running",
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					recentTools: [{ tool: "grep", args: "async widget", endMs: now - 3000 }],
					recentOutput: ["found renderWidget", "checking expanded state"],
				},
			],
		};

		const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(collapsedText, /Press configured-expand-key for live detail/);
		assert.doesNotMatch(collapsedText, /found renderWidget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /Press configured-expand-key for live detail/);
		assert.match(expandedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(expandedText, outputPathPattern("/tmp/1/output-0.log"));
		assert.match(expandedText, /grep: async widget/);
		assert.match(expandedText, /found renderWidget/);
		assert.match(expandedText, /checking expanded state/);
	});

	it("shows step detail and configured live detail key hint for running single async jobs with steps", () => {
		const now = Date.now();
		const job = {
			asyncId: "single-run",
			asyncDir: "/tmp/single-run",
			status: "running",
			mode: "single",
			agents: ["worker"],
			stepsTotal: 1,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "worker",
					status: "running",
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					recentOutput: ["reading render widget"],
				},
			],
		};

		const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(collapsedText, /async subagent worker · background/);
		assert.match(collapsedText, /Step 1\/1: worker · running/);
		assert.match(collapsedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(collapsedText, /Press configured-expand-key for live detail/);
		assert.match(collapsedText, outputPathPattern("/tmp/single-run/output-0.log"));
		assert.doesNotMatch(collapsedText, /reading render widget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /Press configured-expand-key for live detail/);
		assert.match(expandedText, /reading render widget/);
	});

	it("keeps generic activity fallback for single async jobs without steps", () => {
		const now = Date.now();
		const text = buildWidgetLines([
			{
				asyncId: "single-no-steps",
				asyncDir: "/tmp/single-no-steps",
				status: "running",
				mode: "single",
				agents: ["worker"],
				currentTool: "read",
				currentToolStartedAt: now - 1000,
				updatedAt: now,
			},
		], theme, 180).join("\n");

		assert.match(text, /⎿  read 1\.0s/);
		assert.doesNotMatch(text, /Step 1\/1/);
		assert.doesNotMatch(text, /Press configured-expand-key for live detail/);
	});

	it("includes logical chain context for active async chain parallel groups", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-chain",
				asyncDir: "/tmp/chain",
				status: "running",
				mode: "chain",
				agents: ["reviewer", "auditor"],
				activeParallelGroup: true,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				runningSteps: 1,
				completedSteps: 1,
				stepsTotal: 2,
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /step 2\/3 · parallel group: 1 agent running · 1\/2 done/);
	});

	it("uses logical chain steps after an async chain parallel group finishes", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-chain",
				asyncDir: "/tmp/chain",
				status: "running",
				mode: "chain",
				agents: ["scout", "reviewer", "auditor", "writer"],
				activeParallelGroup: false,
				currentStep: 3,
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				stepsTotal: 4,
				steps: [
					{ index: 0, agent: "scout", status: "complete" },
					{ index: 1, agent: "reviewer", status: "complete" },
					{ index: 2, agent: "auditor", status: "complete" },
					{ index: 3, agent: "writer", status: "running", toolCount: 1 },
				],
			},
		], theme, 180);

		const text = lines.join("\n");
		assert.match(text, /async subagent chain \(2\)/);
		assert.match(text, /chain · step 2\/2/);
		assert.match(text, /Step 1\/2: parallel group · 3\/3 done/);
		assert.match(text, /Step 2\/2: writer · running · 1 tool use/);
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.match(text, outputPathPattern("/tmp/chain/output-3.log"));
		assert.doesNotMatch(text, /step 4\/4/);
		assert.doesNotMatch(text, /Step 4\/4/);
	});

	it("omits zero-running labels for pending active async parallel groups", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "parallel-pending",
				asyncDir: "/tmp/parallel-pending",
				status: "running",
				mode: "parallel",
				agents: ["scout", "reviewer", "worker"],
				activeParallelGroup: true,
				runningSteps: 0,
				completedSteps: 0,
				stepsTotal: 3,
			},
			{
				asyncId: "chain-pending",
				asyncDir: "/tmp/chain-pending",
				status: "running",
				mode: "chain",
				agents: ["reviewer", "auditor"],
				activeParallelGroup: true,
				currentStep: 0,
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }],
				runningSteps: 0,
				completedSteps: 0,
				stepsTotal: 2,
			},
		], theme, 180);

		const text = lines.join("\n");
		assert.match(text, /parallel · 0\/3 done/);
		assert.match(text, /chain · step 1\/2 · parallel group: 0\/2 done/);
		assert.doesNotMatch(text, /0 agents running/);
	});

	it("shows explicit overflow counts for hidden work", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["a1"] },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
			{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
			{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
			{ asyncId: "run-5", asyncDir: "/tmp/5", status: "running", agents: ["a5"] },
		], theme, 120);

		assert.match(lines.join("\n"), /\+1 more \(1 running\)/);
	});

	it("counts hidden queued work even when a visible running agent name contains queued", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["queued-scanner"] },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
			{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
			{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
			{ asyncId: "queued-1", asyncDir: "/tmp/q", status: "queued", agents: ["planner"] },
		], theme, 120);

		assert.match(lines.join("\n"), /\+1 more \(1 queued\)/);
	});

	it("advances running widget glyphs when progress seed changes", () => {
		const first = buildWidgetLines([
			{ asyncId: "run-progress", asyncDir: "/tmp/run", status: "running", agents: ["worker"], updatedAt: 11 },
			{ asyncId: "run-other", asyncDir: "/tmp/other", status: "running", agents: ["scout"], updatedAt: 0 },
		], theme, 120);
		const second = buildWidgetLines([
			{ asyncId: "run-progress", asyncDir: "/tmp/run", status: "running", agents: ["worker"], updatedAt: 12 },
			{ asyncId: "run-other", asyncDir: "/tmp/other", status: "running", agents: ["scout"], updatedAt: 0 },
		], theme, 120);

		assert.notEqual(firstGrapheme(first[0] ?? ""), firstGrapheme(second[0] ?? ""), "header glyph should advance from changed progress");
		assert.notEqual(firstRunningGlyph(first[1] ?? ""), firstRunningGlyph(second[1] ?? ""), "job glyph should advance from changed progress");

		const firstStep = buildWidgetLines([{
			asyncId: "run-step-progress",
			asyncDir: "/tmp/run-step",
			status: "running",
			agents: ["worker"],
			stepsTotal: 1,
			updatedAt: 20,
			steps: [{ agent: "worker", status: "running", currentToolStartedAt: 10 }],
		}], theme, 120);
		const secondStep = buildWidgetLines([{
			asyncId: "run-step-progress",
			asyncDir: "/tmp/run-step",
			status: "running",
			agents: ["worker"],
			stepsTotal: 1,
			updatedAt: 20,
			steps: [{ agent: "worker", status: "running", currentToolStartedAt: 11 }],
		}], theme, 120);
		assert.notEqual(
			firstRunningGlyph(firstStep.find((line) => line.includes("Step 1/1")) ?? ""),
			firstRunningGlyph(secondStep.find((line) => line.includes("Step 1/1")) ?? ""),
			"step glyph should advance from changed step progress",
		);
	});

	it("keeps running widget output stable when progress seed is unchanged", async () => {
		const job = {
			asyncId: "run-stable",
			asyncDir: "/tmp/run",
			status: "running",
			agents: ["worker"],
			startedAt: 1_000,
			updatedAt: 3_000,
			currentTool: "read",
			currentToolStartedAt: 2_000,
			lastActivityAt: 2_500,
		};
		const first = buildWidgetLines([job], theme, 120);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = buildWidgetLines([job], theme, 120);

		assert.deepEqual(second, first);
		assert.equal(firstGrapheme(first[1] ?? ""), firstGrapheme(second[1] ?? ""));
	});

	it("does not animate queued-only widgets", async () => {
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [{ asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] }]);
		const initialWidgetCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, initialWidgetCount, "static queued widget should not refresh at animation cadence");
		assert.equal(ui.renderRequests, 0);
	});

	it("clears legacy result row animation timers", async () => {
		let ticks = 0;
		const context = {
			state: { subagentResultAnimationTimer: setInterval(() => { ticks += 1; }, 10) },
		};
		try {
			clearLegacyResultAnimationTimer(context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(context.state.subagentResultAnimationTimer, undefined);
			assert.equal(ticks, 0, "legacy timer should be cleared before it can tick");
		} finally {
			if (context.state.subagentResultAnimationTimer) clearInterval(context.state.subagentResultAnimationTimer);
		}
	});

	it("does not refresh running widgets at animation cadence", async () => {
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [{ asyncId: "run-static", asyncDir: "/tmp/run", status: "running", agents: ["scout"] }]);
		const initialWidgetCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, initialWidgetCount, "running widget should wait for status updates instead of animation ticks");
		assert.equal(ui.renderRequests, 0);

		renderWidget(ui.ctx as never, []);
		const afterClearCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, afterClearCount, "cleared widget should stay quiet");
		assert.equal(ui.widgets.at(-1), undefined);
	});
});
