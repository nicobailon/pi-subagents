import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import type {
	AsyncStatus,
	ResolvedToolBudget,
	ResolvedTurnBudget,
	SteerActionResult,
	SteeringRecoveryDescriptor,
	SteeringRequestStatus,
	SteeringStatus,
	SteeringTargetState,
	SteeringTargetStatus,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";

export const MAX_STEERING_REQUESTS = 20;
export const STEERING_MESSAGE_PREVIEW_LIMIT = 160;

export function createSteeringStatus(): SteeringStatus {
	return { requested: 0, scheduled: 0, pending: 0, delivered: 0, failed: 0, recovered: 0, recent: [] };
}

export function steeringStatus(status: Pick<AsyncStatus, "steering">): SteeringStatus {
	return status.steering ?? createSteeringStatus();
}

export function recordSteeringRequest(
	status: SteeringStatus,
	input: { id: string; requestedAt: number; source?: string; message: string; targets: Array<{ index: number; state: SteeringTargetState; reason?: string }> },
): SteeringRequestStatus {
	const existing = status.recent.find((request) => request.id === input.id);
	if (existing) return existing;
	const request: SteeringRequestStatus = {
		id: input.id,
		requestedAt: input.requestedAt,
		...(input.source ? { source: input.source } : {}),
		messagePreview: input.message.slice(0, STEERING_MESSAGE_PREVIEW_LIMIT),
		targets: input.targets.map((target) => ({ index: target.index, state: target.state, ...(target.reason ? { reason: target.reason } : {}) })),
	};
	status.requested++;
	status.lastRequestedAt = input.requestedAt;
	status.recent = [...status.recent, request].slice(-MAX_STEERING_REQUESTS);
	for (const target of request.targets) incrementStateCount(status, target.state);
	return request;
}

function incrementStateCount(status: SteeringStatus, state: SteeringTargetState): void {
	if (state === "scheduled") status.scheduled++;
	else if (state === "routed") status.pending++;
	else if (state === "delivered" || state === "late") status.delivered++;
	else if (state === "failed") status.failed++;
	else if (state === "recovered") status.recovered++;
}

export function updateSteeringTarget(
	status: SteeringStatus,
	requestId: string,
	index: number,
	state: SteeringTargetState,
	now: number,
	fields: Pick<SteeringTargetStatus, "reason" | "replacementRunId"> = {},
): SteeringTargetStatus | undefined {
	const request = status.recent.find((candidate) => candidate.id === requestId);
	const target = request?.targets.find((candidate) => candidate.index === index);
	if (!target) return undefined;
	if (state === "late" && target.state === "recovered") {
		if (target.lateDeliveredAt === undefined) {
			target.lateDeliveredAt = now;
			status.delivered++;
			status.lastDeliveredAt = now;
		}
		if (fields.reason) target.reason = fields.reason;
		return target;
	}
	if (target.state === state) {
		if (state === "routed" && target.routedAt === undefined) target.routedAt = now;
		if (state === "delivered" && target.deliveredAt === undefined) target.deliveredAt = now;
		if (state === "late" && target.lateDeliveredAt === undefined) target.lateDeliveredAt = now;
		if (fields.reason) target.reason = fields.reason;
		if (fields.replacementRunId) target.replacementRunId = fields.replacementRunId;
		return target;
	}
	if (target.state === "routed" && state !== "routed") status.pending = Math.max(0, status.pending - 1);
	target.state = state;
	if (state === "routed") target.routedAt = now;
	if (state === "delivered") {
		target.deliveredAt = now;
		status.lastDeliveredAt = now;
	}
	if (state === "late") {
		target.lateDeliveredAt = now;
		status.lastDeliveredAt = now;
	}
	if (state === "failed") target.failedAt = now;
	if (state === "recovered") target.recoveredAt = now;
	if (fields.reason) target.reason = fields.reason;
	if (fields.replacementRunId) target.replacementRunId = fields.replacementRunId;
	incrementStateCount(status, state);
	return target;
}

export function findSteeringRequest(status: SteeringStatus, requestId: string): SteeringRequestStatus | undefined {
	return status.recent.find((request) => request.id === requestId);
}

export function actionResultFromSteeringStatus(status: SteeringStatus, sourceRunId: string, requestId: string, replacementRunId?: string): SteerActionResult | undefined {
	const request = findSteeringRequest(status, requestId);
	if (!request) return undefined;
	const targets = request.targets.map((target) => ({
		index: target.index,
		state: target.state,
		...(target.deliveredAt !== undefined ? { deliveredAt: target.deliveredAt } : {}),
		...(target.lateDeliveredAt !== undefined ? { lateDeliveredAt: target.lateDeliveredAt } : {}),
		...(target.reason ? { reason: target.reason } : {}),
		...(target.replacementRunId ? { replacementRunId: target.replacementRunId } : {}),
	}));
	const states = targets.map((target) => target.state);
	let state: SteerActionResult["state"] = "pending";
	if (states.length > 0 && states.every((candidate) => candidate === "delivered")) state = "delivered";
	else if (states.length > 0 && states.every((candidate) => candidate === "scheduled")) state = "scheduled";
	else if (states.length > 0 && states.every((candidate) => candidate === "recovered")) state = "recovered";
	else if (states.length > 0 && states.every((candidate) => candidate === "failed" || candidate === "late")) state = "failed";
	else if (states.some((candidate) => candidate === "failed" || candidate === "late") && states.some((candidate) => candidate !== "failed" && candidate !== "late")) state = "partial";
	const effectiveReplacementRunId = replacementRunId ?? request.targets.find((target) => target.replacementRunId)?.replacementRunId;
	return { requestId, state, sourceRunId, ...(effectiveReplacementRunId ? { replacementRunId: effectiveReplacementRunId } : {}), targets };
}

export function steeringActionIsTerminal(result: SteerActionResult | undefined): boolean {
	return result?.state === "delivered" || result?.state === "scheduled" || result?.state === "partial" || result?.state === "recovered" || result?.state === "failed";
}

export function terminalSteeringNoticeState(status: SteeringStatus, requestId: string): "failed" | "partial" | undefined {
	const request = status.recent.find((candidate) => candidate.id === requestId);
	if (!request || request.targets.some((target) => target.state === "routed" || target.state === "scheduled")) return undefined;
	const hasSuccess = request.targets.some((target) => target.state === "delivered" || target.state === "recovered");
	const hasFailure = request.targets.some((target) => target.state === "failed" || target.state === "late");
	if (hasSuccess && hasFailure) return "partial";
	return hasFailure ? "failed" : undefined;
}

export function claimSteeringRecovery(
	asyncDir: string,
	input: { requestId: string; sourceRunId: string; committedAt: number },
): { claimPath: string; markerPath: string } {
	const recoveryDir = path.join(asyncDir, "control", "steer-recovery");
	fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
	const claimPath = path.join(recoveryDir, "claim.json");
	let fd: number;
	try {
		fd = fs.openSync(claimPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("Another steering recovery is already committed for this source run.");
		}
		throw error;
	}
	let writeError: unknown;
	try {
		fs.writeFileSync(fd, JSON.stringify({ version: 1, ...input }, null, 2), "utf-8");
		fs.fsyncSync(fd);
	} catch (error) {
		writeError = error;
	} finally {
		fs.closeSync(fd);
	}
	if (writeError !== undefined) {
		fs.rmSync(claimPath, { force: true });
		throw writeError;
	}
	const markerPath = path.join(recoveryDir, `${Buffer.from(input.requestId).toString("base64url")}.json`);
	try {
		writePrivateAtomicJson(markerPath, { version: 1, ...input });
	} catch (error) {
		fs.rmSync(claimPath, { force: true });
		throw error;
	}
	return { claimPath, markerPath };
}

export function readSteeringStatus(asyncDir: string): SteeringStatus | undefined {
	return readStatus(asyncDir)?.steering;
}

export function remainingSteeringRecoveryLimits(
	descriptor: Pick<SteeringRecoveryDescriptor, "absoluteDeadlineAt" | "initialTurnBudget" | "initialToolBudget">,
	status: Pick<AsyncStatus, "turnBudget" | "turnCount" | "toolBudget" | "toolCount">,
	now = Date.now(),
): { timeoutMs?: number; absoluteDeadlineAt?: number; turnBudget?: ResolvedTurnBudget; toolBudget?: ResolvedToolBudget } {
	const limits: { timeoutMs?: number; absoluteDeadlineAt?: number; turnBudget?: ResolvedTurnBudget; toolBudget?: ResolvedToolBudget } = {};
	if (descriptor.absoluteDeadlineAt !== undefined) {
		const timeoutMs = descriptor.absoluteDeadlineAt - now;
		if (timeoutMs <= 0) throw new Error("Source run has no remaining deadline budget; it remains paused.");
		limits.timeoutMs = timeoutMs;
		limits.absoluteDeadlineAt = descriptor.absoluteDeadlineAt;
	}
	if (descriptor.initialTurnBudget) {
		const consumed = status.turnBudget?.turnCount ?? status.turnCount ?? 0;
		const totalRemaining = descriptor.initialTurnBudget.maxTurns + descriptor.initialTurnBudget.graceTurns - consumed;
		if (totalRemaining <= 0) throw new Error("Source run has no remaining turn budget; it remains paused.");
		const softRemaining = Math.max(0, descriptor.initialTurnBudget.maxTurns - consumed);
		limits.turnBudget = softRemaining > 0
			? { maxTurns: softRemaining, graceTurns: totalRemaining - softRemaining }
			: { maxTurns: 1, graceTurns: totalRemaining - 1 };
	}
	if (descriptor.initialToolBudget) {
		const consumed = status.toolBudget?.toolCount ?? status.toolCount ?? 0;
		const hard = descriptor.initialToolBudget.hard - consumed;
		if (hard <= 0) throw new Error("Source run has no remaining tool budget; it remains paused.");
		const soft = descriptor.initialToolBudget.soft === undefined ? undefined : descriptor.initialToolBudget.soft - consumed;
		limits.toolBudget = {
			hard,
			...(soft !== undefined && soft > 0 && soft < hard ? { soft } : {}),
			block: descriptor.initialToolBudget.block,
		};
	}
	return limits;
}

export async function waitForSteeringAction(input: {
	asyncDir: string;
	sourceRunId: string;
	requestId: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<SteerActionResult | undefined> {
	const deadline = Date.now() + input.timeoutMs;
	while (Date.now() <= deadline) {
		if (input.signal?.aborted) return undefined;
		const status = readSteeringStatus(input.asyncDir);
		const result = status ? actionResultFromSteeringStatus(status, input.sourceRunId, input.requestId) : undefined;
		if (steeringActionIsTerminal(result)) return result;
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
	}
	const status = readSteeringStatus(input.asyncDir);
	return status ? actionResultFromSteeringStatus(status, input.sourceRunId, input.requestId) : undefined;
}
