import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareWorkflowLaunchParams } from "../../src/runs/foreground/subagent-executor.ts";

describe("workflow launch params", () => {
	it("places workflow child gates inside managed worktree tasks", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Implement", worktree: true, gate: "npm test" },
				"workflow-run",
				"gated",
			),
			{
				worktree: true,
				workflowParentRunId: "workflow-run",
				workflowKey: "gated",
				tasks: [{
					agent: "worker",
					task: "Implement",
					acceptance: { level: "verified", verify: [{ id: "gate", command: "npm test" }] },
				}],
			},
		);
	});

	it("rejects gate defaults on retained resume items", () => {
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{ gate: "npm test" },
				{ resume: "retained-run", task: "Continue" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", gate: "npm test" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
	});

	it("preserves execution limits when routing retained resume items", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{ turnBudget: { maxTurns: 8 }, toolBudget: { hard: 12, block: ["read"] } },
				{
					resume: " retained-run ",
					task: "Continue carefully",
					maxRuntimeMs: 5_000,
					turnBudget: { maxTurns: 3, graceTurns: 1 },
					toolBudget: { soft: 2, hard: 4, block: "*" },
				},
				"workflow-run",
				"continue",
				{ missionDetached: true },
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue carefully",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				mission: false,
				timeoutMs: 5_000,
				turnBudget: { maxTurns: 3, graceTurns: 1 },
				toolBudget: { soft: 2, hard: 4, block: "*" },
			},
		);
	});
});
