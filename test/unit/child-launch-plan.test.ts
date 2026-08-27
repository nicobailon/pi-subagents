import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { planChildLaunch, resolveStepBehavior } from "../../src/runs/shared/child-launch-plan.ts";

const agent = {
	name: "worker",
	output: "report.md",
	outputMode: "file-only",
	defaultReads: ["brief.md"],
	defaultProgress: true,
	skills: ["typescript"],
	model: "openai-codex/gpt-5.6-luna",
	fast: true,
} as AgentConfig;

describe("child launch planning", () => {
	it("resolves cwd, behavior, skills, model, and output path without side effects", () => {
		const runnerCwd = path.join("/tmp", "repo");
		const resolvedRunnerCwd = path.resolve(runnerCwd);
		const plan = planChildLaunch({
			agentConfig: agent,
			stepOverrides: { skills: ["review"], outputMode: "inline" },
			task: "Implement the change",
			runnerCwd,
			runtimeCwd: runnerCwd,
			stepCwdInput: "packages/cli",
			chainSkills: ["shared"],
		});

		assert.equal(plan.stepCwd, path.join(resolvedRunnerCwd, "packages/cli"));
		assert.equal(plan.instructionCwd, plan.stepCwd);
		assert.equal(plan.readExistenceCwd, plan.stepCwd);
		assert.equal(plan.outputPath, path.join(resolvedRunnerCwd, "packages/cli", "report.md"));
		assert.deepEqual(plan.skillNames, ["review", "shared"]);
		assert.deepEqual(plan.behavior, {
			output: "report.md",
			outputMode: "inline",
			reads: ["brief.md"],
			progress: true,
			skills: ["review", "shared"],
			model: "openai-codex/gpt-5.6-luna",
			fast: true,
		});
	});

	it("keeps dynamic namespace output unresolved until fanout items materialize", () => {
		const runnerCwd = path.join("/tmp", "repo");
		const resolvedRunnerCwd = path.resolve(runnerCwd);
		const plan = planChildLaunch({
			agentConfig: agent,
			stepOverrides: {},
			runnerCwd,
			runtimeCwd: runnerCwd,
			parallelOutputNamespace: { stepIndex: 2 },
		});

		assert.equal(plan.namespaceOutputPath, true);
		assert.equal(plan.behavior.output, "report.md");
		assert.equal(plan.outputPath, path.join(resolvedRunnerCwd, "report.md"));
	});

	it("namespaces inherited relative parallel output for concrete items", () => {
		const runnerCwd = path.join("/tmp", "repo");
		const resolvedRunnerCwd = path.resolve(runnerCwd);
		const plan = planChildLaunch({
			agentConfig: agent,
			stepOverrides: {},
			runnerCwd,
			runtimeCwd: runnerCwd,
			parallelOutputNamespace: { stepIndex: 2, taskIndex: 4 },
		});

		assert.equal(plan.namespaceOutputPath, false);
		assert.equal(plan.behavior.output, path.join("parallel-2", "4-worker", "report.md"));
		assert.equal(plan.outputPath, path.join(resolvedRunnerCwd, "parallel-2", "4-worker", "report.md"));
	});

	it("suppresses progress for read-only templated tasks", () => {
		const behavior = resolveStepBehavior(agent, {});
		const plan = planChildLaunch({
			agentConfig: agent,
			stepOverrides: {},
			resolvedBehavior: behavior,
			task: "{task}",
			originalTask: "Review-only. Do not edit files.",
			runnerCwd: "/tmp/repo",
			runtimeCwd: "/tmp/repo",
		});

		assert.equal(plan.behavior.progress, false);
	});
});
