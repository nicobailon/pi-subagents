import * as fs from "node:fs";
import { listAsyncRuns } from "./async-status.ts";
import type { TokenUsage } from "../../shared/types.ts";

const MAX_RETAINED_CHILDREN = 10;
const MAX_TASK_SUMMARY_LENGTH = 120;

export interface RetainedChild {
	runId: string;
	parentRunId?: string;
	agent: string;
	taskSummary: string;
	completedAt: number;
	sessionPath: string;
	tokenTotals?: TokenUsage;
}

function retainedSessionFile(sessionFile: string | undefined): sessionFile is string {
	if (!sessionFile?.endsWith(".jsonl")) return false;
	try {
		const stat = fs.lstatSync(sessionFile);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function boundedTaskSummary(value: string | undefined): string {
	const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
	return normalized.length > MAX_TASK_SUMMARY_LENGTH
		? `${normalized.slice(0, MAX_TASK_SUMMARY_LENGTH - 1)}…`
		: normalized;
}

export function listRetainedChildren(asyncDirRoot: string, sessionId: string): RetainedChild[] {
	return listAsyncRuns(asyncDirRoot, { sessionId, states: ["complete"], reconcile: false })
		.flatMap((run) => {
			if (!run.parentWorkflowRunId || run.steps.length !== 1) return [];
			const step = run.steps[0]!;
			if ((step.status !== "complete" && step.status !== "completed") || !retainedSessionFile(step.sessionFile ?? run.sessionFile)) return [];
			const completedAt = run.endedAt;
			if (completedAt === undefined) return [];
			return [{
				runId: run.id,
				...(run.parentWorkflowRunId ? { parentRunId: run.parentWorkflowRunId } : {}),
				agent: step.agent,
				taskSummary: boundedTaskSummary(step.description),
				completedAt,
				sessionPath: step.sessionFile ?? run.sessionFile!,
				...(step.tokens ?? run.totalTokens ? { tokenTotals: step.tokens ?? run.totalTokens } : {}),
			}];
		})
		.sort((left, right) => right.completedAt - left.completedAt)
		.slice(0, MAX_RETAINED_CHILDREN);
}

export function formatRetainedChildren(children: RetainedChild[]): string {
	if (children.length === 0) return "No completed retained children in the active parent session.";
	return [
		`Completed retained children (newest first, last ${MAX_RETAINED_CHILDREN}):`,
		...children.flatMap((child) => [
			`- ${child.runId} | ${child.agent} | ${new Date(child.completedAt).toISOString()}`,
			`  task: ${child.taskSummary || "(no task summary)"}`,
			`  session: ${child.sessionPath}`,
			...(child.tokenTotals ? [`  tokens: input ${child.tokenTotals.input}, output ${child.tokenTotals.output}, total ${child.tokenTotals.total}`] : []),
		]),
	].join("\n");
}
