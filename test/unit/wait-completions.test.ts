import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toWaitCompletion } from "../../src/runs/background/wait-completions.ts";

describe("workflow wait completion projection", () => {
	it("omits absent and malformed receipt references", () => {
		for (const workflowReceipt of [undefined, null, [], "path", { path: "" }, { path: 42 }]) {
			assert.equal("workflowReceiptPath" in toWaitCompletion({ workflowReceipt }, "run"), false);
		}
	});
	it("retains the bounded workflow-child summary and excludes result output", () => {
		const completion = toWaitCompletion({
			agent: "workflow",
			mode: "workflow",
			workflowReceipt: { path: "/opaque/published-receipt.json", receipt: { output: "must not be copied" } },
			state: "complete",
			success: true,
			workflowChildren: {
				version: 1,
				parentToolCallId: "tool-1",
				workflowRunId: "workflow-1",
				inventoryComplete: true,
				workflowState: "completed",
				children: [{ childId: "review", runId: "run-1", agent: "reviewer", model: "openai-codex/gpt", thinking: "high", state: "completed" }],
			},
			results: [{
				agent: "reviewer",
				runId: "run-1",
				success: true,
				sessionFile: "/sessions/run-1.jsonl",
				usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0, cost: 0.04, turns: 1 },
				output: "must not be copied",
				task: "must not be copied",
			}],
		}, "workflow-1");

		assert.equal(completion.workflowChildren?.children[0]?.childId, "review");
		assert.equal(completion.workflowReceiptPath, "/opaque/published-receipt.json");
		assert.deepEqual(completion.results?.[0]?.usage, { input: 10, output: 2, cacheRead: 30, cacheWrite: 0, cost: 0.04, turns: 1 });
		assert.equal(completion.results?.[0]?.sessionFile, "/sessions/run-1.jsonl");
		assert.doesNotMatch(JSON.stringify(completion), /must not be copied/);
	});

	it("retains only bounded timeout recovery evidence in completion details", () => {
		const changedFiles = Array.from({ length: 25 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
		const completion = toWaitCompletion({
			state: "failed",
			success: false,
			results: [{
				agent: "worker",
				success: false,
				timeoutRecovery: {
					termination: "timed-out",
					changedFiles,
					truncated: true,
					recoveryNeeded: true,
					reason: "timed-out-with-dirty-worktree",
					reportStatus: "missing",
					message: "raw recovery message must not cross the completion boundary",
					effects: { settlementDiagnostic: { finalTextPresent: true } },
				},
			}],
		}, "run-recovery");

		assert.deepEqual(completion.results?.[0]?.timeoutRecovery, {
			termination: "timed-out",
			changedFiles: changedFiles.slice(0, 20),
			truncated: true,
			recoveryNeeded: true,
			reason: "timed-out-with-dirty-worktree",
			reportStatus: "missing",
		});
		assert.doesNotMatch(JSON.stringify(completion), /raw recovery message|settlementDiagnostic/);
	});

	it("retains captured structured output and its durable artifact path", () => {
		const completion = toWaitCompletion({
			success: true,
			results: [{
				agent: "delegate",
				success: true,
				output: "",
				structuredOutput: { payload: { ok: true }, contract_checks: {} },
				structuredOutputPath: "/runs/structured-output/output.json",
			}],
		}, "run-structured");

		assert.deepEqual(completion.results?.[0]?.structuredOutput, { payload: { ok: true }, contract_checks: {} });
		assert.equal(completion.results?.[0]?.structuredOutputPath, "/runs/structured-output/output.json");
	});

	it("omits oversized structured output while retaining its artifact path", () => {
		const completion = toWaitCompletion({
			success: true,
			results: [{
				agent: "delegate",
				structuredOutput: { payload: "x".repeat(8_000) },
				structuredOutputPath: "/runs/structured-output/output.json",
			}],
		}, "run-large-structured");

		assert.equal(completion.results?.[0]?.structuredOutput, undefined);
		assert.equal(completion.results?.[0]?.structuredOutputPath, "/runs/structured-output/output.json");
	});

	it("rejects non-JSON structured output", () => {
		assert.throws(() => toWaitCompletion({ success: true, results: [{ structuredOutput: 1n }] }, "run-invalid-structured"), /JSON-serializable|serialize a BigInt/);
	});

	it("rejects unbounded or unknown summary fields at the replay boundary", () => {
		assert.throws(() => toWaitCompletion({ workflowChildren: { version: 1, parentToolCallId: "tool", workflowRunId: "run", inventoryComplete: true, workflowState: "completed", children: [], output: "secret" } }, "run"), /unsupported fields/);
	});

	it("rejects a summary bound to another completion", () => {
		assert.throws(() => toWaitCompletion({ workflowChildren: { version: 1, parentToolCallId: "tool", workflowRunId: "other", inventoryComplete: true, workflowState: "completed", children: [] } }, "run"), /does not match its completion run id/);
	});
});
