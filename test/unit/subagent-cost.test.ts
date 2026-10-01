import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectSubagentCost } from "../../src/slash/subagent-cost.ts";
import { SLASH_RESULT_TYPE } from "../../src/shared/types.ts";

describe("collectSubagentCost", () => {
	it("counts each resumed foreground workflow round once even when rounds share a session file", () => {
		const sessionFile = "/tmp/children/run-0/session.jsonl";
		const round = (workflowRunId: string, runId: string, turns: number, cost: number) => ({
			mode: "workflow",
			runId: workflowRunId,
			results: [{ agent: "coder", workflowKey: "code", runId, sessionFile, usage: { input: turns * 10, output: turns, cacheRead: 0, cacheWrite: 0, cost, turns } }],
		});
		const toolResult = (details: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "subagent", details } });
		const rounds = [
			round("wf-cost-round-1", "child-round-1", 16, 0.0122),
			round("wf-cost-round-2", "child-round-2", 16, 0.0169),
			round("wf-cost-round-3", "child-round-3", 5, 0.0033),
		];
		const branch = [
			...rounds.map(toolResult),
			// The same round-2 result again, as a slash-result message replays it.
			{ type: "custom_message", customType: SLASH_RESULT_TYPE, details: { requestId: "slash-1", result: { content: [], details: rounds[1] } } },
			toolResult(rounds[2]),
		];
		const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => branch, getSessionFile: () => undefined } };

		const report = collectSubagentCost(ctx as never, { baseCwd: process.cwd() } as never);

		assert.deepEqual(report.children.map((child) => [child.runId, child.usage.turns]), [["child-round-1", 16], ["child-round-2", 16], ["child-round-3", 5]]);
		assert.equal(report.childTotal.turns, 37);
		assert.equal(report.childTotal.input, 370);
		assert.ok(Math.abs(report.childTotal.cost - 0.0324) < 1e-9);
		assert.equal(report.unresolvedAsyncChildren, 0);
	});
});
