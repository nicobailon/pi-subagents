import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { DIRS, type AsyncStatus, type Details, type SubagentState } from "../../shared/types.ts";
import { updateActiveRunIndex } from "../background/active-run-index.ts";
import { deliverStopRequest } from "../background/control-channel.ts";
import { readProcessTerminal } from "../background/process-terminal.ts";
import { resultFilePath, resultPayloadPathForSessionRun, writeAsyncResultFile } from "../background/result-files.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { isStoppableAsyncStatusStep, resolveAsyncStatusChild, type ResolvedAsyncStatusChild } from "../shared/child-identity.ts";

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

function sealPausedRun(asyncDir: string, status: AsyncStatus): string | undefined {
	const runnerProcessInstanceId = status.processTerminal?.runnerProcessInstanceId;
	if (!runnerProcessInstanceId) return "runner process identity is missing";
	const proof = readProcessTerminal(asyncDir, { runId: status.runId, runnerProcessInstanceId });
	if (proof?.state !== "observed" || proof.runId !== status.runId || proof.runnerProcessInstanceId !== runnerProcessInstanceId) {
		return `process-terminal proof is ${proof?.state === "unknown" ? `unknown (${proof.reason})` : proof?.state ?? "missing"}`;
	}
	if (!status.sessionId) return "session identity is missing";
	const existingResultPath = resultPayloadPathForSessionRun(DIRS.results, status.sessionId, status.runId);
	if (!existingResultPath) return "paused result is missing";
	let existingResult: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(existingResultPath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("result is not an object");
		existingResult = parsed as Record<string, unknown>;
	} catch (error) {
		return `paused result is unavailable: ${error instanceof Error ? error.message : String(error)}`;
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
	writeAsyncResultFile(resultFilePath(DIRS.results, status.runId), stoppedResult);
	writeAtomicJson(path.join(asyncDir, "status.json"), stoppedStatus);
	updateActiveRunIndex(asyncDir, "stopped", status.toolCallId, { retryCapacityErrors: true, terminalIndexBeforeRelease: true });
}

export function stopAsyncRun(
	state: SubagentState,
	runId: string | undefined,
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
	location?: { asyncDir: string | null; resolvedId?: string },
	childId?: string,
): AgentToolResult<Details> | null {
	const target = getAsyncStopTarget(state, runId, location);
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
		deliverStopRequest({ asyncDir: target.asyncDir, pid: typeof status.pid === "number" ? status.pid : undefined, kill, source: "stop-action", targetIndex: child?.index, childId: child?.id ?? childId });
		if (pausedWholeRun) {
			const failure = sealPausedRun(target.asyncDir, status);
			if (failure) {
				return {
					content: [{ type: "text", text: `Stop request persisted for paused async run ${target.asyncId}, but terminal proof is not ready (${failure}). Retry stop after runner shutdown is observed.` }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
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
