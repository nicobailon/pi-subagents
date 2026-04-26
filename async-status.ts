import * as fs from "node:fs";
import * as path from "node:path";
import { formatDuration, formatTokens, shortenPath } from "./formatters.ts";
import { type ActivityState, type AsyncStatus, type TokenUsage } from "./types.ts";
import { DEFAULT_CONTROL_CONFIG, deriveActivityState } from "./subagent-control.ts";
import { readStatus } from "./utils.ts";

export interface AsyncRunStepSummary {
	index: number;
	agent: string;
	status: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	recentOutput?: string[];
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
	state: "queued" | "running" | "complete" | "failed" | "paused";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	recentOutput?: string[];
	mode: "single" | "chain";
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	currentStep?: number;
	steps: AsyncRunStepSummary[];
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

export interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	limit?: number;
}

export interface AsyncRunOverlayData {
	active: AsyncRunSummary[];
	recent: AsyncRunSummary[];
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
	} catch {
		return undefined;
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus): { activityState?: ActivityState; lastActivityAt?: number } {
	if (status.state !== "running") return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
	const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
	const lastActivityAt = status.lastActivityAt ?? outputFileMtime(outputPath) ?? currentStep?.lastActivityAt ?? currentStep?.startedAt ?? status.startedAt;
	return {
		lastActivityAt,
		activityState: status.activityState ?? deriveActivityState({
			config: DEFAULT_CONTROL_CONFIG,
			startedAt: status.startedAt,
			lastActivityAt,
		}),
	};
}

function statusToSummary(asyncDir: string, status: AsyncStatus & { cwd?: string }): AsyncRunSummary {
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	return {
		id: status.runId || path.basename(asyncDir),
		asyncDir,
		state: status.state,
		activityState,
		lastActivityAt,
		currentTool: status.currentTool,
		currentToolStartedAt: status.currentToolStartedAt,
		recentOutput: status.recentOutput,
		mode: status.mode,
		cwd: status.cwd,
		startedAt: status.startedAt,
		lastUpdate: status.lastUpdate,
		endedAt: status.endedAt,
		currentStep: status.currentStep,
		steps: (status.steps ?? []).map((step, index) => {
			const stepActivityState = step.activityState ?? (step.status === "running" ? activityState : undefined);
			const stepLastActivityAt = step.lastActivityAt ?? (step.status === "running" ? lastActivityAt : undefined);
			return {
				index,
				agent: step.agent,
				status: step.status,
				...(stepActivityState ? { activityState: stepActivityState } : {}),
				...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
				...(step.currentTool ? { currentTool: step.currentTool } : {}),
				...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
				...(step.recentOutput ? { recentOutput: step.recentOutput } : {}),
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
		const status = readStatus(asyncDir) as (AsyncStatus & { cwd?: string }) | null;
		if (!status) continue;
		const summary = statusToSummary(asyncDir, status);
		if (allowedStates && !allowedStates.has(summary.state)) continue;
		runs.push(summary);
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}

export function listAsyncRunsForOverlay(asyncDirRoot: string, recentLimit = 5): AsyncRunOverlayData {
	const all = listAsyncRuns(asyncDirRoot);
	const recent = all
		.filter((run) => run.state === "complete" || run.state === "failed" || run.state === "paused")
		.sort((a, b) => (b.lastUpdate ?? b.endedAt ?? b.startedAt) - (a.lastUpdate ?? a.endedAt ?? a.startedAt))
		.slice(0, recentLimit);
	return {
		active: all.filter((run) => run.state === "queued" || run.state === "running"),
		recent,
	};
}

function formatActivityFacts(input: { activityState?: ActivityState; lastActivityAt?: number; currentTool?: string; currentToolStartedAt?: number }): string | undefined {
	if (input.currentTool && input.currentToolStartedAt) return `tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`;
	if (!input.lastActivityAt) return input.activityState === "needs_attention" ? "needs attention" : undefined;
	const elapsed = formatDuration(Math.max(0, Date.now() - input.lastActivityAt));
	return input.activityState === "needs_attention" ? `no activity for ${elapsed}` : `active ${elapsed} ago`;
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

function formatRunHeader(run: AsyncRunSummary): string {
	const stepCount = run.steps.length || 1;
	const stepLabel = run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
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
