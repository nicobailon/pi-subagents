import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncStatus, ProcessTerminal, WorkflowChildSummary, WorkflowTerminalProof } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { readProcessTerminal } from "./process-terminal.ts";

const TERMINAL_WORKFLOW_STATES = new Set<WorkflowChildSummary["workflowState"]>(["completed", "failed", "stopped"]);

export function isTerminalAsyncState(state: AsyncStatus["state"]): boolean {
	return state !== "queued" && state !== "running" && state !== "paused";
}

export type WorkflowChildProcessEvidence =
	| { state: "observed"; children: ProcessTerminal[] }
	| { state: "pending" | "unknown"; reason: string };

/**
 * Process evidence for a workflow's async children. Status proofs and capacity
 * release both use this so they cannot disagree about the same workflow.
 * Synchronous children run inside the workflow host and have no process of their own.
 */
export function readWorkflowChildProcessEvidence(workflowAsyncDir: string, steps: AsyncStatus["steps"]): WorkflowChildProcessEvidence {
	if (!steps) return { state: "unknown", reason: "workflow child roster is missing" };
	const children: ProcessTerminal[] = [];
	for (const step of steps) {
		const label = step.workflowKey ?? step.agent;
		if (typeof step.async !== "boolean") return { state: "unknown", reason: `workflow child ${label} is missing async classification` };
		if (!step.async) continue;
		if (!step.runId || path.basename(step.runId) !== step.runId) return { state: "unknown", reason: `async workflow child ${label} is missing run id` };
		const childDir = path.join(path.dirname(workflowAsyncDir), step.runId);
		if (!fs.existsSync(childDir)) return { state: "unknown", reason: `async workflow child ${label} directory is missing` };
		const childStatus = readStatus(childDir);
		if (!childStatus) return { state: "unknown", reason: `async workflow child ${label} status is missing or unreadable` };
		if (!isTerminalAsyncState(childStatus.state)) return { state: "pending", reason: `async workflow child ${label} is still ${childStatus.state}` };
		const recorded = childStatus.processTerminal;
		if (!recorded?.runnerProcessInstanceId) return { state: "unknown", reason: `async workflow child ${label} has no runner process identity` };
		// A runner startup failure records `not-started` in status and never writes a process-terminal sidecar.
		if (recorded.state === "not-started" && recorded.runId === step.runId && typeof childStatus.error === "string" && childStatus.error) {
			children.push(recorded);
			continue;
		}
		const proof = readProcessTerminal(childDir, { runId: step.runId, runnerProcessInstanceId: recorded.runnerProcessInstanceId });
		if (proof?.state !== "observed" || proof.runId !== step.runId) {
			return { state: !proof || proof.state === "pending" ? "pending" : "unknown", reason: `async workflow child ${label} process-terminal proof is ${proof?.state ?? "missing"}` };
		}
		children.push(proof);
	}
	return { state: "observed", children };
}

function unresolved(runId: string, state: "pending" | "unknown", dispatchClosed: boolean, reason: string): WorkflowTerminalProof {
	return { version: 1, kind: "workflow", runId, state, dispatchClosed, reason };
}

/** A persistent workflow host is terminal only after dispatch closes and every async child has process evidence. */
export function readWorkflowTerminalProof(asyncDir: string, steps: AsyncStatus["steps"], summary: WorkflowChildSummary, hostCommandCount: number, closedAt: number): WorkflowTerminalProof {
	const runId = summary.workflowRunId;
	if (!summary.inventoryComplete || !TERMINAL_WORKFLOW_STATES.has(summary.workflowState)) {
		return unresolved(runId, "pending", false, "Workflow dispatch is still open.");
	}
	if (hostCommandCount > 0) {
		return unresolved(runId, "unknown", true, "Workflow host commands have no process-terminal proof.");
	}
	const evidence = readWorkflowChildProcessEvidence(asyncDir, steps);
	if (evidence.state !== "observed") return unresolved(runId, evidence.state, true, evidence.reason);
	const observedAt = Math.max(closedAt, ...evidence.children.map((child) => child.state === "observed" ? child.observedAt : 0));
	return { version: 1, kind: "workflow", runId, state: "observed", dispatchClosed: true, observedAt, children: evidence.children };
}
