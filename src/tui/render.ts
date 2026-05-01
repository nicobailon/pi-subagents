/**
 * Rendering functions for subagent results
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
import {
	type AgentProgress,
	type AsyncJobState,
	type Details,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "../shared/types.ts";
import { formatTokens, formatUsage, formatDuration, formatToolCall, shortenPath } from "../shared/formatters.ts";
import { getDisplayItems, getLastActivity, getSingleResultOutput } from "../shared/utils.ts";

type Theme = ExtensionContext["ui"]["theme"];

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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDGET_ANIMATION_MS = 80;

let widgetTimer: ReturnType<typeof setInterval> | undefined;
let latestWidgetCtx: ExtensionContext | undefined;
let latestWidgetJobs: AsyncJobState[] = [];

const resultAnimationTimers = new Map<ReturnType<typeof setInterval>, ResultAnimationContext["state"]>();
const outputActivityCache = new Map<string, { checkedAt: number; text: string }>();
const STALE_EXTENSION_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload";

interface ResultAnimationContext {
	state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
	invalidate: () => void;
}

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / WIDGET_ANIMATION_MS) % SPINNER.length]!;
}

function isStaleExtensionContextError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.includes(STALE_EXTENSION_CONTEXT_MESSAGE);
}

function resultIsRunning(result: AgentToolResult<Details>): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function stopResultAnimation(context: ResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (!timer) return;
	clearInterval(timer);
	resultAnimationTimers.delete(timer);
	context.state.subagentResultAnimationTimer = undefined;
}

export function syncResultAnimation(result: AgentToolResult<Details>, context: ResultAnimationContext): void {
	if (!resultIsRunning(result)) {
		stopResultAnimation(context);
		return;
	}
	if (context.state.subagentResultAnimationTimer) return;
	const timer = setInterval(() => {
		try {
			context.invalidate();
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			stopResultAnimation(context);
		}
	}, WIDGET_ANIMATION_MS);
	timer.unref?.();
	context.state.subagentResultAnimationTimer = timer;
	resultAnimationTimers.set(timer, context.state);
}

function extractOutputTarget(task: string): string | undefined {
	const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
	const findingsMatch = task.match(/Write your findings to:\s*(\S+)/i);
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

function formatActivityAge(ms: number): string {
	if (ms < 1000) return "now";
	if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
	return `${Math.floor(ms / 60000)}m`;
}

function formatActivityLabel(lastActivityAt: number | undefined, activityState?: AgentProgress["activityState"], now = Date.now()): string | undefined {
	if (lastActivityAt === undefined) {
		if (activityState === "needs_attention") return "needs attention";
		if (activityState === "active_long_running") return "active but long-running";
		return undefined;
	}
	const age = formatActivityAge(Math.max(0, now - lastActivityAt));
	if (activityState === "needs_attention") return `no activity for ${age}`;
	if (activityState === "active_long_running") return `active but long-running · last activity ${age} ago`;
	return age === "now" ? "active now" : `active ${age} ago`;
}

function formatCurrentToolLine(progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">, availableWidth: number, expanded: boolean): string | undefined {
	if (!progress.currentTool) return undefined;
	const maxToolArgsLen = Math.max(50, availableWidth - 20);
	const toolArgsPreview = progress.currentToolArgs
		? (expanded || progress.currentToolArgs.length <= maxToolArgsLen
			? progress.currentToolArgs
			: `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`)
		: "";
	const durationSuffix = progress.currentToolStartedAt !== undefined
		? ` | ${formatDuration(Math.max(0, Date.now() - progress.currentToolStartedAt))}`
		: "";
	return toolArgsPreview
		? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
		: `${progress.currentTool}${durationSuffix}`;
}

function buildLiveStatusLine(progress: Pick<AgentProgress, "activityState" | "lastActivityAt">): string | undefined {
	return formatActivityLabel(progress.lastActivityAt, progress.activityState);
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
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	return "Done";
}

function resultGlyph(result: Details["results"][number], output: string, theme: Theme, running = result.progress?.status === "running"): string {
	if (running) return theme.fg("accent", spinnerFrame());
	if (result.detached) return theme.fg("warning", "■");
	if (result.interrupted) return theme.fg("warning", "■");
	if (result.exitCode !== 0) return theme.fg("error", "✗");
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
	return theme.fg("success", "✓");
}

function compactCurrentActivity(progress: AgentProgress): string {
	return formatCurrentToolLine(progress, getTermWidth() - 4, false) ?? buildLiveStatusLine(progress) ?? "thinking…";
}

function hasAnimatedWidgetJobs(jobs: AsyncJobState[]): boolean {
	return jobs.some((job) => job.status === "running");
}

function widgetJobName(job: AsyncJobState): string {
	if (job.agents?.length) return job.agents.join(" → ");
	return job.mode ?? "subagent";
}

function getCachedLastActivity(outputFile: string | undefined): string {
	if (!outputFile) return "";
	const now = Date.now();
	const cached = outputActivityCache.get(outputFile);
	if (cached && now - cached.checkedAt < 1000) return cached.text;
	const text = getLastActivity(outputFile);
	outputActivityCache.set(outputFile, { checkedAt: now, text });
	return text;
}

function widgetActivity(job: AsyncJobState): string {
	const facts: string[] = [];
	if (job.currentTool && job.currentToolStartedAt !== undefined) facts.push(`${job.currentTool} ${formatDuration(Math.max(0, Date.now() - job.currentToolStartedAt))}`);
	else if (job.currentTool) facts.push(job.currentTool);
	if (job.currentPath) facts.push(shortenPath(job.currentPath));
	if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
	if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
	const activity = formatActivityLabel(job.lastActivityAt, job.activityState)
		?? (job.status === "running" ? getCachedLastActivity(job.outputFile) : "");
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (job.status === "queued") return "queued…";
	if (job.status === "paused") return "Paused";
	if (job.status === "failed") return "Failed";
	return "Done";
}

function widgetStatusGlyph(job: AsyncJobState, theme: Theme): string {
	if (job.status === "running") return theme.fg("accent", spinnerFrame());
	if (job.status === "queued") return theme.fg("muted", "◦");
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function parseParallelGroupAgentCount(label: string | undefined): number | undefined {
	if (!label || !label.startsWith("[") || !label.endsWith("]")) return undefined;
	const inner = label.slice(1, -1).trim();
	if (!inner) return 0;
	return inner.split("+").map((part) => part.trim()).filter(Boolean).length;
}

function isChainParallelGroupActive(details: Pick<Details, "mode" | "chainAgents" | "currentStepIndex">): boolean {
	if (details.mode !== "chain") return false;
	if (details.currentStepIndex === undefined) return false;
	const currentLabel = details.chainAgents?.[details.currentStepIndex];
	return parseParallelGroupAgentCount(currentLabel) !== undefined;
}

interface ChainStepSpan {
	stepIndex: number;
	start: number;
	count: number;
	isParallel: boolean;
}

function buildChainStepSpans(chainAgents: string[] | undefined): ChainStepSpan[] {
	if (!chainAgents?.length) return [];
	const spans: ChainStepSpan[] = [];
	let start = 0;
	for (let stepIndex = 0; stepIndex < chainAgents.length; stepIndex++) {
		const label = chainAgents[stepIndex]!;
		const parsedCount = parseParallelGroupAgentCount(label);
		const count = parsedCount ?? 1;
		spans.push({ stepIndex, start, count, isParallel: parsedCount !== undefined });
		start += count;
	}
	return spans;
}

function formatAgentRunningLabel(count: number): string {
	return count === 1 ? "1 agent running" : `${count} agents running`;
}

function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted || result.detached) return false;
	return result.exitCode === 0;
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

function buildMultiProgressLabel(details: Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "chainAgents">, hasRunning: boolean): MultiProgressLabel {
	const stepSpans = buildChainStepSpans(details.chainAgents);
	const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
	const activeParallelGroup = isChainParallelGroupActive(details);
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

	if (details.mode === "parallel") {
		const totalCount = details.totalSteps ?? details.results.length;
		const statuses = new Array(totalCount).fill("pending") as Array<"pending" | "running" | "completed" | "failed" | "detached">;
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
				?? (result.interrupted || result.detached
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
			for (let index = span.start; index < span.start + span.count; index++) {
				const progressEntry = details.progress?.find((progress) => progress.index === index);
				const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
				if (progressEntry?.status === "running" || progressEntry?.status === "pending") return false;
				if (resultEntry && !isDoneResult(resultEntry)) return false;
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

function resultRowLabel(details: Pick<Details, "mode" | "chainAgents">, label: MultiProgressLabel, resultIndex: number, stepNumber: number): string {
	if (details.mode === "chain" && label.hasParallelInChain) {
		const span = buildChainStepSpans(details.chainAgents).find((candidate) => resultIndex >= candidate.start && resultIndex < candidate.start + candidate.count);
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
		if (job.status === "running") parts.push(formatAgentRunningLabel(running));
		if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
	} else if (job.currentStep !== undefined) {
		parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
	} else if (stepsTotal > 1) {
		parts.push(`steps ${stepsTotal}`);
	}
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	const endTime = job.status === "complete" || job.status === "failed" || job.status === "paused" ? (job.updatedAt ?? Date.now()) : Date.now();
	if (job.startedAt) parts.push(formatDuration(Math.max(0, endTime - job.startedAt)));
	return statJoin(theme, parts);
}

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth()): string[] {
	if (jobs.length === 0) return [];
	const running = jobs.filter((job) => job.status === "running");
	const queued = jobs.filter((job) => job.status === "queued");
	const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");

	const lines: string[] = [];
	const hasActive = running.length > 0 || queued.length > 0;
	lines.push(truncLine(`${theme.fg(hasActive ? "accent" : "dim", hasActive ? "●" : "○")} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background · /subagents-status")}`, width));

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

function refreshAnimatedWidget(): void {
	try {
		if (!latestWidgetCtx?.hasUI || latestWidgetJobs.length === 0) return;
		latestWidgetCtx.ui.setWidget(WIDGET_KEY, buildWidgetLines(latestWidgetJobs, latestWidgetCtx.ui.theme));
		latestWidgetCtx.ui.requestRender?.();
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
		stopWidgetAnimation();
	}
}

function ensureWidgetAnimation(): void {
	if (widgetTimer) return;
	widgetTimer = setInterval(() => {
		if (!hasAnimatedWidgetJobs(latestWidgetJobs)) {
			stopWidgetAnimation();
			return;
		}
		refreshAnimatedWidget();
	}, WIDGET_ANIMATION_MS);
	widgetTimer.unref?.();
}

export function stopWidgetAnimation(): void {
	if (widgetTimer) {
		clearInterval(widgetTimer);
		widgetTimer = undefined;
	}
	latestWidgetCtx = undefined;
	latestWidgetJobs = [];
	outputActivityCache.clear();
}

export function stopResultAnimations(): void {
	for (const [timer, state] of resultAnimationTimers) {
		clearInterval(timer);
		state.subagentResultAnimationTimer = undefined;
	}
	resultAnimationTimers.clear();
}

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (jobs.length === 0) {
		stopWidgetAnimation();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (!ctx.hasUI) {
		stopWidgetAnimation();
		return;
	}
	latestWidgetCtx = ctx;
	latestWidgetJobs = [...jobs];

	ctx.ui.setWidget(WIDGET_KEY, buildWidgetLines(jobs, ctx.ui.theme));
	if (hasAnimatedWidgetJobs(jobs)) ensureWidgetAnimation();
	else stopWidgetAnimation();
}

function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = r.progress?.status === "running";
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const stats = statJoin(theme, [
		r.usage?.turns ? `⟳${r.usage.turns}` : "",
		formatProgressStats(theme, progress),
	]);
	const c = new Container();
	const width = getTermWidth() - 4;
	c.addChild(new Text(truncLine(`${resultGlyph(r, output, theme, isRunning)} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	if (isRunning && r.progress) {
		const activity = compactCurrentActivity(r.progress);
		c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${activity}`), width), 0, 0));
		const liveStatus = buildLiveStatusLine(r.progress);
		if (liveStatus && liveStatus !== activity) c.addChild(new Text(truncLine(theme.fg("dim", `     ${liveStatus}`), width), 0, 0));
		c.addChild(new Text(truncLine(theme.fg("accent", "  Press Ctrl+O for live detail"), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
		return c;
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

function renderMultiCompact(d: Details, theme: Theme): Component {
	const hasRunning = d.progress?.some((p) => p.status === "running")
		|| d.results.some((r) => r.progress?.status === "running");
	const failed = d.results.some((r) => r.exitCode !== 0 && r.progress?.status !== "running");
	const paused = d.results.some((r) => (r.interrupted || r.detached) && r.progress?.status !== "running");
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
	const stats = statJoin(theme, [multiLabel.headerLabel, formatProgressStats(theme, totalSummary)]);
	const glyph = hasRunning
		? theme.fg("accent", spinnerFrame())
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
	for (let i = displayStart; i < displayEnd; i++) {
		const r = d.results[i];
		const fallbackLabel = itemTitle.toLowerCase();
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		const agentName = useResultsDirectly ? (r?.agent || `${fallbackLabel}-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `${fallbackLabel}-${rowNumber}`);
		if (!r) {
			c.addChild(new Text(truncLine(theme.fg("dim", `  ◦ ${itemTitle} ${rowNumber}: ${agentName} · pending`), width), 0, 0));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg && "status" in rProg && rProg.status === "running";
		const rPending = rProg && "status" in rProg && rProg.status === "pending";
		const stepNumber = r.progress?.index !== undefined ? r.progress.index + 1 : progressFromArray?.index !== undefined ? progressFromArray.index + 1 : i + 1;
		const stepStats = formatProgressStats(theme, rProg);
		const glyph = rPending ? theme.fg("dim", "◦") : resultGlyph(r, output, theme, rRunning);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
		c.addChild(new Text(truncLine(`  ${line}`, width), 0, 0));
		if (rRunning && rProg && "status" in rProg) {
			const activity = compactCurrentActivity(rProg);
			c.addChild(new Text(truncLine(theme.fg("dim", `    ⎿  ${activity}`), width), 0, 0));
			c.addChild(new Text(truncLine(theme.fg("accent", "    Press Ctrl+O for live detail"), width), 0, 0));
		} else if (!rPending && (r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))) {
			c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
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
): Component {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
		return new Text(truncLine(`${contextPrefix}${text}`, getTermWidth() - 4), 0, 0);
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		if (!expanded) return renderSingleCompact(d, r, theme);
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
			const toolLine = formatCurrentToolLine(r.progress, w, expanded);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(r.progress);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", "Press Ctrl+O for live detail")), 0, 0));
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
		c.addChild(new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model, r.preferredModel))), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
		}

		if (!isRunning && r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}
		return c;
	}

	if (!expanded) return renderMultiCompact(d, theme);

	const hasRunning = d.progress?.some((p) => p.status === "running") 
		|| d.results.some((r) => r.progress?.status === "running");
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0
		&& r.progress?.status !== "running"
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const icon = hasRunning
		? theme.fg("warning", "running")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "warning")
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

	const summaryStr =
		totalSummary.toolCount || totalSummary.tokens
			? ` | ${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
			: "";

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

	c.addChild(new Spacer(1));

	for (let i = displayStart; i < displayEnd; i++) {
		const r = d.results[i];
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		const agentName = useResultsDirectly 
			? (r?.agent || `step-${rowNumber}`)
			: (d.chainAgents![i] || r?.agent || `step-${rowNumber}`);

		if (!r) {
			c.addChild(new Text(fit(theme.fg("dim", `  ${itemTitle} ${rowNumber}: ${agentName}`)), 0, 0));
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
		const modelDisplay = r.model ? theme.fg("dim", ` (${r.model})`) : "";
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
			const toolLine = formatCurrentToolLine(rProg, w, expanded);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(rProg);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", "    Press Ctrl+O for live detail")), 0, 0));
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
