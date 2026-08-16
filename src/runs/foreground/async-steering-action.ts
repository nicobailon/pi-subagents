import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { AsyncStatus, Details, SubagentState, ToolBudgetConfig, TurnBudgetConfig } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { consumeSteerAcks, deliverInterruptRequest, queueRevivalBrief, requestAsyncSteer, type SteerDeliveryMode, type SteerRequest } from "../background/control-channel.ts";
import { resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { actionResultFromSteeringStatus, claimSteeringRecovery, createSteeringStatus, recordSteeringRequest, remainingSteeringRecoveryLimits, steeringReceipt, updateSteeringTarget, waitForSteeringAction } from "../background/steering.ts";

export function canQueueRetainedAsyncFollowUp(status: AsyncStatus, index?: number): boolean {
	const steps = status.steps ?? [];
	return status.state === "complete"
		&& Boolean(status.parentWorkflowRunId)
		&& steps.length === 1
		&& (steps[0]?.status === "complete" || steps[0]?.status === "completed")
		&& Boolean(steps[0]?.sessionFile ?? status.sessionFile)
		&& (index === undefined || index === 0);
}

export async function steerAsyncRun(input: {
	state: SubagentState;
	runId: string;
	message: string;
	mode?: SteerDeliveryMode;
	index?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	location: { asyncDir: string | null };
	signal?: AbortSignal;
	ackTimeoutMs?: number;
	recoveryTimeoutMs?: number;
	onRequestQueued?: (requestPath: string) => void;
	onBeforeRecoveryClaim?: (requestId: string, committedAt: number) => void;
	onRecoveryCommitted?: (requestId: string, committedAt: number) => void;
	recover?: (limits: { timeoutMs?: number; absoluteDeadlineAt?: number; turnBudget?: TurnBudgetConfig; toolBudget?: ToolBudgetConfig }) => Promise<AgentToolResult<Details>>;
}): Promise<AgentToolResult<Details>> {
	if (!input.location.asyncDir) {
		return {
			content: [{ type: "text", text: `Async run '${input.runId}' has no live run directory to steer.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const asyncDir = input.location.asyncDir;
	const status = reconcileAsyncRun(asyncDir, { kill: input.kill }).status;
	if (input.state.currentSessionId && status?.sessionId !== input.state.currentSessionId) {
		return {
			content: [{ type: "text", text: `Async run '${input.runId}' was not found in the active session.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!status) {
		return {
			content: [{ type: "text", text: `Async run '${input.runId}' was not found.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const steps = status.steps ?? [];
	if (status.state !== "running" && status.state !== "queued") {
		const retained = input.mode === "follow_up" && canQueueRetainedAsyncFollowUp(status, input.index);
		if (!retained) {
			return {
				content: [{ type: "text", text: `Async run '${input.runId}' is not running or queued and cannot be steered.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const request: SteerRequest = { type: "steer", id: randomUUID(), ts: Date.now(), message: input.message.trim(), mode: "follow_up", targetIndex: 0, source: "steer-action" };
		try {
			queueRevivalBrief(asyncDir, request);
		} catch (error) {
			return { content: [{ type: "text", text: `Failed to queue retained follow-up for async run ${status.runId}: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "management", results: [] } };
		}
		status.steering ??= createSteeringStatus();
		recordSteeringRequest(status.steering, { id: request.id, requestedAt: request.ts, source: request.source, message: request.message, targets: [{ index: 0, state: "scheduled" }] });
		writeAtomicJson(path.join(asyncDir, "status.json"), status);
		const queued = { requestId: request.id, state: "scheduled" as const, deliveryStatus: "queued" as const, sourceRunId: status.runId, targets: [{ index: 0, state: "scheduled" as const }] };
		return { content: [{ type: "text", text: steeringReceipt(request.message, `Follow-up queued for the next resume of retained async run ${status.runId} (request ${request.id}).`) }], details: { mode: "management", results: [], steering: queued } };
	}
	if (input.index !== undefined) {
		if (input.index < 0 || input.index >= steps.length) {
			return {
				content: [{ type: "text", text: `Async run '${status.runId}' has ${steps.length} children. Index ${input.index} is out of range.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const targetStep = steps[input.index];
		if (targetStep && targetStep.status !== "running" && targetStep.status !== "pending") {
			return {
				content: [{ type: "text", text: `Async run '${status.runId}' child ${input.index} is ${targetStep.status} and cannot be steered.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	} else {
		const running = steps.filter((step) => step.status === "running");
		if (running.length === 0 && steps.length > 1) {
			return {
				content: [{ type: "text", text: `Async run '${status.runId}' has no running child yet. Provide index to steer a queued child.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	}
	const runningIndexes = steps
		.map((step, index) => step.status === "running" ? index : undefined)
		.filter((index): index is number => index !== undefined);
	const effectiveTargetIndex = input.index ?? (status.mode === "single" && runningIndexes.length === 0 && steps[0]?.status === "pending" ? 0 : undefined);
	const targetIndexes = effectiveTargetIndex !== undefined ? [effectiveTargetIndex] : runningIndexes;
	if (targetIndexes.length === 0) {
		return {
			content: [{ type: "text", text: `Async run '${status.runId}' has no running child to steer.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const requestId = randomUUID();
	let requestPath: string;
	try {
		requestPath = requestAsyncSteer(asyncDir, {
			message: input.message,
			mode: input.mode,
			...(effectiveTargetIndex !== undefined ? { targetIndex: effectiveTargetIndex } : { targetIndexes }),
			source: "steer-action",
			id: requestId,
		});
	} catch (error) {
		return {
			content: [{ type: "text", text: `Failed to queue steering for async run ${status.runId}: ${error instanceof Error ? error.message : String(error)}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	input.onRequestQueued?.(requestPath);
	const tracked = input.state.asyncJobs.get(status.runId);
	if (tracked) tracked.updatedAt = Date.now();
	const targets = targetIndexes.map((index) => ({ index, state: status.steps?.[index]?.status === "pending" ? "scheduled" as const : "pending" as const }));
	if (targets.every((target) => target.state === "scheduled")) {
		const scheduled = { requestId, state: "scheduled" as const, deliveryStatus: "queued" as const, sourceRunId: status.runId, targets };
		return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering scheduled for async run ${status.runId} (request ${requestId}).`) }], details: { mode: "management", results: [], steering: scheduled } };
	}
	const waited = await waitForSteeringAction({ asyncDir, sourceRunId: status.runId, requestId, timeoutMs: input.ackTimeoutMs ?? 3_000, signal: input.signal });
	const result = waited ?? { requestId, state: "pending" as const, deliveryStatus: "queued" as const, sourceRunId: status.runId, targets };
	if (input.signal?.aborted) {
		return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering pending for async run ${status.runId} (request ${requestId}); caller aborted before recovery.`) }], details: { mode: "management", results: [], steering: result } };
	}
	const finalStatus = readStatus(asyncDir);
	const finalResult = finalStatus?.steering ? actionResultFromSteeringStatus(finalStatus.steering, status.runId, requestId) : undefined;
	if (finalResult?.state === "delivered") {
		return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering delivered for async run ${status.runId} (request ${requestId}).`) }], details: { mode: "management", results: [], steering: finalResult } };
	}
	const running = (finalStatus?.steps ?? status.steps ?? []).filter((step) => step.status === "running");
	const recoveryAllowed = (input.mode ?? "steer") === "steer" && status.mode === "single" && status.isNested !== true && running.length === 1 && Boolean(finalStatus?.steering) && (input.index === undefined || input.index === 0);
	if (recoveryAllowed && finalResult?.state !== "scheduled" && input.recover) {
		const appendSteeringNotice = (state: "failed" | "recovered", message: string): void => {
			try {
				fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent.steering.notice", ts: Date.now(), runId: status.runId, requestId, state, message, ...(status.sessionId ? { currentSessionId: status.sessionId } : {}) })}\n`);
			} catch {
				// The action result and status remain authoritative if diagnostic notification persistence fails.
			}
		};
		try {
			const latest = readStatus(asyncDir);
			const latestResult = latest?.steering ? actionResultFromSteeringStatus(latest.steering, status.runId, requestId) : undefined;
			if (latestResult?.state === "delivered") return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering delivered for async run ${status.runId} (request ${requestId}).`) }], details: { mode: "management", results: [], steering: latestResult } };
			const committedAt = Date.now();
			input.onBeforeRecoveryClaim?.(requestId, committedAt);
			const { claimPath, markerPath } = claimSteeringRecovery(asyncDir, { requestId, sourceRunId: status.runId, committedAt });
			input.onRecoveryCommitted?.(requestId, committedAt);
			const preCommitStatus = readStatus(asyncDir);
			const preCommitResult = preCommitStatus?.steering ? actionResultFromSteeringStatus(preCommitStatus.steering, status.runId, requestId) : undefined;
			if (preCommitResult?.state === "delivered" && preCommitResult.targets.every((target) => target.deliveredAt !== undefined && target.deliveredAt <= committedAt)) {
				fs.rmSync(markerPath, { force: true });
				fs.rmSync(claimPath, { force: true });
				return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering delivered for async run ${status.runId} (request ${requestId}).`) }], details: { mode: "management", results: [], steering: preCommitResult } };
			}
			try {
				deliverInterruptRequest({ asyncDir, source: "steering-recovery" });
			} catch (error) {
				fs.rmSync(markerPath, { force: true });
				fs.rmSync(claimPath, { force: true });
				throw new Error(`Failed to commit steering recovery interrupt: ${error instanceof Error ? error.message : String(error)}`);
			}
			const pauseDeadline = Date.now() + (input.recoveryTimeoutMs ?? 15_000);
			let paused: AsyncStatus | null = null;
			while (Date.now() <= pauseDeadline) {
				if (input.signal?.aborted) break;
				const candidate = readStatus(asyncDir);
				if (candidate?.state === "paused" && candidate.endedAt !== undefined) { paused = candidate; break; }
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
			}
			if (!paused) throw new Error("Source run did not reach confirmed paused state within 15 seconds; no replacement was launched and the recovery claim remains committed to prevent a delayed duplicate.");
			let lateAckRecorded = false;
			for (const ack of consumeSteerAcks(asyncDir)) {
				if (!paused.steering?.recent.some((request) => request.id === ack.requestId && request.targets.some((target) => target.index === ack.index))) continue;
				const state = ack.state === "delivered" ? "late" : "failed";
				const reason = ack.state === "delivered" ? "acknowledged after recovery commit" : ack.message;
				updateSteeringTarget(paused.steering, ack.requestId, ack.index, state, ack.ts, { reason });
				const stepSteering = paused.steps?.[ack.index]?.steering;
				if (stepSteering) updateSteeringTarget(stepSteering, ack.requestId, ack.index, state, ack.ts, { reason });
				lateAckRecorded = true;
				try {
					fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: ack.state === "delivered" ? "subagent.steer.delivered" : "subagent.steer.failed", ts: ack.ts, runId: status.runId, requestId: ack.requestId, index: ack.index, late: true, message: ack.message })}\n`);
				} catch {
					// Status remains authoritative when diagnostic event persistence fails.
				}
			}
			if (lateAckRecorded) writeAtomicJson(path.join(asyncDir, "status.json"), paused);
			let recoveryTarget;
			try {
				recoveryTarget = resolveAsyncResumeTarget(
					{ id: status.runId },
					{ kill: input.kill },
					{ sessionId: input.state.currentSessionId ?? undefined },
				);
			} catch (error) {
				throw new Error(`Source run remains paused and cannot be revived safely: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (recoveryTarget.kind !== "revive" || !recoveryTarget.sessionFile) throw new Error("Source run has no valid persisted child session; it remains paused and requires a new run.");
			if (!recoveryTarget.recoveryDescriptor) throw new Error("Source run has no private recovery descriptor; it remains paused and is not safely resumable.");
			const limits = remainingSteeringRecoveryLimits(recoveryTarget.recoveryDescriptor, paused);
			const revived = await input.recover(limits);
			if (revived.isError || !revived.details.asyncId) throw new Error(revived.content[0]?.type === "text" ? revived.content[0].text : "Replacement launch failed; source run remains paused.");
			const targetIndex = input.index ?? paused.steering?.recent.find((request) => request.id === requestId)?.targets[0]?.index ?? status.steps?.findIndex((step) => step.status === "running") ?? -1;
			if (paused.steering && targetIndex >= 0) {
				updateSteeringTarget(paused.steering, requestId, targetIndex, "recovered", Date.now(), { replacementRunId: revived.details.asyncId });
				const stepSteering = paused.steps?.[targetIndex]?.steering;
				if (stepSteering) updateSteeringTarget(stepSteering, requestId, targetIndex, "recovered", Date.now(), { replacementRunId: revived.details.asyncId });
				writeAtomicJson(path.join(asyncDir, "status.json"), paused);
			}
			const recovered = paused.steering ? actionResultFromSteeringStatus(paused.steering, status.runId, requestId, revived.details.asyncId) : undefined;
			appendSteeringNotice("recovered", `Steering recovered for run ${status.runId}; replacement ${revived.details.asyncId} launched.`);
			return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering recovered for async run ${status.runId}; replacement ${revived.details.asyncId} launched after the source paused.`) }], details: { mode: "management", results: [], steering: recovered ?? { requestId, state: "recovered", sourceRunId: status.runId, replacementRunId: revived.details.asyncId, deliveryStatus: "delivered", targets: [{ index: input.index ?? 0, state: "recovered" }] } } };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const failedStatus = readStatus(asyncDir);
			const targetIndex = input.index ?? status.steps?.findIndex((step) => step.status === "running") ?? -1;
			if (failedStatus && failedStatus.state !== "running" && failedStatus.state !== "queued" && failedStatus.steering && targetIndex >= 0) {
				updateSteeringTarget(failedStatus.steering, requestId, targetIndex, "failed", Date.now(), { reason });
				const stepSteering = failedStatus.steps?.[targetIndex]?.steering;
				if (stepSteering) updateSteeringTarget(stepSteering, requestId, targetIndex, "failed", Date.now(), { reason });
				failedStatus.activityState = "needs_attention";
				writeAtomicJson(path.join(asyncDir, "status.json"), failedStatus);
			}
			const failed = failedStatus?.steering ? actionResultFromSteeringStatus(failedStatus.steering, status.runId, requestId) : undefined;
			appendSteeringNotice("failed", `Steering failed for run ${status.runId}: ${reason}`);
			return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering failed for async run ${status.runId} (request ${requestId}): ${reason}`) }], isError: true, details: { mode: "management", results: [], steering: failed ?? { requestId, state: "failed", sourceRunId: status.runId, deliveryStatus: "queued", targets: [{ index: input.index ?? 0, state: "failed", reason }] } } };
		}
	}
	const stateText = result.state === "failed" ? "failed" : result.state === "partial" ? "partial" : result.deliveryStatus === "queued" ? "queued" : result.state === "delivered" ? "delivered" : result.state === "scheduled" ? "scheduled" : result.state === "recovered" ? "recovered" : "pending";
	const isError = result.state === "failed" || result.state === "partial";
	return {
		content: [{ type: "text", text: steeringReceipt(input.message, `Steering ${stateText} for async run ${status.runId} (request ${requestId}).`) }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [], steering: result },
	};
}
