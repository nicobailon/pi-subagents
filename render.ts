/**
 * Rendering functions for subagent results
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Widget } from "@mariozechner/pi-tui";
import {
	type AsyncJobState,
	type Details,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "./types.js";
import { formatTokens, formatUsage, formatDuration, formatToolCall, shortenPath } from "./formatters.js";
import { getFinalOutput, getDisplayItems, getOutputTail, getLastActivity } from "./utils.js";

type Theme = ExtensionContext["ui"]["theme"];

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

		lines.push(`- ${id} ${status} | ${agentLabel} | ${stepText}${elapsed ? ` | ${elapsed}` : ""}${tokenText}${activitySuffix}`);

		if (job.status === "running" && job.outputFile) {
			const tail = getOutputTail(job.outputFile, 3);
			for (const line of tail) {
				lines.push(theme.fg("dim", `  > ${line}`));
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
		return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
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

		const c = new Container();
		c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${progressInfo}`, 0, 0));
		c.addChild(new Spacer(1));
		c.addChild(
			new Text(theme.fg("dim", `Task: ${r.task.slice(0, 150)}${r.task.length > 150 ? "..." : ""}`), 0, 0),
		);
		c.addChild(new Spacer(1));

		const items = getDisplayItems(r.messages);
		for (const item of items) {
			if (item.type === "tool")
				c.addChild(new Text(theme.fg("muted", formatToolCall(item.name, item.args)), 0, 0));
		}
		if (items.length) c.addChild(new Spacer(1));

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(theme.fg("dim", `Skills: ${r.skills.join(", ")}`), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(theme.fg("warning", `⚠️ ${r.skillsWarning}`), 0, 0));
		}
		c.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), 0, 0));
		}

		if (r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0));
		}
		return c;
	}

	const hasRunning = d.progress?.some((p) => p.status === "running") 
		|| d.results.some((r) => r.progress?.status === "running");
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const icon = hasRunning
		? theme.fg("warning", "...")
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

	const modeLabel = d.mode === "parallel" ? "parallel (no live progress)" : d.mode;
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
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const icon = isFailed
						? theme.fg("error", "✗")
						: isComplete
							? theme.fg("success", "✓")
							: isCurrent && hasRunning
								? theme.fg("warning", "●")
								: theme.fg("dim", "○");
					return `${icon} ${agent}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const c = new Container();
	c.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${stepInfo}${summaryStr}`,
			0,
			0,
		),
	);
	// Show chain visualization
	if (chainVis) {
		c.addChild(new Text(`  ${chainVis}`, 0, 0));
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
			c.addChild(new Text(theme.fg("dim", `  Step ${i + 1}: ${agentName}`), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: ○ pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i) 
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";

		// Step header with status
		const statusIcon = rRunning
			? theme.fg("warning", "●")
			: r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		// Show model if available (full provider/model format)
		const modelDisplay = r.model ? theme.fg("dim", ` (${r.model})`) : "";
		const stepHeader = rRunning
			? `${statusIcon} Step ${i + 1}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} Step ${i + 1}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
		c.addChild(new Text(stepHeader, 0, 0));

		// Task (truncated)
		const taskPreview = r.task.slice(0, 120) + (r.task.length > 120 ? "..." : "");
		c.addChild(new Text(theme.fg("dim", `    task: ${taskPreview}`), 0, 0));

		// Output target (extract from task)
		const outputMatch = r.task.match(/[Oo]utput(?:\s+to)?\s+([^\s]+\.(?:md|txt|json))/);
		if (outputMatch) {
			c.addChild(new Text(theme.fg("dim", `    output: ${outputMatch[1]}`), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(theme.fg("dim", `    skills: ${r.skills.join(", ")}`), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(theme.fg("warning", `    ⚠️ ${r.skillsWarning}`), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`), 0, 0));
			}
			// Current tool for running step
			if (rProg.currentTool) {
				const toolLine = rProg.currentToolArgs
					? `${rProg.currentTool}: ${rProg.currentToolArgs.slice(0, 100)}${rProg.currentToolArgs.length > 100 ? "..." : ""}`
					: rProg.currentTool;
				c.addChild(new Text(theme.fg("warning", `    > ${toolLine}`), 0, 0));
			}
			// Recent tools
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(0, 3)) {
					const args = t.args.slice(0, 90) + (t.args.length > 90 ? "..." : "");
					c.addChild(new Text(theme.fg("dim", `      ${t.tool}: ${args}`), 0, 0));
				}
			}
			// Recent output (limited)
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(theme.fg("dim", `      ${line.slice(0, 100)}${line.length > 100 ? "..." : ""}`), 0, 0));
			}
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`), 0, 0));
	}
	return c;
}
