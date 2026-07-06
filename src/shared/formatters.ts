/**
 * Formatting utilities for display output
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Usage, SingleResult, Details, ToolCallSummary } from "./types.ts";
import type { ChainStep } from "./settings.ts";
import { isDynamicParallelStep, isParallelStep } from "./settings.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS } from "./model-info.ts";
import { getSingleResultOutput } from "./utils.ts";

/**
 * Format token count with k suffix for large numbers
 */
export function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function formatModelThinking(model?: string, thinking?: string): string {
	const parsed = model ? splitKnownThinkingSuffix(model) : undefined;
	let displayModel = parsed?.baseModel ?? model;
	const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
	const displayThinking = parsed?.thinkingSuffix ? parsed.thinkingSuffix.slice(1) : explicitThinking;
	if (displayModel) {
		const slashIdx = displayModel.lastIndexOf("/");
		if (slashIdx !== -1) displayModel = displayModel.slice(slashIdx + 1);
	}
	return [displayModel, displayThinking ? `thinking ${displayThinking}` : undefined].filter(Boolean).join(" · ");
}

/**
 * Format usage statistics into a compact string
 */
export function formatUsage(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`in:${formatTokens(u.input)}`);
	if (u.output) parts.push(`out:${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Build a summary string for a completed/failed chain
 */
export function buildChainSummary(
	steps: ChainStep[],
	results: SingleResult[],
	chainDir: string,
	status: "completed" | "failed",
	failedStep?: { index: number; error: string },
): string {
	const stepNames = steps
		.map((step) => (isParallelStep(step) ? `parallel[${step.parallel.length}]` : isDynamicParallelStep(step) ? `expand:${step.parallel.agent}` : step.agent))
		.join(" → ");

	const totalDuration = results.reduce((sum, r) => sum + (r.progress?.durationMs || 0), 0);
	const durationStr = formatDuration(totalDuration);

	const progressPath = path.join(chainDir, "progress.md");
	const hasProgress = fs.existsSync(progressPath);
	const allSkills = new Set<string>();
	for (const r of results) {
		if (r.skills) r.skills.forEach((s) => allSkills.add(s));
	}
	const skillsLine = allSkills.size > 0 ? `🔧 Skills: ${[...allSkills].join(", ")}` : "";

	if (status === "completed") {
		const stepWord = results.length === 1 ? "step" : "steps";
		return `✅ Chain completed: ${stepNames} (${results.length} ${stepWord}, ${durationStr})${skillsLine ? `\n${skillsLine}` : ""}

📋 Progress: ${hasProgress ? progressPath : "(none)"}
📁 Artifacts: ${chainDir}`;
	} else {
		const stepInfo = failedStep ? ` at step ${failedStep.index + 1}` : "";
		const errorInfo = failedStep?.error ? `: ${failedStep.error}` : "";
		return `❌ Chain failed${stepInfo}${errorInfo}${skillsLine ? `\n${skillsLine}` : ""}

📋 Progress: ${hasProgress ? progressPath : "(none)"}
📁 Artifacts: ${chainDir}`;
	}
}

/**
 * Format a tool call for display
 */
export function formatToolCall(name: string, args: Record<string, unknown>, expanded = false): string {
	switch (name) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "";
			const maxLength = expanded ? 240 : 60;
			return `$ ${command.slice(0, maxLength)}${command.length > maxLength ? "..." : ""}`;
		}
		case "read":
		case "write":
		case "edit": {
			const target = typeof args.path === "string"
				? args.path
				: typeof args.file_path === "string"
					? args.file_path
					: "";
			return `${name} ${shortenPath(target)}`;
		}
		default: {
			const s = JSON.stringify(args);
			const maxLength = expanded ? 160 : 40;
			return `${name} ${s.slice(0, maxLength)}${s.length > maxLength ? "..." : ""}`;
		}
	}
}

/**
 * Shorten a path by replacing home directory with ~
 */
export function shortenPath(p: string): string {
	const home = process.env.HOME;
	if (home && p.startsWith(home)) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

export interface RichReportInput {
	details: Details;
	runId?: string;
	artifactsDir?: string;
}

function escapeCodeBlock(text: string): string {
	return text.replace(/```/g, "\\`\\`\\`");
}

function renderToolCalls(toolCalls?: ToolCallSummary[]): string {
	if (!toolCalls || toolCalls.length === 0) return "";
	const lines = toolCalls.map((tc) => `- \`${tc.expandedText || tc.text}\``);
	return `**Tool calls**:\n${lines.join("\n")}`;
}

function renderResultSection(
	result: SingleResult,
	label: string,
): string {
	const parts: string[] = [];

	const statusIcon = result.exitCode === 0 ? "✅" : "❌";
	const model = result.model || "(no model)";
	const progress = result.progress || result.progressSummary;
	const duration = progress ? formatDuration(progress.durationMs) : "?";
	const toolCount = progress ? `${progress.toolCount} tools` : "?";
	const usageStr = formatUsage(result.usage);

	parts.push(`### ${label}`);
	parts.push(`**Status**: ${statusIcon} | **Model**: ${model} | ${duration} | ${toolCount}${usageStr ? ` | ${usageStr}` : ""}`);
	parts.push("");

	if (result.task) {
		parts.push("**Task**:");
		parts.push("```");
		parts.push(result.task);
		parts.push("```");
		parts.push("");
	}

	const output = getSingleResultOutput(result);
	if (output) {
		parts.push("**Output**:");
		parts.push("```");
		parts.push(escapeCodeBlock(output));
		parts.push("```");
		parts.push("");
	}

	const toolCallsSection = renderToolCalls(result.toolCalls);
	if (toolCallsSection) {
		parts.push(toolCallsSection);
		parts.push("");
	}

	const meta: string[] = [];
	if (result.savedOutputPath) meta.push(`**Saved to**: \`${shortenPath(result.savedOutputPath)}\``);
	if (result.sessionFile) meta.push(`**Session**: \`${result.sessionFile}\``);
	if (result.artifactPaths?.outputPath) meta.push(`**Artifact**: \`${result.artifactPaths.outputPath}\``);
	if (result.skills?.length) meta.push(`**Skills**: ${result.skills.join(", ")}`);
	if (meta.length > 0) {
		parts.push(meta.join("  \n"));
	}

	return parts.join("\n");
}

export function buildRichReportMarkdown(input: RichReportInput): string {
	const { details, runId, artifactsDir } = input;
	const results = details.results || [];
	const mode = details.mode;

	const parts: string[] = [];
	parts.push(`# Subagent report: ${mode}`);
	parts.push("");

	// Summary
	const totalDuration = results.reduce((sum, r) => {
		const p = r.progress || r.progressSummary;
		if (mode === "chain") return sum + (p?.durationMs || 0);
		return Math.max(sum, p?.durationMs || 0);
	}, 0);

	const allOk = results.every((r) => r.exitCode === 0);
	const summaryIcon = allOk ? "✅" : "❌";
	const taskWord = results.length === 1 ? "task" : "tasks";
	const chainVis = details.chainAgents?.length
		? `: ${details.chainAgents.join(" → ")}`
		: "";

	parts.push("## Summary");
	parts.push(`${summaryIcon} ${mode} completed${chainVis} (${results.length} ${taskWord}, ${formatDuration(totalDuration)})`);
	const summaryMeta: string[] = [];
	if (runId) summaryMeta.push(`Run ID: \`${runId}\``);
	if (artifactsDir) summaryMeta.push(`Artifacts: \`${artifactsDir}\``);
	if (summaryMeta.length > 0) parts.push(summaryMeta.join(" · "));
	parts.push("");
	parts.push("---");
	parts.push("");

	// Per-result sections
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const agentName = details.chainAgents?.[i] || r.agent || `Task ${i + 1}`;
		let label: string;
		if (mode === "chain") {
			label = `Step ${i + 1}: ${agentName}`;
		} else if (mode === "parallel") {
			label = `Task ${i + 1}: ${agentName}`;
		} else {
			label = agentName;
		}
		parts.push(renderResultSection(r, label));
		if (i < results.length - 1) {
			parts.push("---");
			parts.push("");
		}
	}

	// Artifacts section
	if (details.artifacts?.files) {
		parts.push("");
		parts.push("---");
		parts.push("");
		parts.push("## Artifacts");
		for (const f of details.artifacts.files) {
			if (f.outputPath) parts.push(`- \`${f.outputPath}\``);
		}
	}

	return parts.join("\n");
}
