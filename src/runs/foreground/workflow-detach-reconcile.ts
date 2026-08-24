import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { getSingleResultOutput, readStatus } from "../../shared/utils.ts";
import {
	DIRS,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	type AsyncStatus,
	type IntercomEventBus,
	type SingleResult,
	type SubagentState,
} from "../../shared/types.ts";
import { updateActiveRunIndex } from "../background/active-run-index.ts";
import { resultFilePath, writeAsyncResultFile } from "../background/result-files.ts";
import { resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { externalCliReceiptMetadata, normalizeExternalCliRunnerStatus } from "../shared/external-cli-contract.ts";
import { readWorkflowReceipt, workflowReceiptPath, writeWorkflowReceipt, type WorkflowReceipt } from "../../workflows/workflow-receipt.ts";

function cloneWorkflowStatus(status: AsyncStatus): AsyncStatus {
	return {
		...status,
		steps: status.steps?.map((step) => ({ ...step })),
		workflow: status.workflow ? { ...status.workflow, trace: [...(status.workflow.trace ?? [])] } : status.workflow,
	};
}

function childSucceeded(result: Pick<SingleResult, "exitCode" | "error" | "interrupted">): boolean {
	return result.exitCode === 0 && !result.error && !result.interrupted;
}

const UNSUPPORTED_DETACHED_WORKFLOW_CONTINUATION = "unsupported-continuation: detached workflow child settled, but JavaScript workflow continuation was not persisted. Resume the workflow explicitly instead of treating the completed child as top-level workflow completion.";
const INTERRUPTED_DETACHED_CHILD = "Interrupted. Waiting for explicit next action.";

export function applyDetachedChildToPausedWorkflow(
	status: AsyncStatus,
	input: { childRunId: string; result: Pick<SingleResult, "exitCode" | "error" | "interrupted" | "sessionFile">; workflowKey?: string },
): AsyncStatus | undefined {
	if (status.mode !== "workflow" || status.state !== "paused") return undefined;
	const next = cloneWorkflowStatus(status);
	const step = next.steps?.find((candidate) => candidate.runId === input.childRunId)
		?? (input.workflowKey ? next.steps?.find((candidate) => candidate.workflowKey === input.workflowKey) : undefined);
	if (!step) return undefined;
	const succeeded = childSucceeded(input.result);
	const failedSiblingError = next.steps?.find((candidate) => candidate !== step && candidate.status === "failed" && candidate.error)?.error;
	const updatedAt = Date.now();
	step.status = succeeded ? "completed" : "failed";
	step.endedAt = updatedAt;
	delete step.activityState;
	delete step.currentTool;
	delete step.currentToolStartedAt;
	if (input.result.sessionFile) step.sessionFile = input.result.sessionFile;
	if (succeeded) delete step.error;
	else if (input.result.interrupted) step.error = input.result.error ?? INTERRUPTED_DETACHED_CHILD;
	else if (input.result.error) step.error = input.result.error;
	next.lastUpdate = updatedAt;
	const promoted = promotePausedWorkflowIfSettled(next);
	if (promoted?.state === "failed" && input.result.interrupted && !failedSiblingError) promoted.error = input.result.error ?? INTERRUPTED_DETACHED_CHILD;
	else if (promoted?.state === "failed" && input.result.error) promoted.error = input.result.error;
	return promoted ?? next;
}

export function promotePausedWorkflowIfSettled(status: AsyncStatus): AsyncStatus | undefined {
	if (status.mode !== "workflow" || status.state !== "paused") return undefined;
	const next = cloneWorkflowStatus(status);
	const stillOpen = next.steps?.some((candidate) =>
		candidate.status === "running"
		|| (candidate.status === "paused" && candidate.activityState === "needs_attention")
	) === true;
	if (stillOpen || !next.steps?.length) return undefined;
	const failed = next.steps.some((candidate) => candidate.status === "failed");
	const updatedAt = Date.now();
	next.lastUpdate = updatedAt;
	next.state = "failed";
	next.endedAt = updatedAt;
	delete next.activityState;
	if (failed) return next;
	next.error = UNSUPPORTED_DETACHED_WORKFLOW_CONTINUATION;
	return next;
}

function workflowResultChildren(status: AsyncStatus, childRunId: string, result: SingleResult, existingResults: unknown): unknown {
	const output = getSingleResultOutput(result);
	if (Array.isArray(existingResults)) {
		return existingResults.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
			const child = entry as Record<string, unknown>;
			if (child.runId !== childRunId) return child;
			return {
				...child,
				success: childSucceeded(result),
				output,
				outputState: output.trim() ? "present" : "absent",
				detached: undefined,
				...(result.interrupted ? { interrupted: true } : {}),
				...(result.error ? { error: result.error } : {}),
			};
		});
	}
	return status.steps?.map((step) => ({
		workflowKey: step.workflowKey,
		agent: step.agent,
		runId: step.runId,
		success: step.status === "completed" || step.status === "complete",
		output: step.runId === childRunId ? output : "",
		outputState: step.runId === childRunId && output.trim() ? "present" : "absent",
		...(step.runId === childRunId && result.interrupted ? { interrupted: true } : {}),
		...(step.error ? { error: step.error } : {}),
	}));
}

function publishedWorkflowResult(status: AsyncStatus, childRunId: string, result: SingleResult, asyncDir: string, existing?: Record<string, unknown>, receipt?: WorkflowReceipt): Record<string, unknown> {
	const sessionId = status.sessionId ?? (typeof existing?.sessionId === "string" ? existing.sessionId : undefined);
	const summary = status.state === "complete"
		? `Workflow completed after detached child ${childRunId} finished.`
		: status.error ?? (typeof existing?.summary === "string" ? existing.summary : undefined);
	return {
		...(existing ?? {}),
		id: status.runId,
		runId: status.runId,
		toolCallId: status.toolCallId,
		agent: "workflow",
		mode: "workflow",
		success: status.state === "complete",
		state: status.state,
		summary,
		error: status.error,
		activityState: status.activityState,
		endedAt: status.endedAt,
		timestamp: Date.now(),
		results: workflowResultChildren(status, childRunId, result, existing?.results),
		workflow: status.workflow,
		reconciledFromDetachedChild: childRunId,
		...(receipt ? { workflowReceipt: { path: path.join(asyncDir, "workflow-receipt.json"), receipt } } : {}),
		asyncDir,
		cwd: status.cwd,
		sessionId,
		completionOwnerId: status.completionOwnerId,
	};
}

function reconcileWorkflowReceipt(status: AsyncStatus, childRunId: string, result: SingleResult, asyncDir: string): WorkflowReceipt | undefined {
	const receiptPath = workflowReceiptPath(DIRS.async, status.runId);
	if (!fs.existsSync(receiptPath)) return undefined;
	const receipt = readWorkflowReceipt(DIRS.async, status.runId);
	const step = status.steps?.find((candidate) => candidate.runId === childRunId);
	const key = step?.workflowKey;
	if (!key) throw new Error(`Workflow receipt '${status.runId}' cannot identify detached child '${childRunId}' by stable key.`);
	const entry = receipt.entries[key];
	if (!entry) throw new Error(`Workflow receipt '${status.runId}' has no detached child key '${key}'.`);
	let resumability: typeof entry.resumability;
	try {
		const target = resolveAsyncResumeTarget({ id: childRunId, dir: path.join(DIRS.async, childRunId) }, {}, { requireSessionFile: true, sessionId: status.sessionId });
		resumability = target.kind === "revive" ? { state: "resumable" } : { state: "not-resumable", reason: "child is still running" };
	} catch (error) {
		resumability = { state: "not-resumable", reason: error instanceof Error ? error.message : String(error) };
	}
	const outputReference = result.savedOutputPath ?? result.outputReference?.path ?? entry.outputReference;
	const childStatus = readStatus(path.join(DIRS.async, childRunId));
	const externalStep = childStatus?.steps?.length === 1 && childStatus.steps[0]?.runner?.type === "external-cli" ? childStatus.steps[0] : undefined;
	const externalRunner = normalizeExternalCliRunnerStatus(result.runner?.type === "external-cli" ? result.runner : externalStep?.runner);
	const externalProcess = result.externalProcess ?? externalStep?.externalProcess;
	const externalAdapter = externalRunner ? externalCliReceiptMetadata({ runner: externalRunner, externalProcess, outputReference }) : entry.externalAdapter;
	if (externalAdapter) resumability = { state: "not-resumable", reason: externalAdapter.nonResumableReason };
	const updatedEntry: WorkflowReceipt["entries"][string] = resumability.state === "resumable"
		? {
			...entry,
			...(step.agent ? { agent: step.agent } : {}),
			...(step.context ? { resolvedContext: step.context } : {}),
			latestRunId: entry.latestRunId ?? childRunId,
			resumability,
			...(outputReference ? { outputReference } : {}),
			...(externalAdapter ? { externalAdapter } : {}),
		}
		: {
			...entry,
			...(step.agent ? { agent: step.agent } : {}),
			...(step.context ? { resolvedContext: step.context } : {}),
			resumability,
			...(outputReference ? { outputReference } : {}),
			...(externalAdapter ? { externalAdapter } : {}),
		};
	const next: WorkflowReceipt = {
		...receipt,
		state: status.state === "complete" ? "complete" : status.state === "stopped" ? "stopped" : status.state === "paused" ? "paused" : "failed",
		entries: {
			...receipt.entries,
			[key]: updatedEntry,
		},
	};
	writeWorkflowReceipt(asyncDir, next);
	return next;
}

function appendDetachedWorkflowEvent(asyncDir: string, event: Record<string, unknown>): void {
	const eventsPath = path.join(asyncDir, "events.jsonl");
	try {
		fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
	} catch (error) {
		console.error(`Failed to append detached workflow event '${eventsPath}':`, error);
	}
}

export function reconcileDetachedWorkflowChildCompletion(input: {
	state: SubagentState;
	workflowRunId: string;
	childRunId: string;
	result: SingleResult;
	events?: IntercomEventBus;
	workflowKey?: string;
}): boolean {
	const job = input.state.asyncJobs.get(input.workflowRunId);
	const asyncDir = job?.asyncDir ?? path.join(DIRS.async, input.workflowRunId);
	const status = readStatus(asyncDir);
	if (!status) return false;
	const next = applyDetachedChildToPausedWorkflow(status, {
		childRunId: input.childRunId,
		result: input.result,
		workflowKey: input.workflowKey,
	});
	if (!next) return false;
	writeAtomicJson(path.join(asyncDir, "status.json"), next);
	updateActiveRunIndex(asyncDir, next.state, next.toolCallId);
	if (job) {
		job.status = next.state;
		job.updatedAt = next.lastUpdate;
		job.activityState = next.activityState;
		job.steps = next.steps?.map((step, index) => ({ ...step, index }));
		job.workflow = next.workflow;
	}
	const resultPath = resultFilePath(DIRS.results, input.workflowRunId);
	let existing: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let receipt: WorkflowReceipt | undefined;
	let receiptError: string | undefined;
	try {
		receipt = reconcileWorkflowReceipt(next, input.childRunId, input.result, asyncDir);
	} catch (error) {
		receiptError = `Failed to reconcile async workflow receipt: ${error instanceof Error ? error.message : String(error)}`;
	}
	const published = publishedWorkflowResult(next, input.childRunId, input.result, asyncDir, existing, receipt);
	writeAsyncResultFile(resultPath, published);
	if (receiptError) {
		appendDetachedWorkflowEvent(asyncDir, {
			ts: Date.now(),
			runId: input.workflowRunId,
			type: "subagent.workflow.receipt_write_failed",
			error: receiptError,
			reconciledFromDetachedChild: input.childRunId,
		});
	}
	if (next.state === "complete" || next.state === "failed") {
		appendDetachedWorkflowEvent(asyncDir, {
			ts: Date.now(),
			runId: input.workflowRunId,
			type: "subagent.workflow.completed",
			state: next.state,
			...(next.error ? { error: next.error } : {}),
			reconciledFromDetachedChild: input.childRunId,
		});
		input.events?.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: input.workflowRunId,
			runId: input.workflowRunId,
			source: "async",
			mode: "workflow",
			agent: "workflow",
			success: next.state === "complete",
			state: next.state,
			summary: typeof published.summary === "string" ? published.summary : (next.state === "complete" ? "Workflow completed." : next.error),
			reconciledFromDetachedChild: input.childRunId,
			...(Array.isArray(published.results) ? { results: published.results } : {}),
			sessionId: next.sessionId,
			completionOwnerId: next.completionOwnerId,
			timestamp: Date.now(),
			triggerTurn: true,
		});
	}
	return true;
}
