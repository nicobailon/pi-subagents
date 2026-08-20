import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { row } from "../../src/tui/render-helpers.ts";
import { renderSubagentResult, truncLine, widgetRenderKey } from "../../src/tui/render.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

const theme = {
	fg(_name: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

function componentText(component: unknown): string {
	if (typeof component !== "object" || component === null) return "";
	if ("text" in component && typeof component.text === "string") return component.text;
	if ("children" in component && Array.isArray(component.children)) return component.children.map(componentText).filter(Boolean).join("\n");
	return "";
}

function result(agent: string, output: string) {
	return {
		agent,
		task: `${agent} task`,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		finalOutput: output,
	};
}

test("row clips content to the available width", () => {
	const rendered = row("abcdef", 6, theme as any);
	assert.equal(visibleWidth(rendered), 6);
});

test("row normalizes multiline content before clipping", () => {
	const rendered = row("bash failed: line 1\nline 2\tvalue", 20, theme as any);
	assert.equal(visibleWidth(rendered), 20);
	assert.doesNotMatch(rendered, /[\r\n\t]/);
});

test("row keeps styled multiline content within the available width", () => {
	const rendered = row("\u001b[31merror line 1\nline 2\tvalue\u001b[39m", 18, theme as any);
	assert.equal(visibleWidth(rendered), 18);
	assert.doesNotMatch(rendered, /[\r\n\t]/);
});

test("truncLine preserves ANSI styles and resets through the ellipsis", () => {
	assert.equal(truncLine("\u001b[31mabcdef\u001b[0m", 4), "\u001b[31mabc\u001b[31m…");
	assert.equal(truncLine("\u001b[31mab\u001b[0mcdef", 4), "\u001b[31mab\u001b[0mc…");
	assert.equal(truncLine("ab\u001b[xcd", 4), "ab\u001b[…");
});

test("truncLine respects grapheme display width", () => {
	const rendered = truncLine("🙂🙂🙂", 5);
	assert.equal(rendered, "🙂🙂…");
	assert.equal(visibleWidth(rendered), 5);
});

test("truncLine emits no marker at zero width", () => {
	assert.equal(truncLine("abcdef", 0), "");
});

test("widget render keys keep compact payloads quiet and expanded payloads fresh", () => {
	const job: AsyncJobState = {
		asyncId: "workflow-1",
		asyncDir: "/tmp/workflow-1",
		status: "running",
		mode: "workflow",
		startedAt: 100,
		updatedAt: 200,
		steps: [{
			agent: "reviewer",
			workflowKey: "review",
			status: "running",
			currentTool: "grep",
			recentOutput: ["started", "x".repeat(20_000)],
			recentTools: [
				{ tool: "read", args: "hidden", endMs: 100 },
				{ tool: "grep", args: "visible", endMs: 150 },
			],
		}],
	};
	const noisy = structuredClone(job);
	noisy.steps![0]!.recentOutput = ["started", "y".repeat(20_000)];
	noisy.steps![0]!.recentTools = [
		{ tool: "read", args: "changed-hidden", endMs: 100 },
		{ tool: "grep", args: "visible", endMs: 150 },
	];
	assert.equal(widgetRenderKey(noisy), widgetRenderKey(job));
	assert.notEqual(widgetRenderKey(noisy, true), widgetRenderKey(job, true));

	const expandedVisibleChange = structuredClone(job);
	expandedVisibleChange.steps![0]!.recentTools![1]!.args = "changed-visible";
	assert.equal(widgetRenderKey(expandedVisibleChange), widgetRenderKey(job));
	assert.notEqual(widgetRenderKey(expandedVisibleChange, true), widgetRenderKey(job, true));

	const visibleChange = structuredClone(job);
	visibleChange.steps![0]!.currentTool = "bash";
	assert.notEqual(widgetRenderKey(visibleChange), widgetRenderKey(job));

	const visibleArgsChange = structuredClone(job);
	visibleArgsChange.steps![0]!.currentToolArgs = "{\"pattern\":\"workflow\"}";
	assert.notEqual(widgetRenderKey(visibleArgsChange), widgetRenderKey(job));

	const nestedVisibleChange = structuredClone(job);
	nestedVisibleChange.nestedChildren = [{ id: "nested-1", parentRunId: "workflow-1", depth: 1, path: [{ runId: "workflow-1" }], state: "failed", agent: "nested", error: "failed" }];
	assert.notEqual(widgetRenderKey(nestedVisibleChange), widgetRenderKey(job));
});

test("multiline rendering omits two-column graphemes at one-column width", () => {
	const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: 5 });
	try {
		const rendered = componentText(renderSubagentResult({
			content: [{ type: "text", text: "a🙂b\n🙂" }],
		}, { expanded: true }, theme as any));
		assert.deepEqual(rendered.split("\n"), ["a", "b"]);
		for (const line of rendered.split("\n")) assert.ok(visibleWidth(line) <= 1);
	} finally {
		if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
		else delete (process.stdout as { columns?: number }).columns;
	}
});

test("running single-subagent cards show the configured detach shortcut", () => {
	const running = {
		...result("reviewer", ""),
		progress: { status: "running", index: 0, agent: "reviewer", toolCount: 0, tokens: 0, durationMs: 0 },
	};
	const toolResult = {
		content: [{ type: "text", text: "running" }],
		details: { mode: "single", results: [running] },
	};

	const configured = componentText(renderSubagentResult(
		toolResult as never,
		{ expanded: false },
		theme as any,
		undefined,
		undefined,
		"ctrl+b",
	));
	assert.match(configured, /Ctrl\+B to run in background/);

	const unconfigured = componentText(renderSubagentResult(toolResult as never, { expanded: false }, theme as any));
	assert.doesNotMatch(unconfigured, /run in background/);

	const alreadyBackground = componentText(renderSubagentResult(
		{ ...toolResult, details: { ...toolResult.details, asyncId: "async-123" } } as never,
		{ expanded: false },
		theme as any,
		undefined,
		undefined,
		"ctrl+b",
	));
	assert.doesNotMatch(alreadyBackground, /run in background/);

	const pendingBackground = componentText(renderSubagentResult(
		{ ...toolResult, details: { ...toolResult.details, background: true } } as never,
		{ expanded: false },
		theme as any,
		undefined,
		undefined,
		"ctrl+b",
	));
	assert.doesNotMatch(pendingBackground, /run in background/);
});

test("compact chain rendering uses workflow graph spans for dynamic fanout results", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets"), result("reviewer", "a"), result("reviewer", "b"), result("writer", "final")],
			workflowGraph: {
				runId: "render-dynamic",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "completed",
						stepIndex: 1,
						children: [
							{ id: "step-1-item-a", kind: "agent", agent: "reviewer", label: "Review A", status: "completed", flatIndex: 1, stepIndex: 1 },
							{ id: "step-1-item-b", kind: "agent", agent: "reviewer", label: "Review B", status: "completed", flatIndex: 2, stepIndex: 1 },
						],
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "completed", flatIndex: 3, stepIndex: 2 },
				],
			},
		},
	}, { expanded: false }, theme as any);

	const text = componentText(component);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Agent 1\/2: reviewer/);
	assert.match(text, /Agent 2\/2: reviewer/);
	assert.match(text, /Step 3: writer/);
});

test("compact chain rendering shows failed zero-child dynamic fanout groups", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "failed" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets")],
			workflowGraph: {
				runId: "render-empty-dynamic-failed",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "failed",
						stepIndex: 1,
						children: [],
						error: "No review targets materialized",
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "pending", stepIndex: 2 },
				],
			},
		},
	}, { expanded: false }, theme as any);

	const text = componentText(component);
	assert.match(text, /step 1\/3/);
	assert.doesNotMatch(text, /step 3\/3/);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Step 2: Review targets .* failed/);
	assert.match(text, /No review targets materialized/);
	assert.match(text, /Step 3: writer .* pending/);
});

test("expanded chain rendering uses workflow graph spans for dynamic fanout results", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets"), result("reviewer", "a"), result("reviewer", "b"), result("writer", "final")],
			workflowGraph: {
				runId: "render-dynamic-expanded",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "completed",
						stepIndex: 1,
						children: [
							{ id: "step-1-item-a", kind: "agent", agent: "reviewer", label: "Review A", status: "completed", flatIndex: 1, stepIndex: 1 },
							{ id: "step-1-item-b", kind: "agent", agent: "reviewer", label: "Review B", status: "completed", flatIndex: 2, stepIndex: 1 },
						],
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "completed", flatIndex: 3, stepIndex: 2 },
				],
			},
		},
	}, { expanded: true }, theme as any);

	const text = componentText(component);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Agent 1\/2: reviewer/);
	assert.match(text, /Agent 2\/2: reviewer/);
	assert.match(text, /Step 3: writer/);
});

test("compact multi-result rendering shows total cost in the header", () => {
	const text = componentText(renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "parallel",
			results: [result("scout", "a"), result("reviewer", "b")],
			totalCost: { inputTokens: 30, outputTokens: 12, costUsd: 0.04 },
		},
	}, { expanded: false }, theme as any));

	assert.match(text, /2\/2 done/);
	assert.match(text, /in:30 out:12 \$0\.0400/);
});

test("static sequential and static parallel chain rendering keep existing labels", () => {
	const sequential = componentText(renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "writer"],
			totalSteps: 2,
			results: [result("scout", "a"), result("writer", "b")],
		},
	}, { expanded: false }, theme as any));
	assert.match(sequential, /Step 1: scout/);
	assert.match(sequential, /Step 2: writer/);

	const parallel = componentText(renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "[reviewer+auditor]", "writer"],
			totalSteps: 3,
			results: [result("scout", "a"), result("reviewer", "b"), result("auditor", "c"), result("writer", "d")],
		},
	}, { expanded: false }, theme as any));
	assert.match(parallel, /Step 1: scout/);
	assert.match(parallel, /Agent 1\/2: reviewer/);
	assert.match(parallel, /Agent 2\/2: auditor/);
	assert.match(parallel, /Step 3: writer/);
});

test("main-window renderer config removes compact result indentation without changing status glyphs", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "parallel",
			results: [result("scout", "a"), { ...result("reviewer", ""), exitCode: 1, error: "failed" }],
		},
	}, { expanded: false }, theme as any, undefined, { horizontalSpacing: 0 });

	const text = componentText(component);
	assert.match(text, /^✗ parallel/m);
	assert.match(text, /^✓ Agent 1\/2: scout/m);
	assert.match(text, /^✗ Agent 2\/2: reviewer/m);
	assert.match(text, /^⎿  Error: failed/m);
});

test("main-window renderer config caps only collapsed rich result rows", () => {
	const rendered = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "parallel",
			results: [
				result("scout", "a"),
				result("reviewer", "b"),
				result("writer", "c"),
			],
		},
	}, { expanded: false }, theme as any, undefined, { compactResultMaxLines: 3 }).render(120);

	assert.equal(rendered.length, 3);
	assert.match(rendered[2]!, /rows hidden/);

	const expanded = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "parallel",
			results: [
				result("scout", "a"),
				result("reviewer", "b"),
				result("writer", "c"),
			],
		},
	}, { expanded: true }, theme as any, undefined, { compactResultMaxLines: 3 }).render(120);

	assert.ok(expanded.length > 3);
	assert.doesNotMatch(expanded.join("\n"), /rows hidden/);
});
