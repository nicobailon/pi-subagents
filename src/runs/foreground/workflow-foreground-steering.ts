import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, ForegroundRunControl, SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { steeringReceipt } from "../background/steering.ts";
import {
	consumeSteerAckFromDir,
	readSteerCapability,
	steerAcksDir,
	steerCapabilityPath,
	stepSteerInboxDir,
	writeSteerRequestToExistingDir,
	type SteerDeliveryMode,
	type SteerRequest,
} from "../background/control-channel.ts";

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
		&& Boolean(control.workflowSteeringDir)
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

export async function steerWorkflowForegroundTarget(input: {
	target: WorkflowForegroundSteeringTarget;
	message: string;
	mode?: SteerDeliveryMode;
	index?: number;
	signal?: AbortSignal;
	ackTimeoutMs?: number;
}): Promise<AgentToolResult<Details>> {
	const { control, sourceRunId } = input.target;
	const routeDir = control.workflowSteeringDir;
	if (!routeDir || !fs.existsSync(routeDir)) return managementError(`Foreground run '${control.runId}' has no live workflow steering route.`);
	const activeIndexes = [...(control.activeChildren?.keys() ?? [])].sort((left, right) => left - right);
	const index = input.index ?? (activeIndexes.length === 1 ? activeIndexes[0] : undefined);
	if (index === undefined) {
		return managementError(activeIndexes.length === 0
			? `Foreground run '${control.runId}' has no live child session.`
			: `Foreground run '${control.runId}' has ${activeIndexes.length} live child sessions; provide index.`);
	}
	if (!activeIndexes.includes(index)) return managementError(`Foreground run '${control.runId}' child ${index} is not live.`);
	const capability = readSteerCapability(routeDir, index);
	if (capability?.supported === false) return managementError(`Foreground run '${control.runId}' child ${index} does not support steering.`);

	const request: SteerRequest = {
		type: "steer",
		id: randomUUID(),
		ts: Date.now(),
		message: input.message.trim(),
		...(input.mode && input.mode !== "steer" ? { mode: input.mode } : {}),
		targetIndex: index,
		source: "steer-action",
	};
	try {
		writeSteerRequestToExistingDir(stepSteerInboxDir(routeDir, index), request);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return managementError(`Foreground run '${control.runId}' has no live workflow steering route.`);
		}
		return managementError(`Failed to queue steering for foreground run ${control.runId}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const deadline = Date.now() + (input.ackTimeoutMs ?? 3_000);
	let ack;
	let routeRemoved = false;
	while (Date.now() <= deadline) {
		ack = consumeSteerAckFromDir(steerAcksDir(routeDir, index), request.id);
		if (ack || input.signal?.aborted) break;
		if (!fs.existsSync(routeDir)) {
			routeRemoved = true;
			break;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
	}
	if (routeRemoved || (!ack && !input.signal?.aborted && !fs.existsSync(routeDir))) {
		return managementError(`Foreground run '${control.runId}' has no live child session.`);
	}
	const target = ack?.state === "delivered"
		? { index, state: "delivered" as const, deliveredAt: ack.ts }
		: ack?.state === "queued"
			? { index, state: "queued" as const }
			: ack?.state === "failed"
				? { index, state: "failed" as const, reason: ack.message }
				: { index, state: "pending" as const };
	const steering = {
		requestId: request.id,
		state: ack?.state === "delivered" ? "delivered" as const : ack?.state === "failed" ? "failed" as const : "pending" as const,
		deliveryStatus: ack?.state === "delivered" ? "delivered" as const : "queued" as const,
		sourceRunId,
		targets: [target],
	};
	if (input.signal?.aborted) {
		return { content: [{ type: "text", text: steeringReceipt(request.message, `Steering pending for foreground run ${control.runId} (request ${request.id}); caller aborted before acknowledgment.`) }], details: { mode: "management", results: [], steering } };
	}
	if (ack?.state === "delivered") {
		return { content: [{ type: "text", text: steeringReceipt(request.message, `Steering delivered for foreground run ${control.runId} (request ${request.id}).`) }], details: { mode: "management", results: [], steering } };
	}
	if (ack?.state === "queued") {
		return { content: [{ type: "text", text: steeringReceipt(request.message, `Steering queued for foreground run ${control.runId} (request ${request.id}).`) }], details: { mode: "management", results: [], steering } };
	}
	if (ack?.state === "failed") {
		return { content: [{ type: "text", text: steeringReceipt(request.message, `Steering failed for foreground run ${control.runId} (request ${request.id}): ${ack.message}`) }], isError: true, details: { mode: "management", results: [], steering } };
	}
	return { content: [{ type: "text", text: steeringReceipt(request.message, `Steering pending for foreground run ${control.runId} (request ${request.id}); no acknowledgment was received.`) }], details: { mode: "management", results: [], steering } };
}

export function workflowForegroundSteeringDir(asyncDirRoot: string, workflowRunId: string, childRunId: string): string {
	return path.join(asyncDirRoot, workflowRunId, "control", "workflow-foreground", childRunId);
}

export function removeWorkflowForegroundSteeringRoute(control: ForegroundRunControl): void {
	if (!control.workflowSteeringDir) return;
	try {
		fs.rmSync(control.workflowSteeringDir, { recursive: true, force: true });
	} catch (error) {
		console.warn(`[pi-subagents] Failed to remove workflow foreground steering route '${control.workflowSteeringDir}': ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function workflowForegroundSteeringLaunchOptions(control: ForegroundRunControl | undefined, index: number): Pick<import("../../shared/types.ts").RunSyncOptions, "steerInboxDir" | "steerCapabilityPath" | "steerAckDir"> {
	if (!control?.workflowSteeringDir) return {};
	const steerInboxDir = stepSteerInboxDir(control.workflowSteeringDir, index);
	const steerAckDir = steerAcksDir(control.workflowSteeringDir, index);
	fs.mkdirSync(steerInboxDir, { recursive: true });
	fs.mkdirSync(steerAckDir, { recursive: true });
	return {
		steerInboxDir,
		steerCapabilityPath: steerCapabilityPath(control.workflowSteeringDir, index),
		steerAckDir,
	};
}
