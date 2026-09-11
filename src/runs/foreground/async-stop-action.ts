import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { DIRS, type AsyncStatus, type Details, type SubagentState } from "../../shared/types.ts";
import { getActiveAsyncCapacitySnapshot } from "../background/active-async-capacity.ts";
import { updateActiveRunIndex } from "../background/active-run-index.ts";
import { closeSteerInbox, deliverStopRequest } from "../background/control-channel.ts";
import { readProcessTerminal, processTerminalPath } from "../background/process-terminal.ts";
import { resultFilePath, writeAsyncResultFile } from "../background/result-files.ts";
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

function sealPausedRunStopped(state: SubagentState, status: AsyncStatus, asyncDir: string, existingResultPath?: string): boolean {
	const proof = readProcessTerminal(asyncDir, { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId });
	if (proof?.state !== "observed") return false;
	const now = Date.now();
	const stopMessage = "Subagent stopped by user.";
	const stoppedProof = { ...proof, resumeDisposition: "non-resumable" as const };
	const stoppedSteps = (status.steps ?? []).map((step) => {
		if (step.status !== "pending" && step.status !== "running" && step.status !== "paused") return step;
		return {
			...step,
			status: "stopped" as const,
			error: stopMessage,
			exitCode: 1,
			stopped: true,
			activityState: undefined,
			endedAt: step.endedAt ?? now,
			durationMs: step.durationMs ?? (step.startedAt === undefined ? 0 : Math.max(0, now - step.startedAt)),
			lastActivityAt: now,
			...(step.processTerminal ? { processTerminal: { ...step.processTerminal, resumeDisposition: "non-resumable" as const } } : {}),
		};
	});
	const stoppedStatus: AsyncStatus = {
		...status,
		state: "stopped",
		stopped: true,
		error: stopMessage,
		activityState: undefined,
		lastUpdate: now,
		endedAt: status.endedAt ?? now,
		processTerminal: stoppedProof,
		steps: stoppedSteps,
	};
	let existing: Record<string, unknown> = {};
	if (existingResultPath) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(existingResultPath, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const priorResults = Array.isArray(existing.results) ? existing.results : [];
	const results = stoppedSteps.map((step, index) => {
		const prior = priorResults[index];
		const base = prior && typeof prior === "object" && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
		if (step.status === "complete" || step.status === "completed") {
			return { ...base, agent: step.agent, success: true, exitCode: typeof base.exitCode === "number" ? base.exitCode : 0 };
		}
		if (step.status !== "stopped") {
			return { ...base, agent: step.agent, success: false, exitCode: typeof base.exitCode === "number" ? base.exitCode : 1, error: typeof base.error === "string" ? base.error : step.error };
		}
		return { ...base, agent: step.agent, success: false, stopped: true, interrupted: false, exitCode: 1, error: stopMessage, output: typeof base.output === "string" && base.output ? base.output : stopMessage };
	});
	writeAtomicJson(processTerminalPath(asyncDir), stoppedProof);
	writeAsyncResultFile(resultFilePath(DIRS.results, status.runId), {
		...existing,
		id: status.runId,
		runId: status.runId,
		agent: stoppedSteps.length === 1 ? stoppedSteps[0]!.agent : status.mode === "parallel" ? "parallel" : status.mode === "workflow" ? "workflow" : "chain",
		mode: status.mode,
		success: false,
		state: "stopped",
		summary: stopMessage,
		error: stopMessage,
		stopped: true,
		results,
		exitCode: 1,
		timestamp: now,
		durationMs: Math.max(0, now - status.startedAt),
		asyncDir,
		cwd: status.cwd,
		sessionId: status.sessionId,
		completionOwnerId: status.completionOwnerId,
		sessionFile: status.sessionFile,
	});
	writeAtomicJson(path.join(asyncDir, "status.json"), stoppedStatus);
	closeSteerInbox(asyncDir, "stopped");
	updateActiveRunIndex(asyncDir, "stopped", status.toolCallId);
	const tracked = state.asyncJobs.get(status.runId);
	if (tracked) Object.assign(tracked, { status: "stopped", stopped: true, activityState: undefined, updatedAt: now, steps: stoppedSteps.map((step, index) => ({ ...step, index })) });
	if (status.sessionId) {
		state.activeAsyncCapacity = getActiveAsyncCapacitySnapshot(status.sessionId, state.activeAsyncCapacity?.limit || undefined, { liveWorkflowRunIds: new Set(state.workflowControllers?.keys() ?? []) });
	}
	return true;
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
	if (!status || (status.state !== "running" && status.state !== "queued" && status.state !== "paused")) {
		return {
			content: [{ type: "text", text: `No running, queued, or paused async run was found for '${runId ?? "current"}'.` }],
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
		const sealedPaused = status.state === "paused" && childId === undefined
			? sealPausedRunStopped(state, status, target.asyncDir, reconcileAsyncRun(target.asyncDir, { kill }).resultPath)
			: false;
		if (status.state === "paused" && childId === undefined && !sealedPaused) {
			return {
				content: [{ type: "text", text: `Stop request stored for paused async run ${target.asyncId}, but matching process-terminal proof is not observed yet. Retry stop after terminal proof is available.` }],
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
			content: [{ type: "text", text: sealedPaused ? `Stopped paused async run ${target.asyncId}.` : child ? `Stop requested for child ${child.id} in async run ${target.asyncId}.` : `Stop requested for async run ${target.asyncId}.` }],
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
