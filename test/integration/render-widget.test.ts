import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildWidgetLines, renderWidget, stopResultAnimations, stopWidgetAnimation, syncResultAnimation } = await import("../../src/tui/render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number, expanded?: boolean) => string[];
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
	stopResultAnimations: () => void;
	stopWidgetAnimation: () => void;
	syncResultAnimation: (result: Record<string, unknown>, context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> }; invalidate: () => void }) => void;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const STALE_EXTENSION_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload";

function staleExtensionContextError(): Error {
	return new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
}

async function expectNoUncaught(action: () => Promise<void> | void): Promise<void> {
	let uncaught: unknown;
	const handler = (error: unknown) => {
		uncaught = error;
	};
	process.once("uncaughtException", handler);
	try {
		await action();
	} finally {
		process.removeListener("uncaughtException", handler);
	}
	assert.equal(uncaught, undefined, `expected no uncaught exception, got: ${uncaught instanceof Error ? uncaught.message : String(uncaught)}`);
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

describe("subagent async widget rendering", () => {
	it("orders running jobs before queued summaries and completions", () => {
		const lines = buildWidgetLines([
			{ asyncId: "done-1", asyncDir: "/tmp/done", status: "complete", agents: ["reviewer"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "queued-1", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "run-1", asyncDir: "/tmp/run", status: "running", agents: ["scout"], currentStep: 0, stepsTotal: 2, startedAt: Date.now() - 1000, updatedAt: Date.now(), currentTool: "read", currentToolStartedAt: Date.now() - 500 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /^● Async agents · background · \/subagents-status/);
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
				steps: [
					{ agent: "reviewer", status: "running", lastActivityAt: now, toolCount: 2 },
					{ agent: "reviewer", status: "running", currentTool: "read", currentToolStartedAt: now - 2000 },
					{ agent: "reviewer", status: "complete", tokens: { input: 1000, output: 500, cache: 0, total: 1500 } },
				],
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /async subagent parallel \(3\) · background · \/subagents-status/);
		assert.match(text, /parallel · 2 agents running · 1\/3 done/);
		assert.match(text, /Agent 1\/3: reviewer · 2 tool uses/);
		assert.match(text, /⎿  active now/);
		assert.match(text, /Agent 2\/3: reviewer\n\s+⎿  read \| 2\.0s/);
		assert.match(text, /Press Ctrl\+O for live detail/);
		assert.match(text, /Agent 3\/3: reviewer · 1\.5k token/);
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
		assert.match(collapsedText, /Press Ctrl\+O for live detail/);
		assert.doesNotMatch(collapsedText, /found renderWidget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /Press Ctrl\+O for live detail/);
		assert.match(expandedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(expandedText, /output: \/tmp\/1\/output-0\.log/);
		assert.match(expandedText, /grep: async widget/);
		assert.match(expandedText, /found renderWidget/);
		assert.match(expandedText, /checking expanded state/);
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
		assert.match(text, /Step 2\/2: writer · 1 tool use/);
		assert.match(text, /Press Ctrl\+O for live detail/);
		assert.match(text, /output: \/tmp\/chain\/output-3\.log/);
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

	it("does not animate queued-only widgets", async () => {
		const ui = createUiContext();
		try {
			renderWidget(ui.ctx as never, [{ asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] }]);
			const initialWidgetCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(ui.widgets.length, initialWidgetCount, "static queued widget should not refresh at animation cadence");
			assert.equal(ui.renderRequests, 0);
		} finally {
			stopWidgetAnimation();
		}
	});

	it("invalidates running result rows and stops after completion", async () => {
		let invalidations = 0;
		const context = {
			state: {},
			invalidate: () => {
				invalidations += 1;
			},
		};
		try {
			syncResultAnimation({
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
				},
			}, context);
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.ok(invalidations > 0, "running result should request row redraws");
			assert.ok(context.state.subagentResultAnimationTimer, "running result should store its timer handle");
			stopResultAnimations();
			assert.equal(context.state.subagentResultAnimationTimer, undefined, "global cleanup should clear row timer state");

			syncResultAnimation({
				content: [{ type: "text", text: "running again" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
				},
			}, context);
			assert.ok(context.state.subagentResultAnimationTimer, "running result should restart after global cleanup");

			syncResultAnimation({
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "parallel",
					results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "completed" } }],
				},
			}, context);
			const afterComplete = invalidations;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(invalidations, afterComplete, "completed result should stop row redraws");
			assert.equal(context.state.subagentResultAnimationTimer, undefined);
		} finally {
			stopResultAnimations();
		}
	});

	it("stops result animation when invalidate throws stale-context errors", async () => {
		let invalidations = 0;
		const context = {
			state: {},
			invalidate: () => {
				invalidations += 1;
				throw staleExtensionContextError();
			},
		};
		try {
			await expectNoUncaught(async () => {
				syncResultAnimation({
					content: [{ type: "text", text: "running" }],
					details: {
						mode: "parallel",
						results: [{ agent: "scout", task: "scan", exitCode: 0, progress: { status: "running" } }],
					},
				}, context);
				await new Promise((resolve) => setTimeout(resolve, 190));
			});
			assert.equal(context.state.subagentResultAnimationTimer, undefined, "stale invalidate should clear timer state");
			const afterStop = invalidations;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(invalidations, afterStop, "stale invalidate should stop future timer ticks");
		} finally {
			stopResultAnimations();
		}
	});

	it("animates while active and stops after the widget is cleared", async () => {
		const ui = createUiContext();
		try {
			renderWidget(ui.ctx as never, [{ asyncId: "run-anim", asyncDir: "/tmp/run", status: "running", agents: ["scout"] }]);
			const initialWidgetCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.ok(ui.widgets.length > initialWidgetCount, "animation should refresh widget lines");
			assert.ok(ui.renderRequests > 0, "animation should request UI renders");

			renderWidget(ui.ctx as never, []);
			const afterClearCount = ui.widgets.length;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(ui.widgets.length, afterClearCount, "cleared widget should stop animating");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			stopWidgetAnimation();
		}
	});

	it("stops widget animation when stale-context errors are thrown during refresh", async () => {
		const widgets: unknown[] = [];
		let hasUiReads = 0;
		let setWidgetCalls = 0;
		let renderRequests = 0;
		const ctx = {
			get hasUI() {
				hasUiReads += 1;
				if (hasUiReads > 1) throw staleExtensionContextError();
				return true;
			},
			ui: {
				theme,
				setWidget: (_key: string, value: unknown) => {
					setWidgetCalls += 1;
					widgets.push(value);
				},
				requestRender: () => {
					renderRequests += 1;
				},
			},
		};
		try {
			await expectNoUncaught(async () => {
				renderWidget(ctx as never, [{ asyncId: "run-anim", asyncDir: "/tmp/run", status: "running", agents: ["scout"] }]);
				await new Promise((resolve) => setTimeout(resolve, 190));
			});
			assert.equal(hasUiReads, 2, "widget refresh should stop immediately after stale hasUI throw");
			assert.equal(setWidgetCalls, 1, "stale hasUI throw should stop before refreshing widget lines");
			const requestsAfterStop = renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 190));
			assert.equal(renderRequests, requestsAfterStop, "stale-context throw should stop future render requests");
		} finally {
			stopWidgetAnimation();
		}
	});
});
