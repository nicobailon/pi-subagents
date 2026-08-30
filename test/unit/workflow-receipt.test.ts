import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildWorkflowReceipt, readWorkflowReceipt, resolveWorkflowReceiptResume, workflowReceiptPath, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import type { WorkflowScriptChildResult } from "../../src/workflows/scripted-workflow.ts";
import type { HostStepNodeV1 } from "../../src/shared/types.ts";
import { parseWorkflowChildSummary, workflowChildSummary } from "../../src/workflows/workflow-child-summary.ts";

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

function hostStep(overrides: Partial<HostStepNodeV1> = {}): HostStepNodeV1 {
	return {
		version: 1,
		kind: "host-step",
		monitorKind: "gate",
		id: "gate-1",
		label: "Review gate",
		state: "done",
		verdict: "pass",
		updatedAt: 10,
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

	it("round-trips named workflow resource provenance", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-resource");
		fs.mkdirSync(asyncDir, { recursive: true });
		const resource = { kind: "workflow" as const, name: "review", version: 1, invocation: "named" as const, expansion: "resolved" as const, id: "resource-1" };
		const receipt = buildWorkflowReceipt({ workflowRunId: "workflow-resource", state: "complete", children: [], resource, createdAt: 10 });
		writeWorkflowReceipt(asyncDir, receipt);
		assert.deepEqual(readWorkflowReceipt(asyncRoot, "workflow-resource").resource, resource);
	});

	it("round-trips bounded host CI/gate state in terminal receipts", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-host");
		fs.mkdirSync(asyncDir, { recursive: true });
		const receipt = buildWorkflowReceipt({
			workflowRunId: "workflow-host",
			state: "complete",
			children: [],
			hostSteps: [hostStep({ monitorKind: "ci", id: "ci-1", label: "CI checks", provider: "opaque-provider", state: "done", verdict: "inconclusive", reasonCode: "stale-head", freshness: { expectedRef: "old", observedRef: "new", stale: true }, reportPath: "/private/report.json" })],
			createdAt: 10,
		});
		writeWorkflowReceipt(asyncDir, receipt);
		assert.deepEqual(readWorkflowReceipt(asyncRoot, "workflow-host").hostSteps, receipt.hostSteps);
		assert.equal(JSON.stringify(receipt).includes("/private/report.json"), true);
	});

	it("reads inconclusive host monitor receipt state without a verdict", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-host-inconclusive");
		fs.mkdirSync(asyncDir, { recursive: true });
		const receipt = buildWorkflowReceipt({ workflowRunId: "workflow-host-inconclusive", state: "complete", children: [] });
		fs.writeFileSync(workflowReceiptPath(asyncRoot, "workflow-host-inconclusive"), JSON.stringify({ ...receipt, hostSteps: [{ ...hostStep(), state: "done", verdict: undefined }] }));
		assert.equal(readWorkflowReceipt(asyncRoot, "workflow-host-inconclusive").hostSteps?.[0]?.verdict, undefined);
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

	it("round-trips durable acceptance recovery metadata in terminal receipts", () => {
		const recovery = {
			status: "available-for-review" as const,
			reason: "acceptance-metadata-rejected" as const,
			reportPath: "/tmp/writer-report.md",
			reportHash: "b".repeat(64),
		};
		const receipt = buildWorkflowReceipt({
			workflowRunId: "workflow-recovery",
			state: "complete",
			children: [child("writer", { ok: false, recovery })],
			createdAt: 10,
		});
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-recovery");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeWorkflowReceipt(asyncDir, receipt);
		assert.deepEqual(readWorkflowReceipt(asyncRoot, "workflow-recovery").entries.writer?.acceptanceRecovery, recovery);
	});

	it("persists structured partial outcomes for workflows and children", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-budget");
		fs.mkdirSync(asyncDir, { recursive: true });
		const terminalOutcome = { state: "partial" as const, reason: "budget_exhausted" as const };
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({
			workflowRunId: "workflow-budget",
			state: "failed",
			children: [child("first"), child("second", { ok: false, terminalOutcome })],
			terminalOutcome,
			createdAt: 10,
		}));
		const receipt = readWorkflowReceipt(asyncRoot, "workflow-budget");

		assert.deepEqual(receipt.terminalOutcome, terminalOutcome);
		assert.deepEqual(receipt.entries.second?.terminalOutcome, terminalOutcome);
		assert.equal(receipt.entries.first?.terminalOutcome, undefined);
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

	it("round-trips long parent tool-call ids while rejecting ids over the summary bound", () => {
		const parentToolCallId = `call_${"x".repeat(500)}`;
		const summary = workflowChildSummary({ parentToolCallId, workflowRunId: "workflow-long-tool-call", workflowState: "completed", inventoryComplete: true });
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-long-tool-call");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeWorkflowReceipt(asyncDir, buildWorkflowReceipt({ workflowRunId: "workflow-long-tool-call", state: "complete", children: [], workflowChildren: summary, createdAt: 10 }));
		assert.equal(readWorkflowReceipt(asyncRoot, "workflow-long-tool-call").workflowChildren?.parentToolCallId, parentToolCallId);

		const overBoundParentToolCallId = `call_${"x".repeat(4_091)}`;
		assert.equal(workflowChildSummary({ parentToolCallId: overBoundParentToolCallId, workflowRunId: "workflow-long-tool-call", workflowState: "completed", inventoryComplete: true }).parentToolCallId, overBoundParentToolCallId);
		assert.throws(() => workflowChildSummary({ parentToolCallId: `${overBoundParentToolCallId}x`, workflowRunId: "workflow-long-tool-call", workflowState: "completed", inventoryComplete: true }), /at most 4096 UTF-8 bytes/);
		assert.throws(() => parseWorkflowChildSummary({ ...summary, parentToolCallId: `${overBoundParentToolCallId}x` }), /at most 4096 UTF-8 bytes/);
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

	it("round-trips bounded lane metadata and rejects mismatched receipt identity", () => {
		const lane = { version: 1 as const, key: "advisor", mode: "review" as const, sourceRef: "owner/repo#1621", claims: ["src/shared/types.ts"], outputPaths: ["reports/advisor.md"] };
		const receipt = buildWorkflowReceipt({ workflowRunId: "workflow-lane", state: "complete", children: [child("advisor", { lane })], createdAt: 10 });
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-lane");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeWorkflowReceipt(asyncDir, receipt);
		assert.deepEqual(readWorkflowReceipt(asyncRoot, "workflow-lane").entries.advisor?.lane, lane);
		assert.throws(() => buildWorkflowReceipt({ workflowRunId: "workflow-lane", state: "complete", children: [child("advisor", { lane: { ...lane, key: "other" } })] }), /does not match workflow key/);

		const receiptPath = workflowReceiptPath(asyncRoot, "workflow-lane");
		const malformed = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as { entries: { advisor: { lane: { key: string } } } };
		malformed.entries.advisor.lane.key = "other";
		fs.writeFileSync(receiptPath, JSON.stringify(malformed), "utf-8");
		assert.throws(() => readWorkflowReceipt(asyncRoot, "workflow-lane"), /does not match workflow key/);
	});

	it("rejects non-string workflow-child summary identifiers", () => {
		const asyncRoot = tempRoot();
		const asyncDir = path.join(asyncRoot, "workflow-1");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeWorkflowReceipt(asyncDir, {
			...buildWorkflowReceipt({ workflowRunId: "workflow-1", state: "complete", children: [] }),
			workflowChildren: { version: 1, parentToolCallId: 123, workflowRunId: true, inventoryComplete: true, workflowState: "completed", children: [] } as never,
		});

		assert.throws(() => readWorkflowReceipt(asyncRoot, "workflow-1"), /workflowChildren\.parentToolCallId is invalid/);
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
		receipt.workflowResolution = "settled-awaiting-resume";
		receipt.recovery = [{ key: "advisor", call: "runs.run", resume: { workflowRunId: "workflow-1", key: "advisor", latest: true }, taskRequired: true }];
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
		const invalid = { ...receipt, recovery: [{ ...receipt.recovery[0], resume: { workflowRunId: "other", key: "advisor", latest: true } }] };
		fs.writeFileSync(workflowReceiptPath(asyncRoot, "workflow-1"), JSON.stringify(invalid));
		assert.throws(() => readWorkflowReceipt(asyncRoot, "workflow-1"), /recovery\[0\] does not identify a resumable entry/);
	});

	it("explains a missing receipt when workflow status or events remain visible", () => {
		const asyncRoot = tempRoot();
		const workflowRunId = "workflow-active";
		const asyncDir = path.join(asyncRoot, workflowRunId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: workflowRunId, state: "running" }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent.workflow.child.completed", runId: workflowRunId, childRunId: "run-advisor" })}\n`);

		assert.throws(
			() => resolveWorkflowReceiptResume({ reference: { workflowRunId, key: "advisor", latest: true }, asyncDirRoot: asyncRoot }),
			/Workflow receipt 'workflow-active' is not available because the workflow may still be active or terminal receipt writing failed\. Use direct child run IDs from status\/events for direct resume after the normal retained-child checks\./,
		);
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

describe("workflow child session names", () => {
	it("persists a bounded child session name from async status", () => {
		const summary = workflowChildSummary({
			parentToolCallId: "tool-call",
			workflowRunId: "workflow-1",
			workflowState: "completed",
			inventoryComplete: true,
			steps: [{
				agent: "reviewer",
				sessionName: "reviewer: Inspect the changed auth middleware",
				workflowKey: "review",
				status: "complete",
			}],
		});
		assert.equal(summary.children[0]?.sessionName, "reviewer: Inspect the changed auth middleware");
	});

	it("rejects unbounded session names in persisted workflow summaries", () => {
		const root = tempRoot();
		const asyncDir = path.join(root, "workflow-1");
		fs.mkdirSync(asyncDir, { recursive: true });
		writeWorkflowReceipt(asyncDir, {
			...buildWorkflowReceipt({ workflowRunId: "workflow-1", state: "complete", children: [] }),
			workflowChildren: {
				version: 1,
				parentToolCallId: "tool",
				workflowRunId: "workflow-1",
				inventoryComplete: true,
				workflowState: "completed",
				children: [{ childId: "review", state: "completed", sessionName: "x".repeat(257) }],
			},
		});
		assert.throws(() => readWorkflowReceipt(root, "workflow-1"), /sessionName is invalid/);
	});
});
