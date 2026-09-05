import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { extractToolArgsPreview } from "../../src/shared/utils.ts";

const { buildWidgetLines, clearLegacyResultAnimationTimer, compactTaskText, projectAsyncLane, renderWidget, widgetRenderKey } = await import("../../src/tui/render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number, expanded?: boolean, frame?: number) => string[];
	clearLegacyResultAnimationTimer: (context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } }) => void;
	compactTaskText: (task: string | undefined, label?: string) => string | undefined;
	projectAsyncLane: (job: Record<string, unknown>) => { label?: string; role: string; phase?: string; state: string; gate?: string; next?: string; output?: string; workspace?: string; ref: string; chips: string[] } | undefined;
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
	widgetRenderKey: (job: Record<string, unknown>, expanded?: boolean) => string;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const runningGlyphPattern = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]";
const malformedSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

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
	return (widget as (_tui: { requestRender(): void }, widgetTheme: typeof theme) => { render(width: number): string[] })({ requestRender() {} }, theme).render(width);
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
	it("updates the mounted async widget without changing host insertion order", () => {
		type Widget = { render(width: number): string[]; dispose?(): void };
		const widgets = new Map<string, Widget>();
		let registrations = 0;
		let renderRequests = 0;
		const tui = { requestRender: () => { renderRequests += 1; } };
		const ctx = {
			hasUI: true,
			ui: {
				// Pi 0.85 setExtensionWidget disposes/deletes before inserting.
				setWidget(key: string, factory: ((tui: typeof tui, theme: typeof theme) => Widget) | undefined) {
					widgets.get(key)?.dispose?.();
					widgets.delete(key);
					if (factory) {
						registrations += 1;
						widgets.set(key, factory(tui, theme));
					}
				},
			},
		};
		const job = { asyncId: "same-run", asyncDir: "/tmp/run", status: "running", agents: ["before-update"] };
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			renderWidget(ctx, [job]);
			const mounted = widgets.get("subagent-async")!;
			assert.match(mounted.render(180).join("\n"), /before-update/);
			ctx.ui.setWidget("other-extension", () => ({ render: () => ["other"] }));
			for (const agent of ["after-update", "latest-update"]) {
				renderWidget({ ...ctx }, [{ ...job, agents: [agent] }]);
				assert.deepEqual([...widgets.keys()], ["subagent-async", "other-extension"]);
				assert.equal(widgets.get("subagent-async"), mounted);
				assert.match(mounted.render(180).join("\n"), new RegExp(agent), "same-frame cache must be invalidated");
			}
			assert.equal(registrations, 2, "progress must not re-register either widget");
			assert.equal(renderRequests, 2, "each update requests a repaint without a timer");

			ctx.ui.setWidget("subagent-async", undefined);
			renderWidget(ctx, [job]);
			assert.notEqual(widgets.get("subagent-async"), mounted, "host disposal allows remounting");
			renderWidget(ctx, []);
			assert.deepEqual([...widgets.keys()], ["other-extension"]);
			renderWidget(ctx, [job]);
			assert.ok(widgets.has("subagent-async"), "cleared widgets can mount again");
		} finally {
			Date.now = originalNow;
			renderWidget(ctx, []);
		}
	});

	it("renders compact workflow lanes by default and keeps details expanded", () => {
		const job = {
			asyncId: "a6b9aa6b-workflow",
			asyncDir: "/tmp/workflow-preflight",
			status: "running",
			mode: "workflow",
			description: "Review workflow",
			toolCount: 5,
			startedAt: 100,
			updatedAt: 2_600,
			preflight: {
				version: 1,
				coverage: "partial",
				lanes: [
					{ key: "write", mode: "mutation", decision: "apply the smallest fix", claims: ["src/tui"], expectedOutput: "fix.md" },
					{ key: "review", mode: "review", decision: "check the compact surface", claims: ["src/tui"], expectedOutput: "review.md" },
				],
			},
			steps: [
				{ index: 0, workflowKey: "review", agent: "reviewer", label: "Review the compact surface", status: "running", toolCount: 2 },
				{ index: 1, workflowKey: "write", agent: "worker", label: "Apply the smallest fix", status: "complete", toolCount: 3 },
			],
			workflow: {
				trace: [],
				emits: [],
				console: [],
				preflightWarnings: ["Preflight advisory: workflow key 'review.extra' launched without a declared lane."],
			},
		};
		const compact = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(compact, /async workflow: Review workflow ─ background/);
		assert.match(compact, /id: a6b9aa6b · 1\/2 done · 1 active · 5 tool uses · 2\.5s/);
		assert.match(compact, /write · worker\/mutation · apply the smallest fix · src\/tui · fix\.md/);
		assert.match(compact, /review · reviewer\/review · active · check the compact surface · src\/tui · review\.md/);
		assert.doesNotMatch(compact, /Plan:|Plan note:|preflight mismatch|Preflight advisory/);
		assert.doesNotMatch(compact, /decision:|claims:|expected:/);
		assert.doesNotMatch(compact, /output:\s|next:/i);

		const expanded = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(expanded, /Preflight: v1 · partial · 2 lanes/);
		assert.match(expanded, /write \| mutation \| apply the smallest fix \| src\/tui \| fix\.md/);
		assert.match(expanded, /review \| review \| check the compact surface \| src\/tui \| review\.md/);
		assert.match(expanded, /expected output \| independence/);
		assert.match(expanded, /Preflight warnings:/);
		assert.match(expanded, /review\.extra.*without a declared lane/);
	});

	it("degrades compact workflow rows without preflight metadata", () => {
		const job = {
			asyncId: "workflow-fallback-123",
			asyncDir: "/tmp/workflow-fallback",
			status: "running",
			mode: "workflow",
			steps: [
				{ index: 0, workflowKey: "scope", agent: "scout", label: "Scope the request", description: "Inspect the repository", status: "complete", outputName: "scope.md" },
				{ index: 1, workflowKey: "implement", agent: "worker", label: "Implement the fix", description: "Change only the renderer", status: "running", outputName: "fix.md" },
			],
		};
		const compact = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(compact, /async workflow: workflow ─ background/);
		assert.match(compact, /scope · scout · Scope the request/);
		assert.match(compact, /implement · worker · active · Implement the fix/);
		assert.doesNotMatch(compact, /Plan:|next:|output:/i);

		const narrow = buildWidgetLines([job], theme, 72);
		assert.match(narrow[1] ?? "", /id: workflow · 1\/2 done · 1 active/);
		for (const line of narrow) assert.ok(visibleWidth(line) <= 72, `workflow row exceeds width: ${visibleWidth(line)}`);
		const tightHeader = buildWidgetLines([{ ...job, description: "backlog-wave" }], theme, 40)[0] ?? "";
		assert.match(tightHeader, /async workflow backlog-wave · background/);
		assert.doesNotMatch(tightHeader, /workflow:/);
		const longJob = { ...job, steps: job.steps.map((step, index) => ({ ...step, label: `${step.label} ${"with a deliberately long lane description ".repeat(4)}`, description: index === 1 ? `${step.description} ${"and more detail ".repeat(8)}` : step.description })) };
		const truncated = buildWidgetLines([longJob], theme, 72);
		assert.match(truncated[1] ?? "", /id: workflow · 1\/2 done · 1 active/);
		assert.ok(truncated.some((line) => line.includes("...")), "narrow lane rows should be truncated");
	});

	it("projects known workflow metadata into a compact lane row", () => {
		const job = {
			asyncId: "lane-run-123456",
			asyncDir: "/tmp/lane-run",
			status: "running",
			mode: "parallel",
			agents: ["reviewer", "writer"],
			steps: [
				{
					index: 0,
					agent: "reviewer",
					status: "running",
					phase: "fresh-review",
					label: "Review #1610",
					workflowKey: "review",
					description: "Inspect the current status surface",
					outputName: "review.md",
					context: "fresh",
					review: { status: "review-required" },
				},
				{ index: 1, agent: "writer", status: "pending", phase: "implementation", label: "Fix candidate", workflowKey: "writer", outputName: "fix.md" },
			],
		};

		assert.deepEqual(projectAsyncLane(job), {
			label: "Review #1610 — Inspect the current status surface",
			role: "reviewer",
			phase: "fresh-review",
			state: "running",
			gate: "review required",
			next: "review output",
			output: "review.md",
			ref: "review",
			chips: ["fresh"],
		});
		const text = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(text, /Review #1610 — Inspect the current status surface · role:reviewer · running/);
		assert.match(text, /phase:fresh-review · gate:review required · next:review output · out:review\.md · ref:review · \[fresh\]/);
		assert.match(text, /Fix candidate/);
		assert.match(text, /Fix candidate · role:writer · pending/);
		assert.match(text, /phase:implementation · next:await launch · out:fix\.md/);
		assert.doesNotMatch(text, /lane:/);
	});

	it("prefers bounded loaded workspace context over repeated internal lane refs", () => {
		const workspacePath = `/tmp/workspaces/${"project-".repeat(16)}`;
		const job = {
			asyncId: "workspace-run",
			asyncDir: "/tmp/workspace-run",
			cwd: workspacePath,
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			workflowKey: "internal-workflow-key",
			steps: [{ index: 0, agent: "reviewer", status: "running", workflowKey: "internal-workflow-key" }],
		};

		const lane = projectAsyncLane(job);
		assert.equal(lane?.ref, "internal-workflow-key");
		assert.ok(lane?.workspace);
		assert.ok((lane.workspace?.length ?? 0) <= 48, "workspace display should stay bounded");
		assert.match(lane?.workspace ?? "", /^\/tmp\/workspaces\/project-/);
		assert.match(lane?.workspace ?? "", /\.\.\.$/);

		const text = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(text, /workspace:\/tmp\/workspaces\/project-/);
		assert.doesNotMatch(text, /ref:internal-workflow-key/);
	});

	it("shows workspace context in expanded single and parallel/chain rows", () => {
		for (const mode of ["single", "parallel", "chain"] as const) {
			const workflowKey = `${mode}-workflow-key`;
			const workspace = `/tmp/${mode}-workspace`;
			const job = {
				asyncId: `${mode}-workspace-run`,
				asyncDir: `/tmp/${mode}-workspace-run`,
				cwd: workspace,
				status: "running",
				mode,
				agents: ["worker"],
				steps: [{ index: 0, agent: "worker", status: "running", workflowKey }],
			};

			const text = buildWidgetLines([job], theme, 180, true).join("\n");
			assert.match(text, new RegExp(`workspace:${escapeRegExp(workspace)}`));
			assert.doesNotMatch(text, new RegExp(`ref:${escapeRegExp(workflowKey)}`));
		}
	});

	it("keeps the bounded workflow-key fallback when no workspace is loaded", () => {
		const workflowKey = `internal-${"workflow-key-".repeat(8)}`;
		const job = {
			asyncId: "fallback-ref-run",
			asyncDir: "/tmp/fallback-ref-run",
			status: "running",
			mode: "single",
			agents: ["worker"],
			workflowKey,
		};

		const lane = projectAsyncLane(job);
		assert.equal(lane?.workspace, undefined);
		assert.ok(lane?.ref);
		assert.ok((lane.ref.length) <= 24, "workflow-key fallback should stay bounded");
		const text = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(text, new RegExp(`ref:${escapeRegExp(lane?.ref ?? "")}`));
	});

	it("uses workspace context in compact progressive lane headers", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const workspace = "/tmp/compact-workspace";
			const job = {
				asyncId: "compact-workspace-run",
				asyncDir: "/tmp/compact-workspace-run",
				cwd: workspace,
				status: "running",
				mode: "single",
				agents: ["worker"],
				workflowKey: "compact-workflow-key",
				currentTool: "read",
			};
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [job]);
			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(text, new RegExp(`workspace:${escapeRegExp(workspace)}`));
			assert.doesNotMatch(text, /ref:compact-workflow-key/);
		});
		resetWidgetLayout();
	});

	it("refreshes widget render keys when loaded workspace changes", () => {
		const base = {
			asyncId: "render-key-workspace-run",
			asyncDir: "/tmp/render-key-workspace-run",
			status: "running",
			mode: "single",
			agents: ["worker"],
			workflowKey: "render-key-workflow",
		};
		assert.notEqual(
			widgetRenderKey({ ...base, cwd: "/tmp/workspace-one" }),
			widgetRenderKey({ ...base, cwd: "/tmp/workspace-two" }),
		);
	});

	it("renders loaded host CI and gate nodes without creating child lanes", () => {
		const job = {
			asyncId: "host-run",
			asyncDir: "/tmp/host-run",
			status: "running",
			mode: "workflow",
			agents: [],
			hostSteps: [
				{
					version: 1,
					kind: "host-step",
					monitorKind: "ci",
					id: "ci-1",
					label: "CI checks",
					provider: "local-tests",
					state: "running",
					target: "PR #1614",
					updatedAt: 10,
				},
				{
					version: 1,
					kind: "host-step",
					monitorKind: "gate",
					id: "gate-1",
					label: "Review gate",
					provider: "opaque-provider",
					state: "done",
					verdict: "inconclusive",
					reasonCode: "stale-head",
					freshness: { expectedRef: "old", observedRef: "new", stale: true },
					reportPath: "/tmp/reports/gate.json",
					updatedAt: 20,
				},
			],
		};

		const text = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(text, /async workflow: host-run ─ background/);
		assert.match(text, /id: host-run · 0\/2 done · 1 active · 1 blocked/);
		assert.match(text, /ci-1 · active · CI checks/);
		assert.match(text, /gate-1 · blocked · Review gate/);
		assert.match(text, /bottleneck · gate-1 · blocked/);
		assert.doesNotMatch(text, /Plan:|next:|output:/i);

		const expanded = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(expanded, /ci: CI checks · running · provider:local-tests · PR #1614/);
		assert.match(expanded, /gate: Review gate · inconclusive · provider:opaque-provider · reason:stale-head · stale · out:gate.json/);
	});

	it("chooses the most severe compact workflow bottleneck", () => {
		const text = buildWidgetLines([{
			asyncId: "workflow-bottleneck-severity",
			asyncDir: "/tmp/workflow-bottleneck-severity",
			status: "running",
			mode: "workflow",
			steps: [
				{ index: 0, workflowKey: "paused-first", agent: "worker", status: "paused" },
				{ index: 1, workflowKey: "failed-later", agent: "reviewer", status: "failed", error: "review failed" },
			],
		}], theme, 180).join("\n");
		assert.match(text, /paused-first · worker · paused/);
		assert.match(text, /failed-later · reviewer · failed/);
		assert.match(text, /bottleneck · failed-later · failed/);
		assert.doesNotMatch(text, /bottleneck · paused-first/);
	});

	it("renders a workflow failure detail once in expanded checklist output", () => {
		const detail = "review failed with one canonical diagnostic";
		const text = buildWidgetLines([{
			asyncId: "workflow-error-dedup",
			asyncDir: "/tmp/workflow-error-dedup",
			status: "failed",
			mode: "workflow",
			steps: [{ index: 0, workflowKey: "review", agent: "reviewer", status: "failed", error: detail }],
		}], theme, 180, true).join("\n");

		assert.equal(text.match(new RegExp(detail, "g"))?.length, 1, text);
	});

	it("keeps simple one-off async rows on the existing fallback projection", () => {
		const job = {
			asyncId: "simple-run",
			asyncDir: "/tmp/simple-run",
			cwd: "/repo/simple",
			status: "running",
			mode: "single",
			agents: ["scout"],
			description: "Explore the repository",
			outputFile: "/tmp/simple-run/output-0.log",
			currentTool: "read",
		};

		assert.equal(projectAsyncLane(job), undefined);
		const text = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(text, /async subagent scout · background/);
		assert.match(text, /⎿  read/);
		assert.doesNotMatch(text, /lane:/);
	});

	it("keeps lane state and next-action signals distinct for terminal and attention states", () => {
		const states = [
			{ status: "complete", expectedState: "complete", expectedNext: "inspect output" },
			{ status: "failed", expectedState: "failed", expectedNext: "inspect failure" },
			{ status: "paused", expectedState: "paused", expectedNext: "inspect paused state" },
			{ status: "stopped", expectedState: "stopped", expectedNext: "inspect stopped state" },
		] as const;
		for (const [index, candidate] of states.entries()) {
			const lane = projectAsyncLane({
				asyncId: `state-${index}`,
				asyncDir: `/tmp/state-${index}`,
				status: candidate.status,
				mode: "single",
				agents: ["worker"],
				workflowKey: "stateful",
				description: "stateful work item",
				steps: [{ agent: "worker", status: candidate.status, outputName: "result.md" }],
			});
			assert.equal(lane?.state, candidate.expectedState);
			assert.equal(lane?.next, candidate.expectedNext);
		}
		const attention = projectAsyncLane({
			asyncId: "attention",
			asyncDir: "/tmp/attention",
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			steps: [{ agent: "reviewer", status: "running", label: "Review", activityState: "needs_attention" }],
		});
		assert.equal(attention?.next, "inspect attention");
		assert.deepEqual(attention?.chips, ["attention"]);
	});

	it("surfaces stale and tool/turn budget blocked states", () => {
		const staleJob = {
			asyncId: "stale-run",
			asyncDir: "/tmp/stale-run",
			status: "running",
			mode: "single",
			agents: ["worker"],
			steps: [{ agent: "worker", status: "running", label: "Stale work", watchdog: { phase: "stale" } }],
		};
		const stale = projectAsyncLane(staleJob);
		assert.equal(stale?.next, "inspect stale state");
		assert.deepEqual(stale?.chips, ["stale"]);

		const blockedJobs: Array<Record<string, unknown>> = [];
		for (const [index, field] of (["toolBudgetBlocked", "turnBudgetExceeded"] as const).entries()) {
			const blockedJob = {
				asyncId: `blocked-run-${index}`,
				asyncDir: `/tmp/blocked-run-${index}`,
				status: "running",
				mode: "single",
				agents: ["worker"],
				steps: [{ agent: "worker", status: "running", label: "Blocked work", [field]: true }],
			};
			blockedJobs.push(blockedJob);
			const blocked = projectAsyncLane(blockedJob);
			assert.equal(blocked?.next, "inspect blocked state");
			assert.deepEqual(blocked?.chips, ["blocked"]);
		}

		const text = buildWidgetLines([staleJob, ...blockedJobs], theme, 180).join("\n");
		assert.match(text, /next:inspect stale state/);
		assert.match(text, /\[stale\]/);
		assert.match(text, /next:inspect blocked state/);
		assert.match(text, /\[blocked\]/);
	});

	it("keeps stale and blocked lane signals in crowded progressive rows", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const jobs = [
				{
					asyncId: "progressive-stale",
					asyncDir: "/tmp/progressive-stale",
					status: "running",
					mode: "single",
					agents: ["watcher"],
					steps: [{ agent: "watcher", status: "running", label: "Stale lane", watchdog: { phase: "stale" } }],
				},
				{
					asyncId: "progressive-blocked",
					asyncDir: "/tmp/progressive-blocked",
					status: "running",
					mode: "single",
					agents: ["budgeter"],
					steps: [{ agent: "budgeter", status: "running", label: "Blocked lane", toolBudgetBlocked: true }],
				},
			];
			const ui = createUiContext();
			renderWidget(ui.ctx as never, jobs);
			const lines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(lines.length, 3, "22 terminal rows should select the collapsed progressive tier");
			const text = lines.join("\n");
			assert.match(text, /next:inspect stale state/);
			assert.match(text, /\[stale\]/);
			assert.match(text, /next:inspect blocked state/);
			assert.match(text, /\[blocked\]/);
		});
		resetWidgetLayout();
	});

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

	it("returns one physical terminal line per widget line for tool previews", () => {
		const preview = extractToolArgsPreview({ command: "first\r\n\t\x1b[31msecond\x1b[0m" });
		const lines = buildWidgetLines([{
			asyncId: "run-1",
			asyncDir: "/tmp/run",
			status: "running",
			mode: "parallel",
			agents: ["worker"],
			activeParallelGroup: true,
			runningSteps: 1,
			completedSteps: 0,
			stepsTotal: 1,
			steps: [{
				index: 0,
				agent: "worker",
				status: "running",
				currentTool: "bash",
				currentToolArgs: preview,
				recentTools: [{ tool: "bash", args: preview, endMs: 1 }],
			}],
		}], theme, 120, true);

		assert.match(lines.join("\n"), /first second/);
		for (const line of lines) assert.doesNotMatch(line, /[\r\n]/);
	});

	it("does not split surrogate pairs when widget rows shorten previews again", () => {
		const preview = `a${"😀".repeat(30)}`;
		const lines = buildWidgetLines([{
			asyncId: "run-1",
			asyncDir: "/tmp/run",
			status: "running",
			mode: "parallel",
			agents: ["worker"],
			activeParallelGroup: true,
			runningSteps: 1,
			completedSteps: 0,
			stepsTotal: 1,
			steps: [{
				index: 0,
				agent: "worker",
				status: "running",
				currentTool: "bash",
				currentToolArgs: preview,
				recentTools: [{ tool: "bash", args: preview, endMs: 1 }],
			}],
		}], theme, 60, true);

		for (const line of lines) assert.doesNotMatch(line, malformedSurrogate);
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

	it("distinguishes same-agent parallel rows with explicit labels", () => {
		const lines = buildWidgetLines([{
			asyncId: "run-labels",
			asyncDir: "/tmp/labels",
			status: "running",
			mode: "parallel",
			agents: ["reviewer", "reviewer"],
			activeParallelGroup: true,
			runningSteps: 2,
			completedSteps: 0,
			stepsTotal: 2,
			steps: [
				{ index: 0, agent: "reviewer", label: "Review auth", description: "private auth task", status: "running" },
				{ index: 1, agent: "reviewer", label: "Review billing", description: "private billing task", status: "running" },
			],
		}, {
			asyncId: "done",
			asyncDir: "/tmp/done",
			status: "complete",
			mode: "single",
			agents: ["worker"],
			startedAt: 0,
			updatedAt: 1,
		}], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /Review auth — private auth task \(reviewer\) · running/);
		assert.match(text, /Review billing — private billing task \(reviewer\) · running/);
		assert.doesNotMatch(text, /Agent \d+\/2:/);
		assert.equal(compactTaskText("  [prompt redacted]  ", "Review auth"), "Review auth");
	});

	it("renders a named top-level parallel group card with nested readable agent rows", () => {
		const now = Date.now();
		const text = buildWidgetLines([{
			asyncId: "named-parallel-group",
			asyncDir: "/tmp/named-parallel-group",
			status: "running",
			mode: "parallel",
			agents: ["scout", "reviewer", "worker"],
			activeParallelGroup: true,
			runningSteps: 2,
			completedSteps: 0,
			stepsTotal: 3,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "scout",
					label: "Gather context",
					description: "Read source files",
					status: "running",
					currentTool: "read",
					currentToolStartedAt: now - 2_000,
					currentPath: "src/tui/render.ts",
				},
				{
					index: 1,
					agent: "reviewer",
					sessionName: "reviewer: Review diff",
					status: "running",
					currentTool: "grep",
					currentToolStartedAt: now - 1_000,
					currentPath: "test/integration/render-widget.test.ts",
					phase: "review",
					workflowKey: "review",
					outputName: "review.md",
					children: [{
						id: "nested-reviewer",
						parentRunId: "named-parallel-group",
						parentStepIndex: 1,
						depth: 1,
						path: [{ runId: "named-parallel-group", stepIndex: 1 }],
						state: "running",
						agent: "nested-reviewer",
						lastUpdate: now,
					}],
				},
				{
					index: 2,
					agent: "worker",
					label: "Apply fixes",
					status: "pending",
					phase: "implementation",
					workflowKey: "worker",
					outputName: "fix.md",
				},
			],
		}], theme, 220, true).join("\n");

		assert.equal((text.match(/parallel group/g) ?? []).length, 1);
		assert.match(text, /parallel · (?:2 agents running|2 running) · 0\/3 done/);
		assert.match(text, /Gather context/);
		assert.match(text, /Review diff/);
		assert.doesNotMatch(text, /reviewer: Review diff/);
		assert.match(text, /Apply fixes/);
		assert.doesNotMatch(text, /Agent \d+\/3:/);
		assert.match(text, /nested-reviewer/);
		assert.match(text, /src\/tui\/render\.ts/);
		assert.match(text, /out:review\.md/);
		assert.match(text, /pending/);
	});

	it("groups active parallel-card rows before completed and pending rows", () => {
		const text = buildWidgetLines([{
			asyncId: "active-first-group",
			asyncDir: "/tmp/active-first-group",
			status: "running",
			mode: "parallel",
			agents: ["scout", "worker", "reviewer", "auditor"],
			activeParallelGroup: true,
			runningSteps: 2,
			completedSteps: 1,
			stepsTotal: 4,
			steps: [
				{ index: 0, agent: "scout", label: "done-scout", status: "complete" },
				{ index: 1, agent: "worker", label: "pending-worker", status: "pending" },
				{ index: 2, agent: "reviewer", label: "active-reviewer", status: "running" },
				{ index: 3, agent: "auditor", label: "active-auditor", status: "running" },
			],
		}], theme, 220, true).join("\n");
		const rowIndex = (label: string): number => text.split("\n").findIndex((line) => line.includes(label) && !line.includes("task:"));
		const done = rowIndex("done-scout");
		const pending = rowIndex("pending-worker");
		const reviewer = rowIndex("active-reviewer");
		const auditor = rowIndex("active-auditor");

		assert.ok(reviewer >= 0 && auditor >= 0 && done >= 0 && pending >= 0);
		assert.ok(reviewer < auditor, "active rows should retain stable input order");
		assert.ok(auditor < done, "active rows should precede completed rows");
		assert.ok(done < pending, "completed rows should precede pending rows");
		assert.match(text, /done-scout.*complete/);
		assert.match(text, /pending-worker.*pending/);
	});

	it("preserves completed, pending, and hidden overflow evidence in a parallel group card", () => {
		const group = {
			asyncId: "evidence-group",
			asyncDir: "/tmp/evidence-group",
			status: "running",
			mode: "parallel",
			agents: ["scout", "worker"],
			activeParallelGroup: true,
			runningSteps: 0,
			completedSteps: 1,
			stepsTotal: 2,
			steps: [
				{ index: 0, agent: "scout", label: "done-scout", status: "complete" },
				{ index: 1, agent: "worker", label: "pending-worker", status: "pending" },
			],
		};
		const text = buildWidgetLines([
			group,
			{ asyncId: "overflow-1", asyncDir: "/tmp/overflow-1", status: "running", agents: ["one"] },
			{ asyncId: "overflow-2", asyncDir: "/tmp/overflow-2", status: "running", agents: ["two"] },
			{ asyncId: "overflow-3", asyncDir: "/tmp/overflow-3", status: "running", agents: ["three"] },
			{ asyncId: "overflow-4", asyncDir: "/tmp/overflow-4", status: "running", agents: ["four"] },
		], theme, 220).join("\n");

		assert.equal((text.match(/parallel group/g) ?? []).length, 1);
		assert.match(text, /1\/2 done/);
		assert.match(text, /done-scout.*complete/);
		assert.match(text, /pending-worker.*pending/);
		assert.match(text, /\+1 more \(1 running\)/);
	});

	it("shows peak context usage and falls back to token usage without a limit", () => {
		const step = {
			index: 0,
			agent: "reviewer",
			status: "running" as const,
			tokens: { input: 31_000, output: 10_000, total: 44_000, window: 31_000, windowPeak: 32_000 },
		};
		const withLimit = buildWidgetLines([{
			asyncId: "run-context",
			asyncDir: "/tmp/context",
			status: "running" as const,
			mode: "single" as const,
			agents: ["reviewer"],
			steps: [{ ...step, contextLimit: 128_000 }],
		}], theme, 180).join("\n");
		assert.match(withLimit, /ctx 32k\/128k \(25%\)/);

		const withoutLimit = buildWidgetLines([{
			asyncId: "run-context-fallback",
			asyncDir: "/tmp/context-fallback",
			status: "running" as const,
			mode: "single" as const,
			agents: ["reviewer"],
			steps: [step],
		}], theme, 180).join("\n");
		assert.match(withoutLimit, /31k window · 44k spent/);
		assert.doesNotMatch(withoutLimit, /ctx 32k\/128k/);
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
		assert.match(text, /parallel group · 3 agents running · 0\/3 done/);
		assert.match(text, /Agent 1\/3: reviewer · running · active now · 5 turns · 18 tool uses · 44k token/);
		assert.match(text, /Agent 2\/3: reviewer · running · active 2s ago · 4 turns · 13 tool uses · 22k token/);
		assert.match(text, /Agent 3\/3: reviewer · running · grep \| 1\.0s · 3 turns · 11 tool uses · 19k token/);
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.doesNotMatch(text, /widget truncated/);
		assert.ok(lines.length <= 10, "collapsed component should stay under Pi's string-widget cap even though it bypasses it");
	});

	it("uses a bounded string-array snapshot widget in RPC mode", () => {
		const ui = createUiContext();
		(ui.ctx as { mode?: string }).mode = "rpc";
		renderWidget(ui.ctx as never, [{
			asyncId: "run-rpc",
			asyncDir: "/tmp/private-run-rpc",
			cwd: "/repo/private",
			status: "running",
			mode: "single",
			agents: ["worker"],
			currentTool: "bash",
			steps: [{ agent: "worker", status: "running", currentToolArgs: "private args" }],
		}]);

		const widget = ui.widgets.at(-1);
		assert.ok(Array.isArray(widget), "RPC mode should install a string-array widget payload");
		const [line] = widget as string[];
		assert.ok(line?.startsWith("PI_SUBAGENT_ASYNC_JSON:"));
		const snapshot = JSON.parse(line.slice("PI_SUBAGENT_ASYNC_JSON:".length));
		assert.equal(snapshot.kind, "pi-subagents.async-status-snapshot");
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.runs[0].id, "run-rpc");
		assert.equal(JSON.stringify(snapshot).includes("/tmp/private-run-rpc"), false);
		assert.equal(JSON.stringify(snapshot).includes("private args"), false);
	});

	it("honors the component render width instead of the terminal width", () => {
		resetWidgetLayout();
		withStdoutSize(50, 120, () => {
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [{
				asyncId: "run-narrow",
				asyncDir: "/tmp/pi-subagents-uid-1000/async-subagent-runs/call_with_a_long_identifier",
				status: "running",
				mode: "parallel",
				agents: ["correctness", "tests-maintainability"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 0,
				stepsTotal: 2,
				steps: [
					{ index: 0, agent: "correctness", status: "running" },
					{ index: 1, agent: "tests-maintainability", status: "running" },
				],
			}]);

			const widget = ui.widgets.at(-1);
			for (const width of [0, 1, 2, 3, 74]) {
				const lines = renderWidgetLines(widget, width);
				assert.ok(lines.length > 0);
				for (const line of lines) {
					assert.ok(visibleWidth(line) <= width, `widget line exceeds render width: ${visibleWidth(line)} > ${width}`);
				}
			}
		});
		resetWidgetLayout();
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

	it("selects the current flat-indexed member from a collapsed parallel group", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const parallelGroupJob = {
				asyncId: "run-parallel-slice",
				asyncDir: "/tmp/run-parallel-slice",
				status: "running",
				mode: "chain",
				agents: ["producer", "reviewer", "worker"],
				activeParallelGroup: true,
				currentStep: 3,
				chainStepCount: 2,
				parallelGroups: [{ start: 2, count: 2, stepIndex: 1 }],
				steps: [
					{ index: 2, agent: "reviewer", status: "complete", label: "First parallel member", description: "First member task", phase: "first-phase", workflowKey: "first-ref", outputName: "first.md" },
					{ index: 3, agent: "worker", status: "running", label: "Current parallel member", description: "Current member task", phase: "current-phase", workflowKey: "current-ref", outputName: "current.md" },
				],
			};
			const direct = projectAsyncLane(parallelGroupJob);
			assert.equal(direct?.label, "Current parallel member — Current member task");
			assert.equal(direct?.role, "worker");
			assert.equal(direct?.phase, "current-phase");
			assert.equal(direct?.output, "current.md");
			assert.equal(direct?.ref, "current-ref");

			const ui = createUiContext();
			renderWidget(ui.ctx as never, [parallelGroupJob, {
				asyncId: "run-parallel-sibling",
				asyncDir: "/tmp/run-parallel-sibling",
				status: "running",
				mode: "single",
				agents: ["sibling"],
				currentTool: "read",
			}]);
			const lines = renderWidgetLines(ui.widgets.at(-1));
			const text = lines.join("\n");
			assert.match(text, /Current parallel member — Current member task/);
			assert.doesNotMatch(text, /First parallel member — First member task/);
		});
		resetWidgetLayout();
	});

	it("renders loaded workflow lanes without normal-running bottleneck noise", () => {
		resetWidgetLayout();
		withStdoutSize(30, 120, () => {
			const stageKeys = ["scope-scout", "red-tests", "label-helpers", "summary-title", "detail-row", "tiers-noise", "validation", "minimality-challenge", "fresh-review"];
			const nodeIds = stageKeys.map((key) => `issue-1695.${key}`);
			const statuses = stageKeys.map((_, index) => index < 7 ? "completed" : index === 7 ? "running" : "pending");
			const workflowGraph = {
				runId: "workflow-1695",
				mode: "workflow",
				phases: stageKeys.map((title, index) => ({ title, nodeIds: [nodeIds[index]!] })),
				nodes: stageKeys.map((key, index) => ({
					id: nodeIds[index],
					kind: "step",
					agent: index === 0 ? "scout" : "worker",
					label: key,
					status: statuses[index],
					flatIndex: index,
					stepIndex: index,
				})),
				currentNodeId: nodeIds[7],
			};
			const job = {
				asyncId: "workflow-1695",
				asyncDir: "/tmp/workflow-1695",
				status: "running",
				mode: "workflow",
				agents: ["scout", "worker"],
				currentStep: 7,
				stepsTotal: stageKeys.length,
				updatedAt: 200,
				workflowGraph,
				steps: stageKeys.slice(0, 8).map((key, index) => ({
					index,
					agent: index === 0 ? "scout" : "worker",
					status: statuses[index],
					label: key,
					workflowKey: nodeIds[index],
					phase: "issue-1695",
					description: `${key} task`,
					outputName: `${key}.md`,
					...(index < 3 ? { lastActivityAt: 100 } : { currentTool: "read", currentToolStartedAt: 190, lastActivityAt: 195 }),
				})),
			};
			const lines = buildWidgetLines([job], theme, 220);
			const text = lines.join("\n");
			assert.match(text, /async workflow: workflow ─ background/);
			assert.match(text, /id: workflow · 7\/9 done · 1 active · 1 queued/);
			assert.match(text, /issue-1695\.minimality-challenge · worker · active/);
			assert.match(text, /issue-1695\.fresh-review · worker · queued/);
			assert.doesNotMatch(text, /bottleneck ·/);
			assert.match(text, /Press configured-expand-key for details/);
			assert.match(text, /label-helpers/);
			assert.doesNotMatch(text, /Step \d+\/9|task:|workspace:|out(?:put)?:|next:/i);
		});
		resetWidgetLayout();
	});

	it("prioritizes failed, blocked, and gate stages over completed history", () => {
		const stages = [
			{ index: 0, agent: "scout", label: "completed-history", workflowKey: "issue-1695.completed-history", status: "complete" },
			{ index: 1, agent: "worker", label: "failed-stage", workflowKey: "issue-1695.failed-stage", status: "failed", error: "stage failed" },
			{ index: 2, agent: "worker", label: "blocked-stage", workflowKey: "issue-1695.blocked-stage", status: "pending", toolBudgetBlocked: true },
			{ index: 3, agent: "reviewer", label: "gate-stage", workflowKey: "issue-1695.gate-stage", status: "complete", review: { status: "blockers" } },
			{ index: 4, agent: "worker", label: "completed-tail", workflowKey: "issue-1695.completed-tail", status: "complete" },
		];
		const workflowGraph = {
			runId: "workflow-priority",
			mode: "workflow",
			phases: [{ title: "issue-1695 staged lane", nodeIds: stages.map((stage) => stage.workflowKey) }],
			nodes: stages.map((stage) => ({
				id: stage.workflowKey,
				kind: "step",
				agent: stage.agent,
				label: stage.label,
				status: stage.status === "complete" ? "completed" : stage.status === "failed" ? "failed" : "pending",
				flatIndex: stage.index,
				stepIndex: stage.index,
			})),
			currentNodeId: "issue-1695.failed-stage",
		};
		const text = buildWidgetLines([{
			asyncId: "workflow-priority",
			asyncDir: "/tmp/workflow-priority",
			status: "running",
			mode: "workflow",
			agents: ["scout", "worker", "reviewer"],
			currentStep: 1,
			stepsTotal: stages.length,
			workflowGraph,
			steps: stages,
		}], theme, 220, true).join("\n");
		const rowIndex = (label: string): number => text.split("\n").findIndex((line) => line.includes(label));
		const completed = rowIndex("completed-history");
		const failed = rowIndex("failed-stage");
		const blocked = rowIndex("blocked-stage");
		const gate = rowIndex("gate-stage");
		assert.ok(completed >= 0 && failed >= 0 && blocked >= 0 && gate >= 0, text);
		assert.ok(failed < completed, `failed stage should precede completed history:\n${text}`);
		assert.ok(blocked < completed, `blocked stage should precede completed history:\n${text}`);
		assert.ok(gate < completed, `gate stage should precede completed history:\n${text}`);
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
			assert.match(text, /parallel group · 1 agent running · 0\/1 done/);
			assert.match(text, /reviewer · running/);
			assert.doesNotMatch(text, /subagents \(1\/1 running\)/);
		});
		resetWidgetLayout();
	});

	it("updates component expansion state without reinstalling the widget", () => {
		resetWidgetLayout();
		withStdoutSize(20, 120, () => {
			const ui = createUiContext();
			let expanded = false;
			ui.ctx.ui.getToolsExpanded = () => expanded;
			renderWidget(ui.ctx as never, [{
				asyncId: "run-toggle-expanded",
				asyncDir: "/tmp/run-toggle-expanded",
				status: "running",
				mode: "parallel",
				agents: ["reviewer"],
				activeParallelGroup: true,
				runningSteps: 1,
				completedSteps: 0,
				stepsTotal: 1,
				steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
			}]);
			const component = (ui.widgets.at(-1) as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, theme);

			const collapsed = component.render(180).join("\n");
			expanded = true;
			const expandedText = component.render(180).join("\n");

			assert.match(collapsed, /subagents \(1\/1 running\)/);
			assert.doesNotMatch(collapsed, /parallel group · 1 agent running/);
			assert.match(expandedText, /parallel group · 1 agent running · 0\/1 done/);
			assert.match(expandedText, /reviewer · running/);
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
					{ agent: "reviewer", sessionName: "  reviewer: Inspect the first row  ", status: "running", lastActivityAt: now, toolCount: 2 },
					{ agent: "reviewer", status: "running", currentTool: "read", currentToolStartedAt: now - 2000 },
					{ agent: "reviewer", status: "complete", tokens: { input: 1000, output: 500, cache: 0, total: 1500 } },
				],
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /async subagent parallel \(3\) · background/);
		assert.match(text, /parallel · 2 agents running · 1\/3 done/);
		assert.match(text, /Inspect the first row · running · 2 tool uses/);
		assert.doesNotMatch(text, /Agent 1\/3: reviewer/);
		assert.match(text, /⎿  active now/);
		assert.match(text, /Agent 2\/3: reviewer · running\n\s+⎿  read \| 2\.0s/);
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.match(text, /Agent 3\/3: reviewer · complete · 1\.5k token/);
	});

	it("prefers session names in multi-job widget step rows", () => {
		const text = buildWidgetLines([
			{
				asyncId: "run-multi-a",
				asyncDir: "/tmp/multi-a",
				status: "running",
				mode: "parallel",
				agents: ["reviewer"],
				stepsTotal: 1,
				runningSteps: 1,
				completedSteps: 0,
				steps: [{ index: 0, agent: "reviewer", sessionName: "  reviewer: Inspect the multi-job row  ", status: "running" }],
			},
			{
				asyncId: "run-multi-b",
				asyncDir: "/tmp/multi-b",
				status: "complete",
				mode: "single",
				agents: ["worker"],
				stepsTotal: 1,
				steps: [{ index: 0, agent: "worker", status: "complete" }],
			},
		], theme, 180).join("\n");

		assert.match(text, /Inspect the multi-job row · running/);
		assert.doesNotMatch(text, /reviewer: Inspect the multi-job row/);
	});

	it("shows async job and step context badges", () => {
		const now = Date.now();
		const text = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				context: "mixed",
				agents: ["scout", "worker"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 0,
				stepsTotal: 2,
				updatedAt: now,
				steps: [
					{ agent: "scout", context: "fresh", status: "running", lastActivityAt: now },
					{ agent: "worker", context: "fork", status: "running", currentTool: "bash", currentToolStartedAt: now - 1000 },
				],
			},
		], theme, 160).join("\n");

		assert.match(text, /parallel \[mixed\]/);
		assert.match(text, /scout \[fresh\] · running/);
		assert.match(text, /worker \[fork\] · running/);
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
		assert.match(text, /reviewer · running \(gpt-5\.5 · thinking high\)/);
		assert.match(text, /scout · running \(claude-haiku-4-5 · thinking low\)/);
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

		const row = lines.find((line) => line.includes("reviewer · running")) ?? "";
		assert.match(row, /reviewer · running/);
		assert.doesNotMatch(row, /reviewer \(/);
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

	it("compacts noisy repeated live output in expanded async widget rows", () => {
		const now = Date.now();
		const job = {
			asyncId: "run-noisy",
			asyncDir: "/tmp/noisy",
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
					recentOutput: [
						"I will read the required plan first.",
						"I will inspect the exact head.",
						"I will read the relevant implementation seams.",
						"I will verify the action list.",
						"I will inspect the public tool schema.",
						"I will check the async launch path.",
						"I will read agent default application path.",
					],
				},
			],
		};

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(expandedText, /↻ 7 progress updates/);
		assert.match(expandedText, /latest: read agent default application path/);
		assert.match(expandedText, /pattern: repeated short status lines/);
		assert.doesNotMatch(expandedText, /required plan first/);
	});

	it("compacts repeated subagent status snapshots inside mixed live output", () => {
		const now = Date.now();
		const job = {
			asyncId: "run-status-snapshots",
			asyncDir: "/tmp/status-snapshots",
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
					currentTool: "bash",
					currentToolArgs: "set -euo pipefail",
					currentToolStartedAt: now - 2000,
					recentOutput: [
						"reviewer · step 1/1 · 11 tool uses · 3m27s",
						"Step 1/1: reviewer · running (gpt-5.5 · thinking xhigh) · 4 turns · 11 tool uses",
						"reviewer · step 1/1 · 11 tool uses · 3m29s",
						"Step 1/1: reviewer · running (gpt-5.5 · thinking xhigh) · 4 turns · 11 tool uses",
						"reviewer · step 1/1 · 11 tool uses · 3m32s",
						"Step 1/1: reviewer · running (gpt-5.5 · thinking xhigh) · 4 turns · 11 tool uses",
						"reviewer [fresh] · running · 11 tool uses · 3m37s",
						"reviewer · running · 11 tool uses · 3m39s",
						"reviewer · running · 11 tool uses · 3m42s",
						"reviewer · running · 11 tool uses · 3m44s",
						"repo=nicobailon/pi-subagents",
						"sha=d61aca... | 2m32s",
						"output: /var/folders/x/T/pi-subagents-uid-501/async-subagent-runs/run-status-snapshots/output.log",
					],
				},
			],
		};

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(expandedText, /↻ 11 progress updates/);
		assert.match(expandedText, /latest: output: \/var\/folders\/x\/T\/pi-subagents-uid-501\/async-subagent-runs\/run-status-snapshots\/output.log/);
		assert.match(expandedText, /repo=nicobailon\/pi-subagents/);
		assert.match(expandedText, /sha=d61aca\.\.\. \| 2m32s/);
		assert.doesNotMatch(expandedText, /3m27s/);
		assert.doesNotMatch(expandedText, /3m29s/);
		assert.doesNotMatch(expandedText, /3m37s/);
		assert.doesNotMatch(expandedText, /3m39s/);
		assert.doesNotMatch(expandedText, /3m42s/);
		assert.doesNotMatch(expandedText, /3m44s/);
	});

	it("keeps mixed live output raw instead of hiding non-status lines", () => {
		const now = Date.now();
		const job = {
			asyncId: "run-mixed",
			asyncDir: "/tmp/mixed",
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
					recentOutput: [
						"I will read the required plan first.",
						"I will inspect the exact head.",
						"I will verify the action list.",
						"I will check the async launch path.",
						"error: failed to fetch review threads",
						"details: GraphQL returned 502",
					],
				},
			],
		};

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /↻/);
		assert.match(expandedText, /error: failed to fetch review threads/);
		assert.match(expandedText, /details: GraphQL returned 502/);
	});

	it("keeps status-looking error signals visible", () => {
		const now = Date.now();
		const job = {
			asyncId: "run-status-error",
			asyncDir: "/tmp/status-error",
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
					recentOutput: [
						"Checking permissions: Access Denied",
						"Checking token state: error from GitHub",
						"Checking CI: failed",
						"Checking retry: timed out",
						"Checking fallback: unable to recover",
						"Checking final status: rejected",
					],
				},
			],
		};

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /↻/);
		assert.match(expandedText, /older signal line: Checking permissions: Access Denied/);
		assert.match(expandedText, /Checking final status: rejected/);
	});

	it("dedupes one-child single async summary/title while retaining detail evidence", () => {
		const now = Date.now();
		const job = {
			asyncId: "single-run",
			asyncDir: "/tmp/single-run",
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			currentStep: 0,
			stepsTotal: 1,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "reviewer",
					sessionName: "  reviewer: Review the widget  ",
					status: "running",
					description: "Review the widget",
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					toolCount: 23,
					durationMs: 49_100,
					recentOutput: ["error: failed to inspect the widget"],
				},
			],
		};

		const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
		const collapsedLines = collapsedText.split("\n");
		const collapsedSummary = collapsedLines.slice(0, 2).join("\n");
		assert.doesNotMatch(collapsedSummary, /step 1\/1/i);
		assert.match(collapsedSummary, /async subagent · background/);
		assert.match(collapsedSummary, /reviewer/);
		assert.match(collapsedLines[1] ?? "", /reviewer · running · 23 tool uses · 49\.1s/);
		assert.equal(collapsedLines.filter((line) => line.includes("reviewer · running · 23 tool uses · 49.1s")).length, 1);
		assert.doesNotMatch(collapsedText, /Step 1\/1: reviewer:/);
		assert.match(collapsedText, /reviewer · running · 23 tool uses · 49\.1s/);
		assert.match(collapsedText, /task: Review the widget/);
		assert.match(collapsedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(collapsedText, /Press configured-expand-key for live detail/);
		assert.match(collapsedText, outputPathPattern("/tmp/single-run/output-0.log"));
		assert.doesNotMatch(collapsedText, /error: failed to inspect the widget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		const expandedLines = expandedText.split("\n");
		const expandedSummary = expandedLines.slice(0, 2).join("\n");
		assert.doesNotMatch(expandedText, /Press configured-expand-key for live detail/);
		assert.doesNotMatch(expandedSummary, /step 1\/1/i);
		assert.match(expandedSummary, /async subagent · background/);
		assert.match(expandedSummary, /reviewer/);
		assert.match(expandedLines[1] ?? "", /reviewer · running · 23 tool uses · 49\.1s/);
		assert.equal(expandedLines.filter((line) => line.includes("reviewer · running · 23 tool uses · 49.1s")).length, 1);
		assert.doesNotMatch(expandedText, /Step 1\/1: reviewer:/);
		assert.match(expandedText, /reviewer · running · 23 tool uses · 49\.1s/);
		assert.match(expandedText, /task: Review the widget/);
		assert.match(expandedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(expandedText, /error: failed to inspect the widget/);
		assert.match(expandedText, outputPathPattern("/tmp/single-run/output-0.log"));
	});

	it("collapses a completed single child but keeps a mismatched step header", () => {
		const completed = buildWidgetLines([{
			asyncId: "single-complete",
			asyncDir: "/tmp/single-complete",
			status: "complete",
			mode: "single",
			agents: ["reviewer"],
			stepsTotal: 1,
			steps: [{ index: 0, agent: "reviewer", sessionName: "reviewer: Review the widget", status: "completed" }],
		}], theme, 180).join("\n");
		assert.match(completed, /reviewer · complete/);
		assert.doesNotMatch(completed, /Step 1\/1: reviewer:/);
		assert.match(completed, /task: Review the widget/);

		const mismatched = buildWidgetLines([{
			asyncId: "single-mismatch",
			asyncDir: "/tmp/single-mismatch",
			status: "complete",
			mode: "single",
			agents: ["reviewer"],
			currentStep: 0,
			stepsTotal: 1,
			steps: [{ index: 0, agent: "reviewer", sessionName: "reviewer: Review the widget", status: "running" }],
		}], theme, 180).join("\n");
		assert.match(mismatched, /Step 1\/1: reviewer: Review the widget · running/);
	});

	it("keeps explicit single-child error and gate evidence with a step header", () => {
		const text = buildWidgetLines([{
			asyncId: "single-evidence",
			asyncDir: "/tmp/single-evidence",
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			currentStep: 0,
			stepsTotal: 1,
			steps: [{
				index: 0,
				agent: "reviewer",
				sessionName: "reviewer: Review the widget",
				status: "running",
				error: "failed to inspect the widget",
				review: { status: "blockers" },
			}],
		}], theme, 180, true).join("\n");
		assert.match(text, /Step 1\/1: reviewer: Review the widget · running/);
		assert.match(text, /error: failed to inspect the widget/);
		assert.match(text, /gate:review blockers/);
	});

	it("keeps a Step header for lane-bearing one-child single async jobs", () => {
		const job = {
			asyncId: "single-lane",
			asyncDir: "/tmp/single-lane",
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			currentStep: 0,
			stepsTotal: 1,
			steps: [{
				index: 0,
				agent: "reviewer",
				sessionName: "reviewer: Review the widget",
				status: "running",
				phase: "fresh-review",
				label: "Review #1695",
				workflowKey: "review",
				outputName: "review.md",
			}],
		};

		for (const expanded of [false, true]) {
			const text = buildWidgetLines([job], theme, 180, expanded).join("\n");
			assert.match(text, /Step 1\/1: reviewer: Review the widget · running/);
			assert.match(text, /phase:fresh-review/);
			assert.match(text, /out:review\.md/);
		}
	});

	it("keeps failed, paused, and stopped detail evidence in single-child summaries", () => {
		for (const status of ["failed", "paused", "stopped"] as const) {
			const text = buildWidgetLines([{
				asyncId: `single-${status}`,
				asyncDir: `/tmp/single-${status}`,
				status,
				mode: "single",
				agents: ["reviewer"],
				currentStep: 0,
				stepsTotal: 1,
				steps: [{ index: 0, agent: "reviewer", status }],
			}], theme, 180).join("\n");
			const summary = text.split("\n").slice(0, 2).join("\n");

			assert.doesNotMatch(summary, /step 1\/1/i);
			assert.match(text, new RegExp(`Step 1/1: reviewer · ${status}`));
		}
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

	it("keeps the chain step number while nesting readable rows in an active parallel group card", () => {
		const text = buildWidgetLines([{
			asyncId: "active-chain-group",
			asyncDir: "/tmp/active-chain-group",
			status: "running",
			mode: "chain",
			agents: ["producer", "scout", "reviewer"],
			activeParallelGroup: true,
			currentStep: 2,
			chainStepCount: 3,
			parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
			runningSteps: 1,
			completedSteps: 1,
			stepsTotal: 2,
			steps: [
				{ index: 1, agent: "scout", label: "Inspect source", status: "complete" },
				{ index: 2, agent: "reviewer", label: "Review diff", status: "running" },
			],
		}], theme, 220, true).join("\n");

		assert.match(text, /chain · step 2\/3/);
		assert.match(text, /Step 2\/3: parallel group/);
		assert.match(text, /Inspect source/);
		assert.match(text, /Review diff/);
		assert.doesNotMatch(text, /Agent \d+\/3:/);
	});

	it("renders child rows beneath an inactive chain parallel-group header", () => {
		const text = buildWidgetLines([{
			asyncId: "completed-chain-group",
			asyncDir: "/tmp/completed-chain-group",
			status: "running",
			mode: "chain",
			agents: ["scout", "reviewer", "writer"],
			activeParallelGroup: false,
			currentStep: 3,
			chainStepCount: 2,
			parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }],
			stepsTotal: 3,
			steps: [
				{ index: 0, agent: "scout", label: "Gather context", status: "complete" },
				{ index: 1, agent: "reviewer", label: "Review diff", status: "complete" },
				{ index: 2, agent: "writer", label: "Apply fixes", status: "running" },
			],
		}], theme, 220, true).join("\n");
		const headerIndex = text.indexOf("Step 1/2: parallel group");

		assert.ok(headerIndex >= 0);
		assert.ok(text.indexOf("Gather context", headerIndex) > headerIndex);
		assert.ok(text.indexOf("Review diff", headerIndex) > headerIndex);
		assert.match(text, /Step 2\/2: writer/);
	});

	it("renders a pending dynamic fanout placeholder instead of an empty parallel group", () => {
		const text = buildWidgetLines([{
			asyncId: "dynamic-placeholder",
			asyncDir: "/tmp/dynamic-placeholder",
			status: "running",
			mode: "chain",
			agents: ["expand:reviewer"],
			activeParallelGroup: true,
			currentStep: 0,
			chainStepCount: 1,
			parallelGroups: [{ start: 0, count: 1, stepIndex: 0 }],
			runningSteps: 0,
			completedSteps: 0,
			stepsTotal: 1,
			steps: [{
				index: 0,
				agent: "expand:reviewer",
				label: "Dynamic fanout (reviews)",
				description: "Await review targets",
				status: "pending",
				workflowKey: "dynamic-review",
				outputName: "reviews.md",
			}],
		}], theme, 220, true).join("\n");

		assert.match(text, /parallel group/);
		assert.match(text, /Step 1\/1: parallel group/);
		assert.match(text, /Dynamic fanout \(reviews\)/);
		assert.match(text, /pending/);
		assert.match(text, /next:await launch/);
	});

	it("uses logical chain steps after an async chain parallel group finishes", () => {
		const job = {
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
		};
		const lines = buildWidgetLines([job], theme, 180, false, 0);

		const text = lines.join("\n");
		assert.match(text, /async subagent chain \(2\)/);
		assert.match(text, /chain · step 2\/2/);
		assert.match(text, /Step 1\/2: parallel group · 3\/3 done/);
		assert.match(text, /Step 2\/2: writer · running · 1 tool use/);
		assert.match(text, /Press configured-expand-key for live detail/);
		assert.match(text, outputPathPattern("/tmp/chain/output-3.log"));
		assert.doesNotMatch(text, /step 4\/4/);
		assert.doesNotMatch(text, /Step 4\/4/);

		const second = buildWidgetLines([job], theme, 180, false, 1);
		assert.notEqual(
			firstRunningGlyph(lines.find((line) => line.includes("Step 2/2")) ?? ""),
			firstRunningGlyph(second.find((line) => line.includes("Step 2/2")) ?? ""),
			"logical chain step glyph should advance with the render frame",
		);
	});

	it("keeps chain step structure when only one logical child is materialized", () => {
		const job = {
			asyncId: "partial-chain",
			asyncDir: "/tmp/partial-chain",
			status: "running",
			mode: "chain",
			agents: ["planner", "reviewer"],
			currentStep: 0,
			chainStepCount: 2,
			stepsTotal: 1,
			steps: [{
				index: 0,
				agent: "planner",
				sessionName: "planner: Plan the review",
				status: "running",
			}],
		};
		const text = buildWidgetLines([job], theme, 180).join("\n");

		assert.match(text, /async subagent chain \(2\) · background/);
		assert.match(text, /chain · step 1\/2/);
		assert.match(text, /Step 1\/2: planner: Plan the review/);
		assert.doesNotMatch(text, /Step 1\/1: planner: Plan the review/);
		assert.doesNotMatch(text, /\s+[^\n]*planner · running/);
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

	it("keeps running widget glyphs stable across unrelated renders of the same frame", () => {
		const originalNow = Date.now;
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
		try {
			Date.now = () => 1_000;
			const first = buildWidgetLines([job], theme, 120, false, 0);
			Date.now = () => 1_125;
			const second = buildWidgetLines([job], theme, 120, false, 0);
			const third = buildWidgetLines([job], theme, 120, false, 1);
			const withoutRunningGlyphs = (lines: string[]) => lines.map((line) => line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu, ""));

			assert.deepEqual(second, first, "unrelated renders of the same frame must not retick the glyph");
			assert.notDeepEqual(third, first);
			assert.deepEqual(withoutRunningGlyphs(third), withoutRunningGlyphs(first), "only the running glyph should change");
			assert.notEqual(firstGrapheme(first[1] ?? ""), firstGrapheme(third[1] ?? ""));
		} finally {
			Date.now = originalNow;
		}
	});

	it("advances component running glyphs with the render clock", () => {
		const originalNow = Date.now;
		let renderRequests = 0;
		try {
			Date.now = () => 1_000;
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [{
				asyncId: "run-stable",
				asyncDir: "/tmp/run",
				status: "running",
				mode: "parallel",
				agents: ["reviewer"],
				activeParallelGroup: true,
				runningSteps: 1,
				completedSteps: 0,
				stepsTotal: 1,
				updatedAt: 1_000,
				steps: [{ index: 0, agent: "reviewer", status: "running" }],
			}, {
				asyncId: "run-other",
				asyncDir: "/tmp/other",
				status: "running",
				mode: "single",
				agents: ["scout"],
				updatedAt: 1_000,
			}]);
			const component = (ui.widgets.at(-1) as (_tui: { requestRender(): void }, widgetTheme: typeof theme) => { render(width: number): string[] })(
				{ requestRender: () => { renderRequests += 1; } },
				theme,
			);
			const first = component.render(180);

			Date.now = () => 2_000;
			const second = component.render(180);
			const withoutRunningGlyphs = (lines: string[]) => lines.map((line) => line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu, ""));

			assert.equal(renderRequests, 0, "the component must not own the repaint cadence");
			assert.notDeepEqual(second, first, "the animation clock should advance quiet running glyphs");
			assert.deepEqual(withoutRunningGlyphs(second), withoutRunningGlyphs(first), "only running glyphs should change");
			assert.notEqual(firstRunningGlyph(first[0] ?? ""), firstRunningGlyph(second[0] ?? ""), "header glyph should advance");
			assert.notEqual(firstRunningGlyph(first[1] ?? ""), firstRunningGlyph(second[1] ?? ""), "job glyph should advance");
			assert.notEqual(
				firstRunningGlyph(first.find((line) => line.includes("reviewer · running")) ?? ""),
				firstRunningGlyph(second.find((line) => line.includes("reviewer · running")) ?? ""),
				"step glyph should advance",
			);
		} finally {
			Date.now = originalNow;
			renderWidget(createUiContext().ctx as never, []);
		}
	});

	it("memoizes component render output by width and animation frame", () => {
		const originalNow = Date.now;
		let themeCalls = 0;
		const countingTheme = {
			fg: (_name: string, text: string) => {
				themeCalls += 1;
				return text;
			},
			bold: (text: string) => text,
		};
		try {
			Date.now = () => 1_000;
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [{ asyncId: "run-stable", asyncDir: "/tmp/run", status: "running", agents: ["scout"], updatedAt: 1_000 }]);
			const component = (ui.widgets.at(-1) as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, countingTheme);
			const first = component.render(180);
			const callsAfterFirst = themeCalls;

			assert.equal(component.render(180), first);
			assert.equal(themeCalls, callsAfterFirst, "same width and frame should reuse the rendered lines");

			component.render(120);
			assert.ok(themeCalls > callsAfterFirst, "a width change should rebuild lines");
			const callsAfterWidthChange = themeCalls;

			Date.now = () => 2_000;
			component.render(120);
			assert.ok(themeCalls > callsAfterWidthChange, "an animation-frame change should rebuild lines");
		} finally {
			Date.now = originalNow;
			renderWidget(createUiContext().ctx as never, []);
		}
	});

	it("does not animate queued-only widgets", () => {
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [{ asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] }]);
			const component = (ui.widgets.at(-1) as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, theme);
			const first = component.render(180);
			Date.now = () => 1_250;
			assert.deepEqual(component.render(180), first);
			assert.equal(ui.renderRequests, 0);
		} finally {
			Date.now = originalNow;
			renderWidget(createUiContext().ctx as never, []);
		}
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
