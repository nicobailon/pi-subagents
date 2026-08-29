import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AsyncJobState, HostStepNodeV1, WorkflowGraphSnapshot, WorkflowNodeStatus } from "../../src/shared/types.ts";
import {
	ASYNC_STATUS_SNAPSHOT_KIND,
	ASYNC_STATUS_SNAPSHOT_VERSION,
	projectAsyncWorkflowRows,
	projectAsyncStatusSnapshot,
} from "../../src/runs/shared/async-status-projection.ts";

function job(input: Partial<AsyncJobState> & Pick<AsyncJobState, "asyncId" | "status">): AsyncJobState {
	return {
		asyncDir: `/tmp/${input.asyncId}`,
		...input,
	} as AsyncJobState;
}

function hostStep(overrides: Partial<HostStepNodeV1> = {}): HostStepNodeV1 {
	return {
		version: 1,
		kind: "host-step",
		monitorKind: "ci",
		id: "ci-check",
		label: "CI checks",
		provider: "github-ci",
		state: "done",
		verdict: "pass",
		updatedAt: 20,
		...overrides,
	};
}

const stagedLaneKeys = ["scope-scout", "red-tests", "label-helpers", "summary-title", "detail-row", "tiers-noise", "validation", "minimality-challenge", "fresh-review"];

function stagedLaneGraph(statuses: WorkflowNodeStatus[] = stagedLaneKeys.map((_, index) => index === 0 ? "running" : "pending")): WorkflowGraphSnapshot {
	const nodeIds = stagedLaneKeys.map((key) => `issue-1695.${key}`);
	return {
		runId: "workflow-1695",
		mode: "workflow",
		phases: [{ title: "issue-1695", nodeIds }],
		nodes: stagedLaneKeys.map((key, index) => ({
			id: nodeIds[index]!,
			kind: "step",
			agent: index === 0 ? "scout" : index === 7 ? "simplifier" : "worker",
			label: key,
			status: statuses[index] ?? "pending",
			flatIndex: index,
			stepIndex: index,
		})),
		currentNodeId: nodeIds[statuses.findIndex((status) => status === "running")],
	};
}

describe("async status projection", () => {
	it("projects already-loaded jobs in deterministic newest-first order", () => {
		const snapshot = projectAsyncStatusSnapshot([
			job({ asyncId: "older", status: "complete", agents: ["reviewer"], updatedAt: 10 }),
			job({
				asyncId: "newer",
				status: "running",
				mode: "workflow",
				agents: ["worker"],
				updatedAt: 20,
				steps: [{ agent: "worker", status: "pending" }],
			}),
		], { generatedAt: 30 });

		assert.equal(snapshot.kind, ASYNC_STATUS_SNAPSHOT_KIND);
		assert.equal(snapshot.version, ASYNC_STATUS_SNAPSHOT_VERSION);
		assert.equal(snapshot.generatedAt, 30);
		assert.deepEqual(snapshot.runs.map(({ id, kind, state }) => ({ id, kind, state })), [
			{ id: "newer", kind: "workflow", state: "running" },
			{ id: "older", kind: "subagent", state: "complete" },
		]);
		assert.equal(snapshot.runs[0]?.children?.[0]?.state, "queued");
	});

	it("preserves partial needs-attention status while excluding private evidence", () => {
		const snapshot = projectAsyncStatusSnapshot([job({
			asyncId: "partial-run",
			status: "partial",
			agents: ["writer"],
			activityState: "needs_attention",
			steps: [{
				agent: "writer",
				status: "partial",
				activityState: "needs_attention",
				error: "Required file-only output was not produced: /private/report.md",
				effects: { fileMutation: true },
			}],
		})], { generatedAt: 1 });

		assert.equal(snapshot.runs[0]?.state, "partial");
		assert.equal(snapshot.runs[0]?.activity?.state, "needs_attention");
		assert.equal(snapshot.runs[0]?.children?.[0]?.state, "partial");
		assert.equal(snapshot.runs[0]?.children?.[0]?.activity?.state, "needs_attention");
		const serialized = JSON.stringify(snapshot);
		assert.doesNotMatch(serialized, /private\/report|fileMutation|Required file-only output/);
	});

	it("maps malformed persisted states to partial instead of widening the public state union", () => {
		const snapshot = projectAsyncStatusSnapshot([{
			asyncId: "bad-state",
			asyncDir: "/tmp/bad-state",
			status: "mystery",
			steps: [{ agent: "worker", status: "also-mystery" }],
		} as unknown as AsyncJobState]);

		assert.equal(snapshot.runs[0]?.state, "partial");
		assert.equal(snapshot.runs[0]?.children?.[0]?.state, "partial");
	});

	it("projects compact Fleet workflow rows without applying UI bounds", () => {
		const rows = projectAsyncWorkflowRows([{
			agent: "reviewer",
			workflowKey: "review",
			label: "Fresh review",
			phase: "quality",
			status: "partial",
			context: "fresh",
			activityState: "needs_attention",
			startedAt: 10,
			tokens: { input: 20, output: 5, total: 25, window: 18 },
		}]);

		assert.deepEqual(rows, [{
			name: "quality: review · Fresh review (reviewer)",
			state: "partial",
			context: "fresh",
			activity: "needs attention",
			startedAt: 10,
			tokens: 25,
			window: 18,
		}]);
	});

	it("projects typed CI and gate host rows without treating them as child agents", () => {
		const rows = projectAsyncWorkflowRows([], {
			runId: "workflow-1",
			mode: "workflow",
			phases: [],
			nodes: [
				{ id: "ci-check", kind: "host-step", label: "CI checks", status: "completed", hostStep: hostStep() },
				{ id: "review-gate", kind: "host-step", label: "Review gate", status: "completed", hostStep: hostStep({ id: "review-gate", monitorKind: "gate", label: "Review gate", verdict: "inconclusive", reasonCode: "stale-head", detail: "head changed", target: "PR #1614", freshness: { expectedRef: "old-head", observedRef: "new-head", stale: true }, reportPath: "/tmp/reports/gate.json" }) },
			],
		});

		assert.deepEqual(rows, [
			{ name: "CI checks", kind: "ci", state: "done", provider: "github-ci", verdict: "pass" },
			{ name: "Review gate", kind: "gate", state: "done", provider: "github-ci", verdict: "inconclusive", reasonCode: "stale-head", detail: "head changed", target: "PR #1614", freshness: { expectedRef: "old-head", observedRef: "new-head", stale: true }, reportPath: "gate.json" },
		]);
	});

	it("projects done host steps without verdicts as partial", () => {
		const snapshot = projectAsyncStatusSnapshot([job({
			asyncId: "inconclusive-gate",
			status: "running",
			hostSteps: [hostStep({ verdict: undefined })],
		})]);

		assert.equal(snapshot.runs[0]?.children?.[0]?.state, "partial");
	});

	it("reserves bounded snapshot capacity for host steps", () => {
		const snapshot = projectAsyncStatusSnapshot([job({
			asyncId: "bounded-gate",
			status: "running",
			steps: [
				{ agent: "first", status: "running" },
				{ agent: "second", status: "running" },
			],
			hostSteps: [hostStep()],
		})], { maxChildrenPerNode: 2 });

		assert.deepEqual(snapshot.runs[0]?.children?.map(({ kind, id }) => ({ kind, id })), [
			{ kind: "step", id: "step:0" },
			{ kind: "host-step", id: "ci-check" },
		]);
		assert.equal(snapshot.omitted.children, 1);
	});

	it("omits malformed host nodes instead of rendering them as agents", () => {
		const rows = projectAsyncWorkflowRows([], {
			runId: "workflow-1",
			mode: "workflow",
			phases: [],
			nodes: [{ id: "bad", kind: "host-step", label: "bad", status: "running" }],
		});
		assert.deepEqual(rows, []);
	});

	it("projects stored preflight lanes as planned rows and merges launched facts", () => {
		const rows = projectAsyncWorkflowRows([
			{ agent: "worker", workflowKey: "writer", label: "Writer", status: "running" },
		], {
			version: 1,
			coverage: "complete",
			lanes: [
				{ key: "writer", mode: "mutation", claims: ["src/a.ts"] },
				{ key: "review", mode: "review", expectedOutput: "review.md" },
			],
		});

		assert.deepEqual(rows.map((row) => ({ name: row.name, state: row.state, mode: row.preflight?.mode })), [
			{ name: "writer · Writer (worker)", state: "running", mode: "mutation" },
			{ name: "review", state: "planned", mode: "review" },
		]);
	});

	it("projects known runs.lanes stages from the workflow graph, including pending stages", () => {
		const rows = projectAsyncWorkflowRows([{
			agent: "scout",
			workflowKey: "issue-1695.scope-scout",
			label: "scope-scout",
			status: "running",
		}], stagedLaneGraph(), {
			version: 1,
			coverage: "complete",
			lanes: [{ key: "issue-1695", mode: "scout" }],
		});

		for (const [index, key] of stagedLaneKeys.entries()) {
			const row = rows.find((candidate) => candidate.name.includes(key));
			assert.ok(row, `stage ${key} should remain discoverable`);
			assert.equal(row?.state, index === 0 ? "running" : "planned", `stage ${key} state`);
		}
		assert.equal(rows.filter((row) => row.state === "planned").length, stagedLaneKeys.length - 1);
		assert.equal(rows.every((row) => row.preflight?.mode === "scout"), true);
	});

	it("preserves duplicate loaded rows when a declared lane key is reused", () => {
		const rows = projectAsyncWorkflowRows([
			{ agent: "worker", workflowKey: "writer", label: "First", status: "complete" },
			{ agent: "worker", workflowKey: "writer", label: "Second", status: "running" },
		], {
			version: 1,
			coverage: "partial",
			lanes: [{ key: "writer", mode: "mutation" }],
		});

		assert.deepEqual(rows.map((row) => ({ name: row.name, state: row.state })), [
			{ name: "writer · First (worker)", state: "complete" },
			{ name: "writer · Second (worker)", state: "running" },
		]);
	});
});
