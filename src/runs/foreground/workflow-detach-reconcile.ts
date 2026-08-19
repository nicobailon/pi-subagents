import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { isStorageCapacityError } from "../../shared/file-system-retry.ts";
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

function cloneWorkflowStatus(status: AsyncStatus): AsyncStatus {
	return {
		...status,
		steps: status.steps?.map((step) => ({ ...step })),
		workflow: status.workflow ? { ...status.workflow, trace: [...(status.workflow.trace ?? [])] } : status.workflow,
	};
}

function childSucceeded(result: Pick<SingleResult, "exitCode" | "error">): boolean {
	return result.exitCode === 0 && !result.error;
}

export function applyDetachedChildToPausedWorkflow(
	status: AsyncStatus,
	input: { childRunId: string; result: Pick<SingleResult, "exitCode" | "error" | "sessionFile">; workflowKey?: string },
): AsyncStatus | undefined {
	if (status.mode !== "workflow" || status.state !== "paused") return undefined;
	const next = cloneWorkflowStatus(status);
	const step = next.steps?.find((candidate) => candidate.runId === input.childRunId)
		?? (input.workflowKey ? next.steps?.find((candidate) => candidate.workflowKey === input.workflowKey) : undefined);
	if (!step) return undefined;
	const succeeded = childSucceeded(input.result);
	const updatedAt = Date.now();
	step.status = succeeded ? "completed" : "failed";
	step.endedAt = updatedAt;
	delete step.activityState;
	delete step.currentTool;
	delete step.currentToolStartedAt;
	if (input.result.sessionFile) step.sessionFile = input.result.sessionFile;
	if (succeeded) delete step.error;
	else if (input.result.error) step.error = input.result.error;
	next.lastUpdate = updatedAt;
	const promoted = promotePausedWorkflowIfSettled(next);
	if (promoted?.state === "failed" && input.result.error) promoted.error = input.result.error;
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
	const failed = next.steps.some((candidate) => candidate.status === "failed") === true;
	const updatedAt = Date.now();
	next.lastUpdate = updatedAt;
	next.state = failed ? "failed" : "complete";
	next.endedAt = updatedAt;
	delete next.activityState;
	if (!failed) delete next.error;
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
		...(step.error ? { error: step.error } : {}),
	}));
}

function publishedWorkflowResult(status: AsyncStatus, childRunId: string, result: SingleResult, asyncDir: string, existing?: Record<string, unknown>): Record<string, unknown> {
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
		asyncDir,
		cwd: status.cwd,
		sessionId,
		completionOwnerId: status.completionOwnerId,
	};
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
	const published = publishedWorkflowResult(next, input.childRunId, input.result, asyncDir, existing);
	writeAsyncResultFile(resultPath, published);
	if (next.state === "complete" || next.state === "failed") {
		try {
			fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({
				ts: Date.now(),
				runId: input.workflowRunId,
				type: "subagent.workflow.completed",
				state: next.state,
				...(next.error ? { error: next.error } : {}),
				reconciledFromDetachedChild: input.childRunId,
			})}\n`, "utf-8");
		} catch (error) {
			if (!isStorageCapacityError(error)) throw error;
		}
		input.events?.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: input.workflowRunId,
			runId: input.workflowRunId,
			source: "async",
			mode: "workflow",
			agent: "workflow",
			success: next.state === "complete",
			state: next.state,
			summary: typeof published.summary === "string" ? published.summary : (next.state === "complete" ? "Workflow completed." : next.error),
			sessionId: next.sessionId,
			completionOwnerId: next.completionOwnerId,
			timestamp: Date.now(),
			triggerTurn: true,
		});
	}
	return true;
}
