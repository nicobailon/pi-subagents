/**
 * Rendering functions for subagent results
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
import {
	type AsyncJobState,
	type Details,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "./types.ts";
import { formatTokens, formatUsage, formatDuration, formatToolCall, shortenPath } from "./formatters.ts";
import { getDisplayItems, getLastActivity, getOutputTail, getSingleResultOutput } from "./utils.ts";

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

let lastWidgetHash = "";

function computeWidgetHash(jobs: AsyncJobState[]): string {
	return jobs.slice(0, MAX_WIDGET_JOBS).map(job =>
		`${job.asyncId}:${job.status}:${job.currentStep}:${job.updatedAt}:${job.totalTokens?.total ?? 0}`
	).join("|");
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

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (!ctx.hasUI) return;
	if (jobs.length === 0) {
		if (lastWidgetHash !== "") {
			lastWidgetHash = "";
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		return;
	}

	const displayedJobs = jobs.slice(0, MAX_WIDGET_JOBS);
	const hasRunningJobs = displayedJobs.some(job => job.status === "running");
	const newHash = computeWidgetHash(jobs);
	if (!hasRunningJobs && newHash === lastWidgetHash) {
		return;
	}
	lastWidgetHash = newHash;

	const theme = ctx.ui.theme;
	const w = getTermWidth();
	const lines: string[] = [];
	lines.push(theme.fg("accent", "Async subagents"));

	for (const job of displayedJobs) {
		const id = job.asyncId.slice(0, 6);
		const status =
			job.status === "complete"
				? theme.fg("success", "complete")
				: job.status === "failed"
					? theme.fg("error", "failed")
					: theme.fg("warning", "running");

		const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
		const stepIndex = job.currentStep !== undefined ? job.currentStep + 1 : undefined;
		const stepText = stepIndex !== undefined ? `step ${stepIndex}/${stepsTotal}` : `steps ${stepsTotal}`;
		const endTime = (job.status === "complete" || job.status === "failed") ? (job.updatedAt ?? Date.now()) : Date.now();
		const elapsed = job.startedAt ? formatDuration(endTime - job.startedAt) : "";
		const agentLabel = job.agents ? job.agents.join(" -> ") : (job.mode ?? "single");

		const tokenText = job.totalTokens ? ` | ${formatTokens(job.totalTokens.total)} tok` : "";
		const activityText = job.status === "running" ? getLastActivity(job.outputFile) : "";
		const activitySuffix = activityText ? ` | ${theme.fg("dim", activityText)}` : "";

		lines.push(truncLine(`- ${id} ${status} | ${agentLabel} | ${stepText}${elapsed ? ` | ${elapsed}` : ""}${tokenText}${activitySuffix}`, w));

		if (job.status === "running" && job.outputFile) {
			const tail = getOutputTail(job.outputFile, 3);
			for (const line of tail) {
				lines.push(truncLine(theme.fg("dim", `  > ${line}`), w));
			}
		}
	}

	ctx.ui.setWidget(WIDGET_KEY, lines);
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
	const w = getTermWidth() - 4;
	// When expanded, skip truncation — let text wrap naturally
	const trunc = (text: string) => expanded ? text : truncLine(text, w);
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
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

		const c = new Container();
		c.addChild(new Text(trunc(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`), 0, 0));
		c.addChild(new Spacer(1));
		c.addChild(
			new Text(trunc(theme.fg("dim", `Task: ${r.task}`)), 0, 0),
		);
		c.addChild(new Spacer(1));

		if (isRunning && r.progress) {
			if (r.progress.currentTool) {
				const toolArgsPreview = r.progress.currentToolArgs ?? "";
				const toolLine = toolArgsPreview
					? `${r.progress.currentTool}: ${toolArgsPreview}`
					: r.progress.currentTool;
				c.addChild(new Text(trunc(theme.fg("warning", `> ${toolLine}`)), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					c.addChild(new Text(trunc(theme.fg("dim", `${t.tool}: ${t.args}`)), 0, 0));
				}
			}
			for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(trunc(theme.fg("dim", `  ${line}`)), 0, 0));
			}
			if (r.progress.currentTool || r.progress.recentTools?.length || r.progress.recentOutput?.length) {
				c.addChild(new Spacer(1));
			}
		}

		// Only show tool calls when expanded (collapsed = compact summary)
		if (expanded) {
			const toolItems = r.messages
				? getDisplayItems(r.messages).filter((it): it is { type: "tool"; name: string; args: Record<string, any> } => it.type === "tool")
				: (r.toolCalls?.map(tc => ({ type: "tool" as const, name: tc.name, args: tc.args })) ?? []);
			for (const item of toolItems) {
				c.addChild(new Text(theme.fg("muted", formatToolCall(item.name, item.args, true)), 0, 0));
			}
			if (toolItems.length) c.addChild(new Spacer(1));
		}

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(trunc(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(trunc(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(trunc(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}
		c.addChild(new Text(trunc(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(trunc(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
		}

		if (r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(trunc(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}
		return c;
	}

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
	const hasParallelInChain = d.chainAgents?.some((a) => a.startsWith("["));
	const totalCount = hasParallelInChain ? d.results.length : (d.totalSteps ?? d.results.length);
	const currentStep = d.currentStepIndex !== undefined ? d.currentStepIndex + 1 : ok + 1;
	const stepInfo = hasRunning ? ` ${currentStep}/${totalCount}` : ` ${ok}/${totalCount}`;
	
	const chainVis = d.chainAgents?.length && !hasParallelInChain
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

	const c = new Container();
	c.addChild(
		new Text(
			trunc(`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge}${stepInfo}${summaryStr}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(trunc(`  ${chainVis}`), 0, 0));
	}

	const useResultsDirectly = hasParallelInChain || !d.chainAgents?.length;
	const stepsToShow = useResultsDirectly ? d.results.length : d.chainAgents!.length;

	c.addChild(new Spacer(1));

	for (let i = 0; i < stepsToShow; i++) {
		const r = d.results[i];
		const agentName = useResultsDirectly 
			? (r?.agent || `step-${i + 1}`)
			: (d.chainAgents![i] || r?.agent || `step-${i + 1}`);

		if (!r) {
			c.addChild(new Text(trunc(theme.fg("dim", `  Step ${i + 1}: ${agentName}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i) 
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";

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
		const stepHeader = rRunning
			? `${statusIcon} Step ${i + 1}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} Step ${i + 1}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
		c.addChild(new Text(trunc(stepHeader), 0, 0));

		c.addChild(new Text(trunc(theme.fg("dim", `    task: ${r.task}`)), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(trunc(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(trunc(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(trunc(theme.fg("warning", `    Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(trunc(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(trunc(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`)), 0, 0));
			}
			if (rProg.currentTool) {
				const toolArgsPreview = rProg.currentToolArgs ?? "";
				const toolLine = toolArgsPreview
					? `${rProg.currentTool}: ${toolArgsPreview}`
					: rProg.currentTool;
				c.addChild(new Text(trunc(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
			}
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(-3)) {
					c.addChild(new Text(trunc(theme.fg("dim", `      ${t.tool}: ${t.args}`)), 0, 0));
				}
			}
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(trunc(theme.fg("dim", `      ${line}`)), 0, 0));
			}
		}

		// Show tool calls for completed steps when expanded
		if (expanded && !rRunning) {
			const toolItems = r.messages
				? getDisplayItems(r.messages).filter((it): it is { type: "tool"; name: string; args: Record<string, any> } => it.type === "tool")
				: (r.toolCalls?.map(tc => ({ type: "tool" as const, name: tc.name, args: tc.args })) ?? []);
			for (const item of toolItems) {
				c.addChild(new Text(theme.fg("muted", `    ${formatToolCall(item.name, item.args, true)}`), 0, 0));
			}
			if (toolItems.length) c.addChild(new Spacer(1));
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(trunc(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)), 0, 0));
	}
	return c;
}
