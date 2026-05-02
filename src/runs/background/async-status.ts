import * as fs from "node:fs";
import * as path from "node:path";
import { formatDuration, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { type ActivityState, type AsyncParallelGroupStatus, type AsyncStatus, type SubagentRunMode, type TokenUsage } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

interface AsyncRunStepSummary {
	index: number;
	agent: string;
	status: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools?: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput?: string[];
	turnCount?: number;
	toolCount?: number;
	durationMs?: number;
	tokens?: TokenUsage;
	skills?: string[];
	model?: string;
	attemptedModels?: string[];
	error?: string;
}

export interface AsyncRunSummary {
	id: string;
	asyncDir: string;
	sessionId?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	mode: SubagentRunMode;
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps: AsyncRunStepSummary[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	sessionId?: string;
	limit?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	reconcile?: boolean;
}

export interface AsyncRunOverlayData {
	active: AsyncRunSummary[];
	recent: AsyncRunSummary[];
}

export interface AsyncRunOverlayOptions {
	recentLimit?: number;
	sessionId?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAsyncRunDir(root: string, entry: string): boolean {
	const entryPath = path.join(root, entry);
	try {
		return fs.statSync(entryPath).isDirectory();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new Error(`Failed to inspect async run path '${entryPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function outputFileMtime(outputFile: string | undefined): number | undefined {
	if (!outputFile) return undefined;
	try {
		return fs.statSync(outputFile).mtimeMs;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to inspect async output file '${outputFile}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running") return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	return {
		activityState: status.activityState,
		lastActivityAt: status.lastActivityAt ?? outputFileMtime(outputPath) ?? currentStep?.lastActivityAt ?? currentStep?.startedAt ?? status.startedAt,
	};
}

function statusToSummary(asyncDir: string, status: AsyncStatus & { cwd?: string }): AsyncRunSummary {
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") {
		throw new Error(`Invalid async status '${path.join(asyncDir, "status.json")}': sessionId must be a string.`);
	}
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const steps = status.steps ?? [];
	const chainStepCount = status.chainStepCount ?? steps.length;
	const parallelGroups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
	return {
		id: status.runId || path.basename(asyncDir),
		asyncDir,
		...(status.sessionId ? { sessionId: status.sessionId } : {}),
		state: status.state,
		activityState,
		lastActivityAt,
		currentTool: status.currentTool,
		currentToolStartedAt: status.currentToolStartedAt,
		currentPath: status.currentPath,
		turnCount: status.turnCount,
		toolCount: status.toolCount,
		mode: status.mode,
		cwd: status.cwd,
		startedAt: status.startedAt,
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		currentStep: status.currentStep,
		...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: steps.map((step, index) => {
			const stepActivityState = step.activityState;
			const stepLastActivityAt = step.lastActivityAt;
			return {
				index,
				agent: step.agent,
				status: step.status,
				...(stepActivityState ? { activityState: stepActivityState } : {}),
				...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
				...(step.currentTool ? { currentTool: step.currentTool } : {}),
				...(step.currentToolArgs ? { currentToolArgs: step.currentToolArgs } : {}),
				...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
				...(step.currentPath ? { currentPath: step.currentPath } : {}),
				...(step.recentTools ? { recentTools: step.recentTools.map((tool) => ({ ...tool })) } : {}),
				...(step.recentOutput ? { recentOutput: [...step.recentOutput] } : {}),
				...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
				...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
				...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
				...(step.tokens ? { tokens: step.tokens } : {}),
				...(step.skills ? { skills: step.skills } : {}),
				...(step.model ? { model: step.model } : {}),
				...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
				...(step.error ? { error: step.error } : {}),
			};
		}),
		...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
		...(status.outputFile ? { outputFile: status.outputFile } : {}),
		...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
		...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
	};
}

function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running": return 0;
			case "queued": return 1;
		case "failed": return 2;
		case "paused": return 2;
		case "complete": return 3;
		}
	};
	return [...runs].sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
		const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
		return bTime - aTime;
	});
}

export function listAsyncRuns(asyncDirRoot: string, options: AsyncRunListOptions = {}): AsyncRunSummary[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(asyncDirRoot).filter((entry) => isAsyncRunDir(asyncDirRoot, entry));
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		const reconciliation = options.reconcile === false
			? undefined
			: reconcileAsyncRun(asyncDir, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
		const status = (reconciliation?.status ?? readStatus(asyncDir)) as (AsyncStatus & { cwd?: string }) | null;
		if (!status) continue;
		const summary = statusToSummary(asyncDir, status);
		if (allowedStates && !allowedStates.has(summary.state)) continue;
		if (options.sessionId && summary.sessionId !== options.sessionId) continue;
		runs.push(summary);
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

export function listAsyncRunsForOverlay(asyncDirRoot: string, options: AsyncRunOverlayOptions = {}): AsyncRunOverlayData {
	const recentLimit = options.recentLimit ?? 5;
	const all = listAsyncRuns(asyncDirRoot, { sessionId: options.sessionId });
	const recent = all
		.filter((run) => run.state === "complete" || run.state === "failed" || run.state === "paused")
		.sort((a, b) => (b.lastUpdate ?? b.endedAt ?? b.startedAt) - (a.lastUpdate ?? a.endedAt ?? a.startedAt))
		.slice(0, recentLimit);
	return {
		active: all.filter((run) => run.state === "queued" || run.state === "running"),
		recent,
	};
}

function formatActivityFacts(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number; currentPath?: string; turnCount?: number; toolCount?: number }): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (!input.lastActivityAt) {
		if (input.activityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (input.activityState === "active_long_running") return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const elapsed = formatDuration(Math.max(0, Date.now() - input.lastActivityAt));
	if (input.activityState === "needs_attention") return [`no activity for ${elapsed}`, ...facts].join(" | ");
	if (input.activityState === "active_long_running") return [`active but long-running; last activity ${elapsed} ago`, ...facts].join(" | ");
	return [`active ${elapsed} ago`, ...facts].join(" | ");
}

function formatStepLine(step: AsyncRunStepSummary): string {
	const parts = [`${step.index + 1}. ${step.agent}`, step.status];
	const activity = formatActivityFacts(step);
	if (activity) parts.push(activity);
	if (step.model) parts.push(step.model);
	if (step.durationMs !== undefined) parts.push(formatDuration(step.durationMs));
	if (step.tokens) parts.push(`${formatTokens(step.tokens.total)} tok`);
	return parts.join(" | ");
}

function formatParallelProgress(steps: Pick<AsyncRunStepSummary, "status">[], total: number, showRunning: boolean): string {
	const running = steps.filter((step) => step.status === "running").length;
	const done = steps.filter((step) => step.status === "complete" || step.status === "completed").length;
	const failed = steps.filter((step) => step.status === "failed").length;
	const paused = steps.filter((step) => step.status === "paused").length;
	const parts = [`${done}/${total} done`];
	if (showRunning && running > 0) parts.unshift(running === 1 ? "1 agent running" : `${running} agents running`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (paused > 0) parts.push(`${paused} paused`);
	return parts.join(" · ");
}

export function formatAsyncRunProgressLabel(run: Pick<AsyncRunSummary, "mode" | "state" | "currentStep" | "chainStepCount" | "parallelGroups" | "steps">): string {
	const stepCount = run.steps.length || 1;
	const chainStepCount = run.chainStepCount ?? stepCount;
	const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, chainStepCount);
	const activeGroup = run.currentStep !== undefined
		? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
		: undefined;
	if (activeGroup) {
		const groupSteps = run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count);
		const groupLabel = formatParallelProgress(groupSteps, activeGroup.count, run.state === "running");
		if (run.mode === "parallel") return groupLabel;
		return `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
	}
	if (run.mode === "parallel") return formatParallelProgress(run.steps, stepCount, run.state === "running");
	if (run.mode === "chain" && run.currentStep !== undefined && groups.length > 0) {
		const logicalStep = flatToLogicalStepIndex(run.currentStep, chainStepCount, groups);
		return `step ${logicalStep + 1}/${chainStepCount}`;
	}
	return run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
}

function formatRunHeader(run: AsyncRunSummary): string {
	const stepLabel = formatAsyncRunProgressLabel(run);
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
	const activity = formatActivityFacts(run);
	return `${run.id} | ${run.state}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${stepLabel} | ${cwd}`;
}

export function formatAsyncRunList(runs: AsyncRunSummary[], heading = "Active async runs"): string {
	if (runs.length === 0) return `No ${heading.toLowerCase()}.`;

	const lines = [`${heading}: ${runs.length}`, ""];
	for (const run of runs) {
		lines.push(`- ${formatRunHeader(run)}`);
		for (const step of run.steps) {
			lines.push(`  ${formatStepLine(step)}`);
		}
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
