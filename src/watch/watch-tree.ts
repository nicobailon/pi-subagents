import * as path from "node:path";
import { attachRootChildrenToSteps, hasLiveNestedDescendants, projectNestedRegistryForRoot } from "../runs/shared/nested-events.ts";
import type { ActivityState, AsyncJobState, AsyncJobStep, AsyncStatus, NestedRunSummary, NestedStepSummary, SubagentState } from "../shared/types.ts";
import { formatActivityLabel } from "../shared/status-format.ts";
import { readStatus } from "../shared/utils.ts";
import type { WatchSection, WatchSectionTitle, WatchTarget, WatchTargetStatus, WatchTreeRow } from "./watch-types.ts";

interface BuildWatchOptions {
	now?: () => number;
}

const STATUS_ICON: Record<string, string> = {
	running: "●",
	queued: "○",
	pending: "○",
	complete: "✓",
	completed: "✓",
	failed: "✕",
	paused: "Ⅱ",
};

function normalizeStatus(value: unknown): WatchTargetStatus {
	if (value === "queued" || value === "pending" || value === "running" || value === "complete" || value === "completed" || value === "failed" || value === "paused") return value;
	return "pending";
}

function isLiveStatus(status: WatchTargetStatus): boolean {
	return status === "pending" || status === "queued" || status === "running";
}

function jobHasLiveNested(job: AsyncJobState): boolean {
	return hasLiveNestedDescendants(job.nestedChildren) || hasLiveNestedDescendants(job.steps?.flatMap((step) => step.children ?? []));
}

function sectionForJob(job: AsyncJobState): WatchSectionTitle {
	if (job.status === "queued") return "Queued";
	if (job.status === "running" || jobHasLiveNested(job)) return "Active";
	return "Done";
}

function displayName(agent: string, step: Partial<AsyncJobStep> = {}): string {
	if (step.label?.trim()) return step.label.trim();
	if (step.phase?.trim()) return `${step.phase.trim()} ${agent}`;
	const task = typeof (step as { task?: unknown }).task === "string" ? (step as { task: string }).task.trim().split("\n")[0] : "";
	if (task) return task.length > 80 ? `${task.slice(0, 77)}...` : task;
	return agent;
}

function outputLogFor(asyncDir: string, stepIndex?: number): string | undefined {
	return stepIndex === undefined ? undefined : path.join(asyncDir, `output-${stepIndex}.log`);
}

function targetLine(target: WatchTarget, now: number): string {
	const icon = STATUS_ICON[target.status] ?? "•";
	const tool = target.currentTool ? ` · ${target.currentTool}` : "";
	const activity = target.status === "running"
		? (formatActivityLabel(target.lastActivityAt, target.activityState as ActivityState | undefined, now) ?? target.status)
		: target.status;
	return `${icon} ${target.agent.padEnd(10)} ${target.displayName}  ${activity}${tool}`;
}

function targetFiles(job: AsyncJobState): Pick<WatchTarget, "rootLog" | "eventsFile" | "statusFile"> {
	return {
		rootLog: path.join(job.asyncDir, `subagent-log-${job.asyncId}.md`),
		eventsFile: path.join(job.asyncDir, "events.jsonl"),
		statusFile: path.join(job.asyncDir, "status.json"),
	};
}

function makeStepTarget(job: AsyncJobState, step: AsyncJobStep, index: number): WatchTarget {
	const originalIndex = step.index ?? index;
	const agent = step.agent;
	const status = normalizeStatus(step.status);
	const name = displayName(agent, step);
	const outputLog = outputLogFor(job.asyncDir, originalIndex);
	return {
		id: `${job.asyncId}/${originalIndex + 1}`,
		rootRunId: job.asyncId,
		rootAsyncDir: job.asyncDir,
		rootStatus: job.status,
		stepIndex: originalIndex,
		agent,
		displayName: name,
		status,
		...(step.phase ? { phase: step.phase } : {}),
		...(step.label ? { label: step.label } : {}),
		...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
		...(outputLog ? { outputLog } : {}),
		...targetFiles(job),
		...(step.currentTool ? { currentTool: step.currentTool } : {}),
		...(step.activityState ? { activityState: step.activityState } : {}),
		...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
		...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
		...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
		...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
		...(step.tokens ? { tokens: step.tokens } : {}),
		...(step.error ? { error: step.error } : {}),
		ancestry: [job.asyncId, agent],
		depth: 1,
		rawStep: step,
	};
}

function makePlaceholderTarget(job: AsyncJobState, agent: string, index: number): WatchTarget {
	return {
		id: `${job.asyncId}/placeholder-${index + 1}`,
		rootRunId: job.asyncId,
		rootAsyncDir: job.asyncDir,
		rootStatus: job.status,
		stepIndex: index,
		agent,
		displayName: agent,
		status: normalizeStatus(job.status === "queued" ? "queued" : "pending"),
		...targetFiles(job),
		ancestry: [job.asyncId, agent],
		depth: 1,
	};
}

function makeNestedTarget(job: AsyncJobState, run: NestedRunSummary, parentNames: string[]): WatchTarget {
	const agent = run.agent ?? run.agents?.join("+") ?? run.id;
	const status = normalizeStatus(run.state);
	const ancestry = [...parentNames, agent];
	return {
		id: `${job.asyncId}/${run.id}`,
		rootRunId: job.asyncId,
		rootAsyncDir: job.asyncDir,
		rootStatus: job.status,
		nestedRunId: run.id,
		agent,
		displayName: agent,
		status,
		...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
		...(run.asyncDir ? { outputLog: path.join(run.asyncDir, "output-0.log") } : {}),
		...targetFiles(job),
		...(run.currentTool ? { currentTool: run.currentTool } : {}),
		...(run.activityState ? { activityState: run.activityState } : {}),
		...(run.lastActivityAt !== undefined ? { lastActivityAt: run.lastActivityAt } : {}),
		...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
		...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		...(run.toolCount !== undefined ? { toolCount: run.toolCount } : {}),
		...(run.totalTokens ? { tokens: run.totalTokens } : {}),
		...(run.error ? { error: run.error } : {}),
		ancestry,
		depth: ancestry.length - 1,
		rawNested: run,
	};
}

function makeNestedStepTarget(job: AsyncJobState, run: NestedRunSummary, step: NestedStepSummary, stepIndex: number, parentNames: string[]): WatchTarget {
	const ancestry = [...parentNames, step.agent];
	const outputLog = run.asyncDir ? path.join(run.asyncDir, `output-${stepIndex}.log`) : undefined;
	return {
		id: `${job.asyncId}/${run.id}/${stepIndex + 1}`,
		rootRunId: job.asyncId,
		rootAsyncDir: job.asyncDir,
		rootStatus: job.status,
		nestedRunId: run.id,
		stepIndex,
		agent: step.agent,
		displayName: step.agent,
		status: normalizeStatus(step.status),
		...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
		...(outputLog ? { outputLog } : {}),
		...targetFiles(job),
		...(step.currentTool ? { currentTool: step.currentTool } : {}),
		...(step.activityState ? { activityState: step.activityState } : {}),
		...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
		...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
		...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
		...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
		...(step.error ? { error: step.error } : {}),
		ancestry,
		depth: ancestry.length - 1,
		rawNested: run,
	};
}

function collectNested(job: AsyncJobState, nested: NestedRunSummary[] | undefined, parentNames: string[], rows: WatchTreeRow[], targets: WatchTarget[], now: number): void {
	const runs = nested ?? [];
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index]!;
		const target = makeNestedTarget(job, run, parentNames);
		targets.push(target);
		rows.push({ key: target.id, selectable: true, targetId: target.id, depth: target.depth, text: `${index === runs.length - 1 ? "└─" : "├─"} ${targetLine(target, now)}` });
		const steps = run.steps ?? [];
		for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
			const step = steps[stepIndex]!;
			const stepTarget = makeNestedStepTarget(job, run, step, stepIndex, target.ancestry);
			targets.push(stepTarget);
			rows.push({ key: stepTarget.id, selectable: true, targetId: stepTarget.id, depth: stepTarget.depth, text: `${stepIndex === steps.length - 1 && !step.children?.length ? "└─" : "├─"} ${targetLine(stepTarget, now)}` });
			collectNested(job, step.children, stepTarget.ancestry, rows, targets, now);
		}
		collectNested(job, run.children, target.ancestry, rows, targets, now);
	}
}

function jobFromStatus(job: AsyncJobState, status: AsyncStatus | null): AsyncJobState {
	if (!status) return job;
	const statusAgents = status.steps?.map((step) => step.agent) ?? (status.agent ? [status.agent] : undefined);
	return {
		...job,
		status: status.state,
		mode: status.mode ?? job.mode,
		agents: statusAgents ?? job.agents,
		steps: (status.steps as AsyncJobStep[] | undefined) ?? job.steps,
		sessionFile: status.sessionFile ?? job.sessionFile,
		totalTokens: status.totalTokens ?? job.totalTokens,
		startedAt: status.startedAt ?? job.startedAt,
		updatedAt: status.lastUpdate ?? job.updatedAt,
	};
}

function readJobStatus(job: AsyncJobState): AsyncStatus | null {
	try {
		return readStatus(job.asyncDir);
	} catch {
		return null;
	}
}

function buildJobRows(inputJob: AsyncJobState, now: number): { sectionTitle: WatchSectionTitle; rows: WatchTreeRow[]; targets: WatchTarget[] } {
	const status = readJobStatus(inputJob);
	const job = jobFromStatus(inputJob, status);
	const rows: WatchTreeRow[] = [];
	const targets: WatchTarget[] = [];
	const sectionTitle = sectionForJob(job);
	const agents = job.agents?.join(", ") ?? job.steps?.map((step) => step.agent).join(", ") ?? "subagents";
	rows.push({ key: `${job.asyncId}:root`, selectable: false, depth: 0, text: `▾ ${job.asyncId}  ${job.mode ?? "single"}  ${job.status} · ${agents}` });

	const steps = (job.steps ?? []).map((step, index) => ({ ...step, index: step.index ?? index })) as AsyncJobStep[];
	try {
		const nested = projectNestedRegistryForRoot(job.asyncId)?.children ?? job.nestedChildren;
		if (nested) attachRootChildrenToSteps(job.asyncId, steps, nested);
	} catch {
		// Watch tree is read-only observational state. If sidecar projection fails,
		// keep direct step metadata visible instead of breaking the selector.
	}

	if (steps.length === 0 && job.agents?.length) {
		for (let index = 0; index < job.agents.length; index += 1) {
			const target = makePlaceholderTarget(job, job.agents[index]!, index);
			targets.push(target);
			rows.push({ key: target.id, selectable: true, targetId: target.id, depth: 1, text: `${index === job.agents.length - 1 ? "└─" : "├─"} ${targetLine(target, now)}` });
		}
	}

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!;
		const target = makeStepTarget(job, step, index);
		targets.push(target);
		rows.push({ key: target.id, selectable: true, targetId: target.id, depth: 1, text: `${index === steps.length - 1 && !step.children?.length ? "└─" : "├─"} ${targetLine(target, now)}` });
		collectNested(job, step.children, target.ancestry, rows, targets, now);
	}
	return { sectionTitle, rows, targets };
}

export function buildWatchSections(state: SubagentState, options: BuildWatchOptions = {}): WatchSection[] {
	const now = options.now?.() ?? Date.now();
	const byTitle: Record<WatchSectionTitle, WatchSection> = {
		Active: { title: "Active", rows: [], targets: [] },
		Queued: { title: "Queued", rows: [], targets: [] },
		Done: { title: "Done", rows: [], targets: [] },
	};
	for (const job of state.asyncJobs.values()) {
		const built = buildJobRows(job, now);
		const section = byTitle[built.sectionTitle];
		section.rows.push(...built.rows);
		section.targets.push(...built.targets);
	}
	return [byTitle.Active, byTitle.Queued, byTitle.Done].filter((section) => section.rows.length > 0);
}

export function flattenWatchTargets(sections: WatchSection[]): WatchTarget[] {
	return sections.flatMap((section) => section.targets);
}

export function findWatchTarget(sections: WatchSection[], targetId: string): WatchTarget | undefined {
	return flattenWatchTargets(sections).find((target) => target.id === targetId);
}

export function targetIsLive(target: WatchTarget): boolean {
	return isLiveStatus(target.status);
}
