import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePublicSubagentExecution } from "../../src/extension/public-execution.ts";

describe("public subagent execution normalization", () => {
	it("accepts structured single-child, workflow, management, and schedules", () => {
		assert.deepEqual(normalizePublicSubagentExecution({ workflowScript: "return 1" }), { ok: true, params: { workflowScript: "return 1" } });
		const task = "Use `quotes`\nand newlines";
		assert.deepEqual(normalizePublicSubagentExecution({ agent: " worker ", task, context: "fresh", async: false }), {
			ok: true,
			params: {
				context: "fresh",
				async: false,
				workflowScript: `console.info("Converted structured single-child request to workflow runs.run('main', ...)."); return runs.run("main", ${JSON.stringify({ agent: "worker", task, output: true })})`,
			},
		});
		assert.deepEqual(normalizePublicSubagentExecution({ agent: "worker" }), {
			ok: true,
			params: {
				workflowScript: `console.info("Converted structured single-child request to workflow runs.run('main', ...)."); return runs.run("main", {"agent":"worker","output":true})`,
			},
		});
		assert.deepEqual(normalizePublicSubagentExecution({ agent: "worker", output: false }), {
			ok: true,
			params: {
				workflowScript: `console.info("Converted structured single-child request to workflow runs.run('main', ...)."); return runs.run("main", {"agent":"worker","output":false})`,
			},
		});
		assert.deepEqual(normalizePublicSubagentExecution({ action: " list " }), { ok: true, params: { action: "list" } });
		assert.deepEqual(
			normalizePublicSubagentExecution({ action: " schedule.create ", every: "1h", workflowScript: "return 1" }),
			{ ok: true, params: { action: "schedule.create", every: "1h", workflowScript: "return 1" } },
		);
	});

	it("rejects private run fan-out fields at the public boundary", () => {
		for (const params of [
			{ workflowScript: "return 1", runFanoutBudget: { version: 1 } },
			{ workflowScript: "return 1", runFanoutAdmitted: true },
		] as const) {
			const result = normalizePublicSubagentExecution(params);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /does not accept internal run fan-out fields/);
		}
	});

	it("rejects mixed, invalid, and removed public execution shapes", () => {
		for (const params of [
			{ action: " " },
			{ action: "single" },
			{ action: "parallel" },
			{ action: "chain" },
			{ action: "append-step", id: "run", step: { agent: "worker" } },
			{ action: "approve-checkpoint", id: "run" },
			{ action: "reject-checkpoint", id: "run" },
			{ agent: "" },
			{ agent: 42 },
			{ task: "work" },
			{ agent: "worker", task: 42 },
			{ agent: "worker", workflowScript: "return 1" },
			{ action: "status", task: "work" },
			{ tasks: [{ agent: "worker" }] },
			{ chain: [{ agent: "worker" }] },
			{ parallel: [{ agent: "worker" }] },
			{ concurrency: 2 },
			{ action: "get", chainName: "review-pipeline" },
			{ action: "create", config: { name: "review-pipeline", steps: [{ agent: "worker" }] } },
			{ clarify: true, workflowScript: "return 1" },
			{ resume: "retained-run", workflowScript: "return 1" },
			{},
			{ workflowScript: " " },
			{ action: "status", workflowScript: "return 1" },
			{ action: "schedule.create", every: "1h", agent: "worker", workflowScript: "return 1" },
		] as const) {
			assert.equal(normalizePublicSubagentExecution(params).ok, false, JSON.stringify(params));
		}
	});
});
