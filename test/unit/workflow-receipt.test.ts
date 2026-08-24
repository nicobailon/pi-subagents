import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildWorkflowReceipt, readWorkflowReceipt, resolveWorkflowReceiptResume, workflowReceiptPath, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import type { WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import { workflowChildSummary } from "../../src/workflows/workflow-child-summary.ts";

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
	it("reads old receipt-v1 files without external adapter metadata", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-old");
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), JSON.stringify({
			version: 1,
			workflowRunId: "workflow-old",
			state: "complete",
			createdAt: 10,
			entries: { advisor: { key: "advisor", latestRunId: "run-old", resumability: { state: "resumable" }, continuation: { runIds: ["run-old"] } } },
		}));

		assert.equal(readWorkflowReceipt(asyncRoot, "workflow-old").entries.advisor?.externalAdapter, undefined);
	});

	it("reads legacy Grok receipt metadata after the active profile is removed", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-old-grok");
		fs.mkdirSync(asyncDir, { recursive: true });
		const reason = "The legacy prompt-file adapter has no durable external session identity.";
		fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), JSON.stringify({
			version: 1,
			workflowRunId: "workflow-old-grok",
			state: "complete",
			createdAt: 10,
			entries: { grok: {
				key: "grok",
				resumability: { state: "not-resumable", reason },
				continuation: { runIds: [] },
				externalAdapter: {
					adapter: { id: "grok-build", version: 1, executionMode: "one-shot-prompt-file" },
					capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false, supervisor: "unsupported", forkContext: false, extensionBindings: false },
					safety: { access: "read-only", authentication: "xai-api-key-required", permissionMode: "plan", tools: "read_file,grep,list_dir", deniedTools: "run_terminal_cmd,search_replace,Agent,Bash,Edit,Write,MCPTool", sandbox: "read-only", webSearch: false, subagents: false, config: "temporary-home", updates: "disabled", sessionPersistence: false },
					handoff: { mode: "fresh" },
					supervisor: { mode: "unsupported", reason: "Legacy adapter has no supervisor transport." },
					nonResumableReason: reason,
				},
			} },
		}));

		assert.equal(readWorkflowReceipt(asyncRoot, "workflow-old-grok").entries.grok?.externalAdapter?.adapter.id, "grok-build");
	});

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

	it("persists a bounded terminal workflow-child summary without payload data", () => {
		const trace = Array.from({ length: 64 }, (_, index) => ({ operation: "run" as const, key: `child-${index}`, state: "started" as const }));
		const started = performance.now();
		let summary = workflowChildSummary({ parentToolCallId: "tool-call", workflowRunId: "workflow-1", workflowState: "failed", inventoryComplete: true, trace });
		for (let index = 0; index < 999; index += 1) summary = workflowChildSummary({ parentToolCallId: "tool-call", workflowRunId: "workflow-1", workflowState: "failed", inventoryComplete: true, trace });
		const elapsedMs = performance.now() - started;
		assert.equal(summary.children.length, 64);
		assert.equal(summary.children[0]?.childId, "child-0");
		assert.equal(summary.children[0]?.state, "failed");
		const serialized = JSON.stringify(summary);
		assert.ok(Buffer.byteLength(serialized) < 8_000, `max-fanout summary too large: ${Buffer.byteLength(serialized)}`);
		assert.ok(elapsedMs < 500, `1,000 max-fanout projections took ${elapsedMs.toFixed(1)}ms`);
		assert.doesNotMatch(serialized, /task|prompt|output|artifact|transcript|secret/);

		const receipt = buildWorkflowReceipt({ workflowRunId: "workflow-1", state: "failed", children: [], workflowChildren: summary, createdAt: 10 });
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-1");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeWorkflowReceipt(asyncDir, receipt);
		assert.deepEqual(readWorkflowReceipt(asyncRoot, "workflow-1").workflowChildren, summary);
	});

	it("uses workflow keys when flattened child indexes collide", () => {
		const summary = workflowChildSummary({
			parentToolCallId: "tool-call",
			workflowRunId: "workflow-1",
			workflowState: "completed",
			inventoryComplete: true,
			children: [
				child("review", { results: [{ index: 0, model: "provider/reviewer", thinking: "high" }] }),
				child("tests", { results: [{ index: 0, model: "provider/tester", thinking: "low" }] }),
			],
		});

		assert.deepEqual(summary.children.map(({ childId, model }) => ({ childId, model })), [
			{ childId: "review", model: "provider/reviewer" },
			{ childId: "tests", model: "provider/tester" },
		]);
	});

	it("rejects a summary bound to a different workflow", () => {
		const summary = workflowChildSummary({ parentToolCallId: "tool", workflowRunId: "other", workflowState: "completed", inventoryComplete: true });
		assert.throws(() => buildWorkflowReceipt({ workflowRunId: "workflow-1", state: "complete", children: [], workflowChildren: summary }), /does not match its receipt/);
	});

	it("adds bounded external adapter metadata without raw output or handoff content", () => {
		const runner = resolveExternalCliRunnerStatus({ command: "review-cli" });
		const externalAdapter = externalCliReceiptMetadata({
			runner,
			externalProcess: { startedAt: 1, stdoutPath: "/tmp/stdout.log", stderrPath: "/tmp/stderr.log" },
			outputReference: "/tmp/final.md",
		});
		const receipt = buildWorkflowReceipt({
			workflowRunId: "workflow-external",
			state: "complete",
			children: [child("advisor", { resumability: { state: "not-resumable", reason: externalAdapter.nonResumableReason }, externalAdapter })],
		});
		const serialized = JSON.stringify(receipt);

		assert.equal(receipt.entries.advisor?.externalAdapter?.adapter.id, "external-cli");
		assert.equal(receipt.entries.advisor?.externalAdapter?.capabilities.stop, true);
		assert.equal(receipt.entries.advisor?.externalAdapter?.capabilities.supervisor, "unsupported");
		assert.equal(receipt.entries.advisor?.externalAdapter?.handoff.mode, "fresh");
		assert.match(receipt.entries.advisor?.resumability.state === "not-resumable" ? receipt.entries.advisor.resumability.reason : "", /no durable external session identity/);
		assert.doesNotMatch(serialized, /artifactPaths|rawOutput|handoffText|contact_supervisor/);
		assert.ok(Buffer.byteLength(serialized) < 2_000, `external receipt metadata unexpectedly large: ${Buffer.byteLength(serialized)}`);
	});

	it("fails closed for malformed external adapter receipt metadata", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-external-bad");
		fs.mkdirSync(asyncDir, { recursive: true });
		const runner = resolveExternalCliRunnerStatus({ command: "review-cli" });
		const externalAdapter = externalCliReceiptMetadata({ runner });
		fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), JSON.stringify({
			version: 1,
			workflowRunId: "workflow-external-bad",
			state: "complete",
			createdAt: 10,
			entries: {
				advisor: {
					key: "advisor",
					latestRunId: "run-advisor",
					resumability: { state: "not-resumable", reason: externalAdapter.nonResumableReason },
					continuation: { runIds: ["run-advisor"] },
					externalAdapter: { ...externalAdapter, nonResumableReason: "" },
				},
			},
		}));

		assert.throws(() => readWorkflowReceipt(asyncRoot, "workflow-external-bad"), /externalAdapter\.nonResumableReason is missing/);
		const badRaw = JSON.parse(fs.readFileSync(path.join(asyncDir, "workflow-receipt.json"), "utf-8"));
		badRaw.entries.advisor.externalAdapter = { ...externalAdapter, rawOutput: "do not persist" };
		fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), JSON.stringify(badRaw));
		assert.throws(() => readWorkflowReceipt(asyncRoot, "workflow-external-bad"), /externalAdapter has unsupported fields: rawOutput/);
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

	it("refuses keyed resume for a one-shot external CLI with its adapter reason", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-external");
		fs.mkdirSync(asyncDir, { recursive: true });
		const runner = resolveExternalCliRunnerStatus({ command: "review-cli" });
		const externalAdapter = externalCliReceiptMetadata({ runner });
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({
			workflowRunId: "workflow-external",
			state: "complete",
			children: [child("advisor", { externalAdapter, resumability: { state: "not-resumable", reason: externalAdapter.nonResumableReason } })],
		}));

		assert.throws(
			() => resolveWorkflowReceiptResume({ reference: { workflowRunId: "workflow-external", key: "advisor", latest: true }, asyncDirRoot: asyncRoot }),
			/not resumable: The one-shot stdin adapter has no durable external session identity/,
		);
	});
});
