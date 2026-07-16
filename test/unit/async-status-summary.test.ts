import assert from "node:assert/strict";
import { it } from "node:test";
import { summarizeAsyncStatus } from "../../src/runs/background/async-status.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

it("preserves workflow graph and resolved step labels in async summaries", () => {
	const workflowGraph = {
		version: 1 as const,
		runId: "run-1",
		mode: "chain" as const,
		nodes: [{ id: "step-0", kind: "step" as const, agent: "scout", label: "Audit auth", status: "running" as const, flatIndex: 0, stepIndex: 0 }],
		phases: [],
	};
	const status: AsyncStatus = {
		runId: "run-1",
		mode: "chain",
		state: "running",
		startedAt: 1,
		lastUpdate: 2,
		currentStep: 0,
		workflowGraph,
		steps: [{
			agent: "scout",
			label: "Audit auth",
			status: "running",
			recentTools: [],
			recentOutput: [],
		}],
	};

	const summary = summarizeAsyncStatus("/tmp/run-1", status);
	assert.equal(summary.steps[0]?.label, "Audit auth");
	assert.equal(summary.workflowGraph?.nodes[0]?.label, "Audit auth");
});
