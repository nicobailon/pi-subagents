import * as fs from "node:fs";
import * as path from "node:path";
import { readRecentTerminalRunIndex } from "../runs/background/terminal-run-index.ts";
import type { AsyncStatus } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { recordWorkflowResumeRefusal, workflowResumeClaimState } from "./workflow-resume-claim.ts";
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

/**
 * Claims this session's interrupted top-level workflows for auto-resume. Synchronous and bounded:
 * one listing of the session's terminal index, reads only for runs that ended in the last 24 h,
 * then the cheap filters before any claim. A refusal is recorded in the run, so each run gets one
 * automatic attempt; the launch itself happens later, off session start.
 */
export function planWorkflowAutoResumes(input: { asyncDirRoot: string; currentSessionId: string; now: number; runIds?: readonly string[] }): PreparedWorkflowResume[] {
	const { asyncDirRoot, currentSessionId, now } = input;
	let runIds: readonly string[];
	try {
		runIds = input.runIds ?? readRecentTerminalRunIndex(asyncDirRoot, { sessionId: currentSessionId, limit: AUTO_RESUME_SCAN_LIMIT, endedAfter: now - AUTO_RESUME_MAX_AGE_MS });
	} catch (error) {
		console.error("Failed to read interrupted workflows for auto-resume:", error);
		return [];
	}
	const prepared: PreparedWorkflowResume[] = [];
	for (const runId of runIds) {
		const asyncDir = path.join(asyncDirRoot, runId);
		try {
			const status = readStatus(asyncDir);
			if (!status || status.mode !== "workflow" || status.parentWorkflowRunId !== undefined || status.sessionId !== currentSessionId) continue;
			if (!isReusableWorkflowStopCause(status.workflow?.stopCause)) continue;
			const at = interruptedAt(status);
			if (at === undefined || now - at > AUTO_RESUME_MAX_AGE_MS) continue;
			if (workflowResumeClaimState(asyncDir).kind !== "none" || fs.existsSync(path.join(asyncDir, RESUME_REFUSAL_FILE))) continue;
			const preparation = prepareWorkflowResume({ asyncDirRoot, sourceRunId: runId, trigger: "auto", now, currentSessionId });
			if (preparation.ok) {
				prepared.push(preparation.prepared);
				continue;
			}
			// Another claimant continues it; nothing to record.
			if (preparation.code === "claim-busy" || preparation.code === "claim-resumed") continue;
			recordWorkflowResumeRefusal(asyncDir, { reason: preparation.reason, byHand: preparation.byHand }, now);
		} catch (error) {
			console.error(`Failed to prepare auto-resume of workflow ${runId}:`, error);
		}
	}
	return prepared;
}

/** The one line posted when an auto-resume launch did not start. */
export function autoResumeFailureText(sourceRunId: string, refusal: { reason: string; byHand: string }): string {
	const byHand = refusal.byHand ? ` ${refusal.byHand}` : "";
	return `Auto-resume of workflow ${sourceRunId} failed: ${refusal.reason.replace(/\.$/, "")}.${byHand}`;
}
