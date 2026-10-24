import * as fs from "node:fs";
import * as path from "node:path";
import { readRecentTerminalRunIndex } from "../runs/background/terminal-run-index.ts";
import type { AsyncStatus } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { recordWorkflowResumeRefusal, releaseWorkflowResumeClaim, workflowResumeClaimState } from "./workflow-resume-claim.ts";
import { prepareWorkflowResume, type PreparedWorkflowResume } from "./workflow-resume.ts";
import { isReusableWorkflowStopCause, WORKFLOW_STOP_CAUSE_OWNER_EXITED } from "./workflow-stop-cause.ts";

/** Custom message posted when an auto-resume launch did not start. */
export const WORKFLOW_AUTO_RESUME_MESSAGE_TYPE = "subagent-auto-resume";

/** Interrupted workflows older than this are left for a resume by hand. */
export const AUTO_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AUTO_RESUME_SCAN_LIMIT = 50;
const RESUME_REFUSAL_FILE = "resume-refused.json";

/** When the run was interrupted: the dead owner's last update, or the runtime replacement. */
function interruptedAt(status: AsyncStatus): number | undefined {
	return status.workflow?.stopCause === WORKFLOW_STOP_CAUSE_OWNER_EXITED ? status.workflow.ownerExitedAt : status.endedAt;
}

/** One planned auto-resume: its claim is held from session start until the launch starts or is cancelled. */
export interface PendingWorkflowAutoResume {
	readonly sessionId: string;
	/** The extension runtime that planned it. */
	readonly owner: object;
	readonly prepared: PreparedWorkflowResume;
	state: "pending" | "started" | "cancelled";
}

// Shared by every runtime in the process: a reload's new runtime must see the old runtime's pending claims.
const registryKey = Symbol.for("pi-subagents.workflow-auto-resume.v1");
const registryGlobal = globalThis as typeof globalThis & { [registryKey]?: Set<PendingWorkflowAutoResume> };
const pendingAutoResumes = registryGlobal[registryKey] ?? (registryGlobal[registryKey] = new Set<PendingWorkflowAutoResume>());
// The new run id of each launch cancelled before it started, by session and source run. The next scan
// of that session claims the run again under the same id, so a notice that already said
// `Auto-resumed as <id>.` stays true.
const cancelledKey = Symbol.for("pi-subagents.workflow-auto-resume-cancelled.v1");
const cancelledGlobal = globalThis as typeof globalThis & { [cancelledKey]?: Map<string, Map<string, string>> };
const cancelledRunIds = cancelledGlobal[cancelledKey] ?? (cancelledGlobal[cancelledKey] = new Map<string, Map<string, string>>());

/** Cancels matching launches that have not started and gives their claims back, synchronously. */
export function cancelPendingWorkflowAutoResumes(match: (entry: PendingWorkflowAutoResume) => boolean): void {
	for (const entry of pendingAutoResumes) {
		if (entry.state !== "pending" || !match(entry)) continue;
		entry.state = "cancelled";
		pendingAutoResumes.delete(entry);
		const sessionRunIds = cancelledRunIds.get(entry.sessionId) ?? new Map<string, string>();
		sessionRunIds.set(entry.prepared.sourceRunId, entry.prepared.newRunId);
		cancelledRunIds.set(entry.sessionId, sessionRunIds);
		try {
			releaseWorkflowResumeClaim(entry.prepared.sourceAsyncDir, entry.prepared.newRunId);
		} catch (error) {
			console.error(`Failed to give back the auto-resume claim of workflow ${entry.prepared.sourceRunId}:`, error);
		}
	}
}

/** Marks a pending launch started; false when it was cancelled meanwhile and must not launch. */
export function startPendingWorkflowAutoResume(entry: PendingWorkflowAutoResume): boolean {
	if (entry.state !== "pending") return false;
	entry.state = "started";
	return true;
}

export function finishWorkflowAutoResume(entry: PendingWorkflowAutoResume): void {
	pendingAutoResumes.delete(entry);
}

/**
 * Claims this session's interrupted top-level workflows for auto-resume. Synchronous and bounded:
 * one listing of the session's terminal index, reads only for runs that ended in the last 24 h,
 * then the cheap filters before any claim. A refusal is recorded in the run, so each run gets one
 * automatic attempt; the launch itself happens later, off session start. Launches of this session
 * that another runtime (or an earlier session start) planned but did not start are cancelled first,
 * so their claims do not hide the runs from this scan.
 */
export function planWorkflowAutoResumes(input: { asyncDirRoot: string; currentSessionId: string; now: number; owner: object }): PendingWorkflowAutoResume[] {
	const { asyncDirRoot, currentSessionId, now } = input;
	cancelPendingWorkflowAutoResumes((entry) => entry.sessionId === currentSessionId);
	// A launch cancelled before it started keeps its run id here, so the run is claimed again under it.
	const reusableRunIds = cancelledRunIds.get(currentSessionId);
	cancelledRunIds.delete(currentSessionId);
	let runIds: readonly string[];
	try {
		runIds = readRecentTerminalRunIndex(asyncDirRoot, { sessionId: currentSessionId, limit: AUTO_RESUME_SCAN_LIMIT, endedAfter: now - AUTO_RESUME_MAX_AGE_MS });
	} catch (error) {
		console.error("Failed to read interrupted workflows for auto-resume:", error);
		return [];
	}
	const planned: PendingWorkflowAutoResume[] = [];
	for (const runId of runIds) {
		const asyncDir = path.join(asyncDirRoot, runId);
		try {
			const status = readStatus(asyncDir);
			if (!status || status.mode !== "workflow" || status.parentWorkflowRunId !== undefined || status.sessionId !== currentSessionId) continue;
			if (!isReusableWorkflowStopCause(status.workflow?.stopCause)) continue;
			const at = interruptedAt(status);
			if (at === undefined || now - at > AUTO_RESUME_MAX_AGE_MS) continue;
			if (workflowResumeClaimState(asyncDir).kind !== "none" || fs.existsSync(path.join(asyncDir, RESUME_REFUSAL_FILE))) continue;
			const reusedRunId = reusableRunIds?.get(runId);
			const preparation = prepareWorkflowResume({ asyncDirRoot, sourceRunId: runId, trigger: "auto", now, currentSessionId, ...(reusedRunId ? { newRunId: reusedRunId } : {}) });
			if (preparation.ok) {
				const entry: PendingWorkflowAutoResume = { sessionId: currentSessionId, owner: input.owner, prepared: preparation.prepared, state: "pending" };
				pendingAutoResumes.add(entry);
				planned.push(entry);
				continue;
			}
			// Another claimant continues it; nothing to record.
			if (preparation.code === "claim-busy" || preparation.code === "claim-resumed") continue;
			recordWorkflowResumeRefusal(asyncDir, { reason: preparation.reason, byHand: preparation.byHand }, now);
		} catch (error) {
			console.error(`Failed to prepare auto-resume of workflow ${runId}:`, error);
		}
	}
	return planned;
}

/** The one line posted when an auto-resume launch did not start. */
export function autoResumeFailureText(sourceRunId: string, refusal: { reason: string; byHand: string }): string {
	const byHand = refusal.byHand ? ` ${refusal.byHand}` : "";
	return `Auto-resume of workflow ${sourceRunId} failed: ${refusal.reason.replace(/\.$/, "")}.${byHand}`;
}
