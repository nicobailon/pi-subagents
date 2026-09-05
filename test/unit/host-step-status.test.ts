import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AsyncStatus, HostStepNode } from "../../src/shared/types.ts";
import {
	HOST_STEP_MAX_LABEL_CHARS,
	assertHostStepNode,
	assertWorkflowGraphHostSteps,
	hostStepWorkflowNode,
	parseHostStepNode,
	assertUniqueHostStepIds,
	upsertHostStep,
	validHostStepNodes,
} from "../../src/runs/shared/host-step-status.ts";

function hostStep(overrides: Partial<HostStepNode> = {}): HostStepNode {
	return {
		version: 1,
		kind: "host-step",
		monitorKind: "gate",
		id: "gate-ci",
		label: "CI and review gate",
		provider: "github-ci",
		state: "running",
		updatedAt: 10,
		...overrides,
	};
}

describe("host step status", () => {
	it("validates host monitor states and command exit evidence", () => {
		const running = parseHostStepNode(hostStep({ monitorKind: "ci" }), "fixture");
		assert.equal(running.monitorKind, "ci");
		assert.equal(hostStepWorkflowNode(running).status, "running");
		assert.equal(hostStepWorkflowNode(hostStep({ state: "done", verdict: "pass" })).status, "completed");
		assert.equal(hostStepWorkflowNode(hostStep({ state: "done", verdict: "inconclusive" })).status, "partial");
		assert.equal(hostStepWorkflowNode(hostStep({ state: "done" })).status, "partial");
		assert.equal(hostStepWorkflowNode(hostStep({ state: "done", verdict: "fail" })).status, "failed");
		assert.equal(hostStepWorkflowNode(hostStep({ state: "cancelled" })).status, "stopped");
		assert.equal(hostStepWorkflowNode(hostStep({ state: "error" })).status, "failed");
		assert.equal(parseHostStepNode(hostStep({ monitorKind: "command", state: "done", verdict: "pass", exitCode: 0 })).exitCode, 0);
	});

	it("rejects unbounded or incomplete terminal data", () => {
		assert.throws(() => assertHostStepNode(hostStep({ label: "x".repeat(HOST_STEP_MAX_LABEL_CHARS + 1) }), "fixture"), /label exceeds/);
		assert.throws(() => assertHostStepNode(hostStep({ state: "running", verdict: "pass" }), "fixture"), /verdict is only valid/);
		assert.throws(() => assertHostStepNode(hostStep({ state: "done", verdict: "inconclusive", freshness: {} as HostStepNode["freshness"] }), "fixture"), /expected/);
		assert.throws(() => assertHostStepNode(hostStep({ state: "done", verdict: "pass", freshness: { expectedRef: "head", stale: true } }), "fixture"), /stale freshness/);
		assert.throws(() => assertHostStepNode(hostStep({ exitCode: 1 }), "fixture"), /only valid for command/);
		assert.throws(() => assertHostStepNode(hostStep({ monitorKind: "command", exitCode: 1 }), "fixture"), /only valid after command settlement/);
	});

	it("upserts through the host-owned persistence callback without touching legacy child steps", () => {
		const status: AsyncStatus = {
			runId: "workflow-1",
			mode: "workflow",
			state: "running",
			startedAt: 1,
			steps: [{ agent: "reviewer", workflowKey: "review", runId: "child-1", status: "running" }],
		};
		const writes: AsyncStatus[] = [];
		const next = upsertHostStep({ status, hostStep: hostStep({ state: "done", verdict: "pass", updatedAt: 20 }), persist: (value) => writes.push(value) });
		assert.equal(writes.length, 1);
		assert.deepEqual(next.steps, status.steps);
		assert.equal(next.workflowGraph?.nodes[0]?.kind, "host-step");
		assert.equal(next.workflowGraph?.nodes[0]?.hostStep?.monitorKind, "gate");
		assert.equal(next.workflowGraph?.nodes[0]?.status, "completed");
		assert.equal(next.lastUpdate, 20);

		const replaced = upsertHostStep({ status: next, hostStep: hostStep({ state: "error", updatedAt: 30 }), persist: (value) => writes.push(value) });
		assert.equal(replaced.workflowGraph?.nodes.length, 1);
		assert.equal(replaced.workflowGraph?.nodes[0]?.status, "failed");
		assert.equal(writes.length, 2);
	});

	it("fails closed for malformed graph nodes while strict loaders can reject them", () => {
		const graph = {
			runId: "workflow-1",
			mode: "workflow" as const,
			phases: [],
			nodes: [{ id: "bad", kind: "host-step" as const, label: "bad", status: "running" as const }],
		};
		assert.deepEqual(validHostStepNodes(graph), []);
		assert.throws(() => assertHostStepNode(graph.nodes[0]?.hostStep, "status"), /expected an object/);
	});

	it("rejects ambiguous host-step identities", () => {
		const duplicate = hostStep({ id: "duplicate" });
		assert.throws(() => assertUniqueHostStepIds([duplicate, duplicate], "receipt"), /duplicate host step id/);
		const graph = {
			runId: "workflow-1",
			mode: "workflow" as const,
			phases: [],
			nodes: [hostStepWorkflowNode(duplicate), hostStepWorkflowNode(duplicate)],
		};
		assert.deepEqual(validHostStepNodes(graph), []);
		assert.throws(() => assertWorkflowGraphHostSteps(graph, "status", "workflow-1"), /duplicate host step id/);
	});
});
