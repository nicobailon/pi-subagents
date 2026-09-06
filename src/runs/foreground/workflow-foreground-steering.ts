import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, ForegroundRunControl, SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { steeringReceipt } from "../background/steering.ts";
import type { SteerDeliveryMode } from "../background/control-channel.ts";

export interface WorkflowForegroundSteeringTarget {
	control: ForegroundRunControl;
	workflowRunId: string;
	sourceRunId: string;
}

export type WorkflowForegroundSteeringResolution =
	| { ok: true; target: WorkflowForegroundSteeringTarget }
	| { ok: false; message: string };

function activeWorkflowError(state: SubagentState, workflowRunId: string, asyncDirRoot: string): string | undefined {
	if (!state.currentSessionId) return "Workflow steering requires an active parent session.";
	if (!state.workflowControllers?.has(workflowRunId)) return `Workflow '${workflowRunId}' has no live foreground child.`;
	const status = readStatus(path.join(asyncDirRoot, workflowRunId));
	if (!status || status.mode !== "workflow" || (status.state !== "running" && status.state !== "queued")) {
		return `Workflow '${workflowRunId}' has no live foreground child.`;
	}
	if (status.sessionId !== state.currentSessionId) return `Workflow '${workflowRunId}' was not found in the active session.`;
	return undefined;
}

function controlIsLiveInWorkflow(control: ForegroundRunControl, workflowRunId: string, sessionId: string): boolean {
	return control.parentWorkflowRunId === workflowRunId
		&& control.sessionId === sessionId
		&& (control.activeChildren?.size ?? 0) > 0;
}

export function resolveWorkflowForegroundSteeringTarget(input: {
	state: SubagentState;
	childRunId?: string;
	workflowRunId?: string;
	asyncDirRoot: string;
}): WorkflowForegroundSteeringResolution {
	const { state, childRunId, asyncDirRoot } = input;
	if (childRunId) {
		const control = state.foregroundControls.get(childRunId);
		if (!control?.parentWorkflowRunId) return { ok: false, message: `Foreground run '${childRunId}' is not a live workflow-owned child.` };
		const workflowRunId = control.parentWorkflowRunId;
		const workflowError = activeWorkflowError(state, workflowRunId, asyncDirRoot);
		if (workflowError) return { ok: false, message: workflowError };
		if (!controlIsLiveInWorkflow(control, workflowRunId, state.currentSessionId!)) {
			return { ok: false, message: `Foreground run '${childRunId}' is not a live workflow-owned child in the active session.` };
		}
		return { ok: true, target: { control, workflowRunId, sourceRunId: childRunId } };
	}

	const workflowRunId = input.workflowRunId;
	if (!workflowRunId) return { ok: false, message: "Workflow steering requires a workflow or child run id." };
	const workflowError = activeWorkflowError(state, workflowRunId, asyncDirRoot);
	if (workflowError) return { ok: false, message: workflowError };
	const controls = [...state.foregroundControls.values()].filter((control) => controlIsLiveInWorkflow(control, workflowRunId, state.currentSessionId!));
	if (controls.length === 0) return { ok: false, message: `Workflow '${workflowRunId}' has no live foreground child.` };
	if (controls.length > 1) return { ok: false, message: `Workflow '${workflowRunId}' has ${controls.length} live foreground children; steer a child run id instead.` };
	return { ok: true, target: { control: controls[0]!, workflowRunId, sourceRunId: workflowRunId } };
}

function managementError(message: string): AgentToolResult<Details> {
	return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
}

/**
 * Steer a live workflow-owned foreground child through its in-process session.
 * `steer` (and `auto`) interrupt the child at its next safe point; `follow_up`
 * queues the message until the current run settles.
 */
export async function steerWorkflowForegroundTarget(input: {
	target: WorkflowForegroundSteeringTarget;
	message: string;
	mode?: SteerDeliveryMode;
	index?: number;
}): Promise<AgentToolResult<Details>> {
	const { control, sourceRunId } = input.target;
	const activeIndexes = [...(control.activeChildren?.keys() ?? [])].sort((left, right) => left - right);
	const index = input.index ?? (activeIndexes.length === 1 ? activeIndexes[0] : undefined);
	if (index === undefined) {
		return managementError(activeIndexes.length === 0
			? `Foreground run '${control.runId}' has no live child session.`
			: `Foreground run '${control.runId}' has ${activeIndexes.length} live child sessions; provide index.`);
	}
	const child = control.activeChildren?.get(index);
	if (!child) return managementError(`Foreground run '${control.runId}' child ${index} is not live.`);
	if (!child.steer) return managementError(`Foreground run '${control.runId}' child ${index} does not support steering.`);

	const message = input.message.trim();
	const requestId = randomUUID();

	const outcome = await child.steer({ message, ...(input.mode && input.mode !== "steer" ? { mode: input.mode } : {}) });
	const target = outcome.state === "delivered"
		? { index, state: "delivered" as const, deliveredAt: Date.now() }
		: outcome.state === "queued"
			? { index, state: "queued" as const }
			: { index, state: "failed" as const, reason: outcome.reason };
	const steering = {
		requestId,
		state: outcome.state === "delivered" ? "delivered" as const : outcome.state === "failed" ? "failed" as const : "pending" as const,
		deliveryStatus: outcome.state === "delivered" ? "delivered" as const : "queued" as const,
		sourceRunId,
		targets: [target],
	};
	if (outcome.state === "delivered") {
		return { content: [{ type: "text", text: steeringReceipt(message, `Steering delivered for foreground run ${control.runId} (request ${requestId}).`) }], details: { mode: "management", results: [], steering } };
	}
	if (outcome.state === "queued") {
		return { content: [{ type: "text", text: steeringReceipt(message, `Steering queued for foreground run ${control.runId} (request ${requestId}).`) }], details: { mode: "management", results: [], steering } };
	}
	return { content: [{ type: "text", text: steeringReceipt(message, `Steering failed for foreground run ${control.runId} (request ${requestId}): ${outcome.reason ?? "unknown error"}`) }], isError: true, details: { mode: "management", results: [], steering } };
}
