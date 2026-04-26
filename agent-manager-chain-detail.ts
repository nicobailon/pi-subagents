import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { ChainConfig, ChainStepConfig } from "./agents.ts";
import { row, renderFooter, renderHeader, formatPath, formatScrollInfo } from "./render-helpers.ts";
import { isParallelStep, type ChainStep } from "./settings.ts";

export interface ChainDetailState {
	scrollOffset: number;
}

export type ChainDetailAction =
	| { type: "back" }
	| { type: "launch" }
	| { type: "edit" };

const CHAIN_DETAIL_VIEWPORT_HEIGHT = 12;

type DetailChainStep = ChainStepConfig | ChainStep;

export function buildDependencyMap(steps: DetailChainStep[]): Map<number, number[]> {
	const outputMap = new Map<string, number>();
	const deps = new Map<number, number[]>();
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		if (isParallelStep(step as ChainStep)) {
			const reads = step.parallel.flatMap((task) => Array.isArray(task.reads) ? task.reads : []);
			const sources = reads
				.map((file) => outputMap.get(file))
				.filter((idx): idx is number => idx !== undefined);
			if (sources.length > 0) deps.set(i, [...new Set(sources)]);
			for (const task of step.parallel) {
				if (typeof task.output === "string" && task.output.length > 0) outputMap.set(task.output, i);
			}
			continue;
		}
		if (typeof step.output === "string" && step.output.length > 0) outputMap.set(step.output, i);
		if (Array.isArray(step.reads) && step.reads.length > 0) {
			const sources = step.reads
				.map((file) => outputMap.get(file))
				.filter((idx): idx is number => idx !== undefined);
			if (sources.length > 0) deps.set(i, sources);
		}
	}
	return deps;
}

function buildChainDetailLines(chain: ChainConfig, width: number): string[] {
	const contentWidth = width - 3;
	const lines: string[] = [];
	const steps = chain.steps as DetailChainStep[];
	const dependencyMap = buildDependencyMap(steps);
	lines.push(truncateToWidth(chain.description, contentWidth));
	lines.push("");
	lines.push(truncateToWidth(`File: ${formatPath(chain.filePath)}`, contentWidth));
	lines.push("");
	lines.push(truncateToWidth("── Flow ──", contentWidth));

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		const sources = dependencyMap.get(i);
		const fromText = sources && sources.length > 0 ? ` (from ${sources.map((s) => s + 1).join(", ")})` : "";
		if (isParallelStep(step as ChainStep)) {
			lines.push(truncateToWidth(`  ${i + 1}  Parallel: ${step.parallel.map((task) => task.agent).join(" + ")}`, contentWidth));
			if (step.concurrency !== undefined) lines.push(truncateToWidth(`     concurrency: ${step.concurrency}`, contentWidth));
			if (step.failFast !== undefined) lines.push(truncateToWidth(`     fail fast: ${step.failFast ? "on" : "off"}`, contentWidth));
			if (step.worktree !== undefined) lines.push(truncateToWidth(`     worktree: ${step.worktree ? "on" : "off"}`, contentWidth));
			for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
				const task = step.parallel[taskIndex]!;
				lines.push(truncateToWidth(`     ${taskIndex + 1}. ${task.agent}`, contentWidth));
				const taskPreview = (task.task ?? "").split("\n")[0] ?? "";
				if (taskPreview) lines.push(truncateToWidth(`        task: ${taskPreview}`, contentWidth));
				if (Array.isArray(task.reads) && task.reads.length > 0) lines.push(truncateToWidth(`        ← reads: ${task.reads.join(", ")}${fromText}`, contentWidth));
				else if (task.reads === false) lines.push(truncateToWidth("        ← reads: (disabled)", contentWidth));
				if (typeof task.output === "string" && task.output.length > 0) lines.push(truncateToWidth(`        → output: ${task.output}`, contentWidth));
				else if (task.output === false) lines.push(truncateToWidth("        → output: (disabled)", contentWidth));
				if (task.model) lines.push(truncateToWidth(`        model: ${task.model}`, contentWidth));
				if (task.skill !== undefined) {
					const skillsText =
						task.skill === false
							? "(disabled)"
							: Array.isArray(task.skill)
								? (task.skill.length > 0 ? task.skill.join(", ") : "(none)")
								: task.skill;
					lines.push(truncateToWidth(`        skills: ${skillsText}`, contentWidth));
				}
				if (task.progress !== undefined) lines.push(truncateToWidth(`        progress: ${task.progress ? "on" : "off"}`, contentWidth));
			}
			lines.push("");
			continue;
		}
		lines.push(truncateToWidth(`  ${i + 1}  ${step.agent}`, contentWidth));
		const taskPreview = step.task.split("\n")[0] ?? "";
		lines.push(truncateToWidth(`     task: ${taskPreview || "(none)"}`, contentWidth));
		if (Array.isArray(step.reads) && step.reads.length > 0) {
			lines.push(truncateToWidth(`     ← reads: ${step.reads.join(", ")}${fromText}`, contentWidth));
		} else if (step.reads === false) {
			lines.push(truncateToWidth("     ← reads: (disabled)", contentWidth));
		}
		if (typeof step.output === "string" && step.output.length > 0) {
			lines.push(truncateToWidth(`     → output: ${step.output}`, contentWidth));
		} else if (step.output === false) {
			lines.push(truncateToWidth("     → output: (disabled)", contentWidth));
		}
		if (step.model) lines.push(truncateToWidth(`     model: ${step.model}`, contentWidth));
		if (step.skills !== undefined) {
			const skillsText =
				step.skills === false
					? "(disabled)"
					: step.skills.length > 0
						? step.skills.join(", ")
						: "(none)";
			lines.push(truncateToWidth(`     skills: ${skillsText}`, contentWidth));
		}
		if (step.progress !== undefined) {
			lines.push(truncateToWidth(`     progress: ${step.progress ? "on" : "off"}`, contentWidth));
		}
		lines.push("");
	}

	if (chain.steps.length === 0) {
		lines.push(truncateToWidth("(no steps)", contentWidth));
	}

	return lines;
}

export function handleChainDetailInput(state: ChainDetailState, data: string): ChainDetailAction | undefined {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return { type: "back" };
	if (data === "l") return { type: "launch" };
	if (data === "e") return { type: "edit" };
	if (matchesKey(data, "up")) { state.scrollOffset--; return; }
	if (matchesKey(data, "down")) { state.scrollOffset++; return; }
	if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) { state.scrollOffset -= CHAIN_DETAIL_VIEWPORT_HEIGHT; return; }
	if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) { state.scrollOffset += CHAIN_DETAIL_VIEWPORT_HEIGHT; return; }
	return;
}

export function renderChainDetail(
	state: ChainDetailState,
	chain: ChainConfig,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const scopeBadge = chain.source === "user" ? "[user]" : "[proj]";
	lines.push(renderHeader(` ${chain.name} [chain] ${scopeBadge} `, width, theme));
	lines.push(row("", width, theme));

	const contentLines = buildChainDetailLines(chain, width);
	const maxOffset = Math.max(0, contentLines.length - CHAIN_DETAIL_VIEWPORT_HEIGHT);
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset));
	const visible = contentLines.slice(state.scrollOffset, state.scrollOffset + CHAIN_DETAIL_VIEWPORT_HEIGHT);
	for (const line of visible) lines.push(row(` ${line}`, width, theme));
	for (let i = visible.length; i < CHAIN_DETAIL_VIEWPORT_HEIGHT; i++) lines.push(row("", width, theme));

	const scrollInfo = formatScrollInfo(state.scrollOffset, Math.max(0, contentLines.length - (state.scrollOffset + CHAIN_DETAIL_VIEWPORT_HEIGHT)));
	lines.push(row(scrollInfo ? ` ${theme.fg("dim", scrollInfo)}` : "", width, theme));
	lines.push(renderFooter(" [l]aunch  [e]dit  [↑↓] scroll  [esc] back ", width, theme));
	return lines;
}
