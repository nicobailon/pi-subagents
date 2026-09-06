import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, ForegroundRunControl, SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { steeringReceipt, waitForSteeringAction } from "../background/steering.ts";
import { requestAsyncSteer, type SteerDeliveryMode } from "../background/control-channel.ts";
import { currentCompletionOwnerId } from "../../shared/completion-owner.ts";

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

/** Local controllers remain authoritative; recorded foreign ownership permits enqueue, not takeover or proof of liveness. */
export async function steerWorkflowRun(input: {
	state: SubagentState;
	runId: string;
	asyncDir: string;
	message: string;
	mode?: SteerDeliveryMode;
	index?: number;
	signal?: AbortSignal;
	ackTimeoutMs?: number;
}): Promise<AgentToolResult<Details>> {
	const { state, runId, asyncDir } = input;
	const status = readStatus(asyncDir);
	if (!status || status.mode !== "workflow" || status.runId !== runId || path.basename(asyncDir) !== runId) {
		return managementError(`Workflow '${runId}' does not match its resolved run directory.`);
	}
	if (state.workflowControllers?.has(runId)) {
		const route = resolveWorkflowForegroundSteeringTarget({ state, workflowRunId: runId, asyncDirRoot: path.dirname(asyncDir) });
		if (!route.ok) return managementError(route.message);
		return steerWorkflowForegroundTarget({ target: route.target, message: input.message, mode: input.mode, index: input.index });
	}
	if (!state.currentSessionId) return managementError("Workflow steering requires an active parent session.");
	if (status.sessionId !== state.currentSessionId) return managementError(`Workflow '${runId}' was not found in the active session.`);
	if (status.state !== "running" && status.state !== "queued") return managementError(`Workflow '${runId}' is not running or queued and cannot be steered.`);
	if (typeof status.completionOwnerId !== "string" || !status.completionOwnerId.trim()
		|| status.completionOwnerId === (state.completionOwnerId ?? currentCompletionOwnerId())
		|| [...state.foregroundControls.values()].some((control) => control.parentWorkflowRunId === runId)) {
		return managementError(`Workflow '${runId}' has no live foreground child and is not a recorded foreign workflow.`);
	}
	if (input.index !== undefined) {
		const step = status.steps?.[input.index];
		if (!Number.isInteger(input.index) || input.index < 0 || !step) return managementError(`Workflow '${runId}' index ${input.index} is out of range or invalid.`);
		if (step.status !== "running" && step.status !== "pending") return managementError(`Workflow '${runId}' child ${input.index} is ${step.status} and cannot be steered.`);
		if (typeof step.workflowKey !== "string" || !step.workflowKey.trim()) return managementError(`Workflow '${runId}' child ${input.index} has no projected workflow key.`);
	}
	const requestId = randomUUID();
	try {
		requestAsyncSteer(asyncDir, { id: requestId, message: input.message, mode: input.mode, ...(input.index !== undefined ? { targetIndex: input.index } : {}), source: "steer-action" });
	} catch (error) {
		return managementError(`Failed to queue steering for workflow ${runId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	// Only the owner writes the ledger. No acknowledgment leaves an honest, unaddressed queued receipt.
	const steering = await waitForSteeringAction({ asyncDir, sourceRunId: runId, requestId, timeoutMs: input.ackTimeoutMs ?? 3_000, signal: input.signal })
		?? { requestId, state: "pending" as const, deliveryStatus: "queued" as const, sourceRunId: runId, targets: input.index === undefined ? [] : [{ index: input.index, state: "pending" as const }] };
	const failed = steering.state === "failed" || steering.state === "partial";
	return {
		content: [{ type: "text", text: steeringReceipt(input.message, `Steering ${failed ? steering.state : steering.deliveryStatus === "delivered" ? "delivered" : "queued"} for workflow ${runId} (request ${requestId}).`) }],
		...(failed ? { isError: true } : {}),
		details: { mode: "management", results: [], steering },
	};
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
