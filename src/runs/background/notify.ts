/**
 * Completion notification delivery.
 *
 * Async result files call this notifier directly and are deleted only after
 * `sendMessage()` accepts the notification. The event bus remains an
 * observation channel, not a delivery acknowledgement.
 */

import { debuglog } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import {
	type CompletionBatchConfig,
	type CompletionBatcher,
	createCompletionBatcher,
	resolveCompletionBatchConfig,
} from "./completion-batcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT, type ChildWatchdogProgress, type ChildWatchdogWarningSummary, type ParallelHandoffReference, type ScheduleOrigin, type SubagentState } from "../../shared/types.ts";
import { safeTerminalText } from "../../shared/display-text.ts";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { isUnexplainedProcessSignal } from "../shared/process-signal.ts";
import type { ResultDeliveryOwnership } from "./result-delivery-ownership.ts";

export interface SubagentNotifyChildOutput {
	workflowKey?: string;
	runId?: string;
	agent?: string;
	status: string;
	savedOutputPath?: string;
	preview: string;
	previewTruncated?: boolean;
	previewUnavailableReason?: string;
}

export type SubagentNotifyWatchdogBlocker = Pick<ChildWatchdogWarningSummary, "summary" | "addressed" | "stalemate"> & { agent: string };

export interface SubagentNotifyDetails {
	workflowReceiptPath?: string;
	agent: string;
	status: "completed" | "failed" | "paused" | "stopped";
	source?: "async" | "foreground";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	workflowRunId?: string;
	childRuns?: Array<{ runId: string; workflowKey?: string; agent?: string; status?: string }>;
	childOutputs?: SubagentNotifyChildOutput[];
	reconciledFromDetachedChild?: string;
	sessionLabel?: string;
	sessionValue?: string;
	handoffPath?: string;
	/** Present when a durable schedule launched the run. */
	scheduleOrigin?: ScheduleOrigin;
	watchdogBlockers?: SubagentNotifyWatchdogBlocker[];
}

export interface CompletionNotification {
	[key: string]: unknown;
	id?: string | null;
	source?: "async" | "foreground";
	agent?: string | null;
	success?: boolean;
	summary?: string;
	exitCode?: number;
	state?: string;
	mode?: string;
	runId?: string | null;
	reconciledFromDetachedChild?: string;
	processSignal?: string | null;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudgetExceeded?: boolean;
	results?: Array<{
		runId?: string;
		workflowKey?: string;
		agent?: string;
		status?: string;
		state?: string;
		success?: boolean;
		output?: string;
		structuredOutput?: unknown;
		outputState?: "present" | "absent" | "unknown";
		outputReference?: string | { path?: string };
		artifactPaths?: { outputPath?: string };
		detached?: boolean;
		exitCode?: number | null;
		processSignal?: string | null;
		interrupted?: boolean;
		timedOut?: boolean;
		stopped?: boolean;
		turnBudgetExceeded?: boolean;
		watchdog?: ChildWatchdogProgress;
	}>;
	watchdog?: ChildWatchdogProgress;
	timestamp?: number;
	durationMs?: number;
	cwd?: string;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	taskIndex?: number;
	totalTasks?: number;
	sessionId?: string | null;
	completionOwnerId?: string | null;
	triggerTurn?: boolean;
	/** True when an acknowledged grouped intercom relay already delivered this run. */
	intercomDelivered?: boolean;
	parallelHandoff?: ParallelHandoffReference;
	scheduleOrigin?: ScheduleOrigin;
}

interface NotifyTimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RegisterSubagentNotifyOptions {
	batchConfig?: CompletionBatchConfig;
	timers?: NotifyTimerApi;
	now?: () => number;
	ownership?: Pick<ResultDeliveryOwnership, "owns">;
}

export interface CompletionNotifier {
	deliver(result: CompletionNotification): Promise<boolean>;
	hasPendingDelivery(): boolean;
	dispose(): void;
}

const CHILD_OUTPUT_PREVIEW_MAX_BYTES = 4 * 1024;
const CHILD_OUTPUT_PREVIEW_COUNT = 8;
const PREVIEW_TRUNCATION_MARKER = "...[preview truncated]";
type CompletionChild = NonNullable<CompletionNotification["results"]>[number];

function truncateUtf8Head(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return { text: value, truncated: false };
	const markerBytes = Buffer.byteLength(PREVIEW_TRUNCATION_MARKER, "utf8");
	const contentBytes = Math.max(0, maxBytes - markerBytes);
	let end = contentBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return {
		text: `${bytes.subarray(0, end).toString("utf8")}${PREVIEW_TRUNCATION_MARKER}`,
		truncated: true,
	};
}

function boundedSafeText(value: string, maxBytes = 1_024): string {
	return truncateUtf8Head(safeTerminalText(value).replace(/\n/g, "\\n"), maxBytes).text;
}

function outputPathFromReference(value: CompletionChild["outputReference"]): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (value && typeof value === "object" && typeof value.path === "string" && value.path.trim()) return value.path.trim();
	return undefined;
}

function childSavedOutputPath(child: CompletionChild): string | undefined {
	return outputPathFromReference(child.outputReference);
}

function childStatus(child: CompletionChild, workflowState?: string): string {
	const knownStatus = child.status === "complete"
		? "completed"
		: child.status === "completed" || child.status === "failed" || child.status === "paused" || child.status === "stopped" || child.status === "detached"
			? child.status
		: undefined;
	if (knownStatus) return knownStatus;
	return resolveSubagentResultStatus({
		success: child.success,
		state: child.state ?? (child.success === undefined ? workflowState : undefined),
		interrupted: child.interrupted,
		detached: child.detached,
		processSignal: child.processSignal,
		timedOut: child.timedOut,
		stopped: child.stopped,
		turnBudgetExceeded: child.turnBudgetExceeded,
		exitCode: typeof child.exitCode === "number" ? child.exitCode : undefined,
	});
}

function structuredOutputText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const serialized = JSON.stringify(value, null, 2);
		return typeof serialized === "string" ? serialized : undefined;
	} catch {
		return undefined;
	}
}

function isDegenerateOutput(text: string): boolean {
	return !text.trim() || text.trim() === "</think>";
}

function childInlinePreview(child: CompletionChild): { preview?: string; truncated?: boolean; unavailableReason?: string } {
	const output = typeof child.output === "string" ? child.output : "";
	const outputReference = childSavedOutputPath(child);
	const referenceOnly = Boolean(outputReference && output.trim().startsWith("Output saved to:"));
	const raw = child.outputState === "absent" || referenceOnly
		? structuredOutputText(child.structuredOutput)
		: isDegenerateOutput(output) ? structuredOutputText(child.structuredOutput) ?? output : output;
	if (!raw?.trim()) {
		return { unavailableReason: referenceOnly ? "saved output is file-only" : "no safe inline output" };
	}
	const safe = safeTerminalText(raw);
	if (!safe.trim()) return { unavailableReason: "no safe inline output" };
	const bounded = truncateUtf8Head(safe, CHILD_OUTPUT_PREVIEW_MAX_BYTES);
	return { preview: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) };
}

function formatChildOutputBlock(children: SubagentNotifyChildOutput[] | undefined): string | undefined {
	if (!children?.length) return undefined;
	const lines = ["Child outputs:"];
	for (let index = 0; index < children.length; index++) {
		const child = children[index]!;
		const key = child.workflowKey ? boundedSafeText(child.workflowKey) : "unavailable";
		const runId = child.runId ? boundedSafeText(child.runId) : "unavailable";
		const status = boundedSafeText(child.status) || "unavailable";
		lines.push(`- key=${key} run=${runId} status=${status}`);
		lines.push(`  Saved output: ${child.savedOutputPath ? boundedSafeText(child.savedOutputPath) : "unavailable"}`);
		if (index >= CHILD_OUTPUT_PREVIEW_COUNT) {
			lines.push("  Preview: unavailable (notice preview budget exceeded)");
			continue;
		}
		if (!child.preview) {
			lines.push(`  Preview: unavailable (${child.previewUnavailableReason ?? "no safe inline output"})`);
			continue;
		}
		lines.push("  Preview:");
		for (const line of child.preview.split("\n")) lines.push(`    | ${line}`);
	}
	if (children.length > CHILD_OUTPUT_PREVIEW_COUNT) {
		lines.push(`- ${children.length - CHILD_OUTPUT_PREVIEW_COUNT} additional child preview(s) omitted by notice budget; child run metadata is retained below.`);
	}
	return lines.join("\n");
}

function formatResultPreview(details: SubagentNotifyDetails): string {
	const summary = details.resultPreview.trim() ? details.resultPreview : "(no output)";
	const childOutputs = formatChildOutputBlock(details.childOutputs);
	return childOutputs ? `${summary}\n\n${childOutputs}` : summary;
}

function formatSessionLine(details: SubagentNotifyDetails): string | undefined {
	if (!details.sessionValue) return undefined;
	return details.sessionLabel ? `${details.sessionLabel}: ${details.sessionValue}` : details.sessionValue;
}

function formatChildRun(child: { runId: string; workflowKey?: string; agent?: string; status?: string }): string {
	const label = child.workflowKey ?? child.agent;
	const status = child.status ? ` (${child.status})` : "";
	return `${label ? `${label}=` : ""}${child.runId}${status}`;
}

function formatCorrelationLines(details: SubagentNotifyDetails): string[] {
	return [
		details.workflowRunId ? `Workflow run: ${details.workflowRunId}` : undefined,
		details.childRuns?.length ? `Child runs: ${details.childRuns.map(formatChildRun).join(", ")}` : undefined,
		details.reconciledFromDetachedChild ? `Reconciled detached child: ${details.reconciledFromDetachedChild}` : undefined,
	].filter((line): line is string => line !== undefined);
}

const WATCHDOG_BLOCKERS_HEADING = "Watchdog blockers:";

function formatWatchdogBlockerLines(details: SubagentNotifyDetails): string[] {
	if (!details.watchdogBlockers?.length) return [];
	return [WATCHDOG_BLOCKERS_HEADING, ...details.watchdogBlockers.map((blocker) => `- ${blocker.agent}: ${blocker.summary} (${blocker.stalemate ? "stalemate" : blocker.addressed ? "addressed" : "unaddressed"})`)];
}

// A stalemate blocker parses back as unaddressed; acceptance treats both as unresolved.
function parseWatchdogBlockerLines(lines: string[]): SubagentNotifyWatchdogBlocker[] {
	const blockers: SubagentNotifyWatchdogBlocker[] = [];
	for (const line of lines) {
		const match = line.match(/^- (.+?): (.+) \((addressed|unaddressed|stalemate)\)$/);
		if (!match) break;
		blockers.push({ agent: match[1]!, summary: match[2]!, addressed: match[3] === "addressed", stalemate: match[3] === "stalemate" });
	}
	return blockers;
}

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
	const sessionLine = formatSessionLine(details);
	const correlationLines = formatCorrelationLines(details);
	const watchdogLines = formatWatchdogBlockerLines(details);
	const taskKind = details.source === "foreground" ? "Detached foreground task" : "Background task";
	const scheduleLine = details.scheduleOrigin
		? `Scheduled run from **${details.scheduleOrigin.name ?? details.scheduleOrigin.id}** (schedule ${details.scheduleOrigin.id}).`
		: undefined;
	return [
		`${taskKind} ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
		details.workflowReceiptPath ? `Workflow receipt: ${details.workflowReceiptPath}` : undefined,
		"",
		scheduleLine,
		scheduleLine ? "" : undefined,
		formatResultPreview(details),
		...(watchdogLines.length ? ["", ...watchdogLines] : []),
		details.handoffPath ? "" : undefined,
		details.handoffPath ? `Parallel handoff: ${details.handoffPath}` : undefined,
		correlationLines.length && !details.handoffPath ? "" : undefined,
		...correlationLines,
		sessionLine ? "" : undefined,
		sessionLine,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

export function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const match = (lines[0] ?? "").match(/^(Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	// Only the header slot before the blank separator can carry a receipt.
	// Identical lines anywhere in model output remain preview text.
	const receiptHeader = lines[1]?.startsWith("Workflow receipt: ") && lines[2] === "";
	const workflowReceiptPath = receiptHeader ? lines[1]!.slice("Workflow receipt: ".length) : undefined;
	let body = lines.slice(receiptHeader ? 3 : 2);
	// Restore the schedule origin so a re-rendered notice keeps its attribution and
	// does not fold the line into the result preview.
	const scheduleMatch = (body[0] ?? "").match(/^Scheduled run from \*\*(.+?)\*\* \(schedule (.+?)\)\.$/);
	let parsedScheduleOrigin: ScheduleOrigin | undefined;
	if (scheduleMatch) {
		const label = scheduleMatch[1]!;
		const id = scheduleMatch[2]!;
		parsedScheduleOrigin = { id, ...(label === id ? {} : { name: label }) };
		body = body.slice(body[1]?.trim() === "" ? 2 : 1);
	}
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const handoffIndex = body.findIndex((line) => line.startsWith("Parallel handoff: "));
	const workflowRunIndex = body.findIndex((line) => line.startsWith("Workflow run: "));
	const childRunsIndex = body.findIndex((line) => line.startsWith("Child runs: "));
	const reconciledIndex = body.findIndex((line) => line.startsWith("Reconciled detached child: "));
	const watchdogIndex = body.findIndex((line) => line === WATCHDOG_BLOCKERS_HEADING);
	const watchdogBlockers = watchdogIndex >= 0 ? parseWatchdogBlockerLines(body.slice(watchdogIndex + 1)) : [];
	const metadataIndexes = [sessionIndex, handoffIndex, workflowRunIndex, childRunsIndex, reconciledIndex, watchdogIndex].filter((index) => index >= 0);
	const firstMetadataIndex = metadataIndexes.length ? Math.min(...metadataIndexes) : body.length;
	const resultEnd = firstMetadataIndex > 0 && body[firstMetadataIndex - 1]?.trim() === "" ? firstMetadataIndex - 1 : firstMetadataIndex;
	const resultPreview = body.slice(0, resultEnd).join("\n").trim() || "(no output)";
	const handoffPath = handoffIndex >= 0 ? body[handoffIndex]!.slice("Parallel handoff: ".length).trim() : undefined;
	const workflowRunId = workflowRunIndex >= 0 ? body[workflowRunIndex]!.slice("Workflow run: ".length).trim() : undefined;
	const childRuns = childRunsIndex >= 0
		? body[childRunsIndex]!.slice("Child runs: ".length).split(", ").map((part) => {
			const trimmed = part.trim();
			const statusMatch = trimmed.match(/^(.*?)(?: \(([^)]*)\))?$/);
			const raw = statusMatch?.[1] ?? trimmed;
			const separator = raw.indexOf("=");
			return separator >= 0
				? { workflowKey: raw.slice(0, separator), runId: raw.slice(separator + 1), ...(statusMatch?.[2] ? { status: statusMatch[2] } : {}) }
				: { runId: raw, ...(statusMatch?.[2] ? { status: statusMatch[2] } : {}) };
		}).filter((child) => child.runId)
		: undefined;
	const reconciledFromDetachedChild = reconciledIndex >= 0 ? body[reconciledIndex]!.slice("Reconciled detached child: ".length).trim() : undefined;
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[3]!,
		status: match[2] as SubagentNotifyDetails["status"],
		...(match[1] === "Detached foreground task" ? { source: "foreground" as const } : {}),
		...(match[4] ? { taskInfo: match[4] } : {}),
		...(parsedScheduleOrigin ? { scheduleOrigin: parsedScheduleOrigin } : {}),
		...(workflowReceiptPath ? { workflowReceiptPath } : {}),
		resultPreview,
		...(handoffPath ? { handoffPath } : {}),
		...(workflowRunId ? { workflowRunId } : {}),
		...(childRuns?.length ? { childRuns } : {}),
		...(reconciledFromDetachedChild ? { reconciledFromDetachedChild } : {}),
		...(watchdogBlockers.length ? { watchdogBlockers } : {}),
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}

export function formatGroupedCompletion(details: SubagentNotifyDetails[]): string {
	const header = `Background tasks completed (${details.length}): ${details.map((d) => `**${d.agent}**${d.taskInfo ?? ""}`).join(", ")}`;
	const blocks: string[] = [header, ""];
	for (let index = 0; index < details.length; index++) {
		const detail = details[index];
		if (!detail) continue;
		const sessionLine = formatSessionLine(detail);
		blocks.push(`${index + 1}. ${detail.agent}${detail.taskInfo ?? ""}${detail.scheduleOrigin ? ` — scheduled run from ${detail.scheduleOrigin.name ?? detail.scheduleOrigin.id} (schedule ${detail.scheduleOrigin.id})` : ""}`);
		if (detail.workflowReceiptPath) blocks.push(`Workflow receipt: ${detail.workflowReceiptPath}`);
		blocks.push(formatResultPreview(detail));
		blocks.push(...formatWatchdogBlockerLines(detail));
		if (detail.handoffPath) blocks.push(`Parallel handoff: ${detail.handoffPath}`);
		blocks.push(...formatCorrelationLines(detail));
		if (sessionLine) blocks.push(sessionLine);
		blocks.push("");
	}
	return blocks.join("\n").trimEnd();
}

const notificationDebug = debuglog("pi-subagents-notify");
type TraceIdentity = Pick<CompletionNotification, "id" | "runId" | "source">;
type NotificationReason = "disposed" | "missing_session" | "foreground_session_mismatch" | "not_owned"
	| "intercom_delivered" | "deduped_ttl" | "deduped_pending" | "batch_deferred"
	| "emit_foreground_session_mismatch" | "emit_not_owned" | "send_accepted" | "send_failed" | "dispose_pending";

// Slice before sanitizing: diagnostic work and each identity are bounded even for
// malformed result metadata. Never include task/output, paths, or error bodies.
function traceIdentity(result: TraceIdentity): TraceIdentity {
	const identity = (value: unknown) => typeof value === "string"
		? value.slice(0, 128).replace(/[^a-zA-Z0-9_.:-]/g, "_") : undefined;
	return { id: identity(result.id), runId: identity(result.runId), source: result.source === "foreground" ? "foreground" : "async" };
}

function traceNotification(reason: NotificationReason, result?: TraceIdentity): void {
	if (!notificationDebug.enabled) return;
	try {
		notificationDebug("%s", JSON.stringify({ reason, ...(result ? traceIdentity(result) : {}) }));
	} catch {
		// Diagnostics must never change delivery acknowledgement.
	}
}

interface PendingCompletion {
	trace?: TraceIdentity;
	key: string;
	details: SubagentNotifyDetails;
	sessionId: string;
	completionOwnerId: unknown;
	triggerTurn: boolean;
	resolve(accepted: boolean): void;
}

function sendCompletion(pi: Pick<ExtensionAPI, "sendMessage">, items: PendingCompletion[]): boolean {
	if (items.length === 0) return true;
	const details = items.map((item) => item.details);
	const content = details.length === 1 ? formatSingleCompletion(details[0]!) : formatGroupedCompletion(details);
	const display = details.some((detail) => detail.source === "foreground" || detail.status !== "completed" || detail.scheduleOrigin !== undefined);
	try {
		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display,
			},
			{ triggerTurn: items.some((item) => item.triggerTurn) },
		);
		return true;
	} catch {
		return false;
	}
}

function completionBatchKey(result: CompletionNotification): string {
	const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
	if (sessionId) return `session:${sessionId}`;
	const cwd = typeof result.cwd === "string" ? result.cwd.trim() : "";
	return cwd ? `cwd:${cwd}` : "unknown";
}

export function buildCompletionDetails(result: CompletionNotification): SubagentNotifyDetails {
	const agent = result.agent ?? "unknown";
	const summary = typeof result.summary === "string" ? result.summary : "";
	const stopped = result.stopped === true
		|| result.state === "stopped"
		|| (result.success !== true && result.exitCode !== 0 && isUnexplainedProcessSignal(result))
		|| result.results?.some((child) => child.stopped === true
			|| child.status === "stopped"
			|| (child.success !== true && child.exitCode !== 0 && isUnexplainedProcessSignal(child))) === true;
	const paused = !stopped && !result.success && (
		result.exitCode === 0
		|| result.state === "paused"
		|| result.interrupted === true
		|| summary.startsWith("Paused after interrupt.")
	);
	const status = stopped ? "stopped" : paused ? "paused" : result.success ? "completed" : "failed";
	const taskInfo =
		result.taskIndex !== undefined && result.totalTasks !== undefined
			? ` (${result.taskIndex + 1}/${result.totalTasks})`
			: undefined;

	const parallelHandoff = result.parallelHandoff && typeof result.parallelHandoff === "object"
		? result.parallelHandoff as { path?: unknown }
		: undefined;
	const handoffPath = typeof parallelHandoff?.path === "string" ? parallelHandoff.path : undefined;
	const receipt = result.workflowReceipt;
	const receiptPath = receipt && typeof receipt === "object" && !Array.isArray(receipt)
		? (receipt as Record<string, unknown>).path : undefined;
	const workflowReceiptPath = typeof receiptPath === "string" && receiptPath ? receiptPath : undefined;
	const rawRunId = typeof result.runId === "string" ? result.runId : typeof result.id === "string" ? result.id : undefined;
	const workflowRunId = (result.mode === "workflow" || agent === "workflow") && rawRunId ? rawRunId : undefined;
	const directChild = !workflowRunId && result.results?.length === 1 ? result.results[0]! : undefined;
	const directStructuredPreview = directChild
		? childInlinePreview(directChild).preview
		: undefined;
	const directSummary = summary.trim();
	const directAgent = typeof directChild?.agent === "string" ? directChild.agent : agent;
	const directSummaryBody = directAgent && summary.trimStart().startsWith(`${directAgent}:\n`)
		? summary.trimStart().slice(directAgent.length + 2)
		: directSummary;
	const directDegenerateSummary = directChild
		&& isDegenerateOutput(typeof directChild.output === "string" ? directChild.output : "")
		&& isDegenerateOutput(directSummaryBody)
		&& structuredOutputText(directChild.structuredOutput) !== undefined;
	const directNoOutputSummary = directChild && (!directSummary
		|| directSummary === "(no output)"
		|| (directAgent && directSummary === `${directAgent}:\n(no output)`));
	const resultPreview = directStructuredPreview && (directNoOutputSummary || directDegenerateSummary)
		? `Structured output:\n${directStructuredPreview}`
		: summary;
	const childRuns = result.results?.flatMap((child) => {
		const runId = typeof child.runId === "string" && child.runId.trim() ? child.runId.trim() : undefined;
		const workflowKey = typeof child.workflowKey === "string" && child.workflowKey.trim() ? child.workflowKey.trim() : undefined;
		if (!runId && (!workflowRunId || !workflowKey)) return [];
		return [{
			runId: runId ?? "unavailable",
			...(workflowKey ? { workflowKey } : {}),
			...(typeof child.agent === "string" ? { agent: child.agent } : {}),
			status: childStatus(child, workflowRunId ? result.state : undefined),
		}];
	}) ?? [];
	const childOutputs = workflowRunId && result.results?.length
		? result.results.map((child) => {
			const inline = childInlinePreview(child);
			const workflowKey = typeof child.workflowKey === "string" && child.workflowKey.trim() ? child.workflowKey.trim() : undefined;
			const runId = typeof child.runId === "string" && child.runId.trim() ? child.runId.trim() : undefined;
			const savedOutputPath = childSavedOutputPath(child);
			return {
				...(workflowKey ? { workflowKey } : {}),
				...(runId ? { runId } : {}),
				...(typeof child.agent === "string" ? { agent: child.agent } : {}),
				status: childStatus(child, result.state),
				...(savedOutputPath ? { savedOutputPath } : {}),
				...(inline.preview ? { preview: inline.preview } : { preview: "" }),
				...(inline.truncated ? { previewTruncated: true } : {}),
				...(inline.unavailableReason ? { previewUnavailableReason: inline.unavailableReason } : {}),
			};
		})
		: undefined;
	const reconciledFromDetachedChild = typeof result.reconciledFromDetachedChild === "string" ? result.reconciledFromDetachedChild : undefined;
	const watchdogBlockers: SubagentNotifyWatchdogBlocker[] = [];
	const collectWatchdogBlockers = (owner: string, progress: ChildWatchdogProgress | undefined) => {
		for (const warning of progress?.warnings ?? []) {
			if (warning.severity !== "blocker") continue;
			watchdogBlockers.push({ agent: owner, summary: warning.summary, addressed: warning.addressed, stalemate: warning.stalemate });
		}
	};
	collectWatchdogBlockers(agent, result.watchdog);
	for (const child of result.results ?? []) collectWatchdogBlockers(typeof child.agent === "string" ? child.agent : agent, child.watchdog);
	const session =
		result.shareUrl
			? { label: "Session", value: result.shareUrl }
			: result.shareError
				? { label: "Session share error", value: result.shareError }
				: result.sessionFile
					? { label: "Session file", value: result.sessionFile }
					: undefined;
	const rawOrigin = result.scheduleOrigin;
	const scheduleOrigin = rawOrigin && typeof rawOrigin.id === "string"
		? { id: rawOrigin.id, ...(typeof rawOrigin.name === "string" ? { name: rawOrigin.name } : {}) }
		: undefined;
	return {
		agent,
		status,
		...(scheduleOrigin ? { scheduleOrigin } : {}),
		...(workflowReceiptPath ? { workflowReceiptPath } : {}),
		...(result.source ? { source: result.source } : {}),
		...(taskInfo ? { taskInfo } : {}),
		resultPreview,
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
		...(handoffPath ? { handoffPath } : {}),
		...(workflowRunId ? { workflowRunId } : {}),
		...(childRuns.length ? { childRuns } : {}),
		...(childOutputs?.length ? { childOutputs } : {}),
		...(reconciledFromDetachedChild ? { reconciledFromDetachedChild } : {}),
		...(watchdogBlockers.length ? { watchdogBlockers } : {}),
		...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
	};
}

export default function registerSubagentNotify(
	pi: ExtensionAPI,
	state: Pick<SubagentState, "currentSessionId" | "completionOwnerId">,
	options: RegisterSubagentNotifyOptions = {},
): CompletionNotifier {
	const seen = new Map<string, number>();
	const pending = new Map<string, Promise<boolean>>();
	const ttlMs = 10 * 60 * 1000;
	const now = options.now ?? Date.now;
	const batchConfig = resolveCompletionBatchConfig(options.batchConfig);
	const batchers = new Map<string, CompletionBatcher<PendingCompletion>>();
	let disposed = false;
	const ownsResult = options.ownership?.owns
		?? ((sessionId: string, completionOwnerId: unknown) => sessionId === state.currentSessionId
			&& typeof completionOwnerId === "string"
			&& completionOwnerId === state.completionOwnerId);

	const settle = (items: PendingCompletion[], accepted: boolean, reason?: NotificationReason) => {
		for (const item of items) {
			if (reason) traceNotification(reason, item.trace);
			pending.delete(item.key);
			if (accepted) markSeenWithTtl(seen, item.key, now(), ttlMs);
			item.resolve(accepted);
		}
	};
	const emit = (items: PendingCompletion[]) => {
		const accepted: PendingCompletion[] = [];
		const rejected: PendingCompletion[] = [];
		for (const item of items) {
			const owned = item.details.source === "foreground"
				? item.sessionId === state.currentSessionId
				: ownsResult(item.sessionId, item.completionOwnerId);
			if (!owned) traceNotification(item.details.source === "foreground" ? "emit_foreground_session_mismatch" : "emit_not_owned", item.trace);
			(owned ? accepted : rejected).push(item);
		}
		settle(rejected, false);
		const sent = sendCompletion(pi, accepted);
		settle(accepted, sent, sent ? "send_accepted" : "send_failed");
	};
	const getBatcher = (result: CompletionNotification) => {
		const key = completionBatchKey(result);
		let batcher = batchers.get(key);
		if (!batcher) {
			batcher = createCompletionBatcher<PendingCompletion>({
				config: batchConfig,
				emit,
				...(options.timers ? { timers: options.timers } : {}),
				now,
			});
			batchers.set(key, batcher);
		}
		return batcher;
	};

	const deliver = (result: CompletionNotification): Promise<boolean> => {
		if (disposed || typeof result.sessionId !== "string") {
			traceNotification(disposed ? "disposed" : "missing_session", result);
			return Promise.resolve(false);
		}
		if (result.source === "foreground") {
			if (result.sessionId !== state.currentSessionId) {
				traceNotification("foreground_session_mismatch", result);
				return Promise.resolve(false);
			}
		} else if (!ownsResult(result.sessionId, result.completionOwnerId)) {
			traceNotification("not_owned", result);
			return Promise.resolve(false);
		}
		if (result.intercomDelivered === true) {
			traceNotification("intercom_delivered", result);
			return Promise.resolve(true);
		}
		const key = buildCompletionKey(result, "notify");
		const seenAt = seen.get(key);
		if (seenAt !== undefined && now() - seenAt <= ttlMs) {
			traceNotification("deduped_ttl", result);
			return Promise.resolve(true);
		}
		if (seenAt !== undefined) seen.delete(key);
		const inFlight = pending.get(key);
		if (inFlight) {
			traceNotification("deduped_pending", result);
			return inFlight;
		}
		const details = buildCompletionDetails(result);
		let resolve!: (accepted: boolean) => void;
		const completion = new Promise<boolean>((settleCompletion) => { resolve = settleCompletion; });
		pending.set(key, completion);
		const item: PendingCompletion = {
			key,
			details,
			sessionId: result.sessionId,
			completionOwnerId: result.completionOwnerId,
			triggerTurn: result.triggerTurn !== false,
			resolve,
		};
		if (notificationDebug.enabled) item.trace = traceIdentity(result);
		if (details.source === "foreground") {
			emit([item]);
			return completion;
		}
		const batcher = getBatcher(result);
		if (details.status !== "completed") {
			batcher.flush();
			emit([item]);
			return completion;
		}
		if (batchConfig.enabled) traceNotification("batch_deferred", item.trace);
		batcher.push(item);
		return completion;
	};

	const unsubscribeAsync = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
		void deliver(data as CompletionNotification);
	});
	const unsubscribeForeground = pi.events.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, (data) => {
		void deliver(data as CompletionNotification);
	});

	return {
		deliver,
		hasPendingDelivery: () => pending.size > 0,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const batcher of batchers.values()) settle(batcher.dispose(), false, "dispose_pending");
			batchers.clear();
			for (const unsubscribe of [unsubscribeAsync, unsubscribeForeground]) {
				try {
					unsubscribe?.();
				} catch {
					// The runtime is already shutting down; pending records stay on disk.
				}
			}
		},
	};
}
