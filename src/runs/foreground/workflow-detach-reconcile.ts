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
	type WorkflowRecoveryAction,
	type WorkflowTerminalOutcome,
	type WorkflowTerminalResolution,
} from "../../shared/types.ts";
import { updateActiveRunIndex } from "../background/active-run-index.ts";
import { resultFilePath, writeAsyncResultFile } from "../background/result-files.ts";
import { resolveAsyncResumeTarget } from "../background/async-resume.ts";
import { externalCliReceiptMetadata, normalizeExternalCliRunnerStatus } from "../shared/external-cli-contract.ts";
import { outputPathMappingFromTask } from "../shared/single-output.ts";
import { readWorkflowReceipt, workflowReceiptPath, writeWorkflowReceipt, type WorkflowReceipt } from "../../workflows/workflow-receipt.ts";
import { workflowChildSummary } from "../../workflows/workflow-child-summary.ts";

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
type WorkflowStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	outputPathMapping?: { requestedPath: string; savedPath: string };
	interrupted?: boolean;
};

function findWorkflowStep(status: AsyncStatus, childRunId: string, workflowKey?: string): WorkflowStatusStep | undefined {
	return status.steps?.find((candidate) => candidate.runId === childRunId)
		?? (workflowKey ? status.steps?.find((candidate) => candidate.workflowKey === workflowKey) : undefined) as WorkflowStatusStep | undefined;
}

export function applyDetachedChildToPausedWorkflow(
	status: AsyncStatus,
	input: { childRunId: string; result: Pick<SingleResult, "exitCode" | "error" | "interrupted" | "sessionFile" | "stopped">; workflowKey?: string },
): AsyncStatus | undefined {
	if (status.mode !== "workflow" || status.state !== "paused") return undefined;
	const next = cloneWorkflowStatus(status);
	const step = findWorkflowStep(next, input.childRunId, input.workflowKey);
	if (!step) return undefined;
	const succeeded = childSucceeded(input.result);
	const failedSiblingError = next.steps?.find((candidate) => {
		const candidateStep = candidate as WorkflowStatusStep;
		return candidateStep !== step && candidateStep.status === "failed" && !candidateStep.interrupted && candidateStep.error;
	})?.error;
	const interruptedChildError = next.steps?.find((candidate) => {
		const candidateStep = candidate as WorkflowStatusStep;
		return candidateStep.status === "failed" && candidateStep.interrupted && candidateStep.error;
	})?.error;
	const updatedAt = Date.now();
	step.status = succeeded ? "completed" : "failed";
	step.endedAt = updatedAt;
	delete step.activityState;
	delete step.currentTool;
	delete step.currentToolStartedAt;
	if (input.result.sessionFile) step.sessionFile = input.result.sessionFile;
	if (succeeded) {
		delete step.error;
		delete step.interrupted;
	} else if (input.result.interrupted || input.result.stopped) {
		step.error = input.result.error ?? INTERRUPTED_DETACHED_CHILD;
		step.interrupted = true;
		if (input.result.stopped) step.stopped = true;
	} else {
		delete step.interrupted;
		delete step.stopped;
		if (input.result.error) step.error = input.result.error;
	}
	next.lastUpdate = updatedAt;
	const promoted = promotePausedWorkflowIfSettled(next);
	if (promoted?.state === "failed" && failedSiblingError) promoted.error = failedSiblingError;
	else if (promoted?.state === "failed" && (input.result.interrupted || input.result.stopped)) promoted.error = input.result.error ?? INTERRUPTED_DETACHED_CHILD;
	else if (promoted?.state === "failed" && input.result.error) promoted.error = input.result.error;
	else if (promoted?.state === "failed" && interruptedChildError) promoted.error = interruptedChildError;
	const resolved = promoted ?? next;
	const workflowState = resolved.state === "complete" ? "completed" : resolved.state === "paused" ? "paused" : resolved.state === "stopped" ? "stopped" : "failed";
	resolved.workflowChildren = workflowChildSummary({ parentToolCallId: resolved.toolCallId ?? resolved.runId, workflowRunId: resolved.runId, workflowState, inventoryComplete: true, trace: resolved.workflow?.trace, steps: resolved.steps });
	return resolved;
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

function workflowResolution(status: AsyncStatus, result: Pick<SingleResult, "interrupted">): WorkflowTerminalResolution | undefined {
	if (status.state !== "complete" && status.state !== "failed") return undefined;
	if (status.steps?.some((step) => {
		const candidate = step as WorkflowStatusStep;
		return candidate.status === "failed" && !candidate.interrupted;
	})) return "failed-child";
	if (result.interrupted || status.steps?.some((step) => {
		const candidate = step as WorkflowStatusStep;
		return candidate.status === "stopped" || candidate.stopped || candidate.interrupted || candidate.error === INTERRUPTED_DETACHED_CHILD;
	})) return "interrupted-child";
	return "settled-awaiting-resume";
}

function workflowRecovery(receipt: WorkflowReceipt | undefined): WorkflowRecoveryAction[] {
	if (!receipt) return [];
	return Object.values(receipt.entries).flatMap((entry) => entry.resumability.state === "resumable"
		? [{ key: entry.key, call: "runs.run" as const, resume: { workflowRunId: receipt.workflowRunId, key: entry.key, latest: true as const }, taskRequired: true as const }]
		: []);
}

function resultTerminalOutcome(result: Pick<SingleResult, "timedOut" | "turnBudgetExceeded" | "toolBudgetBlocked">): WorkflowTerminalOutcome | undefined {
	if (result.timedOut) return { state: "partial", reason: "timeout" };
	if (result.turnBudgetExceeded || result.toolBudgetBlocked) return { state: "partial", reason: "budget_exhausted" };
	return undefined;
}

function workflowResultChildren(status: AsyncStatus, childRunId: string, result: SingleResult, existingResults: unknown, receipt?: WorkflowReceipt): unknown {
	const output = getSingleResultOutput(result);
	const outputReference = result.savedOutputPath ?? result.outputReference?.path;
	const outputPathMapping = outputPathMappingFromTask(result.task, outputReference);
	const terminalOutcome = resultTerminalOutcome(result);
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
				...(outputReference ? { outputReference } : {}),
				...(outputPathMapping ? { outputPathMapping } : {}),
				...(result.interrupted || result.stopped ? { interrupted: true } : {}),
				...(result.stopped ? { stopped: true } : {}),
				...(terminalOutcome ? { terminalOutcome } : {}),
				...(result.error ? { error: result.error } : {}),
			};
		});
	}
	return status.steps?.map((step: WorkflowStatusStep) => ({
		workflowKey: step.workflowKey,
		agent: step.agent,
		runId: step.runId,
		success: step.status === "completed" || step.status === "complete",
		output: step.runId === childRunId ? output : "",
		outputState: step.runId === childRunId && output.trim() ? "present" : "absent",
		...(step.runId === childRunId && outputReference ? { outputReference } : step.workflowKey && receipt?.entries[step.workflowKey]?.outputReference ? { outputReference: receipt.entries[step.workflowKey]!.outputReference } : {}),
		...(step.runId === childRunId && outputPathMapping ? { outputPathMapping } : step.outputPathMapping ? { outputPathMapping: step.outputPathMapping } : {}),
		...(step.interrupted ? { interrupted: true } : {}),
		...(step.runId === childRunId && terminalOutcome ? { terminalOutcome } : step.workflowKey && receipt?.entries[step.workflowKey]?.terminalOutcome ? { terminalOutcome: receipt.entries[step.workflowKey]!.terminalOutcome } : {}),
		...(step.stopped ? { stopped: true } : {}),
		...(step.error ? { error: step.error } : {}),
	}));
}

function workflowResultOutputPathMappingSummary(results: unknown): string {
	if (!Array.isArray(results)) return "";
	const mappings = results.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const child = entry as Record<string, unknown>;
		const mapping = child.outputPathMapping;
		if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return [];
		const { requestedPath, savedPath } = mapping as Record<string, unknown>;
		if (typeof requestedPath !== "string" || typeof savedPath !== "string") return [];
		const key = typeof child.workflowKey === "string" ? child.workflowKey : "child";
		return [`'${key}': requested ${requestedPath} -> saved ${savedPath}`];
	});
	return mappings.length > 0 ? ` Output path mappings: ${mappings.join("; ")}.` : "";
}

function publishedWorkflowResult(status: AsyncStatus, childRunId: string, result: SingleResult, asyncDir: string, existing?: Record<string, unknown>, receipt?: WorkflowReceipt): Record<string, unknown> {
	const sessionId = status.sessionId ?? (typeof existing?.sessionId === "string" ? existing.sessionId : undefined);
	const resolution = workflowResolution(status, result);
	const recovery = workflowRecovery(receipt);
	const results = workflowResultChildren(status, childRunId, result, existing?.results, receipt);
	const summary = `${resolution === "settled-awaiting-resume"
		? `Workflow lanes settled after detached child ${childRunId} finished. JavaScript workflow continuation was not persisted.${recovery.length ? " Use the listed keyed recovery action to continue a child." : " No retained child is resumable."}`
		: status.state === "complete"
		? `Workflow completed after detached child ${childRunId} finished.`
		: status.error ?? (typeof existing?.summary === "string" ? existing.summary : "Workflow failed.")}${workflowResultOutputPathMappingSummary(results)}`;
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
		results,
		workflow: status.workflow,
		workflowChildren: status.workflowChildren,
		...(receipt?.terminalOutcome ? { terminalOutcome: receipt.terminalOutcome } : {}),
		...(resolution ? { workflowResolution: resolution, recovery } : {}),
		reconciledFromDetachedChild: childRunId,
		...(receipt ? { workflowReceipt: { path: path.join(asyncDir, "workflow-receipt.json"), receipt } } : {}),
		asyncDir,
		cwd: status.cwd,
		sessionId,
		completionOwnerId: status.completionOwnerId,
	};
}

function reconcileWorkflowReceipt(status: AsyncStatus, childRunId: string, result: SingleResult, asyncDir: string, resolution: WorkflowTerminalResolution | undefined): WorkflowReceipt | undefined {
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
	const childTerminalOutcome = resultTerminalOutcome(result) ?? entry.terminalOutcome;
	if (externalAdapter) resumability = { state: "not-resumable", reason: externalAdapter.nonResumableReason };
	const updatedEntry: WorkflowReceipt["entries"][string] = resumability.state === "resumable"
		? {
			...entry,
			...(step.agent ? { agent: step.agent } : {}),
			...(step.context ? { resolvedContext: step.context } : {}),
			latestRunId: entry.latestRunId ?? childRunId,
			resumability,
			...(outputReference ? { outputReference } : {}),
			...(childTerminalOutcome ? { terminalOutcome: childTerminalOutcome } : {}),
			...(externalAdapter ? { externalAdapter } : {}),
		}
		: {
			...entry,
			...(step.agent ? { agent: step.agent } : {}),
			...(step.context ? { resolvedContext: step.context } : {}),
			resumability,
			...(outputReference ? { outputReference } : {}),
			...(childTerminalOutcome ? { terminalOutcome: childTerminalOutcome } : {}),
			...(externalAdapter ? { externalAdapter } : {}),
		};
	const next: WorkflowReceipt = {
		...receipt,
		state: status.state === "complete" ? "complete" : status.state === "stopped" ? "stopped" : status.state === "paused" ? "paused" : "failed",
		entries: {
			...receipt.entries,
			[key]: updatedEntry,
		},
		workflowChildren: status.workflowChildren,
		...(receipt.terminalOutcome ? { terminalOutcome: receipt.terminalOutcome } : {}),
		...(resolution ? { workflowResolution: resolution } : {}),
	};
	if (resolution) next.recovery = workflowRecovery(next);
	else {
		delete next.workflowResolution;
		delete next.recovery;
	}
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
	const outputReference = input.result.savedOutputPath ?? input.result.outputReference?.path;
	const outputPathMapping = outputPathMappingFromTask(input.result.task, outputReference);
	const settledStep = findWorkflowStep(next, input.childRunId, input.workflowKey);
	if (settledStep && outputPathMapping) settledStep.outputPathMapping = outputPathMapping;
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
	const resolution = workflowResolution(next, input.result);
	try {
		receipt = reconcileWorkflowReceipt(next, input.childRunId, input.result, asyncDir, resolution);
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
		if (!resolution) throw new Error(`Terminal detached workflow '${input.workflowRunId}' has no resolution classification.`);
		appendDetachedWorkflowEvent(asyncDir, {
			ts: Date.now(),
			runId: input.workflowRunId,
			type: "subagent.workflow.completed",
			state: next.state,
			workflowResolution: resolution,
			...(receipt?.terminalOutcome ? { terminalOutcome: receipt.terminalOutcome } : {}),
			recovery: workflowRecovery(receipt),
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
			workflowResolution: resolution,
			...(receipt?.terminalOutcome ? { terminalOutcome: receipt.terminalOutcome } : {}),
			recovery: workflowRecovery(receipt),
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
