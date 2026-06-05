import * as path from "node:path";
import { attachRootChildrenToSteps, projectNestedRegistryForRoot } from "../runs/shared/nested-events.ts";
import type { ActivityState, AsyncJobState, AsyncJobStep, NestedRunSummary, SubagentState } from "../shared/types.ts";
import { formatActivityLabel } from "../shared/status-format.ts";
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

function sectionForJob(job: AsyncJobState): WatchSectionTitle {
	if (job.status === "queued") return "Queued";
	if (job.status === "running") return "Active";
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

function makeStepTarget(job: AsyncJobState, step: AsyncJobStep, index: number): WatchTarget {
	const agent = step.agent;
	const status = normalizeStatus(step.status);
	const name = displayName(agent, step);
	const outputLog = outputLogFor(job.asyncDir, index);
	return {
		id: `${job.asyncId}/${index + 1}`,
		rootRunId: job.asyncId,
		rootAsyncDir: job.asyncDir,
		rootStatus: job.status,
		stepIndex: index,
		agent,
		displayName: name,
		status,
		...(step.phase ? { phase: step.phase } : {}),
		...(step.label ? { label: step.label } : {}),
		...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
		...(outputLog ? { outputLog } : {}),
		rootLog: path.join(job.asyncDir, `subagent-log-${job.asyncId}.md`),
		eventsFile: path.join(job.asyncDir, "events.jsonl"),
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
		rootLog: path.join(job.asyncDir, `subagent-log-${job.asyncId}.md`),
		eventsFile: path.join(job.asyncDir, "events.jsonl"),
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

function collectNested(job: AsyncJobState, nested: NestedRunSummary[] | undefined, parentNames: string[], rows: WatchTreeRow[], targets: WatchTarget[], now: number): void {
	const runs = nested ?? [];
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index]!;
		const target = makeNestedTarget(job, run, parentNames);
		targets.push(target);
		rows.push({ key: target.id, selectable: true, targetId: target.id, depth: target.depth, text: `${index === runs.length - 1 ? "└─" : "├─"} ${targetLine(target, now)}` });
		collectNested(job, run.children, target.ancestry, rows, targets, now);
		for (const step of run.steps ?? []) collectNested(job, step.children, [...target.ancestry, step.agent], rows, targets, now);
	}
}

function buildJobRows(job: AsyncJobState, now: number): { rows: WatchTreeRow[]; targets: WatchTarget[] } {
	const rows: WatchTreeRow[] = [];
	const targets: WatchTarget[] = [];
	const status = job.status;
	const agents = job.agents?.join(", ") ?? job.steps?.map((step) => step.agent).join(", ") ?? "subagents";
	rows.push({ key: `${job.asyncId}:root`, selectable: false, depth: 0, text: `▾ ${job.asyncId}  ${job.mode ?? "single"}  ${status} · ${agents}` });

	const steps = (job.steps ?? []).map((step, index) => ({ ...step, index })) as AsyncJobStep[];
	try {
		const nested = projectNestedRegistryForRoot(job.asyncId)?.children ?? job.nestedChildren;
		if (nested) attachRootChildrenToSteps(job.asyncId, steps, nested);
	} catch {
		// Watch tree is read-only observational state. If sidecar projection fails,
		// keep direct step metadata visible instead of breaking the selector.
	}

	for (let index = 0; index < steps.length; index += 1) {
		const step = steps[index]!;
		const target = makeStepTarget(job, step, index);
		targets.push(target);
		rows.push({ key: target.id, selectable: true, targetId: target.id, depth: 1, text: `${index === steps.length - 1 && !step.children?.length ? "└─" : "├─"} ${targetLine(target, now)}` });
		collectNested(job, step.children, target.ancestry, rows, targets, now);
	}
	return { rows, targets };
}

export function buildWatchSections(state: SubagentState, options: BuildWatchOptions = {}): WatchSection[] {
	const now = options.now?.() ?? Date.now();
	const byTitle: Record<WatchSectionTitle, WatchSection> = {
		Active: { title: "Active", rows: [], targets: [] },
		Queued: { title: "Queued", rows: [], targets: [] },
		Done: { title: "Done", rows: [], targets: [] },
	};
	for (const job of state.asyncJobs.values()) {
		const section = byTitle[sectionForJob(job)];
		const built = buildJobRows(job, now);
		section.rows.push(...built.rows);
		section.targets.push(...built.targets);
	}
	return [byTitle.Active, byTitle.Queued, byTitle.Done].filter((section) => section.rows.length > 0 || section.title !== "Done");
}

export function flattenWatchTargets(sections: WatchSection[]): WatchTarget[] {
	return sections.flatMap((section) => section.targets);
}
