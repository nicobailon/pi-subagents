import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildWorkflowReceipt, readWorkflowReceipt, resolveWorkflowReceiptResume, workflowReceiptPath, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";
import type { WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-receipt-"));
	roots.push(root);
	return root;
}

function child(key: string, overrides: Partial<WorkflowScriptChildResult> = {}): WorkflowScriptChildResult {
	return {
		key,
		ok: true,
		agent: "reviewer",
		runId: `run-${key}`,
		output: "x".repeat(100_000),
		structuredOutput: { report: "x".repeat(100_000) },
		artifactPaths: [`/tmp/${key}.md`],
		requestedContext: "fresh",
		resolvedContext: "fresh",
		outputReference: `/tmp/${key}.md`,
		resumability: { state: "resumable" },
		continuation: { runIds: [`run-${key}`] },
		...overrides,
	};
}

describe("workflow receipts", () => {
	it("builds one metadata-only entry per workflow child", () => {
		const children = Array.from({ length: 1_000 }, (_, index) => child(`child-${index}`));
		const receipt = buildWorkflowReceipt({ workflowRunId: "workflow-1", state: "complete", children, createdAt: 10 });

		assert.equal(Object.keys(receipt.entries).length, children.length);
		assert.deepEqual(receipt.entries["child-0"], {
			key: "child-0",
			agent: "reviewer",
			requestedContext: "fresh",
			resolvedContext: "fresh",
			latestRunId: "run-child-0",
			resumability: { state: "resumable" },
			outputReference: "/tmp/child-0.md",
			continuation: { runIds: ["run-child-0"] },
		});
		const serialized = JSON.stringify(receipt);
		assert.doesNotMatch(serialized, /structuredOutput|artifactPaths|"output"/);
		assert.ok(serialized.length < 400_000, `receipt metadata unexpectedly large: ${serialized.length}`);
	});

	it("writes and resolves one exact terminal receipt", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-1");
		fs.mkdirSync(asyncDir, { recursive: true });
		const receipt = buildWorkflowReceipt({ workflowRunId: "workflow-1", state: "complete", children: [child("advisor")] });
		assert.equal(writeWorkflowReceipt(asyncDir, receipt), workflowReceiptPath(asyncRoot, "workflow-1"));
		assert.deepEqual(readWorkflowReceipt(asyncRoot, "workflow-1"), receipt);
		let validations = 0;
		const runId = resolveWorkflowReceiptResume({
			reference: { workflowRunId: "workflow-1", key: "advisor", latest: true },
			asyncDirRoot: asyncRoot,
			assertResumable(value) {
				validations += 1;
				assert.equal(value, "run-advisor");
			},
		});
		assert.equal(runId, "run-advisor");
		assert.equal(validations, 1);
	});

	it("fails closed for missing, non-resumable, and stale receipt references", () => {
		const asyncRoot = tempRoot();
		assert.throws(
			() => resolveWorkflowReceiptResume({ reference: { workflowRunId: "missing", key: "advisor", latest: true }, asyncDirRoot: asyncRoot }),
			/not found/,
		);

		const asyncDir = path.join(asyncRoot, "workflow-1");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({
			workflowRunId: "workflow-1",
			state: "failed",
			children: [child("advisor", { resumability: { state: "not-resumable", reason: "session removed" } })],
		}));
		assert.throws(
			() => resolveWorkflowReceiptResume({ reference: { workflowRunId: "workflow-1", key: "missing", latest: true }, asyncDirRoot: asyncRoot }),
			/no child key 'missing'/,
		);
		assert.throws(
			() => resolveWorkflowReceiptResume({ reference: { workflowRunId: "workflow-1", key: "advisor", latest: true }, asyncDirRoot: asyncRoot }),
			/not resumable: session removed/,
		);

		const receiptPath = workflowReceiptPath(asyncRoot, "workflow-1");
		const stale = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as Record<string, unknown>;
		((stale.entries as Record<string, Record<string, unknown>>).advisor!).latestRunId = "other-run";
		fs.writeFileSync(receiptPath, JSON.stringify(stale));
		assert.throws(() => readWorkflowReceipt(asyncRoot, "workflow-1"), /stale: latestRunId/);
		assert.throws(
			() => resolveWorkflowReceiptResume({ reference: { workflowRunId: "workflow-1", key: "advisor", latest: false } as never, asyncDirRoot: asyncRoot }),
			/requires latest: true/,
		);
	});
});
