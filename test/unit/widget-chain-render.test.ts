import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWidgetLines } from "../../src/tui/render.ts";
import type { AsyncJobState, AsyncJobStep, WorkflowGraphSnapshot } from "../../src/shared/types.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function step(index: number, agent: string, label: string, status: AsyncJobStep["status"] = "pending"): AsyncJobStep {
	return { index, agent, label, status, recentTools: [], recentOutput: [] };
}

function chainJob(steps: AsyncJobStep[], graph: WorkflowGraphSnapshot, parallelGroups: AsyncJobState["parallelGroups"] = []): AsyncJobState {
	return {
		asyncId: "chain-run",
		asyncDir: "/tmp/chain-run",
		status: "running",
		mode: "chain",
		agents: steps.map((item) => item.agent),
		steps,
		stepsTotal: steps.length,
		chainStepCount: graph.nodes.length,
		parallelGroups,
		workflowGraph: graph,
		startedAt: 0,
		updatedAt: 1_000,
	};
}

describe("async chain widget groups", () => {
	it("shows a named group and all static members while pending", () => {
		const steps = [
			step(0, "worker", "Prepare inputs", "running"),
			step(1, "reviewer", "Review ABI safety"),
			step(2, "reviewer", "Review portability"),
			step(3, "worker", "Apply review fixes"),
		];
		const graph: WorkflowGraphSnapshot = {
			runId: "chain-run", mode: "chain", phases: [], nodes: [
				{ id: "step-0", kind: "step", agent: "worker", label: "Prepare inputs", status: "running", flatIndex: 0, stepIndex: 0 },
				{ id: "step-1", kind: "parallel-group", label: "Native API reviews", status: "pending", stepIndex: 1, children: [
					{ id: "step-1-agent-0", kind: "agent", agent: "reviewer", label: "Review ABI safety", status: "pending", flatIndex: 1, stepIndex: 1 },
					{ id: "step-1-agent-1", kind: "agent", agent: "reviewer", label: "Review portability", status: "pending", flatIndex: 2, stepIndex: 1 },
				] },
				{ id: "step-2", kind: "step", agent: "worker", label: "Apply review fixes", status: "pending", flatIndex: 3, stepIndex: 2 },
			],
		};
		const text = buildWidgetLines([chainJob(steps, graph, [{ start: 1, count: 2, stepIndex: 1 }])], theme as never, 160, false).join("\n");
		assert.match(text, /Step 2\/3: Native API reviews · parallel · pending · 2 agents/);
		assert.match(text, /Agent 1\/2: Review ABI safety \[reviewer\] · pending/);
		assert.match(text, /Agent 2\/2: Review portability \[reviewer\] · pending/);
	});

	it("shows awaiting targets instead of inventing dynamic children", () => {
		const graph: WorkflowGraphSnapshot = {
			runId: "chain-run", mode: "chain", phases: [], nodes: [{
				id: "step-0", kind: "dynamic-parallel-group", label: "Review targets", status: "pending", stepIndex: 0, children: [],
				dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "item", collectAs: "reviews" },
			}],
		};
		const text = buildWidgetLines([chainJob([step(0, "expand:reviewer", "Review targets")], graph)], theme as never, 160, false).join("\n");
		assert.match(text, /Review targets · parallel · awaiting targets/);
		assert.doesNotMatch(text, /Agent 1\/1/);
	});

	it("does not render stale live activity for terminal or pending group members", () => {
		const stale = { activityState: "needs_attention" as const, lastActivityAt: 1_000, currentTool: "bash", currentToolArgs: "npm test", currentToolStartedAt: 2_000 };
		const steps = [
			{ ...step(0, "reviewer", "Completed review", "complete"), ...stale, model: "provider/model", thinking: "high", toolCount: 3, tokens: { input: 800, output: 200, total: 1_000 }, durationMs: 4_000 },
			{ ...step(1, "reviewer", "Failed review", "failed"), ...stale },
			{ ...step(2, "reviewer", "Queued review", "pending"), ...stale },
		];
		const graph: WorkflowGraphSnapshot = {
			runId: "chain-run", mode: "chain", phases: [], nodes: [{
				id: "step-0", kind: "parallel-group", label: "Legacy review group", status: "failed", stepIndex: 0,
				children: steps.map((item, index) => ({ id: `child-${index}`, kind: "agent", agent: item.agent, label: item.label!, status: item.status, flatIndex: index, stepIndex: 0 })),
			}],
		};
		const text = buildWidgetLines([chainJob(steps, graph, [{ start: 0, count: 3, stepIndex: 0 }])], theme as never, 180, false).join("\n");
		assert.match(text, /Completed review \[reviewer\] · complete \(model · thinking high\)/);
		assert.match(text, /3 tool uses · 1\.0k token · 4\.0s/);
		assert.doesNotMatch(text, /no activity|needs attention|bash|npm test/);
	});

	it("uses a named overflow row when a large group exceeds the collapsed budget", () => {
		const steps = Array.from({ length: 12 }, (_, index) => step(index, "reviewer", `Review target ${index + 1}`));
		const graph: WorkflowGraphSnapshot = {
			runId: "chain-run", mode: "chain", phases: [], nodes: [{
				id: "step-0", kind: "parallel-group", label: "Large review group", status: "pending", stepIndex: 0,
				children: steps.map((item, index) => ({ id: `child-${index}`, kind: "agent", agent: item.agent, label: item.label!, status: "pending", flatIndex: index, stepIndex: 0 })),
			}],
		};
		const text = buildWidgetLines([chainJob(steps, graph, [{ start: 0, count: 12, stepIndex: 0 }])], theme as never, 160, false).join("\n");
		assert.match(text, /\+6 more agents/);
	});
});
