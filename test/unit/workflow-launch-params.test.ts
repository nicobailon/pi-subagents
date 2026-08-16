import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareWorkflowLaunchParams } from "../../src/runs/foreground/subagent-executor.ts";

describe("workflow launch params", () => {
	it("keeps omitted workflow child async foreground", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run" },
				"workflow-run",
				"run",
			),
			{
				agent: "worker",
				task: "Run",
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "run",
			},
		);
	});

	it("passes an omitted child timeout parent deadline for default resolution", () => {
		const parentDeadlineAt = Date.now() + 60_000;
		const params = prepareWorkflowLaunchParams(
			{},
			{ agent: "worker", task: "Run" },
			"workflow-run",
			"run",
			{ parentDeadlineAt },
		);
		assert.equal(params.async, false);
		assert.equal(params.timeoutMs, undefined);
		assert.equal(params.workflowParentDeadlineAt, parentDeadlineAt);
	});

	it("preserves explicit child timeout aliases over the parent deadline", () => {
		const parentDeadlineAt = Date.now() + 60_000;
		assert.equal(prepareWorkflowLaunchParams(
			{},
			{ agent: "worker", task: "Run", timeoutMs: 90_000 },
			"workflow-run",
			"timeout",
			{ parentDeadlineAt },
		).timeoutMs, 90_000);
		const maxRuntimeParams = prepareWorkflowLaunchParams(
			{},
			{ agent: "worker", task: "Run", maxRuntimeMs: 90_000 },
			"workflow-run",
			"max-runtime",
			{ parentDeadlineAt },
		);
		assert.equal(maxRuntimeParams.maxRuntimeMs, 90_000);
		assert.equal(maxRuntimeParams.timeoutMs, undefined);
	});

	it("preserves explicit async workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run", async: true },
				"workflow-run",
				"run",
			),
			{
				agent: "worker",
				task: "Run",
				async: true,
				workflowParentRunId: "workflow-run",
				workflowKey: "run",
			},
		);
	});

	it("keeps a bridge override scoped to the target workflow child", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run", intercomBridge: { mode: "off" } },
				"workflow-run",
				"isolated",
			),
			{
				agent: "worker",
				task: "Run",
				intercomBridge: { mode: "off" },
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "isolated",
			},
		);
		assert.equal(prepareWorkflowLaunchParams({}, { agent: "worker", task: "Run" }, "workflow-run", "sibling").intercomBridge, undefined);
	});

	it("keeps managed worktree children on the single-run contract", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Implement", worktree: true, gate: "npm test" },
				"workflow-run",
				"gated",
			),
			{
				agent: "worker",
				task: "Implement",
				worktree: true,
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "gated",
				acceptance: { level: "verified", verify: [{ id: "gate", command: "npm test" }] },
			},
		);
	});

	it("preserves a bridge override for retained workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", intercomBridge: { mode: "off" } },
				"workflow-run",
				"continue",
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				intercomBridge: { mode: "off" },
			},
		);
	});

	it("does not inherit parent deadlines for retained workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue" },
				"workflow-run",
				"continue",
				{ parentDeadlineAt: Date.now() + 60_000 },
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
			},
		);
	});

	it("preserves worktree isolation for retained workflow children", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", worktree: true },
				"workflow-run",
				"continue",
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				worktree: true,
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

	it("preserves execution limits and fan-out identity when routing retained resume items", () => {
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
				{ missionDetached: true, runFanoutBudget: { version: 1, rootRunId: "root-run", directory: "/tmp/fanout", limit: 64, parentPath: "parent" } },
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue carefully",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				runFanoutBudget: { version: 1, rootRunId: "root-run", directory: "/tmp/fanout", limit: 64, parentPath: "parent/workflow[continue]" },
				mission: false,
				timeoutMs: 5_000,
				turnBudget: { maxTurns: 3, graceTurns: 1 },
				toolBudget: { soft: 2, hard: 4, block: "*" },
			},
		);
	});
});
