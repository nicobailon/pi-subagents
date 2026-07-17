/**
 * Rendering functions for subagent results
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, keyText, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	type AgentProgress,
	type AsyncJobState,
	type AsyncJobStep,
	type AsyncParallelGroupStatus,
	type Details,
	type NestedRunSummary,
	type NestedStepSummary,
	type WorkflowNodeStatus,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "../shared/types.ts";
import { formatTokens, formatUsage, formatDuration, formatModelThinking, formatToolCall, shortenPath } from "../shared/formatters.ts";
import { getDisplayItems, getSingleResultOutput } from "../shared/utils.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { formatNestedAggregate } from "../runs/shared/nested-render.ts";
import { aggregateStepStatus, formatActivityLabel, formatAgentRunningLabel, formatParallelOutcome } from "../shared/status-format.ts";

type Theme = ExtensionContext["ui"]["theme"];

function liveDetailKeyText(): string {
	return keyText("app.tools.expand");
}

function liveDetailHintText(): string {
	return `Press ${liveDetailKeyText()} for live detail`;
}

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 * 
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 * 
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

function wrapPlainText(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [""];
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const seg of segmenter.segment(rawLine)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);
			if (currentWidth > 0 && currentWidth + graphemeWidth > maxWidth) {
				lines.push(current);
				current = grapheme;
				currentWidth = graphemeWidth;
				continue;
			}
			current += grapheme;
			currentWidth += graphemeWidth;
		}
		lines.push(current);
	}
	return lines;
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";

type ProgressSeedSource = Partial<Pick<AgentProgress, "index" | "toolCount" | "tokens" | "durationMs" | "lastActivityAt" | "currentToolStartedAt" | "turnCount">>;

function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

function runningGlyph(seed?: number): string {
	if (seed === undefined) return STATIC_RUNNING_GLYPH;
	return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

function progressRunningSeed(progress: ProgressSeedSource | undefined): number | undefined {
	if (!progress) return undefined;
	return runningSeed(
		progress.index,
		progress.toolCount,
		progress.tokens,
		progress.durationMs,
		progress.lastActivityAt,
		progress.currentToolStartedAt,
		progress.turnCount,
	);
}

interface LegacyResultAnimationContext {
	state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
}

export function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (!timer) return;
	clearInterval(timer);
	context.state.subagentResultAnimationTimer = undefined;
}

function extractOutputTarget(task: string): string | undefined {
	const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
	const findingsMatch = task.match(/Write your findings to(?: exactly this path)?:\s*([^\r\n]+)/i);
	if (findingsMatch?.[1]?.trim()) return findingsMatch[1].trim();
	const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
	if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
	return undefined;
}

function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
	if (output.trim()) return false;
	return !extractOutputTarget(task);
}

function getToolCallLines(
	result: Pick<Details["results"][number], "messages" | "toolCalls">,
	expanded: boolean,
): string[] {
	if (result.messages) {
		return getDisplayItems(result.messages)
			.filter((item): item is { type: "tool"; name: string; args: Record<string, unknown> } => item.type === "tool")
			.map((item) => formatToolCall(item.name, item.args, expanded));
	}
	return result.toolCalls?.map((toolCall) => expanded ? toolCall.expandedText : toolCall.text) ?? [];
}


function snapshotNowForProgress(progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">): number | undefined {
	if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) return progress.currentToolStartedAt + progress.durationMs;
	return progress.lastActivityAt;
}

function formatCurrentToolLine(
	progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">,
	availableWidth: number,
	expanded: boolean,
	snapshotNow?: number,
): string | undefined {
	if (!progress.currentTool) return undefined;
	const maxToolArgsLen = Math.max(50, availableWidth - 20);
	const toolArgsPreview = progress.currentToolArgs
		? (expanded || progress.currentToolArgs.length <= maxToolArgsLen
			? progress.currentToolArgs
			: `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`)
		: "";
	const durationSuffix = progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
		? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
		: "";
	return toolArgsPreview
		? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
		: `${progress.currentTool}${durationSuffix}`;
}

function buildLiveStatusLine(progress: Pick<AgentProgress, "activityState" | "lastActivityAt">, snapshotNow?: number): string | undefined {
	if (progress.lastActivityAt !== undefined && snapshotNow !== undefined) return formatActivityLabel(progress.lastActivityAt, progress.activityState, snapshotNow);
	if (progress.activityState === "needs_attention") return "needs attention";
	if (progress.activityState === "active_long_running") return "active but long-running";
	if (progress.lastActivityAt !== undefined) return "active";
	return undefined;
}

function themeBold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

function statJoin(theme: Theme, parts: string[]): string {
	return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} token`;
}

function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

function formatTotalCostStat(totalCost: Details["totalCost"] | undefined): string {
	if (!totalCost || (totalCost.inputTokens === 0 && totalCost.outputTokens === 0 && totalCost.costUsd === 0)) return "";
	const parts: string[] = [];
	if (totalCost.inputTokens) parts.push(`in:${formatTokens(totalCost.inputTokens)}`);
	if (totalCost.outputTokens) parts.push(`out:${formatTokens(totalCost.outputTokens)}`);
	if (totalCost.costUsd) parts.push(`$${totalCost.costUsd.toFixed(4)}`);
	return parts.join(" ");
}

function formatProgressStats(theme: Theme, progress: Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> | undefined, includeDuration = true): string {
	if (!progress) return "";
	const parts: string[] = [];
	if (progress.toolCount > 0) parts.push(formatToolUseStat(progress.toolCount));
	if (progress.tokens > 0) parts.push(formatTokenStat(progress.tokens));
	if (includeDuration && progress.durationMs > 0) parts.push(formatDuration(progress.durationMs));
	return statJoin(theme, parts);
}

function firstOutputLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function resultStatusLine(result: Details["results"][number], output: string): string {
	if (result.detached) return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
	if (result.stopped) return "Stopped";
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (result.acceptance?.status && result.acceptance.status !== "not-required") return `Done · acceptance: ${result.acceptance.status}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	return "Done";
}

function resultGlyph(result: Details["results"][number], output: string, theme: Theme, running = result.progress?.status === "running", seed = progressRunningSeed(result.progress ?? result.progressSummary), frame?: number): string {
	if (running) {
		if (frame !== undefined) return theme.fg("accent", runningGlyph((seed ?? 0) + frame));
		return theme.fg("accent", runningGlyph(seed));
	}
	if (result.detached) return theme.fg("warning", "■");
	if (result.stopped) return theme.fg("warning", "■");
	if (result.interrupted) return theme.fg("warning", "■");
	if (result.exitCode !== 0) return theme.fg("error", "✗");
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
	return theme.fg("success", "✓");
}

function compactCurrentActivity(progress: AgentProgress): string {
	const snapshotNow = snapshotNowForProgress(progress);
	return formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ?? buildLiveStatusLine(progress, snapshotNow) ?? "thinking…";
}

export function widgetRenderKey(job: AsyncJobState): string {
	return JSON.stringify({
		asyncDir: job.asyncDir,
		status: job.status,
		activityState: job.activityState,
		lastActivityAt: job.lastActivityAt,
		currentTool: job.currentTool,
		currentToolStartedAt: job.currentToolStartedAt,
		currentPath: job.currentPath,
		turnCount: job.turnCount,
		toolCount: job.toolCount,
		mode: job.mode,
		agents: job.agents,
		currentStep: job.currentStep,
		chainStepCount: job.chainStepCount,
		parallelGroups: job.parallelGroups,
		steps: job.steps,
		nestedChildren: job.nestedChildren,
		stepsTotal: job.stepsTotal,
		runningSteps: job.runningSteps,
		completedSteps: job.completedSteps,
		activeParallelGroup: job.activeParallelGroup,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		totalTokens: job.totalTokens,
	});
}

function formatWidgetAgents(agents: string[]): string {
	const distinct = [...new Set(agents)];
	if (distinct.length === 1 && agents.length > 1) return `${distinct[0]} ×${agents.length}`;
	if (agents.length > 3) return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
	return agents.join(", ");
}

function widgetJobName(job: AsyncJobState): string {
	if (job.mode === "parallel") return "parallel";
	if (job.mode === "chain") return "chain";
	if (job.mode === "single" && job.agents?.length === 1) return job.agents[0]!;
	if (job.agents?.length) return formatWidgetAgents(job.agents);
	return job.mode ?? "subagent";
}

function widgetActivity(job: AsyncJobState): string {
	const facts: string[] = [];
	if (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined) facts.push(`${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`);
	else if (job.currentTool) facts.push(job.currentTool);
	if (job.currentPath) facts.push(shortenPath(job.currentPath));
	if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
	if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
	const activity = buildLiveStatusLine(job, job.updatedAt);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (job.status === "running") return "thinking…";
	if (job.status === "queued") return "queued…";
	if (job.status === "paused") return "Paused";
	if (job.status === "stopped") return "Stopped";
	if (job.status === "failed") return "Failed";
	return "Done";
}

function widgetStepRunningSeed(step: NonNullable<AsyncJobState["steps"]>[number], fallbackIndex?: number): number | undefined {
	return runningSeed(
		fallbackIndex,
		step.index,
		step.toolCount,
		step.turnCount,
		step.tokens?.total,
		step.lastActivityAt,
		step.currentToolStartedAt,
		step.durationMs,
	);
}

function widgetStepsRunningSeed(steps: Array<NonNullable<AsyncJobState["steps"]>[number]> | undefined): number | undefined {
	let seed: number | undefined;
	for (const [index, step] of (steps ?? []).entries()) seed = runningSeed(seed, widgetStepRunningSeed(step, index));
	return seed;
}

function widgetJobRunningSeed(job: AsyncJobState): number | undefined {
	return runningSeed(
		job.updatedAt,
		job.lastActivityAt,
		job.toolCount,
		job.turnCount,
		job.totalTokens?.total,
		job.currentStep,
		job.runningSteps,
		job.completedSteps,
		widgetStepsRunningSeed(job.steps),
	);
}

function widgetJobsRunningSeed(jobs: AsyncJobState[]): number | undefined {
	let seed: number | undefined;
	for (const job of jobs) seed = runningSeed(seed, widgetJobRunningSeed(job));
	return seed;
}

function widgetStatusGlyph(job: AsyncJobState, theme: Theme): string {
	if (job.status === "running") return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job)));
	if (job.status === "queued") return theme.fg("muted", "◦");
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	if (job.status === "stopped") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme, seed?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(seed));
	if (status === "complete" || status === "completed") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "paused") return theme.fg("warning", "■");
	if (status === "stopped") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

function widgetStepStatus(status: AsyncJobStep["status"], theme: Theme): string {
	if (status === "running") return theme.fg("accent", "running");
	if (status === "complete" || status === "completed") return theme.fg("success", "complete");
	if (status === "failed") return theme.fg("error", "failed");
	if (status === "paused") return theme.fg("warning", "paused");
	if (status === "stopped") return theme.fg("warning", "stopped");
	return theme.fg("dim", status);
}

function widgetStepActivity(step: NonNullable<AsyncJobState["steps"]>[number], snapshotNow?: number): string {
	const facts: string[] = [];
	if (step.currentTool && step.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${step.currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`);
	else if (step.currentTool) facts.push(step.currentTool);
	if (step.currentPath) facts.push(shortenPath(step.currentPath));
	if (step.turnCount !== undefined) facts.push(`${step.turnCount} turns`);
	if (step.toolCount !== undefined) facts.push(`${step.toolCount} tools`);
	if (step.tokens?.total) facts.push(formatTokenStat(step.tokens.total));
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	return facts.join(" · ");
}


function widgetChainDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth()): string[] {
	if (!job.steps?.length) return [];
	const total = job.chainStepCount ?? job.steps.length;
	const lines: string[] = [];
	for (const span of buildAsyncChainStepSpans(total, job.steps.length, job.parallelGroups)) {
		const steps = job.steps.slice(span.start, span.start + span.count);
		if (span.isParallel) {
			const status = aggregateStepStatus(steps);
			lines.push(`  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(steps))} Step ${span.stepIndex + 1}/${total}: ${themeBold(theme, "parallel group")} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(steps, span.count))}`);
			continue;
		}
		const step = steps[0];
		if (!step) {
			lines.push(`  ${theme.fg("dim", `◦ Step ${span.stepIndex + 1}/${total}: pending`)}`);
			continue;
		}
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, "Step", span.stepIndex + 1, total, expanded, width));
	}
	return lines;
}

function widgetParallelAgentDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth()): string[] {
	if (!job.steps?.length) return [];
	if (job.mode !== "parallel" && job.mode !== "chain") return [];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width);
	const total = job.stepsTotal ?? job.steps.length;
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		const marker = index === job.steps.length - 1 ? "└" : "├";
		const activity = widgetStepActivity(step, job.updatedAt);
		const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		lines.push(`  ${theme.fg("dim", `${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${step.agent} · ${widgetStepStatus(step.status, theme)}${modelDisplay}${activity ? ` · ${activity}` : ""}`)}`);
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, expanded ? 8 : 1)) lines.push(`    ${nestedLine}`);
	}
	return lines;
}

function parseParallelGroupAgentCount(label: string | undefined): number | undefined {
	if (!label || !label.startsWith("[") || !label.endsWith("]")) return undefined;
	const inner = label.slice(1, -1).trim();
	if (!inner) return 0;
	return inner.split("+").map((part) => part.trim()).filter(Boolean).length;
}

interface ChainStepSpan {
	stepIndex: number;
	start: number;
	count: number;
	isParallel: boolean;
	status?: WorkflowNodeStatus;
	label?: string;
	error?: string;
}

function buildChainStepSpans(details: Pick<Details, "chainAgents" | "workflowGraph">): ChainStepSpan[] {
	if (details.workflowGraph?.nodes?.length) {
		const spans: ChainStepSpan[] = [];
		let flatCursor = 0;
		for (const node of details.workflowGraph.nodes) {
			if (node.stepIndex === undefined) continue;
			if (node.kind === "parallel-group" || node.kind === "dynamic-parallel-group") {
				const childFlatIndexes = (node.children ?? [])
					.map((child) => child.flatIndex)
					.filter((value): value is number => typeof value === "number");
				const start = childFlatIndexes.length ? Math.min(...childFlatIndexes) : flatCursor;
				const count = node.children?.length ?? 0;
				spans.push({ stepIndex: node.stepIndex, start, count, isParallel: true, status: node.status, label: node.label, error: node.error });
				flatCursor = Math.max(flatCursor, start + count);
				continue;
			}
			const start = node.flatIndex ?? flatCursor;
			spans.push({ stepIndex: node.stepIndex, start, count: 1, isParallel: false, status: node.status, label: node.label, error: node.error });
			flatCursor = Math.max(flatCursor, start + 1);
		}
		if (spans.length) return spans.sort((left, right) => left.stepIndex - right.stepIndex);
	}

	if (!details.chainAgents?.length) return [];
	const spans: ChainStepSpan[] = [];
	let start = 0;
	for (let stepIndex = 0; stepIndex < details.chainAgents.length; stepIndex++) {
		const label = details.chainAgents[stepIndex]!;
		const parsedCount = parseParallelGroupAgentCount(label);
		const count = parsedCount ?? 1;
		spans.push({ stepIndex, start, count, isParallel: parsedCount !== undefined });
		start += count;
	}
	return spans;
}

function isChainParallelGroupActive(details: Pick<Details, "mode" | "chainAgents" | "currentStepIndex" | "workflowGraph">): boolean {
	if (details.mode !== "chain") return false;
	if (details.currentStepIndex === undefined) return false;
	return buildChainStepSpans(details).some((span) => span.stepIndex === details.currentStepIndex && span.isParallel);
}

function buildAsyncChainStepSpans(total: number, stepCount: number, parallelGroups: AsyncParallelGroupStatus[] = []): ChainStepSpan[] {
	const spans: ChainStepSpan[] = [];
	let flatIndex = 0;
	for (let stepIndex = 0; stepIndex < total; stepIndex++) {
		const group = parallelGroups.find((candidate) => candidate.stepIndex === stepIndex);
		if (group) {
			spans.push({ stepIndex, start: group.start, count: group.count, isParallel: true });
			flatIndex = Math.max(flatIndex, group.start + group.count);
			continue;
		}
		spans.push({ stepIndex, start: flatIndex, count: flatIndex < stepCount ? 1 : 0, isParallel: false });
		flatIndex++;
	}
	return spans;
}

function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted || result.detached) return false;
	return result.exitCode === 0;
}

function workflowGraphHasStatus(details: Pick<Details, "workflowGraph">, statuses: WorkflowNodeStatus[]): boolean {
	return details.workflowGraph?.nodes.some((node) => statuses.includes(node.status)) ?? false;
}

interface ChainRenderResultEntry {
	kind: "result";
	resultIndex: number;
	rowNumber: number;
	agentName: string;
}

interface ChainRenderPlaceholderEntry {
	kind: "placeholder";
	rowNumber: number;
	stepLabel: string;
	agentName: string;
	status: WorkflowNodeStatus;
	error?: string;
}

type ChainRenderEntry = ChainRenderResultEntry | ChainRenderPlaceholderEntry;

function buildChainRenderEntries(details: Details, label: MultiProgressLabel): ChainRenderEntry[] | undefined {
	if (details.mode !== "chain" || !label.hasParallelInChain || label.showActiveGroupOnly) return undefined;
	const entries: ChainRenderEntry[] = [];
	for (const span of buildChainStepSpans(details)) {
		if (span.isParallel && span.count === 0) {
			entries.push({
				kind: "placeholder",
				rowNumber: span.stepIndex + 1,
				stepLabel: `Step ${span.stepIndex + 1}`,
				agentName: span.label ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
				status: span.status ?? "pending",
				error: span.error,
			});
			continue;
		}
		for (let index = span.start; index < span.start + span.count; index++) {
			entries.push({
				kind: "result",
				resultIndex: index,
				rowNumber: index + 1,
				agentName: details.results[index]?.agent ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
			});
		}
	}
	return entries;
}

interface MultiProgressLabel {
	headerLabel: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	hasParallelInChain: boolean;
	activeParallelGroup: boolean;
	groupStartIndex: number;
	groupEndIndex: number;
	showActiveGroupOnly: boolean;
}

function buildMultiProgressLabel(details: Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "chainAgents" | "workflowGraph">, hasRunning: boolean): MultiProgressLabel {
	const stepSpans = buildChainStepSpans(details);
	const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
	const activeParallelGroup = isChainParallelGroupActive(details);
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

	if (details.mode === "parallel") {
		const totalCount = details.totalSteps ?? details.results.length;
		const statuses = new Array(totalCount).fill("pending") as Array<"pending" | "running" | "completed" | "failed" | "stopped" | "detached">;
		for (const progress of details.progress ?? []) {
			if (progress.index >= 0 && progress.index < totalCount) statuses[progress.index] = progress.status;
		}
		for (let i = 0; i < details.results.length; i++) {
			const result = details.results[i]!;
			const progressFromArray = details.progress?.find((progress) => progress.index === i)
				|| details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
			const index = result.progress?.index ?? progressFromArray?.index ?? i;
			if (index < 0 || index >= totalCount) continue;
			const status = result.progress?.status
				?? (result.stopped
					? "stopped"
					: result.interrupted || result.detached
						? "detached"
						: result.exitCode === 0
							? "completed"
							: "failed");
			statuses[index] = status;
		}
		const running = statuses.filter((status) => status === "running").length;
		const done = statuses.filter((status) => status === "completed").length;
		const headerLabel = hasRunning
			? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
			: `${done}/${totalCount} done`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: totalCount, showActiveGroupOnly: false };
	}

	if (activeParallelGroup) {
		const currentStepIndex = details.currentStepIndex!;
		const span = stepSpans[currentStepIndex];
		const groupSize = span?.count ?? 1;
		const groupStart = span?.start ?? 0;
		const groupEnd = groupStart + groupSize;
		let running = 0;
		let done = 0;
		for (let index = groupStart; index < groupEnd; index++) {
			const progressEntry = details.progress?.find((progress) => progress.index === index);
			const resultEntry = details.results.find((result) => result.progress?.index === index);
			if (progressEntry?.status === "running") {
				running++;
				continue;
			}
			if (progressEntry?.status === "completed") {
				done++;
				continue;
			}
			if (resultEntry && isDoneResult(resultEntry)) done++;
		}
		const totalSteps = details.totalSteps ?? details.chainAgents?.length ?? 1;
		const headerLabel = hasRunning
			? `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${formatAgentRunningLabel(running)} · ${done}/${groupSize} done`
			: `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
		return { headerLabel, itemTitle, totalCount: groupSize, hasParallelInChain, activeParallelGroup, groupStartIndex: groupStart, groupEndIndex: groupEnd, showActiveGroupOnly: true };
	}

	if (details.mode === "chain" && details.chainAgents?.length) {
		const totalCount = details.totalSteps ?? details.chainAgents.length;
		const doneLogical = stepSpans.filter((span) => {
			if (span.status && span.status !== "completed") return false;
			if (span.count === 0) return span.status === "completed";
			for (let index = span.start; index < span.start + span.count; index++) {
				const progressEntry = details.progress?.find((progress) => progress.index === index);
				const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
				if (progressEntry?.status === "running" || progressEntry?.status === "pending" || progressEntry?.status === "failed") return false;
				if (!resultEntry || !isDoneResult(resultEntry)) return false;
			}
			return true;
		}).length;
		const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, doneLogical + (hasRunning ? 1 : 0));
		const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${doneLogical}/${totalCount}`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
	}

	const totalCount = details.totalSteps ?? details.results.length;
	const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0));
	const done = details.results.filter(isDoneResult).length;
	const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
	return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
}

function resultRowLabel(details: Pick<Details, "mode" | "chainAgents" | "workflowGraph">, label: MultiProgressLabel, resultIndex: number, stepNumber: number): string {
	if (details.mode === "chain" && label.hasParallelInChain) {
		const span = buildChainStepSpans(details).find((candidate) => resultIndex >= candidate.start && resultIndex < candidate.start + candidate.count);
		if (span?.isParallel) return `Agent ${resultIndex - span.start + 1}/${span.count}`;
		if (span) return `Step ${span.stepIndex + 1}`;
	}
	if (label.itemTitle === "Agent") {
		const localStepNumber = label.activeParallelGroup
			? Math.max(1, stepNumber - label.groupStartIndex)
			: stepNumber;
		return `Agent ${localStepNumber}/${label.totalCount}`;
	}
	return `Step ${stepNumber}`;
}

function widgetStats(job: AsyncJobState, theme: Theme): string {
	const parts: string[] = [];
	const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
	if (job.activeParallelGroup) {
		const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
		const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
		if (job.mode === "parallel") {
			if (job.status === "running" && running > 0) parts.push(formatAgentRunningLabel(running));
			if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
		} else {
			const activeGroup = job.currentStep !== undefined
				? job.parallelGroups?.find((group) => job.currentStep! >= group.start && job.currentStep! < group.start + group.count)
				: job.parallelGroups?.find((group) => group.start === 0);
			const logicalStep = activeGroup?.stepIndex ?? job.currentStep ?? 0;
			const total = job.chainStepCount ?? stepsTotal;
			const groupParts = [`${done}/${stepsTotal} done`];
			if (job.status === "running" && running > 0) groupParts.unshift(formatAgentRunningLabel(running));
			parts.push(`step ${logicalStep + 1}/${total} · parallel group: ${groupParts.join(" · ")}`);
		}
	} else if (job.currentStep !== undefined) {
		if (job.mode === "chain" && job.parallelGroups?.length) {
			const total = job.chainStepCount ?? stepsTotal;
			parts.push(`step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups) + 1}/${total}`);
		} else {
			parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
		}
	} else if (stepsTotal > 1) {
		parts.push(`steps ${stepsTotal}`);
	}
	if (job.toolCount !== undefined) parts.push(formatToolUseStat(job.toolCount));
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	if (job.startedAt !== undefined && job.updatedAt !== undefined) parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
	return statJoin(theme, parts);
}

function widgetStepStats(theme: Theme, step: NonNullable<AsyncJobState["steps"]>[number]): string {
	return statJoin(theme, [
		step.turnCount !== undefined ? `${step.turnCount} turns` : "",
		step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
		step.tokens?.total ? formatTokenStat(step.tokens.total) : "",
		step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
	]);
}

function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
	const label = formatModelThinking(model, thinking);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

function widgetStepActivityLine(step: NonNullable<AsyncJobState["steps"]>[number], width: number, expanded: boolean, snapshotNow?: number): string {
	const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
	if (toolLine) return toolLine;
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity) return activity;
	if (step.status === "running") return "thinking…";
	return "";
}

function widgetOutputPath(job: AsyncJobState, step: NonNullable<AsyncJobState["steps"]>[number]): string | undefined {
	if (typeof step.index !== "number") return undefined;
	return path.join(job.asyncDir, `output-${step.index}.log`);
}

function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return formatWidgetAgents(run.agents);
	return run.id;
}

function nestedStatusGlyph(state: NestedRunSummary["state"] | NestedStepSummary["status"], theme: Theme, seed?: number): string {
	if (state === "running") return theme.fg("accent", runningGlyph(seed));
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "paused") return theme.fg("warning", "■");
	if (state === "stopped") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

function nestedRunSeed(run: NestedRunSummary): number | undefined {
	return runningSeed(run.lastUpdate, run.lastActivityAt, run.currentStep, run.toolCount, run.turnCount, run.totalTokens?.total, run.currentToolStartedAt);
}

function formatClockTime(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms)) return undefined;
	const date = new Date(ms);
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function nestedRunEventTime(run: NestedRunSummary): number | undefined {
	return run.state === "running"
		? (run.lastActivityAt ?? run.currentToolStartedAt ?? run.lastUpdate ?? run.startedAt)
		: (run.endedAt ?? run.lastUpdate ?? run.lastActivityAt ?? run.startedAt);
}

function nestedStepTimestamp(step: NestedStepSummary, fallback?: number): string | undefined {
	return formatClockTime(step.status === "running"
		? (step.lastActivityAt ?? step.currentToolStartedAt ?? fallback ?? step.startedAt)
		: (step.endedAt ?? step.lastActivityAt ?? fallback ?? step.startedAt));
}

function nestedTimestampPrefix(timestamp: string | undefined): string {
	return timestamp ? `[${timestamp}] ` : "";
}

function nestedActivity(input: Pick<NestedRunSummary | NestedStepSummary, "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount">, state: NestedRunSummary["state"] | NestedStepSummary["status"], snapshotNow?: number): string {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(input.currentTool);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = buildLiveStatusLine(input, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (state === "running") return "thinking…";
	if (state === "queued" || state === "pending") return "queued…";
	if (state === "paused") return "Paused";
	if (state === "stopped") return "Stopped";
	if (state === "failed") return "Failed";
	return "Done";
}

function formatNestedWidgetLines(children: NestedRunSummary[] | undefined, theme: Theme, width: number, expanded: boolean, snapshotNow?: number, lineBudget = expanded ? 12 : 1): string[] {
	if (!children?.length || lineBudget <= 0) return [];
	if (!expanded) {
		const aggregate = formatNestedAggregate(children);
		const latest = children.reduce((acc, child) => Math.max(acc, nestedRunEventTime(child) ?? 0), 0);
		return aggregate ? [theme.fg("dim", `↳ ${nestedTimestampPrefix(formatClockTime(latest))}${aggregate}`)] : [];
	}
	const lines: string[] = [];
	const maxDepth = 2;
	const append = (items: NestedRunSummary[] | undefined, depth: number, prefix: string): void => {
		if (!items?.length || lines.length >= lineBudget) return;
		if (depth > maxDepth) {
			const aggregate = formatNestedAggregate(items);
			if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= lineBudget) {
				const aggregate = formatNestedAggregate(items.slice(index));
				if (aggregate) lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
				return;
			}
			const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate);
			const error = child.error ? ` · ${child.error}` : "";
			lines.push(theme.fg("dim", `${prefix}↳ ${nestedTimestampPrefix(formatClockTime(nestedRunEventTime(child)))}${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`));
			if (depth === maxDepth) {
				const aggregate = formatNestedAggregate([...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])]);
				if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
				continue;
			}
			for (const step of child.steps ?? []) {
				if (lines.length >= lineBudget) return;
				lines.push(theme.fg("dim", `${prefix}  ↳ ${nestedTimestampPrefix(nestedStepTimestamp(step, child.lastUpdate))}${nestedStatusGlyph(step.status, theme)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`));
				append(step.children, depth + 1, `${prefix}    `);
			}
			append(child.children, depth + 1, `${prefix}  `);
		}
	};
	append(children, 0, "");
	return lines.map((line) => truncLine(line, width));
}

function foregroundStyleWidgetStepLines(
	job: AsyncJobState,
	theme: Theme,
	step: NonNullable<AsyncJobState["steps"]>[number],
	itemTitle: "Agent" | "Step",
	index: number,
	total: number,
	expanded: boolean,
	width: number,
): string[] {
	const status = widgetStepStatus(step.status, theme);
	const stats = widgetStepStats(theme, step);
	const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
	const lines = [`  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index - 1))} ${itemTitle} ${index}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`];
	const activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
	if (activity) lines.push(`    ${theme.fg("dim", `⎿  ${activity}`)}`);
	for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt)) {
		lines.push(`    ${nestedLine}`);
	}
	if (step.status === "running") {
		if (!expanded) lines.push(`    ${theme.fg("accent", liveDetailHintText())}`);
		const output = widgetOutputPath(job, step);
		if (output) lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
		if (expanded) {
			const liveStatus = buildLiveStatusLine(step, job.updatedAt);
			if (liveStatus && liveStatus !== activity) lines.push(`    ${theme.fg("accent", liveStatus)}`);
			for (const tool of step.recentTools?.slice(-3) ?? []) {
				const maxArgsLen = Math.max(40, width - 30);
				const argsPreview = tool.args.length <= maxArgsLen ? tool.args : `${tool.args.slice(0, maxArgsLen)}...`;
				lines.push(`      ${theme.fg("dim", `${tool.tool}${argsPreview ? `: ${argsPreview}` : ""}`)}`);
			}
			for (const line of step.recentOutput?.slice(-5) ?? []) {
				lines.push(`      ${theme.fg("dim", line)}`);
			}
		}
	}
	return lines;
}

function foregroundStyleWidgetDetails(job: AsyncJobState, theme: Theme, expanded: boolean, width: number): string[] {
	if (!job.steps?.length) return [
		`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
		...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt).map((line) => `  ${line}`),
	];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width);
	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, itemTitle, index + 1, total, expanded, width));
	}
	const attached = new Set(job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
	for (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt)) {
		lines.push(`  ${nestedLine}`);
	}
	return lines;
}

function buildSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number, expanded: boolean): string[] {
	const stats = widgetStats(job, theme);
	const count = job.mode === "chain" ? job.chainStepCount : job.stepsTotal ?? job.agents?.length ?? job.steps?.length;
	const mode = widgetJobName(job);
	const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
	return [
		`${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`,
		`${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
		...foregroundStyleWidgetDetails(job, theme, expanded, width),
	].map((line) => truncLine(line, width));
}

function compactSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number): string[] {
	const fullLines = buildSingleWidgetLines(job, theme, width, false);
	if (fullLines.length <= 10 || !job.steps?.length || (job.mode !== "parallel" && !job.activeParallelGroup)) return fullLines;

	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines = fullLines.slice(0, 2);
	for (const [index, step] of job.steps.entries()) {
		const status = widgetStepStatus(step.status, theme);
		const activity = widgetStepActivityLine(step, width, false, job.updatedAt);
		const stepStats = widgetStepStats(theme, step);
		const activitySuffix = activity ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : "";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		lines.push(`  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${activitySuffix}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`);
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt)) lines.push(`    ${nestedLine}`);
	}
	if (job.steps.some((step) => step.status === "running")) lines.push(theme.fg("accent", `  ${liveDetailHintText()}`));
	return lines.map((line) => truncLine(line, width));
}

type WidgetRenderTier = "full" | "single-line" | "progressive";

interface WidgetLayoutSession {
	expanded: boolean;
	rows: number;
	columns: number;
	tier: WidgetRenderTier;
	lockedRows?: number;
	visibleJobKeys: string[];
}

const RESERVED_NON_WIDGET_ROWS = 19;

let widgetLayoutSession: WidgetLayoutSession | undefined;

function resetWidgetLayoutSession(): void {
	widgetLayoutSession = undefined;
}

function estimateAvailableWidgetRows(): number {
	const rows = process.stdout.rows || 30;
	return Math.max(1, rows - RESERVED_NON_WIDGET_ROWS);
}

function currentTerminalRows(): number {
	return process.stdout.rows || 30;
}

function currentTerminalColumns(): number {
	return process.stdout.columns || 120;
}

function widgetSessionMatches(expanded: boolean): boolean {
	return widgetLayoutSession?.expanded === expanded
		&& widgetLayoutSession.rows === currentTerminalRows()
		&& widgetLayoutSession.columns === currentTerminalColumns();
}

function widgetHeaderCounts(jobs: AsyncJobState[]): { running: AsyncJobState[]; queued: AsyncJobState[]; complete: AsyncJobState[]; failed: AsyncJobState[]; paused: AsyncJobState[]; stopped: AsyncJobState[] } {
	return {
		running: jobs.filter((job) => job.status === "running"),
		queued: jobs.filter((job) => job.status === "queued"),
		complete: jobs.filter((job) => job.status === "complete"),
		failed: jobs.filter((job) => job.status === "failed"),
		paused: jobs.filter((job) => job.status === "paused"),
		stopped: jobs.filter((job) => job.status === "stopped"),
	};
}

function buildSingleLineWidgetLines(jobs: AsyncJobState[], theme: Theme, width: number): string[] {
	const counts = widgetHeaderCounts(jobs);
	const hasActive = counts.running.length > 0 || counts.queued.length > 0;
	const glyph = counts.running.length > 0 ? runningGlyph(widgetJobsRunningSeed(counts.running)) : hasActive ? "●" : "○";
	const parts: string[] = [];
	if (counts.running.length > 0) parts.push(`${counts.running.length}/${jobs.length} running`);
	if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
	if (counts.failed.length > 0) parts.push(`${counts.failed.length} failed`);
	if (counts.stopped.length > 0) parts.push(`${counts.stopped.length} stopped`);
	if (counts.paused.length > 0) parts.push(`${counts.paused.length} paused`);
	if (!hasActive && counts.complete.length > 0) parts.push(`${counts.complete.length}/${jobs.length} done`);
	return [truncLine(`${theme.fg(hasActive ? "accent" : "dim", glyph)} ${theme.fg(hasActive ? "accent" : "dim", "subagents")} (${parts.join(", ") || `${jobs.length} total`})`, width)];
}

function orderedWidgetJobs(jobs: AsyncJobState[]): AsyncJobState[] {
	return [
		...jobs.filter((job) => job.status === "running"),
		...jobs.filter((job) => job.status === "queued"),
		...jobs.filter((job) => job.status !== "running" && job.status !== "queued"),
	];
}

function progressiveJobKey(job: AsyncJobState): string {
	return job.asyncId;
}

function isProgressiveActiveJob(job: AsyncJobState | undefined): boolean {
	return job?.status === "running" || job?.status === "queued";
}

function selectProgressiveJobKeys(jobs: AsyncJobState[], previousKeys: string[], bodyRows: number): string[] {
	if (bodyRows <= 0) return [];
	const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
	const selected: string[] = [];
	const append = (key: string): void => {
		if (selected.includes(key) || !jobsByKey.has(key)) return;
		selected.push(key);
	};
	for (const key of previousKeys) {
		if (!isProgressiveActiveJob(jobsByKey.get(key))) continue;
		append(key);
		if (selected.length >= bodyRows) return selected;
	}
	for (const job of orderedWidgetJobs(jobs)) {
		if (!isProgressiveActiveJob(job)) continue;
		const key = progressiveJobKey(job);
		append(key);
		if (selected.length >= bodyRows) break;
	}
	if (selected.length >= bodyRows) return selected;
	for (const key of previousKeys) {
		if (isProgressiveActiveJob(jobsByKey.get(key))) continue;
		append(key);
		if (selected.length >= bodyRows) return selected;
	}
	for (const job of orderedWidgetJobs(jobs)) {
		const key = progressiveJobKey(job);
		append(key);
		if (selected.length >= bodyRows) break;
	}
	return selected;
}

function progressiveHeaderLine(jobs: AsyncJobState[], theme: Theme, width: number): string {
	const counts = widgetHeaderCounts(jobs);
	const hasActive = counts.running.length > 0 || counts.queued.length > 0;
	const glyph = counts.running.length > 0 ? runningGlyph(widgetJobsRunningSeed(counts.running)) : hasActive ? "●" : "○";
	const parts: string[] = [];
	if (counts.running.length > 0) parts.push(formatAgentRunningLabel(counts.running.length));
	if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
	if (!hasActive) {
		if (counts.failed.length > 0) parts.push(`${counts.failed.length} failed`);
		if (counts.stopped.length > 0) parts.push(`${counts.stopped.length} stopped`);
		if (counts.paused.length > 0) parts.push(`${counts.paused.length} paused`);
		if (counts.complete.length > 0) parts.push(`${counts.complete.length}/${jobs.length} done`);
	}
	return truncLine(`${theme.fg(hasActive ? "accent" : "dim", glyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(", ") || `${jobs.length} total`)}`, width);
}

function progressiveJobLine(job: AsyncJobState, theme: Theme, width: number): string {
	const stats = widgetStats(job, theme);
	const activity = widgetActivity(job);
	const status = job.status === "complete" ? "done" : job.status;
	const parts = [
		themeBold(theme, widgetJobName(job)),
		theme.fg("dim", status),
		stats,
		activity && activity.toLowerCase() !== status ? theme.fg("dim", activity) : "",
	].filter(Boolean);
	return truncLine(`  ${widgetStatusGlyph(job, theme)} ${parts.join(` ${theme.fg("dim", "·")} `)}`, width);
}

function progressiveHiddenLine(hiddenJobs: AsyncJobState[], theme: Theme, width: number): string {
	const counts = widgetHeaderCounts(hiddenJobs);
	const parts: string[] = [];
	if (counts.running.length > 0) parts.push(`${counts.running.length} running`);
	if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
	const finished = counts.complete.length + counts.failed.length + counts.paused.length + counts.stopped.length;
	if (finished > 0) parts.push(`${finished} finished`);
	return truncLine(theme.fg("dim", `  +${hiddenJobs.length} more${parts.length ? ` (${parts.join(", ")})` : ""}`), width);
}

function buildProgressiveWidgetLines(jobs: AsyncJobState[], theme: Theme, width: number, lockedRows: number, previousKeys: string[]): { lines: string[]; visibleJobKeys: string[] } {
	const rowCount = Math.max(1, lockedRows);
	if (rowCount === 1) return { lines: buildSingleLineWidgetLines(jobs, theme, width), visibleJobKeys: [] };

	const bodyRows = rowCount - 1;
	let visibleJobKeys = selectProgressiveJobKeys(jobs, previousKeys, bodyRows);
	const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
	let visibleJobs = visibleJobKeys.map((key) => jobsByKey.get(key)).filter((job): job is AsyncJobState => Boolean(job));
	let hiddenJobs = jobs.filter((job) => !visibleJobKeys.includes(progressiveJobKey(job)));
	const needsHiddenLine = hiddenJobs.length > 0;

	if (needsHiddenLine && visibleJobs.length >= bodyRows && bodyRows > 0) {
		visibleJobs = visibleJobs.slice(0, bodyRows - 1);
		visibleJobKeys = visibleJobs.map(progressiveJobKey);
		hiddenJobs = jobs.filter((job) => !visibleJobKeys.includes(progressiveJobKey(job)));
	}

	const lines = [
		progressiveHeaderLine(jobs, theme, width),
		...visibleJobs.map((job) => progressiveJobLine(job, theme, width)),
	];
	if (hiddenJobs.length > 0 && lines.length < rowCount) lines.push(progressiveHiddenLine(hiddenJobs, theme, width));
	while (lines.length < rowCount) lines.push(" ");
	return { lines: lines.slice(0, rowCount), visibleJobKeys };
}

function collapsedWidgetLineBudget(rows: number): number {
	return Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
}

function fitWidgetLineBudget(lines: string[], theme: Theme, width: number, expanded: boolean): string[] {
	const rows = process.stdout.rows || 30;
	const budget = expanded
		? Math.max(12, Math.min(24, Math.floor(rows * 0.55)))
		: collapsedWidgetLineBudget(rows);
	if (lines.length <= budget) return lines;
	const visibleLines = Math.max(1, budget - 1);
	const hiddenCount = lines.length - visibleLines;
	const hint = expanded
		? `… ${hiddenCount} live-detail lines hidden`
		: `… ${hiddenCount} lines hidden · ${liveDetailKeyText()} expands`;
	return [...lines.slice(0, visibleLines), truncLine(theme.fg("dim", hint), width)];
}

function fitAdaptiveWidgetLines(jobs: AsyncJobState[], lines: string[], theme: Theme, width: number, expanded: boolean): string[] {
	if (expanded) {
		resetWidgetLayoutSession();
		return fitWidgetLineBudget(lines, theme, width, true);
	}

	const hasMatchingSession = widgetSessionMatches(expanded);
	const rows = currentTerminalRows();
	const columns = currentTerminalColumns();
	const availableRows = estimateAvailableWidgetRows();

	if (hasMatchingSession && widgetLayoutSession?.tier === "single-line") {
		return buildSingleLineWidgetLines(jobs, theme, width);
	}

	if (hasMatchingSession && widgetLayoutSession?.tier === "progressive" && widgetLayoutSession.lockedRows !== undefined) {
		const rendered = buildProgressiveWidgetLines(jobs, theme, width, widgetLayoutSession.lockedRows, widgetLayoutSession.visibleJobKeys);
		widgetLayoutSession.visibleJobKeys = rendered.visibleJobKeys;
		return rendered.lines;
	}

	if (lines.length <= availableRows) {
		widgetLayoutSession = { expanded, rows, columns, tier: "full", visibleJobKeys: [] };
		return fitWidgetLineBudget(lines, theme, width, false);
	}

	if (availableRows <= 2) {
		widgetLayoutSession = { expanded, rows, columns, tier: "single-line", visibleJobKeys: [] };
		return buildSingleLineWidgetLines(jobs, theme, width);
	}

	const lockedRows = Math.min(availableRows, collapsedWidgetLineBudget(rows));
	const rendered = buildProgressiveWidgetLines(jobs, theme, width, lockedRows, []);
	widgetLayoutSession = { expanded, rows, columns, tier: "progressive", lockedRows, visibleJobKeys: rendered.visibleJobKeys };
	return rendered.lines;
}

function buildWidgetComponent(jobs: AsyncJobState[], expanded: boolean): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => {
		const width = getTermWidth();
		const lines = expanded
			? buildWidgetLines(jobs, theme, width, true)
			: jobs.length === 1
				? compactSingleWidgetLines(jobs[0]!, theme, width)
				: buildWidgetLines(jobs, theme, width, false);
		const container = new Container();
		for (const line of fitAdaptiveWidgetLines(jobs, lines, theme, width, expanded)) container.addChild(new Text(line, 1, 0));
		return container;
	};
}

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth(), expanded = false): string[] {
	if (jobs.length === 0) return [];
	if (jobs.length === 1) return buildSingleWidgetLines(jobs[0]!, theme, width, expanded);
	const running = jobs.filter((job) => job.status === "running");
	const queued = jobs.filter((job) => job.status === "queued");
	const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");

	const lines: string[] = [];
	const hasActive = running.length > 0 || queued.length > 0;
	const headerGlyph = running.length > 0 ? runningGlyph(widgetJobsRunningSeed(running)) : hasActive ? "●" : "○";
	lines.push(truncLine(`${theme.fg(hasActive ? "accent" : "dim", headerGlyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background")}`, width));

	const items: string[][] = [];
	let hiddenRunning = 0;
	let hiddenFinished = 0;
	let queuedSummaryShown = false;
	let slots = MAX_WIDGET_JOBS;

	for (const job of running) {
		if (slots <= 0) { hiddenRunning++; continue; }
		const stats = widgetStats(job, theme);
		items.push([
			`${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
			`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
			...widgetParallelAgentDetails(job, theme, expanded, width),
		]);
		slots--;
	}

	if (queued.length > 0 && slots > 0) {
		items.push([`${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`]);
		queuedSummaryShown = true;
		slots--;
	}

	for (const job of finished) {
		if (slots <= 0) { hiddenFinished++; continue; }
		const stats = widgetStats(job, theme);
		items.push([
			`${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
			`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
			...widgetParallelAgentDetails(job, theme, expanded, width),
		]);
		slots--;
	}

	const hiddenQueued = queued.length > 0 && !queuedSummaryShown ? queued.length : 0;
	const hiddenTotal = hiddenRunning + hiddenFinished + hiddenQueued;
	if (hiddenTotal > 0) {
		const parts: string[] = [];
		if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
		if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
		if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
		items.push([theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)]);
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const last = i === items.length - 1;
		const branch = last ? "└─" : "├─";
		const continuation = last ? "   " : "│  ";
		lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0]}`, width));
		for (const detail of item.slice(1)) {
			lines.push(truncLine(`${theme.fg("dim", continuation)} ${detail}`, width));
		}
	}

	return lines;
}

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (jobs.length === 0) {
		resetWidgetLayoutSession();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(jobs, ctx.ui.getToolsExpanded?.() ?? false));
}

function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme, frame?: number): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = r.progress?.status === "running";
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const stats = statJoin(theme, [
		r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
		formatProgressStats(theme, progress),
	]);
	const c = new Container();
	const width = getTermWidth() - 4;
	const modelDisplay = modelThinkingBadge(theme, r.model);
	c.addChild(new Text(truncLine(`${resultGlyph(r, output, theme, isRunning, undefined, frame)} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelDisplay}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	if (isRunning && r.progress) {
		const progressSnapshotNow = snapshotNowForProgress(r.progress);
		const activity = compactCurrentActivity(r.progress);
		c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${activity}`), width), 0, 0));
		const liveStatus = buildLiveStatusLine(r.progress, progressSnapshotNow);
		if (liveStatus && liveStatus !== activity) c.addChild(new Text(truncLine(theme.fg("dim", `     ${liveStatus}`), width), 0, 0));
		for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, progressSnapshotNow)) {
			c.addChild(new Text(truncLine(`  ${nestedLine}`, width), 0, 0));
		}
		c.addChild(new Text(truncLine(theme.fg("accent", `  ${liveDetailHintText()}`), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
		return c;
	}

	for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, r.progress?.lastActivityAt)) {
		c.addChild(new Text(truncLine(`  ${nestedLine}`, width), 0, 0));
	}
	c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
	const preview = firstOutputLine(output);
	if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
		c.addChild(new Text(truncLine(theme.fg("dim", `     ${preview}`), width), 0, 0));
	}
	if (r.sessionFile) c.addChild(new Text(truncLine(theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`), width), 0, 0));
	if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	if (r.truncation?.artifactPath) c.addChild(new Text(truncLine(theme.fg("dim", `  full output: ${shortenPath(r.truncation.artifactPath)}`), width), 0, 0));
	return c;
}

function renderMultiCompact(d: Details, theme: Theme, frame?: number): Component {
	const hasRunning = d.progress?.some((p) => p.status === "running")
		|| d.results.some((r) => r.progress?.status === "running")
		|| workflowGraphHasStatus(d, ["running"]);
	const stopped = d.results.some((r) => r.stopped && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["stopped"]);
	const failed = d.results.some((r) => !r.stopped && r.exitCode !== 0 && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["failed"]);
	const paused = d.results.some((r) => (r.interrupted || r.detached) && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["paused", "detached"]);
	let totalSummary = d.progressSummary;
	if (!totalSummary) {
		let sawProgress = false;
		const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
		for (const r of d.results) {
			const prog = r.progress || r.progressSummary;
			if (!prog) continue;
			sawProgress = true;
			summary.toolCount += prog.toolCount;
			summary.tokens += prog.tokens;
			summary.durationMs = d.mode === "chain" ? summary.durationMs + prog.durationMs : Math.max(summary.durationMs, prog.durationMs);
		}
		if (sawProgress) totalSummary = summary;
	}
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	const stats = statJoin(theme, [multiLabel.headerLabel, formatProgressStats(theme, totalSummary), formatTotalCostStat(d.totalCost)]);
	const glyph = hasRunning
		? theme.fg("accent", runningGlyph(frame !== undefined ? (runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex) ?? 0) + frame : runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex)))
		: stopped
			? theme.fg("warning", "■")
			: failed
				? theme.fg("error", "✗")
			: paused
				? theme.fg("warning", "■")
				: theme.fg("success", "✓");
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const c = new Container();
	const width = getTermWidth() - 4;
	c.addChild(new Text(truncLine(`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : (useResultsDirectly ? d.results.length : d.chainAgents!.length);
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
		const i = displayStart + offset;
		const r = d.results[i];
		const fallbackLabel = itemTitle.toLowerCase();
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		return { kind: "result", resultIndex: i, rowNumber, agentName: useResultsDirectly ? (r?.agent || `${fallbackLabel}-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `${fallbackLabel}-${rowNumber}`) };
	});
	for (const entry of renderEntries) {
		if (entry.kind === "placeholder") {
			const glyph = widgetStepGlyph(entry.status as AsyncJobStep["status"], theme);
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			c.addChild(new Text(truncLine(`  ${glyph} ${entry.stepLabel}: ${themeBold(theme, entry.agentName)} ${theme.fg("dim", "·")} ${statusLabel}`, width), 0, 0));
			if (entry.error) c.addChild(new Text(truncLine(theme.fg("error", `    ⎿  Error: ${entry.error}`), width), 0, 0));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;
		if (!r) {
			const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(truncLine(theme.fg("dim", `  ◦ ${pendingLabel}: ${agentName} · pending`), width), 0, 0));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg && "status" in rProg && rProg.status === "running";
		const rPending = rProg && "status" in rProg && rProg.status === "pending";
		const stepNumber = r.progress?.index !== undefined ? r.progress.index + 1 : progressFromArray?.index !== undefined ? progressFromArray.index + 1 : i + 1;
		const stepStats = formatProgressStats(theme, rProg);
		const glyph = rPending ? theme.fg("dim", "◦") : resultGlyph(r, output, theme, rRunning, progressRunningSeed(rProg), frame);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
		c.addChild(new Text(truncLine(`  ${line}`, width), 0, 0));
		if (rRunning && rProg && "status" in rProg) {
			const activity = compactCurrentActivity(rProg);
			c.addChild(new Text(truncLine(theme.fg("dim", `    ⎿  ${activity}`), width), 0, 0));
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, snapshotNowForProgress(rProg))) {
				c.addChild(new Text(truncLine(`    ${nestedLine}`, width), 0, 0));
			}
			c.addChild(new Text(truncLine(theme.fg("accent", `    ${liveDetailHintText()}`), width), 0, 0));
		} else if (!rPending && (r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))) {
			c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
		}
		if (!rRunning && !rPending) {
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, r.progress?.lastActivityAt)) {
				c.addChild(new Text(truncLine(`    ${nestedLine}`, width), 0, 0));
			}
		}
		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${outputTarget}`), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	}
	if (d.artifacts) c.addChild(new Text(truncLine(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`), width), 0, 0));
	return c;
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: Theme,
	frame?: number,
): Component {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
		const width = getTermWidth() - 4;
		if (!text.includes("\n")) return new Text(truncLine(`${contextPrefix}${text}`, width), 0, 0);
		const c = new Container();
		const wrapped = wrapPlainText(`${contextPrefix}${text}`, width);
		for (const line of wrapped) c.addChild(new Text(line, 0, 0));
		return c;
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		if (!expanded) return renderSingleCompact(d, r, theme, frame);
		const isRunning = r.progress?.status === "running";
		const icon = isRunning
			? theme.fg("warning", "running")
			: r.detached
				? theme.fg("warning", "detached")
				: r.exitCode === 0
					? theme.fg("success", "ok")
					: theme.fg("error", "failed");
		const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
		const output = r.truncation?.text || getSingleResultOutput(r);

		const progressInfo = isRunning && r.progress
			? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
			: r.progressSummary
				? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
				: "";

		const w = getTermWidth() - 4;
		const fit = (text: string) => expanded ? text : truncLine(text, w);
		const toolCallLines = getToolCallLines(r, expanded);
		const c = new Container();
		c.addChild(new Text(fit(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(
			new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0),
		);
		c.addChild(new Spacer(1));

		if (isRunning && r.progress) {
			const progressSnapshotNow = snapshotNowForProgress(r.progress);
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, progressSnapshotNow, 12)) {
				c.addChild(new Text(fit(`  ${nestedLine}`), 0, 0));
			}
			const toolLine = formatCurrentToolLine(r.progress, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(r.progress, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", liveDetailHintText())), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 24);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(fit(theme.fg("dim", `  ${line}`)), 0, 0));
			}
			if (toolLine || liveStatusLine || r.progress.recentTools?.length || r.progress.recentOutput?.length || r.artifactPaths) {
				c.addChild(new Spacer(1));
			}
		} else {
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, r.progress?.lastActivityAt, 8)) {
				c.addChild(new Text(fit(`  ${nestedLine}`), 0, 0));
			}
		}

		if (expanded) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", line)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}
		c.addChild(new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
		}

		if (!isRunning && r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}
		return c;
	}

	if (!expanded) return renderMultiCompact(d, theme, frame);

	const hasRunning = d.progress?.some((p) => p.status === "running") 
		|| d.results.some((r) => r.progress?.status === "running")
		|| workflowGraphHasStatus(d, ["running"]);
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0
		&& r.progress?.status !== "running"
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const hasWorkflowFailure = workflowGraphHasStatus(d, ["failed"]);
	const hasWorkflowStop = d.results.some((r) => r.stopped && r.progress?.status !== "running") || workflowGraphHasStatus(d, ["stopped"]);
	const hasWorkflowPause = workflowGraphHasStatus(d, ["paused", "detached"]);
	const icon = hasRunning
		? theme.fg("warning", "running")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "warning")
			: hasWorkflowFailure
				? theme.fg("error", "failed")
				: hasWorkflowStop
					? theme.fg("warning", "stopped")
					: hasWorkflowPause
						? theme.fg("warning", "paused")
					: ok === d.results.length
						? theme.fg("success", "ok")
						: theme.fg("error", "failed");

	const totalSummary =
		d.progressSummary ||
		d.results.reduce(
			(acc, r) => {
				const prog = r.progress || r.progressSummary;
				if (prog) {
					acc.toolCount += prog.toolCount;
					acc.tokens += prog.tokens;
					acc.durationMs =
						d.mode === "chain"
							? acc.durationMs + prog.durationMs
							: Math.max(acc.durationMs, prog.durationMs);
				}
				return acc;
			},
			{ toolCount: 0, tokens: 0, durationMs: 0 },
		);

	const summaryParts = [
		totalSummary.toolCount || totalSummary.tokens
			? `${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
			: "",
		formatTotalCostStat(d.totalCost),
	].filter(Boolean);
	const summaryStr = summaryParts.length ? ` | ${summaryParts.join(", ")}` : "";

	const modeLabel = d.mode;
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	
	const chainVis = d.chainAgents?.length && !multiLabel.hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const isFailed = result && result.exitCode !== 0 && result.progress?.status !== "running";
					const isComplete = result && result.exitCode === 0 && result.progress?.status !== "running";
					const isEmptyWithoutTarget = Boolean(result)
						&& Boolean(isComplete)
						&& hasEmptyTextOutputWithoutOutputTarget(result.task, getSingleResultOutput(result));
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepIcon = isFailed
						? theme.fg("error", "failed")
						: isEmptyWithoutTarget
							? theme.fg("warning", "warning")
							: isComplete
								? theme.fg("success", "done")
								: isCurrent && hasRunning
									? theme.fg("warning", "running")
									: theme.fg("dim", "pending");
					return `${stepIcon} ${agent}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const w = getTermWidth() - 4;
	const fit = (text: string) => expanded ? text : truncLine(text, w);
	const c = new Container();
	c.addChild(
		new Text(
			fit(`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
	}

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : (useResultsDirectly ? d.results.length : d.chainAgents!.length);
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
		const i = displayStart + offset;
		const r = d.results[i];
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		return { kind: "result", resultIndex: i, rowNumber, agentName: useResultsDirectly ? (r?.agent || `step-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `step-${rowNumber}`) };
	});

	c.addChild(new Spacer(1));

	for (const entry of renderEntries) {
		if (entry.kind === "placeholder") {
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			c.addChild(new Text(fit(`  ${statusLabel} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`), 0, 0));
			c.addChild(new Text(theme.fg(entry.status === "failed" ? "error" : "dim", `    status: ${entry.status}`), 0, 0));
			if (entry.error) c.addChild(new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;

		if (!r) {
			const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(fit(theme.fg("dim", `  ${pendingLabel}: ${agentName}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i) 
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";
		const stepNumber = typeof rProg?.index === "number" ? rProg.index + 1 : i + 1;

		const resultOutput = getSingleResultOutput(r);
		const statusIcon = rRunning
			? theme.fg("warning", "running")
			: r.exitCode !== 0
				? theme.fg("error", "failed")
				: hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
					? theme.fg("warning", "warning")
					: theme.fg("success", "done");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		const modelDisplay = modelThinkingBadge(theme, r.model);
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const stepHeader = rRunning
			? `${statusIcon} ${stepLabel}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} ${stepLabel}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
		const toolCallLines = getToolCallLines(r, expanded);
		c.addChild(new Text(fit(stepHeader), 0, 0));

		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(new Text(fit(theme.fg("dim", `    task: ${taskPreview}`)), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(fit(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `    Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(fit(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`)), 0, 0));
			}
			const progressSnapshotNow = snapshotNowForProgress(rProg);
			const toolLine = formatCurrentToolLine(rProg, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(rProg, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0));
			}
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, progressSnapshotNow, 8)) {
				c.addChild(new Text(fit(`    ${nestedLine}`), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", `    ${liveDetailHintText()}`)), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 30);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(fit(theme.fg("dim", `      ${line}`)), 0, 0));
			}
		}

		if (!rRunning) {
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, w, true, r.progress?.lastActivityAt, 8)) {
				c.addChild(new Text(fit(`    ${nestedLine}`), 0, 0));
			}
		}

		if (!rRunning && r.artifactPaths) {
			c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}

		if (expanded && !rRunning) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", `      ${line}`)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(fit(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)), 0, 0));
	}
	return c;
}
