import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeCompletionReplay } from "../../src/runs/background/completion-replay.ts";
import { writeAsyncResultFile } from "../../src/runs/background/result-files.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import type { AsyncRunSummary } from "../../src/runs/background/async-status.ts";
import { collectWaitCompletions, recordWaitCompletion, toWaitCompletion } from "../../src/runs/background/wait-completions.ts";

describe("workflow wait completion projection", () => {
	it("returns readable evidence references from the matched result namespace and its replay", (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-evidence-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const resultsDir = path.join(root, "nested", "root-run");
		const runId = "persona";
		const data = { runId, sessionId: "owner", results: [{ agent: "persona", output: "NESTED_FINDING" }] };
		const resultPath = path.join(resultsDir, `${runId}.json`);
		writeAsyncResultFile(resultPath, data);
		writeAsyncResultFile(path.join(root, `${runId}.json`), { ...data, results: [{ output: "WRONG_NAMESPACE" }] });
		const terminal: AsyncRunSummary[] = [{ id: runId, sessionId: "owner", asyncDir: root, mode: "single", state: "complete", startedAt: Date.now(), steps: [] }];
		// SAFETY: the collector only reads the optional completedResults store from this fixture.
		const state = { currentSessionId: "owner" } as SubagentState;
		const references: string[] = [];
		assert.equal(collectWaitCompletions(terminal, state, resultsDir, (text) => references.push(text))?.[0]?.runId, runId);
		assert.deepEqual(references, [`Result [${runId}]: ${resultPath}`]);
		assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf8")).results[0].output, "NESTED_FINDING");
		const replay = writeCompletionReplay({ resultsDir, runId, sessionId: "owner", completion: toWaitCompletion(data, runId), data, now: Date.now(), ttlMs: 60_000 });
		fs.rmSync(resultPath);
		references.length = 0;
		assert.equal(collectWaitCompletions(terminal, state, resultsDir, (text) => references.push(text))?.[0]?.archivePath, replay.archivePath);
		assert.deepEqual(references, [`Result [${runId}]: ${replay.archivePath}`]);
		assert.equal(JSON.parse(fs.readFileSync(replay.archivePath, "utf8")).entries[0].text, "NESTED_FINDING");
		assert.equal(collectWaitCompletions([{ ...terminal[0]!, sessionId: "sibling" }], state, resultsDir), undefined);
	});

	it("only references an unindexed public fallback owned by the completed run session", (t) => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-public-fallback-"));
		t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));
		const runId = "shared-run";
		const terminal: AsyncRunSummary[] = [{ id: runId, sessionId: "owner", asyncDir: resultsDir, mode: "single", state: "complete", startedAt: Date.now(), steps: [] }];
		// SAFETY: recordWaitCompletion initializes the only state collection used by this fixture.
		const state = { currentSessionId: "owner" } as SubagentState;
		recordWaitCompletion(state, runId, { runId, sessionId: "owner", agent: "owner-agent", success: true }, Date.now(), 60_000);
		const resultPath = path.join(resultsDir, `${runId}.json`);
		fs.writeFileSync(resultPath, JSON.stringify({ runId, sessionId: "foreign", agent: "foreign-agent", state: "failed", results: [{ error: "FOREIGN_PAYLOAD" }] }));

		const foreignReferences: string[] = [];
		const foreignCompletion = collectWaitCompletions(terminal, state, resultsDir, (text) => foreignReferences.push(text))?.[0];
		assert.deepEqual(foreignReferences, []);
		assert.equal(foreignCompletion?.agent, "owner-agent");
		assert.equal(foreignCompletion?.state, undefined);
		assert.equal(foreignCompletion?.results, undefined);
		assert.doesNotMatch(JSON.stringify(foreignCompletion), /foreign-agent|FOREIGN_PAYLOAD/);

		fs.writeFileSync(resultPath, JSON.stringify({ runId, sessionId: "owner", agent: "owner-payload" }));
		const ownerReferences: string[] = [];
		const ownerCompletion = collectWaitCompletions(terminal, state, resultsDir, (text) => ownerReferences.push(text))?.[0];
		assert.equal(ownerCompletion?.agent, "owner-agent");
		assert.deepEqual(ownerReferences, [`Result [${runId}]: ${resultPath}`]);
	});

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
