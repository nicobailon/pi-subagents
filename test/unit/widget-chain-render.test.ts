import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AsyncJobState } from "../../src/shared/types.ts";
import { buildWidgetLines } from "../../src/tui/render.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function pendingChain(): AsyncJobState {
	return {
		asyncId: "chain-run",
		asyncDir: "/tmp/chain-run",
		status: "running",
		mode: "chain",
		agents: ["worker", "reviewer", "auditor", "worker", "port-checker"],
		currentStep: 0,
		chainStepCount: 4,
		parallelGroups: [{ stepIndex: 1, start: 1, count: 2 }],
		stepsTotal: 5,
		runningSteps: 1,
		completedSteps: 0,
		startedAt: 0,
		updatedAt: 60_000,
		toolCount: 12,
		totalTokens: { input: 20_000, output: 14_000, total: 34_000 },
		steps: [
			{ index: 0, agent: "worker", status: "running", model: "gpt-5.6-sol", thinking: "high", toolCount: 12, tokens: { input: 20_000, output: 14_000, total: 34_000 }, durationMs: 60_000 },
			{ index: 1, agent: "reviewer", status: "pending" },
			{ index: 2, agent: "auditor", status: "pending" },
			{ index: 3, agent: "worker", status: "pending" },
			{ index: 4, agent: "port-checker", status: "pending" },
		],
	};
}

describe("async chain widget rendering", () => {
	it("labels future parallel groups as pending while preserving usage and model details", () => {
		const text = buildWidgetLines([pendingChain()], theme as never, 180, false).join("\n");
		assert.match(text, /Step 2\/4: parallel group · pending · 2 agents/);
		assert.doesNotMatch(text, /Step 2\/4: parallel group · 0\/2 done/);
		assert.match(text, /gpt-5\.6-sol/);
		assert.match(text, /thinking high/);
		assert.match(text, /12 tool uses/);
		assert.match(text, /34k token/);
	});

	it("keeps progress counts once the parallel group is active", () => {
		const state = pendingChain();
		state.currentStep = 1;
		state.activeParallelGroup = true;
		state.steps = [
			{ index: 1, agent: "reviewer", status: "running", model: "gpt-5.6-sol", thinking: "high" },
			{ index: 2, agent: "auditor", status: "pending", model: "gpt-5.6-sol", thinking: "high" },
		];
		state.stepsTotal = 2;
		state.runningSteps = 1;
		state.completedSteps = 0;

		const text = buildWidgetLines([state], theme as never, 180, false).join("\n");
		assert.match(text, /step 2\/4 · parallel group: 1 agent running · 0\/2 done/);
	});

	it("keeps completed parallel-group progress", () => {
		const state = pendingChain();
		state.currentStep = 3;
		state.steps![0]!.status = "complete";
		state.steps![1]!.status = "complete";
		state.steps![2]!.status = "complete";
		state.steps![3]!.status = "running";

		const text = buildWidgetLines([state], theme as never, 180, false).join("\n");
		assert.match(text, /Step 2\/4: parallel group · 2\/2 done/);
	});
});
