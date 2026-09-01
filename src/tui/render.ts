/**
 * Rendering functions for subagent results
 */

import * as path from "node:path";
import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, keyText, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	type AgentProgress,
	type AsyncJobState,
	type AsyncJobStep,
	type AsyncParallelGroupStatus,
	type Details,
	type HostStepState,
	type HostStepVerdict,
	type NestedRunSummary,
	type NestedStepSummary,
	type WorkflowGraphNode,
	type WorkflowNodeStatus,
	type MainWindowRendererConfig,
	MAX_WIDGET_JOBS,
	WIDGET_ANIMATION_INTERVAL_MS,
	WIDGET_KEY,
} from "../shared/types.ts";
import { previewDisplayText, sanitizeDisplayText, truncateDisplayText } from "../shared/display-text.ts";
import { FLEET_OPEN_SHORTCUT, formatShortcutLabel } from "../shared/shortcuts.ts";
import { formatContextUsage, formatTokens, formatUsage, formatDuration, formatModelThinking, formatToolCall, formatTokenUsage, shortenPath } from "../shared/formatters.ts";
import { getDisplayItems, getSingleResultOutput, PROMPT_REDACTED } from "../shared/utils.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { formatNestedAggregate } from "../runs/shared/nested-render.ts";
import { aggregateStepStatus, formatActivityLabel, formatAgentRunningLabel, formatParallelOutcome } from "../shared/status-format.ts";
import { contextModeBadge, contextModePrefix } from "../runs/shared/context-mode.ts";
import { shouldSuppressSingleStep, stripRepeatedAgentPrefix, withDuplicateLabelDiscriminators } from "./render-helpers.ts";
import { buildWorkflowChatProgressRows, type WorkflowChatProgressRow } from "../workflows/chat-progress.ts";
import { formatWorkflowPreflight, formatWorkflowPreflightPlanSummary, formatWorkflowPreflightWarningSummary, formatWorkflowPreflightWarnings } from "../workflows/workflow-preflight.ts";
import { encodeAsyncStatusSnapshotWidget } from "../runs/background/async-status-snapshot.ts";
import { projectAsyncWorkflowRows, type AsyncStatusWorkflowRow } from "../runs/shared/async-status-projection.ts";
import { hostStepReportName, hostStepVerdictLabel } from "../runs/shared/host-step-status.ts";
import { workflowGraphStageNodes } from "../runs/shared/workflow-graph.ts";
import { formatWorkflowChecklistBottleneck, formatWorkflowChecklistPhase, formatWorkflowChecklistSummary, projectWorkflowChecklist, type WorkflowChecklistItem, type WorkflowChecklistProjection, type WorkflowChecklistState, type WorkflowChecklistStep } from "../workflows/workflow-checklist.ts";

type Theme = ExtensionContext["ui"]["theme"];

interface WorkflowWidgetProjection {
	stages: WorkflowGraphNode[];
	steps: AsyncJobStep[];
	stageProgress?: { total: number; current?: number };
	plannedKeys?: Set<string>;
	checklist?: WorkflowChecklistProjection;
}

type WorkflowWidgetProjectionLookup = (job: AsyncJobState) => WorkflowWidgetProjection;

interface MainWindowRenderLayout {
	horizontalSpacing: number;
	compactResultMaxLines?: number;
}

function resolveMainWindowRenderLayout(config?: MainWindowRendererConfig): MainWindowRenderLayout {
	return {
		horizontalSpacing: config?.horizontalSpacing ?? 2,
		...(config?.compactResultMaxLines !== undefined ? { compactResultMaxLines: config.compactResultMaxLines } : {}),
	};
}

function mainWindowIndent(layout: MainWindowRenderLayout, level: number): string {
	return " ".repeat(Math.max(0, layout.horizontalSpacing * level));
}

function capCompactMainWindowResult(component: Component, layout: MainWindowRenderLayout, theme: Theme, enabled: boolean): Component {
	const maxLines = layout.compactResultMaxLines;
	if (!enabled || maxLines === undefined) return component;
	const capped = new Container();
	capped.render = (width: number): string[] => {
		const lines = component.render(width);
		if (lines.length <= maxLines) return lines;
		const visibleRows = maxLines === 1 ? 1 : maxLines - 1;
		const hiddenCount = lines.length - visibleRows;
		const hint = theme.fg("accent", `… ${hiddenCount} rows hidden · ${liveDetailKeyText()} expands`);
		if (maxLines === 1) return [truncLine(`${lines[0] ?? ""} ${hint}`, width)];
		return [...lines.slice(0, visibleRows), truncLine(hint, width)];
	};
	return capped;
}

function liveDetailKeyText(): string {
	return keyText("app.tools.expand");
}

export function liveDetailHintText(): string {
	return `Press ${liveDetailKeyText()} for live detail · ${formatShortcutLabel(FLEET_OPEN_SHORTCUT)} Fleet`;
}

function foregroundSingleHintText(shortcut?: string): string {
	if (!shortcut) return liveDetailHintText();
	const label = formatShortcutLabel(shortcut);
	return `${liveDetailHintText()} · ${label} to run in background`;
}

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ansiStylePattern = /\x1b\[[0-9;]*m/y;

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 * 
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 * 
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export function truncLine(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		ansiStylePattern.lastIndex = i;
		const ansiMatch = ansiStylePattern.exec(text);
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

		let end = text.indexOf("\x1b[", i);
		if (end === i) end = text.indexOf("\x1b[", i + 2);
		if (end === -1) end = text.length;
		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = grapheme === "\x1b" ? 0 : visibleWidth(grapheme);

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
			if (graphemeWidth > maxWidth) continue;
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

function animatedSeed(seed: number | undefined, frame: number | undefined): number | undefined {
	if (frame === undefined) return seed;
	return (seed ?? 0) + frame;
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

const ansiEscapePattern = /\x1b\[[0-9;]*m/g;
const noisyStatusPatterns = [
	/^(?:i|we)\s+(?:will|need|can|should|am|are)\b/i,
	/^i(?:'m|’m| am)\b/i,
	/\bso i (?:will|need|can)\b/i,
	/^(?:checking|fetching|reading|inspecting|verifying|collecting|confirming|polling)\b/i,
	/^(?:async\s+subagent\s+)?[\w.-]+\s*·\s*(?:step|agent)\s+\d+\/\d+\s*·/i,
	/^(?:Step|Agent)\s+\d+\/\d+:\s+[\w.-]+\s*·\s*(?:running|queued|pending|complete|completed)\b/i,
	/^(?:async\s+subagent\s+)?[\w.-]+(?:\s+\[(?:fresh|fork|mixed)\])?\s*·\s*(?:running|queued|pending|complete|completed|done)\b/i,
	/^Press\s+\S+\s+for\s+live\s+detail$/i,
	/^output:\s+.+\/async-subagent-runs\//i,
];
const liveOutputWordSignalPattern = /\b(?:access denied|denied|error|exception|fail(?:ed|ure)?|fatal|panic|rejected|timeout|timed out|unable|warning)\b/i;
const liveOutputCodeSignalPattern = /\bE[A-Z0-9_]{2,}\b/;

function oneLine(text: string): string {
	return text.replace(ansiEscapePattern, "").replace(/\s+/g, " ").trim();
}

const COMPACT_TASK_MAX_CHARS = 96;

/** Display label for a child run: the derived session name (agent + task
 *  excerpt) when the launcher provided one, else the bare agent name. */
function childDisplayName(result: { agent?: string; sessionName?: string } | undefined, fallback = "subagent"): string {
	return result?.sessionName?.trim() || result?.agent || fallback;
}

export function compactTaskText(task: string | undefined, label?: string): string | undefined {
	const taskText = task?.trim();
	const labelText = label?.trim();
	const normalizedTask = taskText && taskText !== PROMPT_REDACTED ? oneLine(taskText) : "";
	const normalizedLabel = labelText && labelText !== PROMPT_REDACTED ? oneLine(labelText) : "";
	const normalized = normalizedLabel && normalizedTask && normalizedLabel !== normalizedTask
		? `${normalizedLabel} — ${normalizedTask}`
		: normalizedLabel || normalizedTask;
	if (!normalized) return undefined;
	return previewDisplayText(normalized, COMPACT_TASK_MAX_CHARS);
}

export interface AsyncLaneProjection {
	label?: string;
	role: string;
	phase?: string;
	state: AsyncJobState["status"] | AsyncJobStep["status"];
	gate?: string;
	next?: string;
	output?: string;
	workspace?: string;
	ref: string;
	chips: string[];
}

const LANE_VALUE_MAX_CHARS = 48;

function boundedLaneValue(value: string | undefined, maxChars = LANE_VALUE_MAX_CHARS): string | undefined {
	if (!value?.trim() || value.trim() === PROMPT_REDACTED) return undefined;
	return previewDisplayText(oneLine(value), maxChars);
}

function workflowNodeStepStatus(status: WorkflowNodeStatus): AsyncJobStep["status"] {
	switch (status) {
		case "completed":
			return "completed";
		case "detached":
			return "paused";
		default:
			return status;
	}
}

function workflowNodeStatusLabel(status: WorkflowNodeStatus): string {
	switch (status) {
		case "completed":
			return "complete";
		case "detached":
			return "paused";
		default:
			return status;
	}
}

function workflowStepPriority(step: AsyncJobStep, currentNodeId?: string): number {
	const isCurrent = step.workflowKey === currentNodeId;
	if (step.status === "running" || (isCurrent && step.status !== "complete" && step.status !== "completed")) return 0;
	const gate = laneGate(step);
	if (
		step.status === "failed"
		|| step.status === "partial"
		|| step.status === "paused"
		|| step.status === "stopped"
		|| step.status === "rejected"
		|| step.toolBudgetBlocked === true
		|| step.turnBudgetExceeded === true
		|| step.activityState === "needs_attention"
		|| step.watchdog?.phase === "stale"
		|| gate !== undefined
	) return 1;
	if (step.status === "pending") return 2;
	return 3;
}

/** Merge materialized child rows with the planned workflow stages for rendering. */
function workflowWidgetSteps(job: AsyncJobState, planned = job.mode === "workflow" ? workflowGraphStageNodes(job.workflowGraph) : []): AsyncJobStep[] {
	const loaded = job.steps ?? [];
	if (planned.length === 0) return loaded;

	const loadedIndexesByKey = new Map<string, number[]>();
	for (const [index, step] of loaded.entries()) {
		if (!step.workflowKey) continue;
		const indexes = loadedIndexesByKey.get(step.workflowKey) ?? [];
		indexes.push(index);
		loadedIndexesByKey.set(step.workflowKey, indexes);
	}
	const consumed = new Set<number>();
	const entries: Array<{ step: AsyncJobStep; order: number }> = [];
	for (const [order, node] of planned.entries()) {
		const loadedIndex = loadedIndexesByKey.get(node.id)?.find((index) => !consumed.has(index));
		if (loadedIndex !== undefined) {
			consumed.add(loadedIndex);
			const loadedStep = loaded[loadedIndex]!;
			entries.push({
				step: {
					...loadedStep,
					index: node.flatIndex ?? loadedStep.index ?? order,
					agent: loadedStep.agent || node.agent || job.agents?.[0] || "workflow",
					phase: loadedStep.phase ?? node.phase,
					label: loadedStep.label ?? node.label,
					workflowKey: loadedStep.workflowKey ?? node.id,
					...(loadedStep.outputName === undefined && node.outputName !== undefined ? { outputName: node.outputName } : {}),
					...(loadedStep.structured === undefined && node.structured !== undefined ? { structured: node.structured } : {}),
					...(loadedStep.error === undefined && node.error !== undefined ? { error: node.error } : {}),
				},
				order,
			});
			continue;
		}
		entries.push({
			step: {
				index: node.flatIndex ?? order,
				agent: node.agent ?? job.agents?.[0] ?? "workflow",
				status: workflowNodeStepStatus(node.status),
				workflowKey: node.id,
				label: node.label,
				...(node.phase ? { phase: node.phase } : {}),
				...(node.outputName ? { outputName: node.outputName } : {}),
				...(node.structured !== undefined ? { structured: node.structured } : {}),
				...(node.error ? { error: node.error } : {}),
			},
			order,
		});
	}
	for (const [index, step] of loaded.entries()) {
		if (!consumed.has(index)) entries.push({ step, order: planned.length + index });
	}
	entries.sort((left, right) => workflowStepPriority(left.step, job.workflowGraph?.currentNodeId) - workflowStepPriority(right.step, job.workflowGraph?.currentNodeId) || left.order - right.order);
	return entries.map(({ step }) => step);
}

function workflowStageProgress(job: AsyncJobState, stages = job.mode === "workflow" ? workflowGraphStageNodes(job.workflowGraph) : []): { total: number; current?: number } | undefined {
	if (job.mode !== "workflow") return undefined;
	if (stages.length === 0) return undefined;
	const currentId = job.workflowGraph?.currentNodeId;
	const currentIndex = currentId ? stages.findIndex((stage) => stage.id === currentId) : -1;
	if (currentIndex >= 0 && stages[currentIndex]?.status !== "completed") return { total: stages.length, current: currentIndex };
	const runningIndex = stages.findIndex((stage) => stage.status === "running");
	if (runningIndex >= 0) return { total: stages.length, current: runningIndex };
	const indexedStage = job.currentStep !== undefined && job.currentStep >= 0 ? stages[job.currentStep] : undefined;
	if (indexedStage && indexedStage.status !== "completed") return { total: stages.length, current: job.currentStep };
	if (stages.every((stage) => stage.status === "completed")) return { total: stages.length, current: stages.length - 1 };
	return { total: stages.length };
}

function buildWorkflowWidgetProjection(job: AsyncJobState): WorkflowWidgetProjection {
	const stages = job.mode === "workflow" ? workflowGraphStageNodes(job.workflowGraph) : [];
	const stageProgress = workflowStageProgress(job, stages);
	const steps = workflowWidgetSteps(job, stages);
	const projection: WorkflowWidgetProjection = { stages, steps };
	if (stageProgress) projection.stageProgress = stageProgress;
	if (stages.length) projection.plannedKeys = new Set(stages.map((node) => node.id));
	if (job.mode === "workflow") {
		const checklist = projectWorkflowChecklist({
			graph: job.workflowGraph,
			steps: job.steps,
			hostSteps: job.hostSteps,
			preflight: job.preflight,
			trace: job.workflow?.trace,
			now: job.updatedAt ?? Date.now(),
		});
		if (checklist.total > 0) projection.checklist = checklist;
	}
	return projection;
}

function workflowWidgetProjectionLookup(): WorkflowWidgetProjectionLookup {
	const projections = new WeakMap<AsyncJobState, WorkflowWidgetProjection>();
	return (job: AsyncJobState) => {
		const cached = projections.get(job);
		if (cached) return cached;
		const projection = buildWorkflowWidgetProjection(job);
		projections.set(job, projection);
		return projection;
	};
}

function laneStepForJob(job: AsyncJobState, steps = workflowWidgetSteps(job)): AsyncJobStep | undefined {
	if (steps.length === 0) return undefined;
	const graphCurrent = job.workflowGraph?.currentNodeId;
	if (graphCurrent) {
		const current = steps.find((step) => step.workflowKey === graphCurrent);
		if (current) return current;
	}
	if (job.currentStep !== undefined) {
		const current = steps[job.currentStep];
		if (current && (current.index === undefined || current.index === job.currentStep)) return current;
		// Active parallel groups retain flat indices while exposing only the group slice.
		const indexedCurrent = steps.find((step) => step.index === job.currentStep);
		if (indexedCurrent) return indexedCurrent;
		return steps[0];
	}
	return steps.find((step) => step.status === "running")
		?? steps.find((step) => step.status === "pending")
		?? steps.at(-1);
}

function laneTraceForJob(job: AsyncJobState): NonNullable<AsyncJobState["workflow"]>["trace"][number] | undefined {
	return Array.isArray(job.workflow?.trace) ? job.workflow.trace.at(-1) : undefined;
}

function laneGate(step: AsyncJobStep | undefined): string | undefined {
	const review = step?.review?.status ?? step?.acceptance?.reviewResult?.status;
	if (review === "blockers") return "review blockers";
	if (review === "review-required") return "review required";
	if (review === "reviewed") return "reviewed";
	const acceptance = step?.acceptance?.status;
	if (acceptance === "review-required") return "acceptance review";
	if (acceptance === "checked" || acceptance === "verified" || acceptance === "accepted") return "acceptance";
	return undefined;
}

function laneNextAction(state: AsyncLaneProjection["state"], step: AsyncJobStep | undefined, output: string | undefined, gate: string | undefined): string | undefined {
	if (step?.watchdog?.phase === "stale") return "inspect stale state";
	if (step?.toolBudgetBlocked === true || step?.turnBudgetExceeded === true) return "inspect blocked state";
	if (gate === "review blockers") return "resolve review blockers";
	if (gate === "review required" || gate === "acceptance review") return "review output";
	if (step?.activityState === "needs_attention") return "inspect attention";
	if (state === "queued" || state === "pending") return "await launch";
	if (state === "failed" || state === "rejected") return "inspect failure";
	if (state === "partial") return "inspect partial state";
	if (state === "paused") return "inspect paused state";
	if (state === "stopped") return "inspect stopped state";
	if ((state === "complete" || state === "completed") && gate === "reviewed") return "ready";
	if ((state === "complete" || state === "completed") && output) return "inspect output";
	return undefined;
}

function isTerminalLaneState(state: AsyncJobState["status"]): boolean {
	return state !== "queued" && state !== "running";
}

/** Project already-loaded async status facts into one bounded, render-only lane row. */
export function projectAsyncLane(job: AsyncJobState, ...args: [selectedStep?: AsyncJobStep]): AsyncLaneProjection | undefined {
	const selectedStep = args.length === 0 ? laneStepForJob(job) : args[0];
	const trace = laneTraceForJob(job);
	const workspace = job.cwd ? boundedLaneValue(shortenPath(job.cwd)) : undefined;
	const label = compactTaskText(selectedStep?.description, selectedStep?.label)
		?? boundedLaneValue(trace?.label)
		?? (workspace ? undefined : boundedLaneValue(selectedStep?.workflowKey ?? job.workflowKey));
	const role = boundedLaneValue(selectedStep?.agent ?? trace?.agent ?? job.agents?.[0] ?? widgetJobName(job), 32) ?? "subagent";
	const phase = boundedLaneValue(selectedStep?.phase ?? trace?.phase);
	const gate = laneGate(selectedStep);
	const output = boundedLaneValue(selectedStep?.outputName);
	const ref = boundedLaneValue(selectedStep?.workflowKey ?? job.workflowKey ?? job.asyncId.slice(0, 8), 24) ?? job.asyncId.slice(0, 8);
	const chips = [
		selectedStep?.context,
		selectedStep?.structured ? "structured" : undefined,
		selectedStep?.activityState === "active_long_running" ? "long-running" : undefined,
		selectedStep?.activityState === "needs_attention" ? "attention" : undefined,
		selectedStep?.watchdog?.phase === "stale" ? "stale" : undefined,
		selectedStep?.toolBudgetBlocked === true || selectedStep?.turnBudgetExceeded === true ? "blocked" : undefined,
	].filter((chip): chip is string => Boolean(chip));
	const state = isTerminalLaneState(job.status) ? job.status : selectedStep?.status ?? job.status;
	const next = laneNextAction(state, selectedStep, output, gate);
	if (!label && !phase && !gate && !output && !selectedStep?.workflowKey && !job.workflowKey && !trace?.label && !trace?.phase) return undefined;
	return { ...(label ? { label } : {}), role, ...(phase ? { phase } : {}), state, ...(gate ? { gate } : {}), ...(next ? { next } : {}), ...(output ? { output } : {}), ...(workspace ? { workspace } : {}), ref, chips };
}

function laneStateLabel(state: AsyncLaneProjection["state"], theme: Theme): string {
	if (state === "running") return theme.fg("accent", "running");
	if (state === "queued" || state === "pending") return theme.fg("muted", state);
	if (state === "complete" || state === "completed") return theme.fg("success", "complete");
	if (state === "failed" || state === "rejected") return theme.fg("error", state === "rejected" ? "rejected" : "failed");
	return theme.fg("warning", state);
}

function formatLaneProjection(lane: AsyncLaneProjection, theme: Theme): string {
	const label = boundedLaneValue(lane.label, 56);
	const identity = [label, lane.role ? `role:${lane.role}` : undefined].filter(Boolean).join(" · ");
	return `${identity ? theme.bold(identity) : theme.bold(lane.role)} · ${laneStateLabel(lane.state, theme)}`;
}

function formatLaneChip(chip: string, theme: Theme): string {
	const text = `[${chip}]`;
	if (chip === "blocked") return theme.fg("error", text);
	if (chip === "stale") return theme.fg("warning", text);
	return text;
}

function formatLaneProjectionDetails(lane: AsyncLaneProjection, theme: Theme): string | undefined {
	const details = [
		lane.phase ? `phase:${lane.phase}` : undefined,
		lane.gate ? `gate:${lane.gate}` : undefined,
		lane.next ? `next:${lane.next}` : undefined,
		lane.output ? `out:${lane.output}` : undefined,
		lane.workspace ? `workspace:${lane.workspace}` : lane.ref ? `ref:${lane.ref}` : undefined,
	].filter(Boolean);
	const chips = lane.chips.map((chip) => formatLaneChip(chip, theme));
	return [...(details.length ? [theme.fg("dim", details.join(" · "))] : []), ...chips].join(" · ") || undefined;
}

function formatLaneProjectionLines(lane: AsyncLaneProjection, theme: Theme, indent: string): string[] {
	const details = formatLaneProjectionDetails(lane, theme);
	return [
		`${indent}${formatLaneProjection(lane, theme)}`,
		...(details ? [`${indent}  ${details}`] : []),
	];
}

function laneRenderKey(job: AsyncJobState, projection?: WorkflowWidgetProjection): unknown {
	const selectedStep = projection ? laneStepForJob(job, projection.steps) : laneStepForJob(job);
	const lane = projectAsyncLane(job, selectedStep);
	return lane ? [lane.label, lane.role, lane.phase, lane.state, lane.gate, lane.next, lane.output, lane.workspace, lane.ref, lane.chips] : undefined;
}

function widgetLaneDetailLines(job: AsyncJobState, theme: Theme, projection?: WorkflowWidgetProjection): string[] {
	if (job.steps?.length && (job.mode === "parallel" || job.mode === "chain")) return [];
	const selectedStep = projection ? laneStepForJob(job, projection.steps) : laneStepForJob(job);
	const lane = projectAsyncLane(job, selectedStep);
	return lane ? formatLaneProjectionLines(lane, theme, "  ") : [];
}

function workflowPreflightLines(job: AsyncJobState, expanded = false): string[] {
	if (job.mode !== "workflow" || !job.preflight) return [];
	if (!expanded) {
		const warning = formatWorkflowPreflightWarningSummary(job.workflow?.preflightWarnings, { indent: "  ", hint: "expand for debug" });
		return [
			formatWorkflowPreflightPlanSummary(job.preflight, { indent: "  " }),
			...(warning ? [warning] : []),
		];
	}
	return [
		...formatWorkflowPreflight(job.preflight, { indent: "  " }).split("\n"),
		...(job.workflow?.preflightWarnings ? formatWorkflowPreflightWarnings(job.workflow.preflightWarnings, { indent: "  " }).split("\n") : []),
	];
}

function workflowLabelForResult(details: Details, resultIndex: number): string | undefined {
	const flatIndex = foregroundResultIndex(details, resultIndex);
	const visit = (nodes: NonNullable<Details["workflowGraph"]>["nodes"]): string | undefined => {
		for (const node of nodes) {
			if (node.flatIndex === flatIndex && node.label.trim()) return node.label;
			const nested = node.children ? visit(node.children) : undefined;
			if (nested) return nested;
		}
		return undefined;
	};
	return details.workflowGraph ? visit(details.workflowGraph.nodes) : undefined;
}

function foregroundProgressForResult(details: Details, resultIndex: number): AgentProgress | undefined {
	const result = details.results[resultIndex];
	if (result?.progress) return result.progress;
	const index = result?.index ?? resultIndex;
	const indexed = details.progress?.find((progress) => progress.index === index);
	if (indexed) return indexed;
	return result?.agent
		? details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running")
		: undefined;
}

function foregroundResultIndex(details: Details, resultIndex: number): number {
	const result = details.results[resultIndex];
	if (typeof result?.index === "number") return result.index;
	return foregroundProgressForResult(details, resultIndex)?.index ?? resultIndex;
}

function foregroundResultDisplayName(
	details: Details,
	resultIndex: number,
	result: Details["results"][number] | undefined,
	fallback: string,
): string {
	const progress = foregroundProgressForResult(details, resultIndex);
	const agent = normalizedParallelDisplayText(result?.agent) ?? normalizedParallelDisplayText(progress?.agent);
	const workflowLabel = normalizedParallelDisplayText(workflowLabelForResult(details, resultIndex));
	if (workflowLabel) return compactTaskText(undefined, workflowLabel) ?? workflowLabel;

	const sessionName = normalizedParallelDisplayText(result?.sessionName) ?? normalizedParallelDisplayText(progress?.sessionName);
	if (sessionName) {
		const sessionTask = stripRepeatedAgentPrefix(sessionName, agent);
		if (sessionTask && sessionTask !== PROMPT_REDACTED && sessionTask.toLowerCase() !== agent?.toLowerCase()) {
			return compactTaskText(sessionTask) ?? sessionTask;
		}
	}

	return compactTaskText(result?.task) ?? compactTaskText(progress?.task) ?? agent ?? fallback;
}

function foregroundSingleDisplayName(result: Details["results"][number] | undefined): string {
	return normalizedParallelDisplayText(result?.agent)
		?? normalizedParallelDisplayText(result?.sessionName)
		?? compactTaskText(result?.task)
		?? "subagent";
}

function hasLiveOutputSignal(line: string): boolean {
	const clean = oneLine(line);
	return liveOutputWordSignalPattern.test(clean) || liveOutputCodeSignalPattern.test(clean);
}

function isNoisyStatusLine(line: string): boolean {
	const clean = oneLine(line);
	return clean.length > 0
		&& clean.length <= 240
		&& !hasLiveOutputSignal(clean)
		&& noisyStatusPatterns.some((pattern) => pattern.test(clean));
}

function latestActivityText(line: string): string {
	return oneLine(line)
		.replace(/^i (?:will|can|need to|am going to)\s+/i, "")
		.replace(/^i(?:'m|’m| am)\s+/i, "");
}

function progressUpdateSummary(lines: string[]): string {
	const counts = new Map<string, number>();
	for (const line of lines) counts.set(line.toLowerCase(), (counts.get(line.toLowerCase()) ?? 0) + 1);
	const exactRepeatCount = Math.max(...counts.values());
	const latest = latestActivityText(lines[lines.length - 1]!);
	const repeat = exactRepeatCount > 1 ? ` · repeated ${exactRepeatCount}×` : "";
	return `↻ ${lines.length} progress updates${repeat} · latest: ${latest}`;
}

function compactRecentOutputLines(recentOutput: string[] | undefined): string[] {
	const lines: string[] = [];
	const noisyLines: string[] = [];
	const otherLines: string[] = [];
	for (const rawLine of recentOutput ?? []) {
		const line = oneLine(rawLine);
		if (!line || line === "(running...)") continue;
		lines.push(line);
		(isNoisyStatusLine(line) ? noisyLines : otherLines).push(line);
	}
	if (noisyLines.length >= 4 && !otherLines.some(hasLiveOutputSignal)) {
		if (otherLines.length === 0) {
			return [
				progressUpdateSummary(noisyLines),
				"pattern: repeated short status lines",
			];
		}
		const visibleTail = otherLines.slice(-3);
		const hiddenSignals = otherLines.slice(0, -3).filter(hasLiveOutputSignal);
		return [
			progressUpdateSummary(noisyLines),
			...(hiddenSignals.length > 0 ? [`… ${hiddenSignals.length} older signal ${hiddenSignals.length === 1 ? "line" : "lines"}: ${hiddenSignals.at(-1)}`] : []),
			...visibleTail,
		].slice(0, 5);
	}
	if (lines.length <= 5) return lines;

	const tail = lines.slice(-5);
	const hiddenSignals = lines.slice(0, -5).filter(hasLiveOutputSignal);
	if (hiddenSignals.length === 0) return tail;
	return [
		`… ${hiddenSignals.length} older signal ${hiddenSignals.length === 1 ? "line" : "lines"}: ${hiddenSignals.at(-1)}`,
		...lines.slice(-4),
	];
}

function compactWorkflowError(error: string): string {
	const outputMatch = error.match(/(?:^|\n)Output:\s*([\s\S]+)/);
	if (!outputMatch) return oneLine(error);
	const prefix = oneLine(error.slice(0, outputMatch.index)).replace(/:$/, "") || "Failed";
	const outputLines = outputMatch[1]!.split(/\r?\n/).map(oneLine).filter(Boolean);
	const allOutputLinesAreNoisy = outputLines.length > 0 && outputLines.every(isNoisyStatusLine);
	const latest = outputLines.at(-1);
	return allOutputLinesAreNoisy && latest
		? `${prefix} · latest: ${latestActivityText(latest)}`
		: `${prefix} · ${oneLine(outputMatch[1] ?? "")}`;
}

const WORKFLOW_LIVE_ROW_LIMIT = 8;

function visibleWorkflowRows(rows: WorkflowChatProgressRow[]): { rows: WorkflowChatProgressRow[]; hiddenRows: number } {
	if (rows.length <= WORKFLOW_LIVE_ROW_LIMIT) return { rows, hiddenRows: 0 };
	const selected = new Set<string>();
	const add = (row: WorkflowChatProgressRow): void => {
		if (selected.size >= WORKFLOW_LIVE_ROW_LIMIT || selected.has(row.key)) return;
		selected.add(row.key);
	};
	for (const row of [...rows].reverse()) {
		if (row.state === "failed" || row.state === "detached") add(row);
	}
	for (const row of [...rows].reverse()) add(row);
	return {
		rows: rows.filter((row) => selected.has(row.key)),
		hiddenRows: rows.length - selected.size,
	};
}

function snapshotNowForProgress(progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">): number | undefined {
	if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) return progress.currentToolStartedAt + progress.durationMs;
	return progress.lastActivityAt;
}

function renderToolArgsPreview(value: string, maxLength: number, expanded: boolean): string {
	const normalized = sanitizeDisplayText(value);
	if (expanded || normalized.length <= maxLength) return normalized;
	return `${truncateDisplayText(normalized, maxLength)}...`;
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
		? renderToolArgsPreview(progress.currentToolArgs, maxToolArgsLen, expanded)
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

type ResultPresentation = {
	glyph: string;
	label: "running" | "detached" | "stopped" | "paused" | "failed" | "partial" | "completed";
	tone: "accent" | "warning" | "error" | "success";
};

function semanticResultPresentation(input: {
	running?: boolean;
	detached?: boolean;
	stopped?: boolean;
	interrupted?: boolean;
	failed?: boolean;
	partial?: boolean;
	completedWithoutOutput?: boolean;
	seed?: number;
	frame?: number;
}): ResultPresentation {
	if (input.running) {
		const glyph = input.frame !== undefined ? runningGlyph((input.seed ?? 0) + input.frame) : runningGlyph(input.seed);
		return { glyph, label: "running", tone: "accent" };
	}
	if (input.detached) return { glyph: "■", label: "detached", tone: "warning" };
	if (input.stopped) return { glyph: "■", label: "stopped", tone: "warning" };
	if (input.interrupted) return { glyph: "■", label: "paused", tone: "warning" };
	if (input.failed) return { glyph: "✗", label: "failed", tone: "error" };
	if (input.partial) return { glyph: "■", label: "partial", tone: "warning" };
	return { glyph: "✓", label: "completed", tone: input.completedWithoutOutput ? "warning" : "success" };
}

function hasTerminalResultFlag(result: Details["results"][number]): boolean {
	return Boolean(result.detached || result.stopped || result.interrupted);
}

function hasTerminalResult(result: Details["results"][number]): boolean {
	if (hasTerminalResultFlag(result)) return true;
	const status = result.progress?.status;
	if (status === "running" || status === "pending") return false;
	return result.exitCode !== undefined;
}

function isResultRunning(result: Details["results"][number], status = result.progress?.status): boolean {
	return status === "running" && !hasTerminalResultFlag(result);
}

function detailsHaveRunningResult(details: Details): boolean {
	return details.progress?.some((progress) => {
		if (progress.status !== "running") return false;
		const result = details.results.find((entry) => entry.progress?.index === progress.index) ?? details.results[progress.index];
		return !result || !hasTerminalResultFlag(result);
	})
		|| details.results.some((result) => isResultRunning(result))
		|| workflowGraphHasStatus(details, ["running"]);
}

function resultPresentation(result: Details["results"][number], output: string, running = isResultRunning(result), seed = progressRunningSeed(result.progress ?? result.progressSummary), frame?: number): ResultPresentation {
	return semanticResultPresentation({
		running,
		detached: result.detached,
		stopped: result.stopped,
		interrupted: result.interrupted,
		failed: result.exitCode !== 0,
		completedWithoutOutput: hasEmptyTextOutputWithoutOutputTarget(result.task, output),
		seed,
		frame,
	});
}

function resultGlyph(result: Details["results"][number], output: string, theme: Theme, running = isResultRunning(result), seed = progressRunningSeed(result.progress ?? result.progressSummary), frame?: number): string {
	const presentation = resultPresentation(result, output, running, seed, frame);
	return theme.fg(presentation.tone, presentation.glyph);
}

function styledResultPresentation(presentation: ResultPresentation, theme: Theme): { glyph: string; label: string } {
	return {
		glyph: theme.fg(presentation.tone, presentation.glyph),
		label: theme.fg(presentation.tone, presentation.label),
	};
}

function compactCurrentActivity(progress: AgentProgress): string {
	const snapshotNow = snapshotNowForProgress(progress);
	return formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ?? buildLiveStatusLine(progress, snapshotNow) ?? "thinking…";
}

function textDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function displayTextRenderKey(text: string): unknown[] {
	const normalized = sanitizeDisplayText(text);
	return [normalized.length, textDigest(normalized)];
}

function expandedStepActivityRenderKey(step: AsyncJobStep): unknown[] {
	return [
		step.recentTools?.slice(-3).map((tool) => [tool.tool, displayTextRenderKey(tool.args), tool.endMs]),
		compactRecentOutputLines(step.recentOutput).map(displayTextRenderKey),
	];
}

function widgetStepRenderKey(step: AsyncJobStep, index: number, expanded = false): unknown[] {
	return [
		step.index ?? index,
		step.agent,
		step.sessionName,
		step.workflowKey,
		step.phase,
		step.label,
		step.status,
		step.activityState,
		step.lastActivityAt,
		step.currentTool,
		step.currentToolArgs,
		step.currentToolStartedAt,
		step.currentPath,
		step.turnCount,
		step.toolCount,
		step.startedAt,
		step.endedAt,
		step.durationMs,
		step.tokens?.total,
		step.model,
		step.thinking,
		step.context,
		step.description,
		step.outputName,
		step.structured,
		step.acceptance?.status,
		step.acceptance?.reviewResult?.status,
		step.review?.status,
		step.toolBudgetBlocked,
		step.turnBudgetExceeded,
		step.timedOut,
		step.stopped,
		step.execution?.status,
		step.execution?.error,
		step.execution?.timedOut,
		step.execution?.interrupted,
		step.execution?.stopped,
		step.execution?.detached,
		step.watchdog?.phase,
		step.error,
		expanded ? expandedStepActivityRenderKey(step) : undefined,
		nestedRenderKey(step.children, expanded),
	];
}

function nestedRenderKey(children: NestedRunSummary[] | undefined, expanded = false): unknown[] {
	return (children ?? []).map((child) => [
		child.id,
		child.state,
		child.agent,
		child.sessionName,
		child.model,
		child.thinking,
		child.activityState,
		child.lastActivityAt,
		child.currentTool,
		child.currentToolStartedAt,
		child.currentPath,
		child.turnCount,
		child.toolCount,
		child.startedAt,
		child.endedAt,
		child.lastUpdate,
		child.error,
		child.totalTokens?.total,
		child.steps?.map((step, index) => widgetStepRenderKey({ ...step, agent: step.agent, status: step.status }, index, expanded)),
		nestedRenderKey(child.children, expanded),
	]);
}

function hostStepRenderKey(row: AsyncStatusWorkflowRow): unknown[] {
	return [
		row.kind,
		row.name,
		row.state,
		row.provider,
		row.role,
		row.verdict,
		row.reasonCode,
		row.detail,
		row.target,
		row.freshness,
		row.reportPath,
	];
}

export function widgetRenderKey(job: AsyncJobState, expanded = false): string {
	const projection = buildWorkflowWidgetProjection(job);
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
		workflowHostSteps: projectAsyncWorkflowRows([], job.hostSteps).map(hostStepRenderKey),
		workflowGraph: job.mode === "workflow" && job.workflowGraph ? {
			currentNodeId: job.workflowGraph.currentNodeId,
			stages: projection.stages.map((node) => [node.id, node.status, node.agent, node.phase, node.label, node.flatIndex, node.outputName, node.structured, node.error]),
		} : undefined,
		preflight: expanded ? job.preflight : job.preflight ? formatWorkflowPreflightPlanSummary(job.preflight) : undefined,
		preflightWarnings: expanded ? job.workflow?.preflightWarnings : job.workflow?.preflightWarnings?.length || undefined,
		checklist: projection.checklist ? {
			total: projection.checklist.total,
			done: projection.checklist.done,
			running: projection.checklist.running,
			queued: projection.checklist.queued,
			blocked: projection.checklist.blocked,
			failed: projection.checklist.failed,
			phases: projection.checklist.phases.map((phase) => [phase.key, phase.state, phase.done, phase.total, phase.running, phase.queued, phase.blocked, phase.failed, phase.paused, phase.stopped, phase.items.map((item) => [item.key, item.state, item.currentTool, item.currentPath, item.durationMs, item.toolCount, item.error])]),
		} : undefined,
		steps: job.steps?.map((step, index) => widgetStepRenderKey(step, index, expanded)),
		nestedChildren: nestedRenderKey(job.nestedChildren, expanded),
		lane: laneRenderKey(job, projection),
		stepsTotal: job.stepsTotal,
		runningSteps: job.runningSteps,
		completedSteps: job.completedSteps,
		activeParallelGroup: job.activeParallelGroup,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		timedOut: job.timedOut,
		stopped: job.stopped,
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

function isSingleChildAsyncJob(job: AsyncJobState): boolean {
	return job.mode === "single"
		&& job.steps?.length === 1
		&& shouldSuppressSingleStep(job.chainStepCount, job.stepsTotal);
}

function isCompletedWidgetStepStatus(status: AsyncJobStep["status"]): boolean {
	return status === "complete" || status === "completed";
}

function singleChildAgentName(job: AsyncJobState, step: AsyncJobStep): string {
	return job.agents?.length === 1 ? job.agents[0]! : step.agent || widgetJobName(job);
}

function hasSingleChildDetailEvidence(job: AsyncJobState, step: AsyncJobStep): boolean {
	return Boolean(
		step.error?.trim()
		|| step.execution?.error?.trim()
		|| step.phase?.trim()
		|| step.label?.trim()
		|| step.workflowKey?.trim()
		|| step.outputName?.trim()
		|| step.lane
		|| job.workflowKey?.trim()
		|| job.lane
		|| laneTraceForJob(job)?.phase?.trim()
		|| laneTraceForJob(job)?.label?.trim()
		|| step.timedOut
		|| step.stopped
		|| step.execution?.timedOut
		|| step.execution?.interrupted
		|| step.execution?.stopped
		|| step.execution?.detached
		|| job.timedOut
		|| job.stopped
		|| ["failed", "partial", "paused", "stopped", "detached"].includes(step.execution?.status ?? "")
		|| step.acceptance?.status === "rejected"
		|| step.acceptance?.reviewResult?.status === "blockers"
		|| step.review?.status === "blockers",
	);
}

function shouldCollapseSingleChildDetails(job: AsyncJobState, step: AsyncJobStep): boolean {
	if (!isSingleChildAsyncJob(job) || hasSingleChildDetailEvidence(job, step)) return false;
	if (job.status === "running") return step.status === "running";
	if (job.status === "complete") return isCompletedWidgetStepStatus(step.status);
	return false;
}

function singleChildTask(job: AsyncJobState, step: AsyncJobStep): string | undefined {
	const task = compactTaskText(step.description, step.label);
	if (task) return task;
	const sessionName = step.sessionName?.trim();
	if (!sessionName) return undefined;
	const agentName = singleChildAgentName(job, step);
	const sessionTask = stripRepeatedAgentPrefix(sessionName, agentName);
	return sessionTask === agentName ? undefined : compactTaskText(sessionTask);
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
	if (job.status === "partial") return "Partial";
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

function widgetStatusGlyph(job: AsyncJobState, theme: Theme, frame?: number): string {
	if (job.status === "running") return theme.fg("accent", runningGlyph(animatedSeed(widgetJobRunningSeed(job), frame)));
	if (job.status === "queued") return theme.fg("muted", "◦");
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	if (job.status === "stopped") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme, seed?: number, frame?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(animatedSeed(seed, frame)));
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

function workflowChecklistStateLabel(state: WorkflowChecklistState): string {
	if (state === "running") return "running";
	if (state === "complete") return "complete";
	return state;
}

function workflowChecklistGlyph(item: { state: WorkflowChecklistState; startedAt?: number; durationMs?: number; toolCount?: number; currentToolStartedAt?: number }, theme: Theme, frame?: number): string {
	if (item.state === "running") return theme.fg("accent", runningGlyph(animatedSeed(runningSeed(item.startedAt, item.durationMs, item.toolCount, item.currentToolStartedAt), frame)));
	if (item.state === "complete") return theme.fg("success", "✓");
	if (item.state === "blocked") return theme.fg("error", "!");
	if (item.state === "failed") return theme.fg("error", "✗");
	if (item.state === "paused" || item.state === "stopped") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

function workflowChecklistItemPriority(state: WorkflowChecklistState): number {
	if (state === "blocked") return 0;
	if (state === "failed") return 1;
	if (state === "running") return 2;
	if (state === "paused") return 3;
	if (state === "stopped") return 4;
	if (state === "queued") return 5;
	return 6;
}

function workflowChecklistItemLine(item: WorkflowChecklistItem, theme: Theme, indent: string, frame?: number): string {
	const identity = [item.label, item.agent && item.agent !== item.label ? item.agent : undefined].filter(Boolean).join(" · ");
	const context = contextModeBadge(theme, item.context);
	const state = item.state === "complete" ? "" : ` ${theme.fg("dim", `· ${workflowChecklistStateLabel(item.state)}`)}`;
	const details = [
		item.currentTool ? `${item.currentTool}${item.durationMs !== undefined ? ` ${formatDuration(item.durationMs)}` : ""}` : undefined,
		!item.currentTool && item.currentPath ? shortenPath(item.currentPath) : undefined,
		!item.currentTool && item.durationMs !== undefined ? formatDuration(item.durationMs) : undefined,
		item.toolCount !== undefined ? `${item.toolCount} tools` : undefined,
		item.outputName ? `out:${item.outputName}` : undefined,
		item.error ? `error:${oneLine(item.error)}` : undefined,
	].filter(Boolean).join(" · ");
	return `${indent}${workflowChecklistGlyph(item, theme, frame)} ${theme.bold(identity || item.key)}${context}${state}${details ? ` ${theme.fg("dim", `· ${details}`)}` : ""}`;
}

const COLLAPSED_WORKFLOW_PHASE_LIMIT = 4;

function workflowChecklistWidgetLines(checklist: WorkflowChecklistProjection | undefined, theme: Theme, indent: string, expanded: boolean, frame?: number, includeSummary = true, limitPhases = !expanded, includeBottleneckOutput = expanded): string[] {
	if (!checklist?.total) return [];
	const lines = includeSummary ? [`${indent}${theme.fg("dim", `Checklist ${formatWorkflowChecklistSummary(checklist)}`)}`] : [];
	const phases = !limitPhases || checklist.phases.length <= COLLAPSED_WORKFLOW_PHASE_LIMIT
		? checklist.phases
		: checklist.phases
			.map((phase, index) => ({ phase, index }))
			.sort((left, right) => Number(left.phase.state !== "running") - Number(right.phase.state !== "running")
				|| Number(left.phase.state === "complete") - Number(right.phase.state === "complete")
				|| left.index - right.index)
			.slice(0, COLLAPSED_WORKFLOW_PHASE_LIMIT)
			.sort((left, right) => left.index - right.index)
			.map(({ phase }) => phase);
	for (const phase of phases) {
		const phaseItem = phase.items.find((item) => item.state === "running") ?? phase.items[0];
		const glyph = workflowChecklistGlyph({
			state: phase.state,
			startedAt: phaseItem?.startedAt,
			durationMs: phaseItem?.durationMs,
			toolCount: phaseItem?.toolCount,
			currentToolStartedAt: phaseItem?.currentToolStartedAt,
		}, theme, frame);
		lines.push(`${indent}${glyph} ${theme.bold(formatWorkflowChecklistPhase(phase))}`);
		if (expanded) {
			for (const item of [...phase.items].sort((left, right) => workflowChecklistItemPriority(left.state) - workflowChecklistItemPriority(right.state))) {
				lines.push(workflowChecklistItemLine(item, theme, `${indent}  `, frame));
			}
		}
	}
	const bottleneck = formatWorkflowChecklistBottleneck(checklist.bottleneck, { includeOutput: includeBottleneckOutput });
	if (bottleneck) {
		const tone = checklist.bottleneck?.state === "blocked" || checklist.bottleneck?.state === "failed" ? "error" : checklist.bottleneck?.state === "running" ? "accent" : "warning";
		lines.push(`${indent}${theme.fg(tone, `bottleneck · ${bottleneck}`)}`);
	}
	return lines;
}

function widgetStepActivity(step: NonNullable<AsyncJobState["steps"]>[number], snapshotNow?: number): string {
	const facts: string[] = [];
	if (step.currentTool && step.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${step.currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`);
	else if (step.currentTool) facts.push(step.currentTool);
	if (step.currentPath) facts.push(shortenPath(step.currentPath));
	if (step.turnCount !== undefined) facts.push(`${step.turnCount} turns`);
	if (step.toolCount !== undefined) facts.push(`${step.toolCount} tools`);
	if (step.tokens?.total) facts.push(formatTokenUsage(step.tokens, "token"));
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	return facts.join(" · ");
}


function widgetChainDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth(), frame?: number): string[] {
	if (!job.steps?.length) return [];
	const total = job.chainStepCount ?? job.steps.length;
	const lines: string[] = [];
	for (const span of buildAsyncChainStepSpans(total, job.steps.length, job.parallelGroups)) {
		const steps = job.steps.slice(span.start, span.start + span.count);
		if (span.isParallel) {
			lines.push(...parallelWidgetGroupDetails(job, theme, { steps, total: span.count, stepIndex: span.stepIndex, chainTotal: total }, expanded, width, frame, false));
			continue;
		}
		const step = steps[0];
		if (!step) {
			lines.push(`  ${theme.fg("dim", `◦ Step ${span.stepIndex + 1}/${total}: pending`)}`);
			continue;
		}
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, "Step", span.stepIndex + 1, total, expanded, width, frame));
	}
	return lines;
}

function widgetParallelAgentDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth(), frame?: number): string[] {
	if (!job.steps?.length) return [];
	if (job.mode !== "parallel" && job.mode !== "chain") return [];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width, frame);
	const group = activeParallelWidgetGroup(job);
	if (group) return parallelWidgetGroupDetails(job, theme, group, expanded, width, frame, Boolean(job.activeParallelGroup));
	const total = job.stepsTotal ?? job.steps.length;
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		const marker = index === job.steps.length - 1 ? "└" : "├";
		const activity = widgetStepActivity(step, job.updatedAt);
		const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		const label = compactTaskText(step.description, step.label);
		const display = step.sessionName?.trim() || (label ? `${label} (${step.agent})` : step.agent);
		lines.push(`  ${theme.fg("dim", `${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index), frame)} ${itemTitle} ${index + 1}/${total}: ${display} · ${widgetStepStatus(step.status, theme)}${modelDisplay}${activity ? ` · ${activity}` : ""}`)}`);
		const lane = projectAsyncLane(job, step);
		if (lane) lines.push(...formatLaneProjectionLines(lane, theme, "    "));
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, expanded ? 8 : 6)) lines.push(`    ${nestedLine}`);
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

function buildAsyncChainStepSpans(total: number, stepCount: number, parallelGroups: AsyncParallelGroupStatus[] = []): ChainStepSpan[] {
	const groupsByStep = new Map<number, AsyncParallelGroupStatus>();
	for (const group of parallelGroups) {
		if (!groupsByStep.has(group.stepIndex)) groupsByStep.set(group.stepIndex, group);
	}
	const spans: ChainStepSpan[] = [];
	let flatIndex = 0;
	for (let stepIndex = 0; stepIndex < total; stepIndex++) {
		const group = groupsByStep.get(stepIndex);
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

interface ParallelWidgetGroup {
	steps: AsyncJobStep[];
	total: number;
	stepIndex?: number;
	chainTotal?: number;
}

interface ParallelWidgetStepRow {
	step: AsyncJobStep;
	index: number;
	rowLabel: string;
}

function normalizedParallelDisplayText(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	const normalized = oneLine(value);
	return normalized && normalized !== PROMPT_REDACTED ? normalized : undefined;
}

function parallelWidgetStepDisplayName(step: AsyncJobStep): string {
	const agent = normalizedParallelDisplayText(step.agent);
	const explicitLabel = normalizedParallelDisplayText(step.label);
	if (explicitLabel) {
		const label = compactTaskText(step.description, explicitLabel) ?? explicitLabel;
		return agent ? `${label} (${agent})` : label;
	}

	const sessionName = normalizedParallelDisplayText(step.sessionName);
	if (sessionName) {
		const sessionTask = stripRepeatedAgentPrefix(sessionName, agent);
		if (sessionTask && sessionTask !== PROMPT_REDACTED && sessionTask.toLowerCase() !== agent?.toLowerCase()) return sessionTask;
	}

	return compactTaskText(step.description) ?? agent ?? "subagent";
}

function parallelWidgetStepPriority(step: AsyncJobStep): number {
	if (step.status === "running" || step.activityState === "needs_attention") return 0;
	switch (step.status) {
		case "failed":
		case "rejected":
		case "partial":
		case "stopped":
		case "paused":
			return 1;
		case "complete":
		case "completed":
			return 2;
		default:
			return 3;
	}
}

function parallelWidgetStepRows(steps: AsyncJobStep[], total: number, prioritizeActive: boolean): ParallelWidgetStepRow[] {
	const indexed = steps.map((step, index) => ({ step, index, displayName: parallelWidgetStepDisplayName(step) }));
	if (prioritizeActive) indexed.sort((left, right) => parallelWidgetStepPriority(left.step) - parallelWidgetStepPriority(right.step) || left.index - right.index);
	return withDuplicateLabelDiscriminators(indexed, total).map(({ displayName, ...row }) => row);
}

function activeParallelWidgetGroup(job: AsyncJobState): ParallelWidgetGroup | undefined {
	const steps = job.steps ?? [];
	if (!steps.length) return undefined;
	if (job.mode === "parallel") return { steps, total: job.stepsTotal ?? steps.length };
	if (job.mode !== "chain" || !job.activeParallelGroup) return undefined;

	const chainTotal = job.chainStepCount ?? job.stepsTotal ?? steps.length;
	const spans = buildAsyncChainStepSpans(chainTotal, steps.length, job.parallelGroups);
	const currentStep = job.currentStep;
	const activeSpan = currentStep === undefined
		? spans.find((span) => span.isParallel)
		: spans.find((span) => span.isParallel
			&& currentStep >= span.start
			&& currentStep < span.start + span.count);
	return {
		steps,
		total: activeSpan?.count ?? job.stepsTotal ?? steps.length,
		stepIndex: activeSpan?.stepIndex,
		chainTotal,
	};
}

function parallelWidgetGroupHeader(
	group: ParallelWidgetGroup,
	theme: Theme,
	frame?: number,
): string {
	const status = aggregateStepStatus(group.steps);
	const label = group.stepIndex !== undefined && group.chainTotal !== undefined
		? `Step ${group.stepIndex + 1}/${group.chainTotal}: parallel group`
		: "parallel group";
	return `  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(group.steps), frame)} ${themeBold(theme, label)} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(group.steps, group.total))}`;
}

function parallelWidgetGroupDetails(
	job: AsyncJobState,
	theme: Theme,
	group: ParallelWidgetGroup,
	expanded: boolean,
	width: number,
	frame: number | undefined,
	prioritizeActive: boolean,
): string[] {
	const lines = [parallelWidgetGroupHeader(group, theme, frame)];
	const rows = parallelWidgetStepRows(group.steps, group.total, prioritizeActive);
	for (const [rowIndex, row] of rows.entries()) {
		const marker = rowIndex === rows.length - 1 && rows.length >= group.total ? "└─" : "├─";
		lines.push(...foregroundStyleWidgetStepLines(job, theme, row.step, "Agent", row.index + 1, group.total, expanded, width, frame, {
			rowLabel: row.rowLabel,
			rowIndent: "    ",
			detailIndent: "      ",
			rowMarker: marker,
			includeCurrentPath: true,
		}));
	}
	for (let index = rows.length; index < group.total; index++) {
		const marker = index === group.total - 1 ? "└─" : "├─";
		lines.push(`    ${marker} ${theme.fg("muted", "◦")} ${theme.fg("dim", "pending")}`);
	}
	return lines;
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
	rowLabel?: string;
	agentName: string;
	displayIndex: number;
	isParallel?: boolean;
}

interface ChainRenderGroupEntry {
	kind: "group";
	stepLabel: string;
	groupLabel?: string;
	status: WorkflowNodeStatus;
	error?: string;
}

type ChainRenderEntry = ChainRenderResultEntry | ChainRenderGroupEntry;

function chainSpanStatus(details: Details, span: ChainStepSpan): WorkflowNodeStatus {
	if (span.status) return span.status;
	const results = details.results.slice(span.start, span.start + span.count);
	if (results.some((result) => isResultRunning(result))) return "running";
	if (results.some((result) => !hasTerminalResultFlag(result) && (result.progress?.status === "failed" || result.exitCode !== 0) && !isResultRunning(result))) return "failed";
	if (results.some((result) => result.stopped)) return "stopped";
	if (results.some((result) => result.interrupted)) return "paused";
	if (results.some((result) => result.detached || result.progress?.status === "detached")) return "detached";
	if (results.length < span.count) return "pending";
	if (results.length > 0 && results.every(isDoneResult)) return "completed";
	return "pending";
}

function withDuplicateForegroundLabels(entries: ChainRenderResultEntry[], total: number): ChainRenderResultEntry[] {
	return withDuplicateLabelDiscriminators(
		entries.map((entry) => ({ ...entry, index: entry.displayIndex, displayName: entry.agentName })),
		total,
	).map(({ displayName, rowLabel, ...entry }) => ({
		...entry,
		rowLabel: rowLabel === displayName ? undefined : rowLabel.slice(0, -(displayName.length + 2)),
	}));
}

function buildChainRenderEntries(details: Details, label: MultiProgressLabel): ChainRenderEntry[] | undefined {
	if (details.mode !== "chain" || !label.hasParallelInChain || label.showActiveGroupOnly) return undefined;
	const entries: ChainRenderEntry[] = [];
	for (const span of buildChainStepSpans(details)) {
		if (span.isParallel) {
			entries.push({
				kind: "group",
				stepLabel: `Step ${span.stepIndex + 1}/${label.logicalStepCount}: parallel group`,
				groupLabel: span.label?.trim() || undefined,
				status: chainSpanStatus(details, span),
				error: span.error,
			});
			const groupEntries: ChainRenderResultEntry[] = [];
			for (let index = span.start; index < span.start + span.count; index++) {
				const result = details.results[index];
				const localIndex = foregroundResultIndex(details, index);
				const displayIndex = localIndex >= span.start && localIndex < span.start + span.count
					? localIndex - span.start
					: index - span.start;
				groupEntries.push({
					kind: "result",
					resultIndex: index,
					rowNumber: index - span.start + 1,
					agentName: foregroundResultDisplayName(details, index, result, `agent-${displayIndex + 1}`),
					displayIndex,
					isParallel: true,
				});
			}
			entries.push(...withDuplicateForegroundLabels(groupEntries, span.count));
			continue;
		}
		for (let index = span.start; index < span.start + span.count; index++) {
			const result = details.results[index];
			entries.push({
				kind: "result",
				resultIndex: index,
				rowNumber: span.stepIndex + 1,
				rowLabel: resultRowLabel(label, span.stepIndex + 1),
				agentName: foregroundResultDisplayName(details, index, result, details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`),
				displayIndex: foregroundResultIndex(details, index),
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
	logicalStepCount: number;
}

function buildMultiProgressLabel(details: Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "chainAgents" | "workflowGraph">, hasRunning: boolean): MultiProgressLabel {
	const stepSpans = buildChainStepSpans(details);
	const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
	const activeParallelGroup = details.mode === "chain"
		&& details.currentStepIndex !== undefined
		&& stepSpans.some((span) => span.stepIndex === details.currentStepIndex && span.isParallel);
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
			const status = result.stopped
				? "stopped"
				: result.interrupted || result.detached
					? "detached"
					: result.progress?.status
						?? (result.exitCode === 0 ? "completed" : "failed");
			statuses[index] = status;
		}
		const running = statuses.filter((status) => status === "running").length;
		const done = statuses.filter((status) => status === "completed").length;
		const headerLabel = hasRunning
			? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
			: `${done}/${totalCount} done`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: totalCount, showActiveGroupOnly: false, logicalStepCount: totalCount };
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
			const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
			if (progressEntry?.status === "running" && (!resultEntry || !hasTerminalResultFlag(resultEntry))) {
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
		return { headerLabel, itemTitle, totalCount: groupSize, hasParallelInChain, activeParallelGroup, groupStartIndex: groupStart, groupEndIndex: groupEnd, showActiveGroupOnly: true, logicalStepCount: totalSteps };
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
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false, logicalStepCount: totalCount };
	}

	const totalCount = details.totalSteps ?? details.results.length;
	const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0));
	const done = details.results.filter(isDoneResult).length;
	const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
	return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false, logicalStepCount: totalCount };
}

function resultRowLabel(label: MultiProgressLabel, stepNumber: number): string | undefined {
	if (label.itemTitle === "Agent") return undefined;
	if (shouldSuppressSingleStep(label.logicalStepCount)) return undefined;
	return `Step ${stepNumber}/${label.logicalStepCount}`;
}

function buildForegroundResultEntries(
	details: Details,
	label: MultiProgressLabel,
	displayStart: number,
	displayEnd: number,
	useResultsDirectly: boolean,
): ChainRenderResultEntry[] {
	const fallbackLabel = label.itemTitle.toLowerCase();
	const entries = Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderResultEntry => {
		const index = displayStart + offset;
		const result = details.results[index];
		const stableIndex = foregroundResultIndex(details, index);
		const rowNumber = label.showActiveGroupOnly ? index - label.groupStartIndex + 1 : stableIndex + 1;
		const fallbackAgent = useResultsDirectly
			? (result?.agent || `${fallbackLabel}-${rowNumber}`)
			: (details.chainAgents![index] || result?.agent || `${fallbackLabel}-${rowNumber}`);
		const displayIndex = label.activeParallelGroup && stableIndex >= label.groupStartIndex && stableIndex < label.groupEndIndex
			? stableIndex - label.groupStartIndex
			: label.activeParallelGroup ? index - label.groupStartIndex : stableIndex;
		return {
			kind: "result",
			resultIndex: index,
			rowNumber,
			rowLabel: resultRowLabel(label, rowNumber),
			agentName: foregroundResultDisplayName(details, index, result, fallbackAgent),
			displayIndex,
		};
	});
	return label.itemTitle === "Agent" ? withDuplicateForegroundLabels(entries, label.totalCount) : entries;
}

function widgetStats(job: AsyncJobState, theme: Theme, projection = buildWorkflowWidgetProjection(job), collapsed = false): string {
	const parts: string[] = [];
	const { stageProgress } = projection;
	const stepsTotal = stageProgress?.total ?? job.stepsTotal ?? (job.agents?.length ?? 1);
	const isSingleChild = isSingleChildAsyncJob(job);
	const checklistPrimary = collapsed && job.mode === "workflow" && projection.checklist !== undefined;
	if (checklistPrimary) {
		parts.push(formatWorkflowChecklistSummary(projection.checklist!));
	} else if (stageProgress) {
		const currentStage = stageProgress.current !== undefined ? projection.stages[stageProgress.current] : undefined;
		const focus = currentStage
			? [compactTaskText(undefined, currentStage.label) ?? boundedLaneValue(currentStage.id), currentStage.agent ? boundedLaneValue(currentStage.agent) : "", workflowNodeStatusLabel(currentStage.status)].filter(Boolean)
			: [];
		parts.push(["staged lane", stageProgress.current !== undefined ? `stage ${stageProgress.current + 1}/${stageProgress.total}` : `${stageProgress.total} stages`, ...focus].join(" · "));
	} else if (job.activeParallelGroup) {
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
		if (job.mode === "chain") {
			const total = job.chainStepCount ?? stepsTotal;
			parts.push(`step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups ?? []) + 1}/${total}`);
		} else if (!isSingleChild) {
			parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
		}
	} else if (stepsTotal > 1) {
		parts.push(`steps ${stepsTotal}`);
	}
	if (projection.checklist && !checklistPrimary) parts.push(formatWorkflowChecklistSummary(projection.checklist));
	if (job.toolCount !== undefined) parts.push(formatToolUseStat(job.toolCount));
	if (job.totalTokens?.total) parts.push(formatTokenUsage(job.totalTokens, "token"));
	if (job.startedAt !== undefined && job.updatedAt !== undefined) parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
	return statJoin(theme, parts);
}

function widgetStepStats(theme: Theme, step: NonNullable<AsyncJobState["steps"]>[number]): string {
	return statJoin(theme, [
		step.turnCount !== undefined ? `${step.turnCount} turns` : "",
		step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
		step.tokens
			? step.contextLimit !== undefined
				? formatContextUsage(step.tokens, step.contextLimit) ?? formatTokenUsage(step.tokens, "token")
				: step.tokens.total ? formatTokenUsage(step.tokens, "token") : ""
			: "",
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
	if (run.sessionName?.trim()) return run.sessionName.trim();
	if (run.agent) return run.agent;
	if (run.agents?.length) return formatWidgetAgents(run.agents);
	return run.id;
}

function nestedStatusGlyph(state: NestedRunSummary["state"] | NestedStepSummary["status"], theme: Theme, seed?: number): string {
	if (state === "running") return theme.fg("accent", runningGlyph(seed));
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "partial") return theme.fg("warning", "■");
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
	if (state === "partial") return "Partial";
	if (state === "failed") return "Failed";
	return "Done";
}

function formatNestedWidgetLines(children: NestedRunSummary[] | undefined, theme: Theme, width: number, expanded: boolean, snapshotNow?: number, lineBudget = expanded ? 12 : 1): string[] {
	if (!children?.length || lineBudget <= 0) return [];
	if (!expanded) {
		type CollapsedRow = { text: string; prefix: string };
		const rows: CollapsedRow[] = [];
		const maxLeaves = 4;
		const maxLines = Math.min(6, lineBudget);
		let leaves = 0;
		let overflow = 0;
		const appendLeaf = (step: NestedStepSummary | NestedRunSummary, prefix: string, fallback?: number): void => {
			if (leaves >= maxLeaves) {
				overflow++;
				return;
			}
			leaves++;
			const state = "status" in step ? step.status : step.state;
			const modelThinking = formatModelThinking(step.model, step.thinking);
			const activity = nestedActivity(step, state, snapshotNow ?? fallback);
			const timestamp = "status" in step ? nestedStepTimestamp(step, fallback) : formatClockTime(nestedRunEventTime(step));
			const error = step.error ? ` · ${step.error}` : "";
			const name = "status" in step ? childDisplayName(step) : nestedRunName(step);
			rows.push({
				prefix,
				text: `${nestedTimestampPrefix(timestamp)}${nestedStatusGlyph(state, theme)} ${name} · ${state}${modelThinking ? ` · ${modelThinking}` : ""}${activity ? ` · ${activity}` : ""}${error}`,
			});
		};
		for (const child of children) {
			const steps = (child.mode === "parallel" || child.mode === "chain") ? child.steps ?? [] : [];
			if (steps.length > 0) {
				const ownerModelThinking = formatModelThinking(child.model, child.thinking);
				const ownerActivity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate);
				const ownerError = child.error ? ` · ${child.error}` : "";
				rows.push({
					prefix: "↳ ",
					text: `OWNER ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state}${ownerModelThinking ? ` · ${ownerModelThinking}` : ""}${ownerActivity ? ` · ${ownerActivity}` : ""}${ownerError}`,
				});
				for (const step of steps) appendLeaf(step, "↳ │  ", child.lastUpdate);
			} else {
				appendLeaf(child, "↳ ", child.lastUpdate);
			}
		}
		if (overflow > 0) rows.push({ prefix: "↳ ", text: `… +${overflow} more nested leaves` });
		const visibleRows = rows.length <= maxLines
			? rows
			: overflow > 0
				? [...rows.slice(0, Math.max(0, maxLines - 1)), rows.at(-1)!]
				: rows.slice(0, maxLines);
		return visibleRows.map((row, index) => {
			const marker = index === visibleRows.length - 1 ? "└─" : "├─";
			const prefix = row.prefix;
			const text = row.text.startsWith("OWNER ") ? row.text.slice("OWNER ".length) : row.text;
			return truncLine(theme.fg("dim", `${prefix}${marker} ${text}`), width);
		});
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
			const modelThinking = formatModelThinking(child.model, child.thinking);
			lines.push(theme.fg("dim", `${prefix}↳ ${nestedTimestampPrefix(formatClockTime(nestedRunEventTime(child)))}${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state}${modelThinking ? ` · ${modelThinking}` : ""} · ${activity}${error}`));
			if (depth === maxDepth) {
				const aggregate = formatNestedAggregate([...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])]);
				if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
				continue;
			}
			for (const step of child.steps ?? []) {
				if (lines.length >= lineBudget) return;
				const modelThinking = formatModelThinking(step.model, step.thinking);
				lines.push(theme.fg("dim", `${prefix}  ↳ ${nestedTimestampPrefix(nestedStepTimestamp(step, child.lastUpdate))}${nestedStatusGlyph(step.status, theme)} ${childDisplayName(step)} · ${step.status}${modelThinking ? ` · ${modelThinking}` : ""} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`));
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
	itemTitle: "Agent" | "Stage" | "Step",
	index: number,
	total: number,
	expanded: boolean,
	width: number,
	frame?: number,
	options?: { rowLabel?: string; rowIndent?: string; detailIndent?: string; rowMarker?: string; includeCurrentPath?: boolean },
): string[] {
	const rowIndent = options?.rowIndent ?? "  ";
	const detailIndent = options?.detailIndent ?? "    ";
	const status = widgetStepStatus(step.status, theme);
	const stats = widgetStepStats(theme, step);
	const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
	const collapseDetails = shouldCollapseSingleChildDetails(job, step);
	const displayName = collapseDetails ? singleChildAgentName(job, step) : childDisplayName(step);
	const stageName = itemTitle === "Stage"
		? compactTaskText(undefined, step.label) ?? boundedLaneValue(step.workflowKey) ?? displayName
		: undefined;
	const stageIdentity = stageName && stageName !== displayName ? `${stageName} (${displayName})` : stageName ?? displayName;
	const rowLabel = collapseDetails ? displayName : (options?.rowLabel ?? `${itemTitle} ${index}/${total}: ${itemTitle === "Stage" ? stageIdentity : displayName}`);
	const rowMarker = options?.rowMarker ? `${options.rowMarker} ` : "";
	const lines = [`${rowIndent}${rowMarker}${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index - 1), frame)} ${themeBold(theme, rowLabel)}${contextModeBadge(theme, step.context)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`];
	const lane = projectAsyncLane(job, step);
	if (lane) lines.push(...formatLaneProjectionLines(lane, theme, detailIndent));
	const task = collapseDetails ? singleChildTask(job, step) : compactTaskText(step.description, step.label);
	if (task) lines.push(`${detailIndent}${theme.fg("dim", `task: ${task}`)}`);
	const activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
	const currentPath = options?.includeCurrentPath && step.currentPath ? shortenPath(step.currentPath) : undefined;
	const activityWithPath = currentPath && activity && !activity.includes(currentPath)
		? `${activity} · ${currentPath}`
		: activity ?? currentPath;
	if (activityWithPath) lines.push(`${detailIndent}${theme.fg("dim", `⎿  ${activityWithPath}`)}`);
	for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, expanded ? 12 : 6)) {
		lines.push(`${detailIndent}${nestedLine}`);
	}
	const error = step.error?.trim() || step.execution?.error?.trim();
	if (error) lines.push(`${detailIndent}${theme.fg("error", `error: ${oneLine(error)}`)}`);
	if (step.status === "running") {
		if (!expanded) lines.push(`${detailIndent}${theme.fg("accent", liveDetailHintText())}`);
		const output = widgetOutputPath(job, step);
		if (output) lines.push(`${detailIndent}${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
		if (expanded) {
			const liveStatus = buildLiveStatusLine(step, job.updatedAt);
			if (liveStatus && liveStatus !== activity) lines.push(`${detailIndent}${theme.fg("accent", liveStatus)}`);
			for (const tool of step.recentTools?.slice(-3) ?? []) {
				const maxArgsLen = Math.max(40, width - 30);
				const argsPreview = renderToolArgsPreview(tool.args, maxArgsLen, expanded);
				lines.push(`${detailIndent}  ${theme.fg("dim", `${tool.tool}${argsPreview ? `: ${argsPreview}` : ""}`)}`);
			}
			for (const line of compactRecentOutputLines(step.recentOutput)) {
				lines.push(`${detailIndent}  ${theme.fg("dim", line)}`);
			}
		}
	}
	return lines;
}

function hostStepWidgetLines(job: AsyncJobState, theme: Theme, indent: string): string[] {
	const rows = projectAsyncWorkflowRows([], job.hostSteps).filter((row) => row.kind);
	const visible = rows.slice(0, 8);
	const lines = visible.map((row) => {
		const state = hostStepVerdictLabel(row.state as HostStepState, row.verdict as HostStepVerdict | undefined);
		const glyph = state === "running" ? theme.fg("accent", "●")
			: state === "pending" ? theme.fg("muted", "◦")
			: state === "pass" ? theme.fg("success", "✓")
			: state === "fail" || state === "error" ? theme.fg("error", "✗")
			: theme.fg("warning", "■");
		const details = [
			row.provider ? `provider:${row.provider}` : undefined,
			row.role ? `role:${row.role}` : undefined,
			row.target,
			row.detail,
			row.reasonCode ? `reason:${row.reasonCode}` : undefined,
			row.freshness?.stale ? "stale" : row.freshness?.observedRef ? `ref:${row.freshness.observedRef}` : undefined,
			row.reportPath ? `out:${hostStepReportName(row.reportPath)}` : undefined,
		].filter(Boolean).join(" · ");
		return `${indent}${glyph} ${row.kind}: ${row.name} · ${state}${details ? ` · ${details}` : ""}`;
	});
	if (rows.length > visible.length) lines.push(`${indent}${theme.fg("dim", `… +${rows.length - visible.length} host steps hidden`)}`);
	return lines;
}

function foregroundStyleWidgetDetails(job: AsyncJobState, theme: Theme, expanded: boolean, width: number, frame?: number, projection = buildWorkflowWidgetProjection(job)): string[] {
	const { steps } = projection;
	const checklistPrimary = !expanded && job.mode === "workflow" && projection.checklist !== undefined;
	if (checklistPrimary) {
		const lines = [
			...workflowPreflightLines(job, false),
			...workflowChecklistWidgetLines(projection.checklist, theme, "  ", false, frame, false),
		];
		if (job.status === "running" || projection.checklist!.running > 0) lines.push(`  ${theme.fg("accent", liveDetailHintText())}`);
		return lines;
	}
	if (!steps.length) {
		const lane = projectAsyncLane(job, laneStepForJob(job, steps));
		return [
			...workflowPreflightLines(job, expanded),
			...workflowChecklistWidgetLines(projection.checklist, theme, "  ", expanded, frame),
			...(lane ? formatLaneProjectionLines(lane, theme, "  ") : []),
			...hostStepWidgetLines(job, theme, "  "),
			`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
			...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt, expanded ? 12 : 6).map((line) => `  ${line}`),
		];
	}
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) return widgetChainDetails(job, theme, expanded, width, frame);
	const lines: string[] = [
		...workflowPreflightLines(job, expanded),
		...workflowChecklistWidgetLines(projection.checklist, theme, "  ", expanded, frame),
	];
	const group = activeParallelWidgetGroup(job);
	if (group) {
		lines.push(...parallelWidgetGroupDetails(job, theme, group, expanded, width, frame, Boolean(job.activeParallelGroup)));
	} else {
		const { stageProgress, plannedKeys } = projection;
		const total = job.mode === "chain"
			? job.chainStepCount ?? job.stepsTotal ?? steps.length
			: stageProgress?.total ?? job.stepsTotal ?? steps.length;
		const stageTotal = stageProgress?.total ?? total;
		const extraStepCount = plannedKeys
			? steps.filter((step) => step.workflowKey === undefined || !plannedKeys.has(step.workflowKey)).length
			: total;
		let extraStepIndex = 0;
		for (const [index, step] of steps.entries()) {
			const isPlannedStage = plannedKeys !== undefined && step.workflowKey !== undefined && plannedKeys.has(step.workflowKey);
			const itemTitle = isPlannedStage ? "Stage" : "Step";
			const displayIndex = isPlannedStage ? (step.index ?? index) + 1 : plannedKeys ? ++extraStepIndex : index + 1;
			const displayTotal = isPlannedStage ? stageTotal : extraStepCount;
			lines.push(...foregroundStyleWidgetStepLines(job, theme, step, itemTitle, displayIndex, displayTotal, expanded, width, frame));
		}
	}
	lines.push(...hostStepWidgetLines(job, theme, "  "));
	const attached = new Set(steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
	for (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt, expanded ? 12 : 6)) {
		lines.push(`  ${nestedLine}`);
	}
	return lines;
}

function buildSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number, expanded: boolean, frame?: number, projection = buildWorkflowWidgetProjection(job)): string[] {
	const stats = widgetStats(job, theme, projection, !expanded);
	const count = job.mode === "workflow"
		? projection.checklist?.total ?? projection.stageProgress?.total ?? job.stepsTotal ?? job.agents?.length ?? job.steps?.length
		: job.mode === "chain" ? job.chainStepCount : projection.stageProgress?.total ?? job.stepsTotal ?? job.agents?.length ?? job.steps?.length;
	const mode = widgetJobName(job);
	const title = isSingleChildAsyncJob(job)
		? "async subagent"
		: `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
	const checklistPrimary = !expanded && job.mode === "workflow" && projection.checklist !== undefined;
	const collapseDetails = !checklistPrimary && job.steps?.length === 1 && shouldCollapseSingleChildDetails(job, job.steps[0]!);
	const summary = `${widgetStatusGlyph(job, theme, frame)} ${themeBold(theme, mode)}${contextModeBadge(theme, job.context)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`;
	return [
		`${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`,
		...(collapseDetails ? [] : [summary]),
		...foregroundStyleWidgetDetails(job, theme, expanded, width, frame, projection),
	].map((line) => truncLine(line, width));
}

function compactSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number, frame?: number, projection = buildWorkflowWidgetProjection(job)): string[] {
	const fullLines = buildSingleWidgetLines(job, theme, width, false, frame, projection);
	if (fullLines.length <= 10 || !job.steps?.length || (job.mode !== "parallel" && !job.activeParallelGroup)) return fullLines;

	const group = activeParallelWidgetGroup(job);
	if (!group) return fullLines;
	const rows = parallelWidgetStepRows(group.steps, group.total, Boolean(job.activeParallelGroup));
	const lines = fullLines.slice(0, 2);
	lines.push(parallelWidgetGroupHeader(group, theme, frame));
	for (const [rowIndex, row] of rows.entries()) {
		const step = row.step;
		const status = widgetStepStatus(step.status, theme);
		const activity = widgetStepActivityLine(step, width, false, job.updatedAt);
		const stepStats = widgetStepStats(theme, step);
		const activitySuffix = activity ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : "";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		const task = compactTaskText(step.description, step.label);
		const taskSuffix = task ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", `task: ${task}`)}` : "";
		const marker = rowIndex === rows.length - 1 && rowIndex >= group.total - 1 ? "└─" : "├─";
		lines.push(`    ${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, row.index), frame)} ${themeBold(theme, row.rowLabel)}${contextModeBadge(theme, step.context)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${taskSuffix}${activitySuffix}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`);
		const lane = projectAsyncLane(job, step);
		if (lane) lines.push(...formatLaneProjectionLines(lane, theme, "      "));
		for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt, 6)) lines.push(`      ${nestedLine}`);
	}
	lines.push(...hostStepWidgetLines(job, theme, "  "));
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

function buildSingleLineWidgetLines(jobs: AsyncJobState[], theme: Theme, width: number, frame?: number): string[] {
	const counts = widgetHeaderCounts(jobs);
	const hasActive = counts.running.length > 0 || counts.queued.length > 0;
	const glyph = counts.running.length > 0 ? runningGlyph(animatedSeed(widgetJobsRunningSeed(counts.running), frame)) : hasActive ? "●" : "○";
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

function progressiveHeaderLine(jobs: AsyncJobState[], theme: Theme, width: number, frame?: number): string {
	const counts = widgetHeaderCounts(jobs);
	const hasActive = counts.running.length > 0 || counts.queued.length > 0;
	const glyph = counts.running.length > 0 ? runningGlyph(animatedSeed(widgetJobsRunningSeed(counts.running), frame)) : hasActive ? "●" : "○";
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

function progressiveJobLine(job: AsyncJobState, theme: Theme, width: number, frame?: number, projection = buildWorkflowWidgetProjection(job)): string {
	const checklistPrimary = job.mode === "workflow" && projection.checklist !== undefined;
	const stats = widgetStats(job, theme, projection, true);
	const activity = checklistPrimary ? "" : widgetActivity(job);
	const status = job.status === "complete" ? "done" : job.status;
	const lane = checklistPrimary ? undefined : projectAsyncLane(job, laneStepForJob(job, projection.steps));
	const laneSummary = lane
		? [lane.label ?? lane.role, lane.phase ? `phase:${lane.phase}` : undefined, lane.output ? `out:${lane.output}` : undefined, lane.workspace ? `workspace:${lane.workspace}` : `ref:${lane.ref}`].filter(Boolean).join(" · ")
		: "";
	const laneSignals = lane
		? [lane.next ? `next:${lane.next}` : undefined, ...lane.chips.map((chip) => formatLaneChip(chip, theme))].filter(Boolean).join(" · ")
		: "";
	const parts = [
		`${themeBold(theme, widgetJobName(job))}${contextModeBadge(theme, job.context)}`,
		theme.fg("dim", status),
		laneSignals ? laneSignals : "",
		laneSummary ? theme.fg("dim", laneSummary) : "",
		stats,
		activity && activity.toLowerCase() !== status ? theme.fg("dim", activity) : "",
	].filter(Boolean);
	return truncLine(`  ${widgetStatusGlyph(job, theme, frame)} ${parts.join(` ${theme.fg("dim", "·")} `)}`, width);
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

function buildProgressiveWidgetLines(jobs: AsyncJobState[], theme: Theme, width: number, lockedRows: number, previousKeys: string[], frame?: number, projectionFor: WorkflowWidgetProjectionLookup = workflowWidgetProjectionLookup()): { lines: string[]; visibleJobKeys: string[] } {
	const rowCount = Math.max(1, lockedRows);
	if (rowCount === 1) return { lines: buildSingleLineWidgetLines(jobs, theme, width, frame), visibleJobKeys: [] };

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
		progressiveHeaderLine(jobs, theme, width, frame),
		...visibleJobs.map((job) => progressiveJobLine(job, theme, width, frame, projectionFor(job))),
	];
	if (hiddenJobs.length > 0 && lines.length < rowCount) lines.push(progressiveHiddenLine(hiddenJobs, theme, width));
	while (lines.length < rowCount) lines.push(" ");
	return { lines: lines.slice(0, rowCount), visibleJobKeys };
}

function collapsedWidgetLineBudget(rows: number): number {
	return Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
}

function paddedWidgetLine(line: string, width: number): string {
	if (width <= 2) return " ".repeat(Math.max(0, width));
	const text = ` ${truncLine(line, width - 2)} `;
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
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

function fitAdaptiveWidgetLines(jobs: AsyncJobState[], buildLines: () => string[], theme: Theme, width: number, expanded: boolean, frame?: number, projectionFor?: WorkflowWidgetProjectionLookup): string[] {
	if (expanded) {
		resetWidgetLayoutSession();
		return fitWidgetLineBudget(buildLines(), theme, width, true);
	}

	const hasMatchingSession = widgetSessionMatches(expanded);
	const rows = currentTerminalRows();
	const columns = currentTerminalColumns();
	const availableRows = estimateAvailableWidgetRows();

	if (hasMatchingSession && widgetLayoutSession?.tier === "single-line") {
		return buildSingleLineWidgetLines(jobs, theme, width, frame);
	}

	if (hasMatchingSession && widgetLayoutSession?.tier === "progressive" && widgetLayoutSession.lockedRows !== undefined) {
		const rendered = buildProgressiveWidgetLines(jobs, theme, width, widgetLayoutSession.lockedRows, widgetLayoutSession.visibleJobKeys, frame, projectionFor);
		widgetLayoutSession.visibleJobKeys = rendered.visibleJobKeys;
		return rendered.lines;
	}

	const lines = buildLines();
	if (lines.length <= availableRows) {
		widgetLayoutSession = { expanded, rows, columns, tier: "full", visibleJobKeys: [] };
		return fitWidgetLineBudget(lines, theme, width, false);
	}
	if (availableRows > 2 && jobs.length === 1 && projectionFor?.(jobs[0]!).stageProgress) {
		widgetLayoutSession = { expanded, rows, columns, tier: "full", visibleJobKeys: [] };
		return fitWidgetLineBudget(lines, theme, width, false);
	}

	if (availableRows <= 2) {
		widgetLayoutSession = { expanded, rows, columns, tier: "single-line", visibleJobKeys: [] };
		return buildSingleLineWidgetLines(jobs, theme, width, frame);
	}

	const lockedRows = Math.min(availableRows, collapsedWidgetLineBudget(rows));
	const rendered = buildProgressiveWidgetLines(jobs, theme, width, lockedRows, [], frame, projectionFor);
	widgetLayoutSession = { expanded, rows, columns, tier: "progressive", lockedRows, visibleJobKeys: rendered.visibleJobKeys };
	return rendered.lines;
}

function buildWidgetComponent(jobs: AsyncJobState[], isExpanded: () => boolean): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => {
		const container = new Container();
		let cachedRenderWidth: number | undefined;
		let cachedFrame: number | undefined;
		let cachedExpanded: boolean | undefined;
		let cachedLines: string[] | undefined;
		container.render = (renderWidth: number): string[] => {
			const frame = Math.floor(Date.now() / WIDGET_ANIMATION_INTERVAL_MS);
			const expanded = isExpanded();
			if (cachedLines && cachedRenderWidth === renderWidth && cachedFrame === frame && cachedExpanded === expanded) return cachedLines;
			const width = Math.max(0, renderWidth - 2);
			const projectionFor = workflowWidgetProjectionLookup();
			const buildLines = (): string[] => expanded
				? buildWidgetLinesWithProjection(jobs, theme, width, true, frame, projectionFor)
				: jobs.length === 1
					? compactSingleWidgetLines(jobs[0]!, theme, width, frame, projectionFor(jobs[0]!))
					: buildWidgetLinesWithProjection(jobs, theme, width, false, frame, projectionFor);
			cachedRenderWidth = renderWidth;
			cachedFrame = frame;
			cachedExpanded = expanded;
			cachedLines = fitAdaptiveWidgetLines(jobs, buildLines, theme, width, expanded, frame, projectionFor).map((line) => paddedWidgetLine(line, renderWidth));
			return cachedLines;
		};
		return container;
	};
}

function buildWidgetLinesWithProjection(jobs: AsyncJobState[], theme: Theme, width = getTermWidth(), expanded = false, frame?: number, projectionFor: WorkflowWidgetProjectionLookup = workflowWidgetProjectionLookup()): string[] {
	if (jobs.length === 0) return [];
	if (jobs.length === 1) return buildSingleWidgetLines(jobs[0]!, theme, width, expanded, frame, projectionFor(jobs[0]!));
	const running = jobs.filter((job) => job.status === "running");
	const queued = jobs.filter((job) => job.status === "queued");
	const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");

	const lines: string[] = [];
	const hasActive = running.length > 0 || queued.length > 0;
	const headerGlyph = running.length > 0 ? runningGlyph(animatedSeed(widgetJobsRunningSeed(running), frame)) : hasActive ? "●" : "○";
	lines.push(truncLine(`${theme.fg(hasActive ? "accent" : "dim", headerGlyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background")}`, width));

	const items: string[][] = [];
	let hiddenRunning = 0;
	let hiddenFinished = 0;
	let queuedSummaryShown = false;
	let slots = MAX_WIDGET_JOBS;
	const appendJob = (job: AsyncJobState): void => {
		const projection = projectionFor(job);
		const checklistPrimary = !expanded && job.mode === "workflow" && projection.checklist !== undefined;
		const stats = widgetStats(job, theme, projection, !expanded);
		const details = checklistPrimary
			? [
				...workflowChecklistWidgetLines(projection.checklist, theme, "  ", false, frame, false),
				...(job.status === "running" || projection.checklist!.running > 0 ? [`  ${theme.fg("accent", liveDetailHintText())}`] : []),
			]
			: [
				`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
				...widgetLaneDetailLines(job, theme, projection),
				...workflowChecklistWidgetLines(projection.checklist, theme, "  ", expanded, frame),
				...widgetParallelAgentDetails(job, theme, expanded, width, frame),
			];
		items.push([
			`${widgetStatusGlyph(job, theme, frame)} ${themeBold(theme, widgetJobName(job))}${contextModeBadge(theme, job.context)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
			...details,
		]);
	};

	for (const job of running) {
		if (slots <= 0) { hiddenRunning++; continue; }
		appendJob(job);
		slots--;
	}

	if (queued.length > 0 && slots > 0) {
		items.push([`${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`]);
		queuedSummaryShown = true;
		slots--;
	}

	for (const job of finished) {
		if (slots <= 0) { hiddenFinished++; continue; }
		appendJob(job);
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

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth(), expanded = false, frame?: number): string[] {
	return buildWidgetLinesWithProjection(jobs, theme, width, expanded, frame);
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
	if ((ctx as { mode?: string }).mode === "rpc") {
		ctx.ui.setWidget(WIDGET_KEY, encodeAsyncStatusSnapshotWidget(jobs));
		return;
	}
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(jobs, () => ctx.ui.getToolsExpanded?.() ?? false));
}

function renderSingleCompact(
	d: Details,
	r: Details["results"][number],
	theme: Theme,
	layout: MainWindowRenderLayout,
	frame?: number,
	foregroundDetachShortcut?: string,
): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = isResultRunning(r);
	const contextBadge = contextModeBadge(theme, r.context ?? d.context);
	const stats = statJoin(theme, [
		r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
		formatProgressStats(theme, progress),
	]);
	const c = new Container();
	const width = getTermWidth() - 4;
	const detailIndent = mainWindowIndent(layout, 1);
	const continuationIndent = mainWindowIndent(layout, 2) + (layout.horizontalSpacing > 0 ? " " : "");
	const modelDisplay = modelThinkingBadge(theme, r.model ?? r.progress?.model, r.thinking ?? r.progress?.thinking);
	c.addChild(new Text(truncLine(`${resultGlyph(r, output, theme, isRunning, undefined, frame)} ${theme.fg("toolTitle", theme.bold(foregroundSingleDisplayName(r)))}${modelDisplay}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	if (isRunning && r.progress) {
		const task = compactTaskText(r.task);
		if (task) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}task: ${task}`), width), 0, 0));
		const progressSnapshotNow = snapshotNowForProgress(r.progress);
		const activity = compactCurrentActivity(r.progress);
		c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}⎿  ${activity}`), width), 0, 0));
		const liveStatus = buildLiveStatusLine(r.progress, progressSnapshotNow);
		if (liveStatus && liveStatus !== activity) c.addChild(new Text(truncLine(theme.fg("dim", `${continuationIndent}${liveStatus}`), width), 0, 0));
		for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, progressSnapshotNow)) {
			c.addChild(new Text(truncLine(`${detailIndent}${nestedLine}`, width), 0, 0));
		}
		c.addChild(new Text(truncLine(theme.fg("accent", `${detailIndent}${foregroundSingleHintText(foregroundDetachShortcut)}`), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
		return c;
	}

	for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, r.progress?.lastActivityAt)) {
		c.addChild(new Text(truncLine(`${detailIndent}${nestedLine}`, width), 0, 0));
	}
	c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
	const preview = firstOutputLine(output);
	if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
		c.addChild(new Text(truncLine(theme.fg("dim", `${continuationIndent}${preview}`), width), 0, 0));
	}
	if (r.sessionFile) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}session: ${shortenPath(r.sessionFile)}`), width), 0, 0));
	if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	if (r.truncation?.artifactPath) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}full output: ${shortenPath(r.truncation.artifactPath)}`), width), 0, 0));
	return c;
}

function workflowRowGlyph(row: WorkflowChatProgressRow, theme: Theme, frame?: number): string {
	if (row.state === "planned") return theme.fg("muted", "◦");
	if (row.state === "running") return theme.fg("accent", runningGlyph(frame));
	if (row.state === "complete") return theme.fg("success", "✓");
	if (row.state === "detached" || row.state === "stopped") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function workflowRowStateLabel(row: WorkflowChatProgressRow, theme: Theme): string {
	const label = (row.state === "complete" ? "complete" : row.state).padEnd(8);
	if (row.state === "planned") return theme.fg("dim", label);
	if (row.state === "running") return theme.fg("accent", label);
	if (row.state === "complete") return theme.fg("success", label);
	if (row.state === "detached" || row.state === "stopped") return theme.fg("warning", label);
	return theme.fg("error", label);
}

function workflowOverallState(rows: WorkflowChatProgressRow[], hasTerminalValue: boolean, isError?: boolean): "running" | "complete" | "failed" | "paused" {
	if (rows.some((row) => row.state === "failed")) return "failed";
	if (rows.some((row) => row.state === "detached")) return "paused";
	if (isError) return "failed";
	if ((rows.length > 0 && rows.every((row) => row.state === "complete")) || hasTerminalValue) return "complete";
	return "running";
}

function foregroundWorkflowChecklist(details: Details): WorkflowChecklistProjection | undefined {
	if (details.mode !== "workflow") return undefined;
	const stageNodes = details.workflowGraph ? workflowGraphStageNodes(details.workflowGraph) : [];
	const steps: WorkflowChecklistStep[] = details.results.flatMap((result, resultIndex) => {
		const stableIndex = foregroundResultIndex(details, resultIndex);
		const workflowKey = (result as { workflowKey?: unknown }).workflowKey;
		if (details.workflowGraph && typeof workflowKey !== "string") return [];
		const node = typeof workflowKey === "string"
			? stageNodes.find((candidate) => candidate.id === workflowKey)
			: undefined;
		const progress = foregroundProgressForResult(details, resultIndex);
		const status = isResultRunning(result) || progress?.status === "running"
			? "running"
			: result.detached
				? "paused"
				: result.stopped
					? "stopped"
					: result.exitCode === 0
						? "complete"
						: "failed";
		return [{
			key: node?.id ?? (typeof workflowKey === "string" ? workflowKey : `result-${resultIndex + 1}`),
			label: node?.label ?? workflowLabelForResult(details, resultIndex) ?? result.task ?? result.agent,
			phase: node?.phase,
			agent: result.agent,
			status,
			context: result.context,
			activityState: progress?.activityState,
			startedAt: progress?.lastActivityAt !== undefined && progress.durationMs !== undefined ? progress.lastActivityAt - progress.durationMs : undefined,
			durationMs: progress?.durationMs,
			currentTool: progress?.currentTool,
			currentToolStartedAt: progress?.currentToolStartedAt,
			currentPath: progress?.currentPath,
			turnCount: progress?.turnCount,
			toolCount: progress?.toolCount ?? result.progressSummary?.toolCount,
			error: result.error,
			toolBudgetBlocked: result.toolBudgetBlocked,
			turnBudgetExceeded: result.turnBudgetExceeded,
			timedOut: result.timedOut,
			stopped: result.stopped,
			acceptance: result.acceptance ? { status: result.acceptance.status, reviewResult: result.acceptance.reviewResult ? { status: result.acceptance.reviewResult.status } : undefined } : undefined,
			review: result.review ? { status: result.review.status } : undefined,
			watchdog: result.watchdog,
		}];
	});
	const checklist = projectWorkflowChecklist({
		graph: details.workflowGraph,
		steps,
		hostSteps: details.workflow?.receipt?.hostSteps,
		preflight: details.preflight,
		trace: details.workflow?.trace,
		now: Date.now(),
	});
	return checklist.total > 0 ? checklist : undefined;
}

function renderWorkflowChatProgress(d: Details, result: AgentToolResult<Details>, theme: Theme, layout: MainWindowRenderLayout, frame?: number, expanded = false): Component {
	const workflow = d.workflow;
	const rows = workflow ? buildWorkflowChatProgressRows(workflow.trace, d.preflight) : d.preflight ? buildWorkflowChatProgressRows([], d.preflight) : [];
	const state = workflowOverallState(rows, workflow?.value !== undefined, result.isError);
	const glyph = state === "running" ? theme.fg("accent", runningGlyph(frame)) : state === "complete" ? theme.fg("success", "✓") : state === "paused" ? theme.fg("warning", "■") : theme.fg("error", "✗");
	const width = getTermWidth() - 4;
	const runId = d.runId ? d.runId.slice(0, 12) : "workflow";
	const repoLabel = d.chatProgress?.repoLabel ?? (d.chatProgress?.repoRelation === "same" ? "same repo" : "other repo");
	const phase = rows.find((row) => row.state === "running" && row.phase)?.phase ?? [...rows].reverse().find((row) => row.phase)?.phase;
	const c = new Container();
	const rowIndent = mainWindowIndent(layout, 1);
	c.addChild(new Text(truncLine(`${glyph} ${theme.fg("toolTitle", theme.bold("workflow"))} ${runId} ${theme.fg("dim", "·")} ${d.chatProgress?.repoRelation === "same" ? "same repo" : "other repo"} ${theme.fg("dim", "·")} ${state}`, width), 0, 0));
	c.addChild(new Text(truncLine(theme.fg("dim", `${rowIndent}Repo   ${repoLabel}`), width), 0, 0));
	if (d.preflight) c.addChild(new Text(truncLine(theme.fg("dim", formatWorkflowPreflightPlanSummary(d.preflight, { indent: rowIndent })), width), 0, 0));
	if (phase) c.addChild(new Text(truncLine(theme.fg("dim", `${rowIndent}Phase  ${phase}`), width), 0, 0));
	const checklist = projectWorkflowChecklist({ hostSteps: workflow?.receipt?.hostSteps, preflight: d.preflight, trace: workflow?.trace, now: Date.now() });
	for (const line of workflowChecklistWidgetLines(checklist, theme, rowIndent, false, frame, true, !expanded, expanded)) {
		c.addChild(new Text(truncLine(line, width), 0, 0));
	}
	if (rows.length === 0) {
		c.addChild(new Text(truncLine(theme.fg("dim", `${rowIndent}◦ waiting for workflow child launches`), width), 0, 0));
		return c;
	}
	const visible = visibleWorkflowRows(rows);
	if (visible.hiddenRows > 0) c.addChild(new Text(truncLine(theme.fg("dim", `${rowIndent}… ${visible.hiddenRows} older workflow rows hidden`), width), 0, 0));
	for (const row of visible.rows) {
		const status = workflowRowStateLabel(row, theme);
		const label = row.label && row.label !== row.key ? ` ${oneLine(row.label)}` : "";
		const duration = row.durationMs !== undefined ? ` ${theme.fg("dim", `· ${formatDuration(row.durationMs)}`)}` : "";
		const run = row.runId ? ` ${theme.fg("dim", `[${row.runId.slice(0, 8)}]`)}` : "";
		const error = row.error ? ` ${theme.fg(row.state === "detached" ? "warning" : "error", `· ${compactWorkflowError(row.error)}`)}` : "";
		const hints = expanded && row.preflight ? [
			row.preflight.mode ? `mode:${row.preflight.mode}` : undefined,
			row.preflight.decision ? `decision:${row.preflight.decision}` : undefined,
			row.preflight.claims?.length ? `claims:${row.preflight.claims.join(",")}` : undefined,
			row.preflight.expectedOutput ? `expected:${row.preflight.expectedOutput}` : undefined,
			row.preflight.independence ? `independence:${row.preflight.independence}` : undefined,
		].filter((value): value is string => Boolean(value)).join(" · ") : "";
		c.addChild(new Text(truncLine(`${rowIndent}${workflowRowGlyph(row, theme, frame)} ${status} ${theme.bold(row.key)}${label}${run}${duration}${error}${hints ? ` ${theme.fg("dim", `· ${hints}`)}` : ""}`, width), 0, 0));
	}
	if (workflow?.preflightWarnings?.length) {
		const warningLines = expanded
			? formatWorkflowPreflightWarnings(workflow.preflightWarnings, { indent: rowIndent }).split("\n")
			: [formatWorkflowPreflightWarningSummary(workflow.preflightWarnings, { indent: rowIndent, hint: "expand for debug" })];
		for (const warningLine of warningLines) c.addChild(new Text(truncLine(theme.fg("warning", warningLine), width), 0, 0));
	}
	if (workflow?.emits.length) c.addChild(new Text(truncLine(theme.fg("dim", `${rowIndent}Emits  ${workflow.emits.length}`), width), 0, 0));
	return c;
}

function renderMultiCompact(d: Details, theme: Theme, layout: MainWindowRenderLayout, frame?: number): Component {
	const hasRunning = detailsHaveRunningResult(d);
	const detached = d.results.some((r) => r.detached)
		|| workflowGraphHasStatus(d, ["detached"]);
	const stopped = d.results.some((r) => r.stopped)
		|| workflowGraphHasStatus(d, ["stopped"]);
	const failed = d.results.some((r) => !hasTerminalResultFlag(r) && r.exitCode !== 0 && !isResultRunning(r))
		|| workflowGraphHasStatus(d, ["failed"]);
	const paused = d.results.some((r) => r.interrupted)
		|| workflowGraphHasStatus(d, ["paused"]);
	const partial = workflowGraphHasStatus(d, ["partial"]);
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
	const workflowChecklist = foregroundWorkflowChecklist(d);
	const checklistPrimary = d.mode === "workflow" && workflowChecklist !== undefined;
	const stats = statJoin(theme, [checklistPrimary ? formatWorkflowChecklistSummary(workflowChecklist) : multiLabel.headerLabel, formatProgressStats(theme, totalSummary), formatTotalCostStat(d.totalCost)]);
	const aggregatePresentation = semanticResultPresentation({
		running: hasRunning,
		detached,
		stopped,
		interrupted: paused,
		failed,
		partial,
		seed: runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex),
		frame,
	});
	const glyph = theme.fg(aggregatePresentation.tone, aggregatePresentation.glyph);
	const contextBadge = contextModeBadge(theme, d.context);
	const c = new Container();
	const width = getTermWidth() - 4;
	const rowIndent = mainWindowIndent(layout, 1);
	const detailIndent = mainWindowIndent(layout, 2);
	c.addChild(new Text(truncLine(`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));
	if (checklistPrimary) {
		for (const line of workflowChecklistWidgetLines(workflowChecklist, theme, rowIndent, false, frame, false)) {
			c.addChild(new Text(truncLine(line, width), 0, 0));
		}
		if (hasRunning || workflowChecklist.running > 0) c.addChild(new Text(truncLine(theme.fg("accent", `${rowIndent}${liveDetailHintText()}`), width), 0, 0));
		return c;
	}
	for (const line of workflowChecklistWidgetLines(workflowChecklist, theme, rowIndent, false, frame)) {
		c.addChild(new Text(truncLine(line, width), 0, 0));
	}

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : (useResultsDirectly ? d.results.length : d.chainAgents!.length);
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? buildForegroundResultEntries(d, multiLabel, displayStart, displayEnd, useResultsDirectly);
	for (const entry of renderEntries) {
		if (entry.kind === "group") {
			const glyph = widgetStepGlyph(entry.status as AsyncJobStep["status"], theme);
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			const groupLabel = entry.groupLabel ? ` (${compactTaskText(undefined, entry.groupLabel) ?? entry.groupLabel})` : "";
			c.addChild(new Text(truncLine(`${rowIndent}${glyph} ${entry.stepLabel}${groupLabel} ${theme.fg("dim", "·")} ${statusLabel}`, width), 0, 0));
			if (entry.error) c.addChild(new Text(truncLine(theme.fg("error", `${detailIndent}⎿  Error: ${entry.error}`), width), 0, 0));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;
		if (!r) {
			const pendingLabel = entry.rowLabel ?? (entry.isParallel ? "" : `${itemTitle} ${rowNumber}`);
			const labelPrefix = pendingLabel ? `${pendingLabel}: ` : "";
			c.addChild(new Text(truncLine(theme.fg("dim", `${rowIndent}◦ ${labelPrefix}${agentName} · pending`), width), 0, 0));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray = foregroundProgressForResult(d, i);
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg && "status" in rProg && isResultRunning(r, rProg.status);
		const rPending = rProg && "status" in rProg && rProg.status === "pending";
		const stepStats = formatProgressStats(theme, rProg);
		const glyph = rPending ? theme.fg("dim", "◦") : resultGlyph(r, output, theme, rRunning, progressRunningSeed(rProg), frame);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = entry.rowLabel;
		const rowProgressModel = rProg && "status" in rProg ? rProg : undefined;
		const rowModelDisplay = modelThinkingBadge(theme, r.model ?? rowProgressModel?.model, r.thinking ?? rowProgressModel?.thinking);
		const labelPrefix = stepLabel ? `${stepLabel}: ` : "";
		const line = `${glyph} ${labelPrefix}${themeBold(theme, agentName)}${contextModeBadge(theme, r.context)}${rowModelDisplay}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
		c.addChild(new Text(truncLine(`${rowIndent}${line}`, width), 0, 0));
		if (rRunning || rPending) {
			const task = compactTaskText(r.task, workflowLabelForResult(d, i));
			if (task) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}task: ${task}`), width), 0, 0));
		}
		if (rRunning && rProg && "status" in rProg) {
			const liveProgress = rProg as AgentProgress;
			const activity = compactCurrentActivity(liveProgress);
			c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}⎿  ${activity}`), width), 0, 0));
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, snapshotNowForProgress(liveProgress))) {
				c.addChild(new Text(truncLine(`${detailIndent}${nestedLine}`, width), 0, 0));
			}
			c.addChild(new Text(truncLine(theme.fg("accent", `${detailIndent}${liveDetailHintText()}`), width), 0, 0));
		} else if (!rPending && (r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))) {
			c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `${detailIndent}⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
		}
		if (!rRunning && !rPending) {
			for (const nestedLine of formatNestedWidgetLines(r.children, theme, width, false, r.progress?.lastActivityAt)) {
				c.addChild(new Text(truncLine(`${detailIndent}${nestedLine}`, width), 0, 0));
			}
		}
		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}output: ${outputTarget}`), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `${detailIndent}output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	}
	if (d.artifacts) c.addChild(new Text(truncLine(theme.fg("dim", `${rowIndent}artifacts: ${shortenPath(d.artifacts.dir)}`), width), 0, 0));
	return c;
}

export function renderSubagentSummary(
	result: AgentToolResult<Details>,
	options: { isPartial?: boolean },
	theme: Theme,
): Component {
	const details = result.details;
	const results = details?.results ?? [];
	const hasSingleTerminalResult = results.length === 1 && hasTerminalResult(results[0]!);
	const hasOnlyTerminalResults = results.length > 0 && results.every(hasTerminalResult);
	const running = !hasSingleTerminalResult && !hasOnlyTerminalResults && (
		options.isPartial === true
		|| Boolean(details?.asyncId && details.mode !== "management")
		|| Boolean(details && detailsHaveRunningResult(details))
	);
	const stopped = results.some((entry) => entry.stopped)
		|| Boolean(details && workflowGraphHasStatus(details, ["stopped"]));
	const paused = results.some((entry) => entry.interrupted || entry.detached)
		|| Boolean(details && workflowGraphHasStatus(details, ["paused", "detached"]));
	const failed = result.isError === true
		|| results.some((entry) => !hasTerminalResultFlag(entry) && entry.exitCode !== 0 && !isResultRunning(entry))
		|| Boolean(details && workflowGraphHasStatus(details, ["failed"]));
	const partial = Boolean(details && workflowGraphHasStatus(details, ["partial"]));
	const state = running ? "running" : failed ? "failed" : stopped ? "stopped" : paused ? "paused" : partial ? "partial" : "completed";
	const glyph = state === "running"
		? theme.fg("accent", STATIC_RUNNING_GLYPH)
		: state === "completed"
			? theme.fg("success", "✓")
			: state === "failed"
				? theme.fg("error", "✗")
				: theme.fg("warning", "■");
	const label = details?.mode === "single" && results.length === 1
		? foregroundSingleDisplayName(results[0])
		: details?.mode || "subagent";
	return new Text(
		truncLine(`${glyph} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("dim", "·")} ${theme.fg(state === "failed" ? "error" : state === "completed" ? "success" : state === "running" ? "accent" : "warning", state)}`, getTermWidth() - 4),
		0,
		0,
	);
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: Theme,
	frame?: number,
	rendererConfig?: MainWindowRendererConfig,
	foregroundDetachShortcut?: string,
): Component {
	const layout = resolveMainWindowRenderLayout(rendererConfig);
	const compact = (component: Component): Component => capCompactMainWindowResult(component, layout, theme, !options.expanded);
	const d = result.details;
	if (d?.mode === "workflow" && d.chatProgress?.mode === "live-card" && d.workflow?.value === undefined && (!result.isError || (d.workflow?.trace.length ?? 0) > 0)) {
		return compact(renderWorkflowChatProgress(d, result, theme, options.expanded ? resolveMainWindowRenderLayout() : layout, frame, options.expanded));
	}
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = contextModePrefix(theme, d?.context);
		const width = getTermWidth() - 4;
		if (!text.includes("\n")) return compact(new Text(truncLine(`${contextPrefix}${text}`, width), 0, 0));
		if (d && !options.expanded && !result.isError) {
			const lines = text.split(/\r?\n/);
			const firstNonEmptyLine = lines.find((line) => line.trim())?.trim() || "(no output)";
			const compactLine = d.mode === "workflow" && d.preflight
				? formatWorkflowPreflightPlanSummary(d.preflight)
				: firstNonEmptyLine;
			const c = new Container();
			const detailIndent = mainWindowIndent(layout, 1);
			c.addChild(new Text(truncLine(`${contextPrefix}${compactLine} · ${lines.length} lines`, width), 0, 0));
			c.addChild(new Text(truncLine(theme.fg("accent", `${detailIndent}Press ${liveDetailKeyText()} for full output`), width), 0, 0));
			return compact(c);
		}
		const c = new Container();
		const wrapped = wrapPlainText(`${contextPrefix}${text}`, width);
		for (const line of wrapped) c.addChild(new Text(line, 0, 0));
		return c;
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		const detachableShortcut = d.asyncId || d.background ? undefined : foregroundDetachShortcut;
		if (!r) return compact(renderMultiCompact(d, theme, layout, frame));
		if (!expanded) return compact(renderSingleCompact(d, r, theme, layout, frame, detachableShortcut));
		const isRunning = isResultRunning(r);
		const contextBadge = contextModeBadge(theme, r.context ?? d.context);
		const output = r.truncation?.text || getSingleResultOutput(r);
		const presentation = styledResultPresentation(resultPresentation(r, output, isRunning, undefined, frame), theme);

		const progressInfo = isRunning && r.progress
			? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
			: r.progressSummary
				? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
				: "";

		const w = getTermWidth() - 4;
		const fit = (text: string) => expanded ? text : truncLine(text, w);
		const toolCallLines = getToolCallLines(r, expanded);
		const c = new Container();
		c.addChild(new Text(fit(`${presentation.glyph} ${theme.fg("toolTitle", theme.bold(foregroundSingleDisplayName(r)))}${contextBadge}${progressInfo} ${theme.fg("dim", "·")} ${presentation.label}`), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(
			new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0),
		);
		c.addChild(new Spacer(1));
		if (!isRunning && (r.exitCode !== 0 || r.interrupted || r.detached || r.stopped)) {
			c.addChild(new Text(fit(theme.fg(r.exitCode !== 0 ? "error" : "dim", `  ⎿  ${resultStatusLine(r, output)}`)), 0, 0));
		}

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
			c.addChild(new Text(fit(theme.fg("accent", foregroundSingleHintText(detachableShortcut))), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 24);
					const argsPreview = renderToolArgsPreview(t.args, maxArgsLen, expanded);
					c.addChild(new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			for (const line of compactRecentOutputLines(r.progress.recentOutput)) {
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

	if (!expanded) return compact(renderMultiCompact(d, theme, layout, frame));

	const hasRunning = detailsHaveRunningResult(d);
	const detached = d.results.some((r) => r.detached)
		|| workflowGraphHasStatus(d, ["detached"]);
	const stopped = d.results.some((r) => r.stopped)
		|| workflowGraphHasStatus(d, ["stopped"]);
	const failed = d.results.some((r) => !hasTerminalResultFlag(r) && r.exitCode !== 0 && !isResultRunning(r))
		|| workflowGraphHasStatus(d, ["failed"]);
	const paused = d.results.some((r) => r.interrupted)
		|| workflowGraphHasStatus(d, ["paused"]);
	const partial = workflowGraphHasStatus(d, ["partial"]);
	const completedWithoutOutput = d.results.some((r) =>
		!hasTerminalResultFlag(r)
		&& r.exitCode === 0
		&& !isResultRunning(r)
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const presentation = styledResultPresentation(semanticResultPresentation({
		running: hasRunning,
		detached,
		stopped,
		interrupted: paused,
		failed,
		partial,
		completedWithoutOutput,
		frame,
	}), theme);

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
	const contextBadge = contextModeBadge(theme, d.context);
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	
	const chainVis = d.chainAgents?.length && !multiLabel.hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const displayName = foregroundResultDisplayName(d, i, result, agent);
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepPresentation = result
						? styledResultPresentation(resultPresentation(result, getSingleResultOutput(result), isCurrent && hasRunning && !hasTerminalResultFlag(result)), theme)
						: undefined;
					const stepStatus = stepPresentation
						? `${stepPresentation.glyph} ${stepPresentation.label}`
						: theme.fg("dim", "◦ pending");
					return `${stepStatus} ${displayName}${contextModeBadge(theme, result?.context)}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const w = getTermWidth() - 4;
	const fit = (text: string) => expanded ? text : truncLine(text, w);
	const c = new Container();
	c.addChild(
		new Text(
			fit(`${presentation.glyph} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr} ${theme.fg("dim", "·")} ${presentation.label}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
	}
	const workflowChecklist = foregroundWorkflowChecklist(d);
	for (const line of workflowChecklistWidgetLines(workflowChecklist, theme, "  ", true, frame)) {
		c.addChild(new Text(fit(line), 0, 0));
	}

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : (useResultsDirectly ? d.results.length : d.chainAgents!.length);
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? buildForegroundResultEntries(d, multiLabel, displayStart, displayEnd, useResultsDirectly);

	c.addChild(new Spacer(1));

	for (const entry of renderEntries) {
		if (entry.kind === "group") {
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			const groupLabel = entry.groupLabel ? ` (${compactTaskText(undefined, entry.groupLabel) ?? entry.groupLabel})` : "";
			c.addChild(new Text(fit(`  ${statusLabel} ${entry.stepLabel}${groupLabel}`), 0, 0));
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
			const pendingLabel = entry.rowLabel ?? (entry.isParallel ? "" : `${itemTitle} ${rowNumber}`);
			const labelPrefix = pendingLabel ? `${pendingLabel}: ` : "";
			c.addChild(new Text(fit(theme.fg("dim", `  ${labelPrefix}${agentName}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = foregroundProgressForResult(d, i);
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = isResultRunning(r, rProg?.status);

		const resultOutput = getSingleResultOutput(r);
		const rowPresentation = styledResultPresentation(resultPresentation(r, resultOutput, rRunning, progressRunningSeed(rProg), frame), theme);
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		const modelDisplay = modelThinkingBadge(theme, r.model ?? rProg?.model, r.thinking ?? rProg?.thinking);
		const stepLabel = entry.rowLabel;
		const contextBadge = contextModeBadge(theme, r.context);
		const labelPrefix = stepLabel ? `${stepLabel}: ` : "";
		const stepHeader = rRunning
			? `${rowPresentation.glyph} ${labelPrefix}${theme.bold(theme.fg("warning", agentName))}${contextBadge}${modelDisplay}${stats} ${theme.fg("dim", "·")} ${rowPresentation.label}`
			: `${rowPresentation.glyph} ${labelPrefix}${theme.bold(agentName)}${contextBadge}${modelDisplay}${stats} ${theme.fg("dim", "·")} ${rowPresentation.label}`;
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
		if (!rRunning && (r.exitCode !== 0 || r.interrupted || r.detached || r.stopped)) {
			c.addChild(new Text(fit(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, resultOutput)}`)), 0, 0));
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
					const argsPreview = renderToolArgsPreview(t.args, maxArgsLen, expanded);
					c.addChild(new Text(fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			for (const line of compactRecentOutputLines(rProg.recentOutput)) {
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
