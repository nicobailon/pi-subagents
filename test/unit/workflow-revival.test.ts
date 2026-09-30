import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildCompletionDetails, formatSingleCompletion } from "../../src/runs/background/notify.ts";
import { buildWorkflowReceipt, resolveWorkflowReceiptResumeEntry, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";
import { formatWorkflowKeyRevival, projectWorkflowKeyRevival, recordWorkflowRevival, withWorkflowRevivals } from "../../src/workflows/workflow-revival.ts";
import type { WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(childState: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-revival-"));
	roots.push(root);
	writeStatus(root, "child", { state: childState, parentWorkflowRunId: "wf", workflowKey: "memory" });
	const child: WorkflowScriptChildResult = { key: "memory", ok: false, runId: "child", output: "429 rate limit", error: "429 rate limit", terminalOutcome: { state: "partial", reason: "timeout" }, outputReference: "/tmp/memory.md", structuredOutput: { partial: true }, resumability: { state: "resumable" }, artifactPaths: [] };
	fs.mkdirSync(path.join(root, "wf"), { recursive: true });
	writeWorkflowReceipt(path.join(root, "wf"), buildWorkflowReceipt({ workflowRunId: "wf", state: "complete", children: [child] }));
	return { root, child };
}

function writeStatus(root: string, runId: string, fields: Record<string, unknown>): void {
	fs.mkdirSync(path.join(root, runId), { recursive: true });
	fs.writeFileSync(path.join(root, runId, "status.json"), JSON.stringify({ runId, mode: "single", startedAt: 1, ...fields }));
}

function keyedLatest(root: string): { latestRunId: string; runIds: string[] } {
	const entry = resolveWorkflowReceiptResumeEntry({ reference: { workflowRunId: "wf", key: "memory", latest: true }, asyncDirRoot: root });
	return { latestRunId: entry.latestRunId, runIds: entry.continuation.runIds };
}

describe("workflow child revival links", () => {
	it("links only revivals of failed children", () => {
		for (const state of ["complete", "paused", "stopped"]) {
			const { root } = setup(state);
			recordWorkflowRevival(root, "child", "revived");
			assert.deepEqual(keyedLatest(root), { latestRunId: "child", runIds: ["child"] }, state);
		}
		const { root } = setup("failed");
		recordWorkflowRevival(root, "child", "revived");
		assert.deepEqual(keyedLatest(root), { latestRunId: "revived", runIds: ["child", "revived"] });
		const corrupt = setup("failed").root;
		fs.writeFileSync(path.join(corrupt, "child", "status.json"), "{");
		assert.throws(() => recordWorkflowRevival(corrupt, "child", "revived"), /status/i, "an unreadable source status is reported, not skipped");
		const blocked = setup("failed").root;
		fs.mkdirSync(path.join(blocked, "child", "workflow-revival.json"));
		assert.throws(() => recordWorkflowRevival(blocked, "child", "revived"));
		assert.equal(fs.existsSync(path.join(blocked, "revived", "workflow-revival-origin.json")), false, "a failed link write leaves no origin that would pin the run");
	});

	it("refuses a revival past the chain bound, which readers always reach", () => {
		const { root } = setup("failed");
		let source = "child";
		for (let depth = 1; depth <= 16; depth++) {
			const revived = `revived-${depth}`;
			recordWorkflowRevival(root, source, revived);
			writeStatus(root, revived, { state: "failed" });
			source = revived;
		}
		assert.throws(() => recordWorkflowRevival(root, source, "revived-17"), /already has 16 chained revivals/);
		const revival = projectWorkflowKeyRevival(root, "wf", "memory", "child");
		assert.equal(revival?.revivedRunIds.length, 16);
		assert.equal(revival?.latestRunId, "revived-16");
	});

	it("adds revived lineage to a failed child's receipt and notice without rewriting its result", () => {
		const { root, child } = setup("failed");
		recordWorkflowRevival(root, "child", "revived");
		writeStatus(root, "revived", { state: "complete" });
		const [projected] = withWorkflowRevivals(root, "wf", [child]);
		assert.deepEqual({ ...projected, continuation: undefined, revival: undefined }, { ...child, continuation: undefined, revival: undefined });
		assert.deepEqual(projected!.continuation, { runIds: ["child", "revived"] });
		assert.equal(buildWorkflowReceipt({ workflowRunId: "wf", state: "complete", children: [projected!] }).entries.memory!.latestRunId, "revived");

		const notice = formatSingleCompletion(buildCompletionDetails({
			id: "wf", runId: "wf", mode: "workflow", agent: "workflow", state: "complete", success: true, summary: "done",
			results: [{ workflowKey: "memory", runId: "child", success: false, output: child.output, outputState: "present", revival: formatWorkflowKeyRevival(projected!.revival!) }],
		}));
		assert.match(notice, /key=memory run=child status=failed\n {2}Revived → revived: completed\n/);
	});
});
