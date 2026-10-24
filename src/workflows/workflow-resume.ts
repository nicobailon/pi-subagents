import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { normalizePublicSubagentExecution } from "../extension/public-execution.ts";
import { reconcileAsyncRun } from "../runs/background/stale-run-reconciler.ts";
import { ownsRun } from "../runs/shared/run-ownership.ts";
import type { AsyncStatus } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { readWorkflowLaunchRecord } from "./workflow-launch-record.ts";
import { claimWorkflowResume, refusalSentence, relaunchByHandText, resumeByHandText } from "./workflow-resume-claim.ts";
import { isRunName, workflowScriptDigest } from "./workflow-reuse.ts";
import { isReusableWorkflowStopCause, WORKFLOW_STOP_CAUSE_OWNER_EXITED } from "./workflow-stop-cause.ts";

/** A run may be resumed again after at most this many resumes that followed Pi exits (auto-resume only). */
const MAX_WORKFLOW_RESUME_ATTEMPTS = 3;

type WorkflowResumeTrigger = "auto" | "manual";

export type WorkflowResumeRefusalCode =
	| "not-owned" | "not-interrupted" | "claim-busy" | "claim-resumed"
	| "launch-missing" | "launch-invalid" | "structured" | "digest" | "authority"
	| "capacity" | "attempts" | "launch-failed";

export interface WorkflowResumeRefusalReason {
	code: WorkflowResumeRefusalCode;
	reason: string;
	/** How to continue the run by hand; empty when there is nothing to add. */
	byHand: string;
}

export interface PreparedWorkflowResume {
	sourceRunId: string;
	sourceAsyncDir: string;
	newRunId: string;
	trigger: WorkflowResumeTrigger;
	/** Public launch params for executePublic: the saved launch with async, reuseFrom and the source's ceiling. */
	params: Record<string, unknown>;
	expectedScriptDigest: string;
	resumeOrigin: { sourceRunId: string; attempt: number };
}

type WorkflowResumePreparation = { ok: true; prepared: PreparedWorkflowResume } | ({ ok: false } & WorkflowResumeRefusalReason);

export function workflowResumeRefusal(code: WorkflowResumeRefusalCode, reason: string, runId: string): WorkflowResumeRefusalReason {
	const byHand = code === "launch-missing" || code === "launch-invalid" || code === "structured" || code === "digest" || code === "authority"
		? relaunchByHandText(runId)
		: code === "capacity" || code === "attempts" || code === "launch-failed" ? resumeByHandText(runId) : "";
	return { code, reason, byHand };
}

/** The tool error for a resume by id; the resume form is not repeated to a caller that just tried it. */
export function manualWorkflowResumeRefusalText(runId: string, refusal: Pick<WorkflowResumeRefusalReason, "reason" | "byHand">): string {
	return `Cannot resume workflow '${runId}': ${refusalSentence(refusal.reason, refusal.byHand === relaunchByHandText(runId) ? refusal.byHand : "")}`;
}

/**
 * The run id a resume action relaunches: no message, task, chain or index, and an id naming a
 * top-level workflow run. Anything else is a child resume.
 */
export function workflowResumeTargetId(asyncDirRoot: string, params: { id?: unknown; runId?: unknown; message?: unknown; task?: unknown; chain?: unknown; index?: unknown }): string | undefined {
	if (params.message !== undefined || params.task !== undefined || params.index !== undefined) return undefined;
	if (Array.isArray(params.chain) && params.chain.length > 0) return undefined;
	const id = params.id ?? params.runId;
	if (!isRunName(id)) return undefined;
	let status: AsyncStatus | null;
	try {
		status = readStatus(path.join(asyncDirRoot, id));
	} catch {
		return undefined;
	}
	return status?.mode === "workflow" && status.parentWorkflowRunId === undefined ? id : undefined;
}

/**
 * Checks a stopped workflow run can be resumed and claims it for a new run id. Synchronous and
 * cheap: the launch itself happens in the executor.
 * `newRunId` presets the new run's id: a reload claims a run again under the id of the launch it cancelled.
 */
export function prepareWorkflowResume(input: { asyncDirRoot: string; sourceRunId: string; trigger: WorkflowResumeTrigger; now: number; currentSessionId: string; newRunId?: string }): WorkflowResumePreparation {
	const { asyncDirRoot, sourceRunId, trigger } = input;
	const refuse = (code: WorkflowResumeRefusalCode, reason: string): WorkflowResumePreparation => ({ ok: false, ...workflowResumeRefusal(code, reason, sourceRunId) });
	const sourceAsyncDir = path.join(asyncDirRoot, sourceRunId);
	// Only the session that owns the run (itself or one it replaced) may resume it, and nothing is
	// written into another session's run, so this comes before the reconcile.
	const stored = readStatus(sourceAsyncDir);
	if (stored && !ownsRun(input.currentSessionId, stored.sessionId)) return refuse("not-owned", "it was started in another session; reopen that session to resume it");
	// Session start has already reconciled this session's runs; a resume by id may come later.
	if (trigger === "manual") reconcileAsyncRun(sourceAsyncDir);
	const status = readStatus(sourceAsyncDir);
	if (!status || status.mode !== "workflow" || !isReusableWorkflowStopCause(status.workflow?.stopCause)) return refuse("not-interrupted", "not interrupted; pass message to revive one of its children");
	// The attempt the resumed run records: only resumes that follow a Pi exit count.
	const attempt = (status.workflow?.resumeOrigin?.attempt ?? 0) + (status.workflow?.stopCause === WORKFLOW_STOP_CAUSE_OWNER_EXITED ? 1 : 0);
	if (trigger === "auto" && attempt > MAX_WORKFLOW_RESUME_ATTEMPTS) return refuse("attempts", `${MAX_WORKFLOW_RESUME_ATTEMPTS} resumes already followed Pi exits`);
	const read = readWorkflowLaunchRecord(sourceAsyncDir);
	if (!read.ok) return read.missing ? refuse("launch-missing", "launch.json is missing (the run started before launches were saved)") : refuse("launch-invalid", `launch.json is invalid: ${read.error}`);
	const record = read.record;
	if (record.source === "structured") return refuse("structured", "launched from tasks/chain; resume it by hand");
	if (record.source === "script" && (typeof record.params.workflowScript !== "string" || workflowScriptDigest(record.params.workflowScript) !== record.scriptDigest)) {
		return refuse("launch-invalid", "launch.json is invalid: its script does not match its scriptDigest");
	}
	const normalized = normalizePublicSubagentExecution(record.params);
	if (!normalized.ok) return refuse("launch-invalid", `launch.json is invalid: ${normalized.error}`);
	const newRunId = input.newRunId ?? randomUUID();
	const claim = claimWorkflowResume(sourceAsyncDir, { newRunId, trigger, now: input.now });
	if (claim.kind === "resumed") return refuse("claim-resumed", `resumed as ${claim.newRunId}; wait on it or stop it`);
	if (claim.kind === "busy") return refuse("claim-busy", `being resumed by pid ${claim.pid}`);
	if (claim.kind === "unreadable") return refuse("claim-busy", "its resume claim cannot be read; wait or remove it");
	return {
		ok: true,
		prepared: {
			sourceRunId,
			sourceAsyncDir,
			newRunId,
			trigger,
			params: {
				...record.params,
				async: true,
				reuseFrom: sourceRunId,
				...(status.admissionCapabilityCeiling ? { capabilityCeiling: status.admissionCapabilityCeiling } : {}),
			},
			expectedScriptDigest: record.scriptDigest,
			resumeOrigin: { sourceRunId, attempt },
		},
	};
}
