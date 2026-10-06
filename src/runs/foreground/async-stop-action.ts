import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { DIRS, type AsyncStatus, type Details, type SubagentState } from "../../shared/types.ts";
import { updateActiveRunIndex } from "../background/active-run-index.ts";
import { deliverStopRequest, stopInboxClosedPath } from "../background/control-channel.ts";
import { readProcessTerminal } from "../background/process-terminal.ts";
import { resultFilePath, resultPayloadFileForSessionRun, resultPayloadPathForSessionRun, writeAsyncResultFile } from "../background/result-files.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { readStatus } from "../../shared/utils.ts";
import { isStoppableAsyncStatusStep, resolveAsyncStatusChild, stopStoppableAsyncStatusChildren, type ResolvedAsyncStatusChild } from "../shared/child-identity.ts";

function getAsyncStopTarget(
	state: SubagentState,
	runId: string | undefined,
	location?: { asyncDir: string | null; resolvedId?: string },
): { asyncId: string; asyncDir: string } | undefined {
	if (location?.asyncDir) {
		return {
			asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
			asyncDir: location.asyncDir,
		};
	}
	if (!runId) return undefined;
	const direct = state.asyncJobs.get(runId);
	return direct ? { asyncId: direct.asyncId, asyncDir: direct.asyncDir } : undefined;
}

const STOP_MESSAGE = "Subagent stopped by user.";

function sealPausedRun(asyncDir: string, status: AsyncStatus, resultsDir: string): string | undefined {
	const runnerProcessInstanceId = status.processTerminal?.runnerProcessInstanceId;
	if (!runnerProcessInstanceId) return "runner process identity is missing";
	const proof = readProcessTerminal(asyncDir, { runId: status.runId, runnerProcessInstanceId });
	if (proof?.state !== "observed" || proof.runId !== status.runId || proof.runnerProcessInstanceId !== runnerProcessInstanceId) {
		return `process-terminal proof is ${proof?.state === "unknown" ? `unknown (${proof.reason})` : proof?.state ?? "missing"}`;
	}
	if (!status.sessionId) return "session identity is missing";
	// The validated lookup skips unreadable or foreign files; those must be refused below, not replaced.
	const existingResultPath = resultPayloadPathForSessionRun(resultsDir, status.sessionId, status.runId)
		?? resultPayloadFileForSessionRun(resultsDir, status.sessionId, status.runId);
	let existingResult: Record<string, unknown>;
	if (!existingResultPath) {
		// Delivery deletes the paused result, and an interrupted parent may never have received one; seal from status.
		existingResult = {
			id: status.runId,
			mode: status.mode,
			sessionId: status.sessionId,
			asyncDir,
			...(status.completionOwnerId ? { completionOwnerId: status.completionOwnerId } : {}),
			...(status.toolCallId ? { toolCallId: status.toolCallId } : {}),
			results: (status.steps ?? []).map((step) => ({
				agent: step.agent,
				success: step.status === "complete" || step.status === "completed",
				...(step.error ? { error: step.error } : {}),
				...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
			})),
		};
	} else {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(existingResultPath, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("result is not an object");
			existingResult = parsed as Record<string, unknown>;
		} catch (error) {
			return `paused result is unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const resultRunId = typeof existingResult.runId === "string" ? existingResult.runId : existingResult.id;
	if (resultRunId !== status.runId || existingResult.sessionId !== status.sessionId) {
		return "paused result identity does not match the run";
	}

	const now = Date.now();
	const steps = (status.steps ?? []).map((step) => {
		if (step.status !== "pending" && step.status !== "running" && step.status !== "paused") return step;
		const { activityState: _activityState, ...rest } = step;
		return {
			...rest,
			status: "stopped" as const,
			error: STOP_MESSAGE,
			exitCode: 1,
			stopped: true,
			endedAt: now,
			durationMs: step.startedAt ? now - step.startedAt : 0,
			lastActivityAt: now,
		};
	});
	const results = Array.isArray(existingResult.results)
		? existingResult.results.map((entry, index) => {
			const stepState = status.steps?.[index]?.status;
			if ((stepState !== "pending" && stepState !== "running" && stepState !== "paused") || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
			const { interrupted: _interrupted, ...result } = entry as Record<string, unknown>;
			return { ...result, output: STOP_MESSAGE, error: STOP_MESSAGE, success: false, exitCode: 1, stopped: true };
		})
		: existingResult.results;
	const stoppedResult = {
		...existingResult,
		success: false,
		state: "stopped",
		summary: STOP_MESSAGE,
		error: STOP_MESSAGE,
		stopped: true,
		exitCode: 1,
		timestamp: now,
		...(Array.isArray(existingResult.results) ? { results } : {}),
	};
	const stoppedStatus: AsyncStatus = {
		...status,
		state: "stopped",
		stopped: true,
		error: STOP_MESSAGE,
		endedAt: now,
		lastUpdate: now,
		steps,
	};
	delete stoppedStatus.activityState;
	writeAsyncResultFile(resultFilePath(resultsDir, status.runId), stoppedResult);
	writeAtomicJson(path.join(asyncDir, "status.json"), stoppedStatus);
	updateActiveRunIndex(asyncDir, "stopped", status.toolCallId, { retryCapacityErrors: true, terminalIndexBeforeRelease: true });
}

/** After ownership/state checks, deliver stop and seal paused whole runs only with native terminal proof. */
export function deliverAsyncRunStop(
	input: Parameters<typeof deliverStopRequest>[0] & { status: AsyncStatus; resultsDir?: string },
): string | undefined {
	const { status, resultsDir = DIRS.results, ...delivery } = input;
	const pausedWholeRun = status.state === "paused" && delivery.childId === undefined && delivery.targetIndex === undefined;
	// A paused run whose runner closed its inbox can only be sealed from exact exit proof below.
	if (!(pausedWholeRun && fs.existsSync(stopInboxClosedPath(delivery.asyncDir)))) deliverStopRequest(delivery);
	if (pausedWholeRun) return sealPausedRun(delivery.asyncDir, status, resultsDir);
}

export function stopAsyncRun(
	state: SubagentState,
	runId: string | undefined,
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
	location?: { asyncDir: string | null; resolvedId?: string },
	childId?: string,
): AgentToolResult<Details> | null {
	const target = getAsyncStopTarget(state, runId, location);
	// An async workflow runs in this process: it has no runner to read a stop request, so stop it through its controller.
	const workflowRunId = target?.asyncId ?? runId;
	const workflowController = childId === undefined && workflowRunId ? state.workflowControllers?.get(workflowRunId) : undefined;
	const workflowAsyncDir = workflowController && workflowRunId ? target?.asyncDir ?? state.asyncJobs.get(workflowRunId)?.asyncDir : undefined;
	const workflowStatus = workflowAsyncDir ? readStatus(workflowAsyncDir) : undefined;
	// Controllers outlive a session switch; a workflow owned by another session falls through to the ownership check below.
	const foreignWorkflow = Boolean(state.currentSessionId && workflowStatus && workflowStatus.sessionId !== state.currentSessionId);
	if (workflowController && workflowRunId && !foreignWorkflow) {
		if (workflowStatus) stopStoppableAsyncStatusChildren(workflowStatus, state.workflowChildStops?.get(workflowRunId), "Workflow stopped.");
		workflowController.abort(new Error("Workflow stopped."));
		return { content: [{ type: "text", text: `Stop requested for async workflow ${workflowRunId}.` }], details: { mode: "management", results: [] } };
	}
	if (!target) return null;
	const status = reconcileAsyncRun(target.asyncDir, { kill }).status;
	if (state.currentSessionId && status?.sessionId !== state.currentSessionId) {
		return {
			content: [{ type: "text", text: `Async run '${target.asyncId}' was not found in the active session.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const pausedWholeRun = status?.state === "paused" && childId === undefined;
	if (!status || (status.state !== "running" && status.state !== "queued" && !pausedWholeRun)) {
		return {
			content: [{ type: "text", text: `No running or queued async run was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	let child: ResolvedAsyncStatusChild | undefined;
	if (childId !== undefined) {
		const resolution = resolveAsyncStatusChild(status, childId);
		if (!resolution.ok) {
			return {
				content: [{ type: "text", text: resolution.message }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		child = resolution.child;
		if (!isStoppableAsyncStatusStep(child.step)) {
			return {
				content: [{ type: "text", text: `Child '${childId}' in async run '${status.runId}' is ${child.step.status}; stop only supports pending or running children.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	}
	try {
		const failure = deliverAsyncRunStop({ asyncDir: target.asyncDir, status, pid: typeof status.pid === "number" ? status.pid : undefined, kill, source: "stop-action", targetIndex: child?.index, childId: child?.id ?? childId });
		if (failure) {
			return {
				content: [{ type: "text", text: `Stop request persisted for paused async run ${target.asyncId}, but terminal proof is not ready (${failure}). Retry stop after runner shutdown is observed.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: pausedWholeRun ? `Stopped paused async run ${target.asyncId}.` : child ? `Stop requested for child ${child.id} in async run ${target.asyncId}.` : `Stop requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to stop async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}
