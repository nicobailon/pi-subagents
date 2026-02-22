/**
 * Rendering functions for subagent results
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, type Widget } from "@mariozechner/pi-tui";
import {
	type AsyncJobState,
	type Details,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "./types.js";
import { formatTokens, formatUsage, formatDuration, formatToolCall, shortenPath } from "./formatters.js";
import { getFinalOutput, getDisplayItems, getOutputTail, getLastActivity } from "./utils.js";

type Theme = ExtensionContext["ui"]["theme"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	// truncateToWidth adds \x1b[0m before its ellipsis which breaks TUI background
	// Instead: manually truncate to leave room for "..." and append it with proper styling
	const targetWidth = maxWidth - 3;
	let result = "";
	let currentWidth = 0;
	let activeStyle = ""; // Track current style (excluding reset codes)
	let i = 0;

	while (i < text.length) {
		// Check for ANSI code
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;
			// Only track non-reset codes as active style
			if (code !== "\x1b[0m" && code !== "\x1b[m") {
				activeStyle = code;
			} else {
				activeStyle = "";
			}
			i += code.length;
			continue;
		}

		// Get next character (handle Unicode properly)
		const char = text[i];
		const charWidth = visibleWidth(char);

		if (currentWidth + charWidth > targetWidth) {
			break;
		}

		result += char;
		currentWidth += charWidth;
		i++;
	}

	// Append ellipsis with the active style to preserve background color
	return result + activeStyle + "...";
}

// Track last rendered widget state to avoid no-op re-renders
let lastWidgetHash = "";

/**
 * Compute a simple hash of job states for change detection
 */
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

	// Check if anything changed since last render
	// Always re-render if any displayed job is running (output tail updates constantly)
	const displayedJobs = jobs.slice(0, MAX_WIDGET_JOBS);
	const hasRunningJobs = displayedJobs.some(job => job.status === "running");
	const newHash = computeWidgetHash(jobs);
	if (!hasRunningJobs && newHash === lastWidgetHash) {
		return; // Skip re-render, nothing changed
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
	_options: { expanded: boolean },
	theme: Theme,
): Widget {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		return new Text(truncLine(text, getTermWidth() - 4), 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		const isRunning = r.progress?.status === "running";
		const icon = isRunning
			? theme.fg("warning", "...")
			: r.exitCode === 0
				? theme.fg("success", "ok")
				: theme.fg("error", "X");
		const output = r.truncation?.text || getFinalOutput(r.messages);

		const progressInfo = isRunning && r.progress
			? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
			: r.progressSummary
				? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
				: "";

		const w = getTermWidth() - 4;
		const c = new Container();
		c.addChild(new Text(truncLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${progressInfo}`, w), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = r.task.length > taskMaxLen
			? `${r.task.slice(0, taskMaxLen)}...`
			: r.task;
		c.addChild(
			new Text(truncLine(theme.fg("dim", `Task: ${taskPreview}`), w), 0, 0),
		);
		c.addChild(new Spacer(1));

		const items = getDisplayItems(r.messages);
		for (const item of items) {
			if (item.type === "tool")
				c.addChild(new Text(truncLine(theme.fg("muted", formatToolCall(item.name, item.args)), w), 0, 0));
		}
		if (items.length) c.addChild(new Spacer(1));

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(truncLine(theme.fg("dim", `Skills: ${r.skills.join(", ")}`), w), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(truncLine(theme.fg("warning", `⚠️ ${r.skillsWarning}`), w), 0, 0));
		}
		c.addChild(new Text(truncLine(theme.fg("dim", formatUsage(r.usage, r.model)), w), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(truncLine(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), w), 0, 0));
		}

		if (r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(truncLine(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), w), 0, 0));
		}
		return c;
	}

	const hasRunning = d.progress?.some((p) => p.status === "running") 
		|| d.results.some((r) => r.progress?.status === "running");
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0
		&& r.progress?.status !== "running"
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getFinalOutput(r.messages)),
	);
	const icon = hasRunning
		? theme.fg("warning", "...")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "⚠")
			: ok === d.results.length
				? theme.fg("success", "ok")
				: theme.fg("error", "X");

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
	// For parallel-in-chain, show task count (results) for consistency with step display
	// For sequential chains, show logical step count
	const hasParallelInChain = d.chainAgents?.some((a) => a.startsWith("["));
	const totalCount = hasParallelInChain ? d.results.length : (d.totalSteps ?? d.results.length);
	const currentStep = d.currentStepIndex !== undefined ? d.currentStepIndex + 1 : ok + 1;
	const stepInfo = hasRunning ? ` ${currentStep}/${totalCount}` : ` ${ok}/${totalCount}`;
	
	// Build chain visualization: "scout → planner" with status icons
	// Note: Only works correctly for sequential chains. Chains with parallel steps
	// (indicated by "[agent1+agent2]" format) have multiple results per step,
	// breaking the 1:1 mapping between chainAgents and results.
	const chainVis = d.chainAgents?.length && !hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const isFailed = result && result.exitCode !== 0 && result.progress?.status !== "running";
					const isComplete = result && result.exitCode === 0 && result.progress?.status !== "running";
					const isEmptyWithoutTarget = Boolean(result)
						&& Boolean(isComplete)
						&& hasEmptyTextOutputWithoutOutputTarget(result.task, getFinalOutput(result.messages));
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepIcon = isFailed
						? theme.fg("error", "✗")
						: isEmptyWithoutTarget
							? theme.fg("warning", "⚠")
							: isComplete
								? theme.fg("success", "✓")
								: isCurrent && hasRunning
									? theme.fg("warning", "●")
									: theme.fg("dim", "○");
					return `${stepIcon} ${agent}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const w = getTermWidth() - 4;
	const c = new Container();
	c.addChild(
		new Text(
			truncLine(`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${stepInfo}${summaryStr}`, w),
			0,
			0,
		),
	);
	// Show chain visualization
	if (chainVis) {
		c.addChild(new Text(truncLine(`  ${chainVis}`, w), 0, 0));
	}

	// === STATIC STEP LAYOUT (like clarification UI) ===
	// Each step gets a fixed section with task/output/status
	// Note: For chains with parallel steps, chainAgents indices don't map 1:1 to results
	// (parallel steps produce multiple results). Fall back to result-based iteration.
	const useResultsDirectly = hasParallelInChain || !d.chainAgents?.length;
	const stepsToShow = useResultsDirectly ? d.results.length : d.chainAgents!.length;

	c.addChild(new Spacer(1));

	for (let i = 0; i < stepsToShow; i++) {
		const r = d.results[i];
		const agentName = useResultsDirectly 
			? (r?.agent || `step-${i + 1}`)
			: (d.chainAgents![i] || r?.agent || `step-${i + 1}`);

		if (!r) {
			// Pending step
			c.addChild(new Text(truncLine(theme.fg("dim", `  Step ${i + 1}: ${agentName}`), w), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: ○ pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i) 
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";

		const resultOutput = getFinalOutput(r.messages);
		const statusIcon = rRunning
			? theme.fg("warning", "●")
			: r.exitCode !== 0
				? theme.fg("error", "✗")
				: hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
					? theme.fg("warning", "⚠")
					: theme.fg("success", "✓");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		const modelDisplay = r.model ? theme.fg("dim", ` (${r.model})`) : "";
		const stepHeader = rRunning
			? `${statusIcon} Step ${i + 1}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} Step ${i + 1}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
		c.addChild(new Text(truncLine(stepHeader, w), 0, 0));

		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = r.task.length > taskMaxLen
			? `${r.task.slice(0, taskMaxLen)}...`
			: r.task;
		c.addChild(new Text(truncLine(theme.fg("dim", `    task: ${taskPreview}`), w), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${outputTarget}`), w), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(truncLine(theme.fg("dim", `    skills: ${r.skills.join(", ")}`), w), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(truncLine(theme.fg("warning", `    ⚠️ ${r.skillsWarning}`), w), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(truncLine(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`), w), 0, 0));
			}
			// Current tool for running step
			if (rProg.currentTool) {
				const maxToolLen = Math.max(50, w - 20);
				const toolArgsPreview = rProg.currentToolArgs
					? (rProg.currentToolArgs.length > maxToolLen
						? `${rProg.currentToolArgs.slice(0, maxToolLen)}...`
						: rProg.currentToolArgs)
					: "";
				const toolLine = toolArgsPreview
					? `${rProg.currentTool}: ${toolArgsPreview}`
					: rProg.currentTool;
				c.addChild(new Text(truncLine(theme.fg("warning", `    > ${toolLine}`), w), 0, 0));
			}
			// Recent tools
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(0, 3)) {
					const maxArgsLen = Math.max(40, w - 30);
					const argsPreview = t.args.length > maxArgsLen
						? `${t.args.slice(0, maxArgsLen)}...`
						: t.args;
					c.addChild(new Text(truncLine(theme.fg("dim", `      ${t.tool}: ${argsPreview}`), w), 0, 0));
				}
			}
			// Recent output (limited)
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(truncLine(theme.fg("dim", `      ${line}`), w), 0, 0));
			}
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(truncLine(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`), w), 0, 0));
	}
	return c;
}
