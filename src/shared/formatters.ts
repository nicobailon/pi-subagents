/**
 * Formatting utilities for display output
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Usage, SingleResult, TokenUsage } from "./types.ts";
import type { ChainStep } from "./settings.ts";
import { isDynamicParallelStep, isParallelStep } from "./settings.ts";
import { previewDisplayText, sanitizeDisplayText } from "./display-text.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS } from "./model-info.ts";

/**
 * Format token count for compact display.
 */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 999_500) return `${Math.round(n / 1000)}k`;
	return `${Number((n / 1_000_000).toFixed(1))}M`;
}

export function formatTokenUsage(usage: TokenUsage, legacyLabel = "tok"): string {
	return usage.window !== undefined
		? `${formatTokens(usage.window)} window · ${formatTokens(usage.total)} spent`
		: `${formatTokens(usage.total)} ${legacyLabel}`;
}
export function formatContextUsage(usage: Pick<TokenUsage, "window" | "windowPeak">, contextLimit: number): string | undefined {
	if (usage.window === undefined || !Number.isFinite(usage.window) || !Number.isFinite(contextLimit) || contextLimit <= 0) return undefined;
	const peak = usage.windowPeak !== undefined && Number.isFinite(usage.windowPeak) ? usage.windowPeak : usage.window;
	const used = Math.max(0, usage.window, peak);
	return `ctx ${formatTokens(used)}/${formatTokens(contextLimit)} (${Math.round((used / contextLimit) * 100)}%)`;
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
			return `$ ${previewDisplayText(command, expanded ? 240 : 60)}`;
		}
		case "read":
		case "write":
		case "edit": {
			const target = typeof args.path === "string"
				? args.path
				: typeof args.file_path === "string"
					? args.file_path
					: "";
			return `${name} ${sanitizeDisplayText(shortenPath(target))}`;
		}
		default: {
			return `${name} ${previewDisplayText(JSON.stringify(args), expanded ? 160 : 40)}`;
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
