import { formatDuration, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import type { ActivityState, NestedRunSummary, NestedStepSummary } from "../../shared/types.ts";

export interface NestedRunCounts {
	total: number;
	running: number;
	paused: number;
	complete: number;
	failed: number;
	queued: number;
}

export function countNestedRuns(children: NestedRunSummary[] | undefined): NestedRunCounts {
	const counts: NestedRunCounts = { total: 0, running: 0, paused: 0, complete: 0, failed: 0, queued: 0 };
	for (const child of children ?? []) {
		counts.total++;
		counts[child.state]++;
		const nested = countNestedRuns([...(child.children ?? []), ...(child.steps?.flatMap((step) => step.children ?? []) ?? [])]);
		counts.total += nested.total;
		counts.running += nested.running;
		counts.paused += nested.paused;
		counts.complete += nested.complete;
		counts.failed += nested.failed;
		counts.queued += nested.queued;
	}
	return counts;
}

export function formatNestedAggregate(children: NestedRunSummary[] | undefined): string | undefined {
	const counts = countNestedRuns(children);
	if (counts.total === 0) return undefined;
	const parts = [
		counts.running > 0 ? `${counts.running} running` : "",
		counts.paused > 0 ? `${counts.paused} paused` : "",
		counts.failed > 0 ? `${counts.failed} failed` : "",
		counts.complete > 0 ? `${counts.complete} complete` : "",
		counts.queued > 0 ? `${counts.queued} queued` : "",
	].filter(Boolean);
	return `+${counts.total} nested run${counts.total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function nestedRunLabel(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.length === 1 ? run.agents[0]! : `${run.agents.slice(0, 2).join(", ")}${run.agents.length > 2 ? ` +${run.agents.length - 2}` : ""}`;
	return run.id;
}

function formatNestedActivity(input: {
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: NestedRunSummary["totalTokens"];
}): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (input.totalTokens) facts.push(`${formatTokens(input.totalTokens.total)} tok`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState as ActivityState | undefined);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function formatNestedRunLines(children: NestedRunSummary[] | undefined, options: { indent: string; maxDepth: number; maxLines: number; commandHints?: boolean }): string[] {
	const lines: string[] = [];
	const append = (items: NestedRunSummary[] | undefined, depth: number, indent: string): void => {
		if (!items?.length || lines.length >= options.maxLines) return;
		if (depth > options.maxDepth) {
			const aggregate = formatNestedAggregate(items);
			if (aggregate && lines.length < options.maxLines) lines.push(`${indent}↳ ${aggregate}`);
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= options.maxLines) {
				const aggregate = formatNestedAggregate(items.slice(index));
				if (aggregate) lines[lines.length - 1] = `${indent}↳ ${aggregate}`;
				return;
			}
			const activity = child.state === "running" ? formatNestedActivity(child) : undefined;
			const error = child.error ? ` | error: ${child.error}` : "";
			lines.push(`${indent}↳ ${nestedRunLabel(child)} [${child.id}] ${child.state}${activity ? ` | ${activity}` : ""}${error}`);
			if (options.commandHints && lines.length < options.maxLines) lines.push(`${indent}  Status: subagent({ action: "status", id: "${child.id}" })`);
			if (depth === options.maxDepth) {
				const aggregate = formatNestedAggregate([...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])]);
				if (aggregate && lines.length < options.maxLines) lines.push(`${indent}  ↳ ${aggregate}`);
				continue;
			}
			for (const [stepIndex, step] of (child.steps ?? []).entries()) {
				if (lines.length >= options.maxLines) return;
				const stepActivity = step.status === "running" ? formatNestedActivity(step) : undefined;
				lines.push(`${indent}  ${stepIndex + 1}. ${step.agent} ${step.status}${stepActivity ? ` | ${stepActivity}` : ""}${step.error ? ` | error: ${step.error}` : ""}`);
				append(step.children, depth + 1, `${indent}    `);
			}
			append(child.children, depth + 1, `${indent}  `);
		}
	};
	append(children, 0, options.indent);
	return lines;
}

export function formatNestedRunStatusLines(children: NestedRunSummary[] | undefined, options: { indent?: string; maxDepth?: number; maxLines?: number; commandHints?: boolean } = {}): string[] {
	return formatNestedRunLines(children, {
		indent: options.indent ?? "  ",
		maxDepth: options.maxDepth ?? 2,
		maxLines: options.maxLines ?? 40,
		commandHints: options.commandHints ?? false,
	});
}
