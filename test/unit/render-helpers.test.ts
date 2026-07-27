import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { row } from "../../src/tui/render-helpers.ts";
import { renderSubagentResult, truncLine } from "../../src/tui/render.ts";

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
