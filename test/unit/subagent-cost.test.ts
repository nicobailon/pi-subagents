import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { collectSubagentCost, formatSubagentCostReport } from "../../src/slash/subagent-cost.ts";
import { DIRS, SLASH_RESULT_TYPE } from "../../src/shared/types.ts";

function collectWithErrors(branch: unknown[]) {
	const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => branch, getSessionFile: () => undefined } };
	const errors: unknown[][] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		const report = collectSubagentCost(ctx as never, { baseCwd: process.cwd(), artifactDirPreference: "session" } as never);
		return { report, errors };
	} finally {
		console.error = originalError;
	}
}

describe("collectSubagentCost workflow receipts", () => {
	it("does not read receipts for foreground workflows", () => {
		const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.2, turns: 1 };
		const { report, errors } = collectWithErrors([
			{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "workflow", runId: `foreground-${process.pid}`, results: [{ agent: "scout", usage }] } } },
		]);
		assert.deepEqual(errors, []);
		assert.equal(report.children.length, 1);
		assert.equal(report.childTotal.input, 12);
	});

	it("counts a running async workflow without a receipt as unavailable without logging", () => {
		const workflowRunId = `async-running-${process.pid}`;
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: workflowRunId, mode: "workflow", state: "running", startedAt: Date.now(), cwd: process.cwd(), steps: [] }), "utf-8");
		try {
			const { report, errors } = collectWithErrors([
				{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "workflow", runId: workflowRunId, asyncId: workflowRunId, results: [] } } },
			]);
			assert.deepEqual(errors, []);
			assert.equal(report.unresolvedAsyncChildren, 1);
			assert.match(formatSubagentCostReport(report), /Async child usage unavailable: 1\./);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("still reports unreadable async workflow receipts", () => {
		const workflowRunId = `async-malformed-${process.pid}`;
		const asyncDir = path.join(DIRS.async, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), "{not json", "utf-8");
		try {
			const { errors } = collectWithErrors([
				{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "workflow", runId: workflowRunId, asyncId: workflowRunId, results: [] } } },
			]);
			assert.equal(errors.length, 1);
			assert.match(String(errors[0]![0]), new RegExp(`Failed to resolve async subagent usage for '${workflowRunId}'`));
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});
});

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
