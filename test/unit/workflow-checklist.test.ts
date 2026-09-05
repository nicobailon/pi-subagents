import test from "node:test";
import assert from "node:assert/strict";

import { formatWorkflowChecklistBottleneck, formatWorkflowChecklistText, projectWorkflowChecklist } from "../../src/workflows/workflow-checklist.ts";
import type { HostStepNode, WorkflowGraphSnapshot } from "../../src/shared/types.ts";

function graph(): WorkflowGraphSnapshot {
	return {
		runId: "workflow-checklist",
		mode: "workflow",
		phases: [
			{ title: "inventory", nodeIds: ["inventory"] },
			{ title: "writers", nodeIds: ["writer-a", "writer-b"] },
			{ title: "reviews", nodeIds: ["review"] },
			{ title: "gate", nodeIds: ["gate"] },
		],
		nodes: [
			{ id: "inventory", kind: "step", label: "inventory", agent: "scout", status: "completed", flatIndex: 0 },
			{ id: "writer-a", kind: "agent", label: "writer-a", agent: "writer", status: "completed", flatIndex: 1 },
			{ id: "writer-b", kind: "agent", label: "writer-b", agent: "writer", status: "running", flatIndex: 2 },
			{ id: "review", kind: "step", label: "review", agent: "reviewer", status: "pending", flatIndex: 3 },
			{ id: "gate", kind: "step", label: "gate", agent: "reviewer", status: "pending", acceptanceStatus: "rejected", flatIndex: 4 },
		],
	};
}

test("workflow checklist fuses graph phases with loaded child state without duplicate rows", () => {
	const projection = projectWorkflowChecklist({
		graph: graph(),
		steps: [
			{ workflowKey: "inventory", agent: "scout", status: "complete" },
			{ workflowKey: "writer-a", agent: "writer", status: "complete" },
			{ workflowKey: "writer-b", agent: "writer", status: "running", currentTool: "grep", toolCount: 18, startedAt: 1000 },
			{ workflowKey: "review", agent: "reviewer", status: "pending", context: "fork" },
		],
		now: 5000,
	});

	assert.deepEqual(projection.phases.map((phase) => [phase.label, phase.state, phase.total, phase.done]), [
		["inventory", "complete", 1, 1],
		["writers", "running", 2, 1],
		["reviews", "queued", 1, 0],
		["gate", "blocked", 1, 0],
	]);
	assert.deepEqual([projection.total, projection.done, projection.running, projection.queued, projection.blocked], [5, 2, 1, 1, 1]);
	assert.equal(projection.phases.flatMap((phase) => phase.items).length, 5);
	assert.equal(projection.phases[1]!.items[1]!.durationMs, 4000);
	assert.equal(projection.phases[2]!.items[0]!.context, "fork");
	assert.equal(projection.bottleneck?.key, "gate");
});

test("workflow checklist preserves explicit host monitor verdicts and trace lane identity", () => {
	const host: HostStepNode = {
		version: 1,
		kind: "host-step",
		monitorKind: "ci",
		id: "ci",
		label: "CI",
		provider: "buildkite",
		state: "done",
		verdict: "inconclusive",
		target: "main",
		freshness: { expectedRef: "main", stale: true },
		updatedAt: 1000,
	};
	const projection = projectWorkflowChecklist({
		hostSteps: [host],
		preflight: { version: 1, coverage: "partial", lanes: [{ key: "reviewers", mode: "review" }] },
		trace: [
			{ operation: "run", key: "reviewers.a", generatedLaneKey: "reviewers", state: "started", agent: "reviewer" },
			{ operation: "run", key: "reviewers.a", generatedLaneKey: "reviewers", state: "completed", agent: "reviewer" },
		],
	});

	assert.deepEqual(projection.phases.map((phase) => phase.label), ["CI", "reviewers"]);
	assert.equal(projection.phases[0]!.items[0]!.state, "blocked");
	assert.equal(projection.phases[0]!.items[0]!.monitorKind, "ci");
	assert.equal(projection.phases[0]!.items[0]!.verdict, "inconclusive");
	assert.equal(projection.phases[1]!.items[0]!.state, "complete");
	assert.equal(projection.phases[1]!.items[0]!.preflight?.mode, "review");
	assert.match(formatWorkflowChecklistBottleneck(projection.bottleneck) ?? "", /CI/);
});

test("workflow checklist renders a failed item error only once when item details are included", () => {
	const projection = projectWorkflowChecklist({
		steps: [{ workflowKey: "review", agent: "reviewer", status: "failed", error: "review failed with details" }],
	});

	const expanded = formatWorkflowChecklistText(projection).join("\n");
	assert.equal(expanded.match(/review failed with details/g)?.length, 1);
	assert.doesNotMatch(expanded, /bottleneck .*error:review failed with details/);

	const collapsed = formatWorkflowChecklistText(projection, "", { includeItems: false }).join("\n");
	assert.equal(collapsed.match(/review failed with details/g)?.length, 1);
	assert.match(collapsed, /bottleneck .*error:review failed with details/);
});

test("workflow checklist counts one host monitor when host status and trace share an id", () => {
	const host: HostStepNode = {
		version: 1,
		kind: "host-step",
		monitorKind: "ci",
		id: "ci",
		label: "CI",
		state: "done",
		verdict: "pass",
		updatedAt: 1000,
	};
	const projection = projectWorkflowChecklist({
		hostSteps: [host],
		trace: [{ operation: "host", key: "ci", state: "completed", label: "CI" }],
	});

	assert.equal(projection.total, 1);
	assert.deepEqual(projection.phases.flatMap((phase) => phase.items).map((item) => [item.key, item.kind, item.state]), [["ci", "host", "complete"]]);
});

test("workflow checklist keeps terminal child state newer than stale running trace", () => {
	const projection = projectWorkflowChecklist({
		graph: graph(),
		steps: [{ workflowKey: "writer-b", agent: "writer", status: "complete" }],
		trace: [{ operation: "run", key: "writer-b", state: "started", agent: "writer" }],
	});

	assert.equal(projection.running, 0);
	assert.equal(projection.phases[1]!.items[1]!.state, "complete");
});

test("workflow checklist keeps terminal graph state newer than stale running child state", () => {
	const snapshot = graph();
	snapshot.nodes[2] = { ...snapshot.nodes[2]!, status: "failed", error: "writer failed" };
	const projection = projectWorkflowChecklist({
		graph: snapshot,
		steps: [{ workflowKey: "writer-b", agent: "writer", status: "running" }],
		trace: [{ operation: "run", key: "writer-b", state: "started", agent: "writer" }],
	});

	assert.equal(projection.running, 0);
	assert.equal(projection.failed, 1);
	assert.equal(projection.phases[1]!.state, "failed");
	assert.equal(projection.phases[1]!.items[1]!.state, "failed");
});

test("workflow checklist keeps terminal graph state newer than stale trace without loaded child state", () => {
	const snapshot = graph();
	snapshot.nodes[2] = { ...snapshot.nodes[2]!, status: "failed", error: "writer failed" };
	const projection = projectWorkflowChecklist({
		graph: snapshot,
		trace: [{ operation: "run", key: "writer-b", state: "started", agent: "writer" }],
	});

	assert.equal(projection.running, 0);
	assert.equal(projection.failed, 1);
	assert.equal(projection.phases[1]!.items[1]!.state, "failed");
});

test("workflow checklist keeps graph acceptance blockers ahead of stale running child state", () => {
	const snapshot = graph();
	snapshot.nodes[2] = { ...snapshot.nodes[2]!, acceptanceStatus: "rejected" };
	const projection = projectWorkflowChecklist({
		graph: snapshot,
		steps: [{ workflowKey: "writer-b", agent: "writer", status: "running" }],
		trace: [{ operation: "run", key: "writer-b", state: "started", agent: "writer" }],
	});

	assert.equal(projection.running, 0);
	assert.equal(projection.blocked, 2);
	assert.equal(projection.phases[1]!.items[1]!.state, "blocked");
});

test("workflow checklist uses preflight only to annotate authoritative work", () => {
	const projection = projectWorkflowChecklist({
		graph: graph(),
		preflight: { version: 1, coverage: "partial", lanes: [{ key: "writer-b", mode: "mutation" }, { key: "writers", mode: "mutation" }, { key: "deploy", mode: "gate" }] },
	});

	assert.equal(projection.total, 5);
	assert.deepEqual(projection.phases.map((phase) => phase.label), ["inventory", "writers", "reviews", "gate"]);
	assert.equal(projection.queued, 1);
	assert.equal(projection.phases[2]?.items[0]?.key, "review");
});

test("workflow checklist does not turn unmatched preflight metadata into queued work", () => {
	const preflight = { version: 1 as const, coverage: "partial" as const, lanes: [{ key: "pr14", mode: "review" as const }] };
	const declarationOnly = projectWorkflowChecklist({ preflight });
	const mismatchedRuntime = projectWorkflowChecklist({
		preflight,
		trace: [{ operation: "run", key: "pr14-quality", state: "started", agent: "reviewer" }],
	});

	assert.deepEqual(declarationOnly, { phases: [], total: 0, done: 0, running: 0, queued: 0, blocked: 0, failed: 0, paused: 0, stopped: 0 });
	assert.equal(mismatchedRuntime.total, 1);
	assert.equal(mismatchedRuntime.running, 1);
	assert.equal(mismatchedRuntime.queued, 0);
	assert.deepEqual(mismatchedRuntime.phases.flatMap((phase) => phase.items).map((item) => item.key), ["pr14-quality"]);
});

test("workflow checklist prefers specific dotted preflight lanes over generated aliases", () => {
	const projection = projectWorkflowChecklist({
		preflight: {
			version: 1,
			coverage: "partial",
			lanes: [
				{ key: "writer", mode: "mutation" },
				{ key: "writer.quality", mode: "review" },
			],
		},
		trace: [{ operation: "run", key: "writer.quality.deep", generatedLaneKey: "writer", state: "started", agent: "reviewer" }],
	});

	assert.equal(projection.total, 1);
	assert.deepEqual(projection.phases.map((phase) => phase.label), ["writer.quality"]);
	assert.equal(projection.phases[0]?.items[0]?.preflight?.mode, "review");
});

test("workflow checklist text exposes aggregate, phase, and bottleneck signals with bounded errors", () => {
	const projection = projectWorkflowChecklist({
		trace: [{ operation: "run", key: "review", state: "failed", label: "reviewer", agent: "reviewer", error: "Output: secret details" }],
	});
	const text = formatWorkflowChecklistText(projection).join("\n");
	assert.match(text, /Workflow checklist: 0\/1 done · 1 failed/);
	assert.match(text, /reviewer/);
	assert.match(text, /bottleneck/);
	assert.doesNotMatch(text, /Output:/);
});

test("workflow checklist text can suppress item rows for status surfaces", () => {
	const projection = projectWorkflowChecklist({
		graph: graph(),
		steps: [{ workflowKey: "writer-b", agent: "writer", status: "running" }],
	});
	const text = formatWorkflowChecklistText(projection, "", { includeItems: false }).join("\n");

	assert.match(text, /Workflow checklist:/);
	assert.match(text, /writers 1 done · 1 active/);
	assert.doesNotMatch(text, /writer-b · writer · active/);
});
