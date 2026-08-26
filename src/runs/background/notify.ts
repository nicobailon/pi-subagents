/**
 * Completion notification delivery.
 *
 * Async result files call this notifier directly and are deleted only after
 * `sendMessage()` accepts the notification. The event bus remains an
 * observation channel, not a delivery acknowledgement.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import {
	type CompletionBatchConfig,
	type CompletionBatcher,
	createCompletionBatcher,
	resolveCompletionBatchConfig,
} from "./completion-batcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT, type ParallelHandoffReference, type ScheduleOrigin, type SubagentState } from "../../shared/types.ts";
import { isUnexplainedProcessSignal } from "../shared/process-signal.ts";
import type { ResultDeliveryOwnership } from "./result-delivery-ownership.ts";

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused" | "stopped";
	source?: "async" | "foreground";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	workflowRunId?: string;
	childRuns?: Array<{ runId: string; workflowKey?: string; agent?: string; status?: string }>;
	reconciledFromDetachedChild?: string;
	sessionLabel?: string;
	sessionValue?: string;
	handoffPath?: string;
	/** Present when a durable schedule launched the run. */
	scheduleOrigin?: ScheduleOrigin;
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
		success?: boolean;
		exitCode?: number | null;
		processSignal?: string | null;
		interrupted?: boolean;
		timedOut?: boolean;
		stopped?: boolean;
		turnBudgetExceeded?: boolean;
	}>;
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
	dispose(): void;
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

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
	const sessionLine = formatSessionLine(details);
	const correlationLines = formatCorrelationLines(details);
	const taskKind = details.source === "foreground" ? "Detached foreground task" : "Background task";
	const scheduleLine = details.scheduleOrigin
		? `Scheduled run from **${details.scheduleOrigin.name ?? details.scheduleOrigin.id}** (schedule ${details.scheduleOrigin.id}).`
		: undefined;
	return [
		`${taskKind} ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
		"",
		scheduleLine,
		scheduleLine ? "" : undefined,
		details.resultPreview.trim() ? details.resultPreview : "(no output)",
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
	let body = lines.slice(2);
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
	const metadataIndexes = [sessionIndex, handoffIndex, workflowRunIndex, childRunsIndex, reconciledIndex].filter((index) => index >= 0);
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
		resultPreview,
		...(handoffPath ? { handoffPath } : {}),
		...(workflowRunId ? { workflowRunId } : {}),
		...(childRuns?.length ? { childRuns } : {}),
		...(reconciledFromDetachedChild ? { reconciledFromDetachedChild } : {}),
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
		blocks.push(detail.resultPreview.trim() ? detail.resultPreview : "(no output)");
		if (detail.handoffPath) blocks.push(`Parallel handoff: ${detail.handoffPath}`);
		blocks.push(...formatCorrelationLines(detail));
		if (sessionLine) blocks.push(sessionLine);
		blocks.push("");
	}
	return blocks.join("\n").trimEnd();
}

interface PendingCompletion {
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
	const rawRunId = typeof result.runId === "string" ? result.runId : typeof result.id === "string" ? result.id : undefined;
	const workflowRunId = (result.mode === "workflow" || agent === "workflow") && rawRunId ? rawRunId : undefined;
	const childRuns = result.results?.flatMap((child) => {
		if (typeof child.runId !== "string" || !child.runId.trim()) return [];
		return [{
			runId: child.runId,
			...(typeof child.workflowKey === "string" ? { workflowKey: child.workflowKey } : {}),
			...(typeof child.agent === "string" ? { agent: child.agent } : {}),
			...(typeof child.status === "string" ? { status: child.status } : {}),
		}];
	}) ?? [];
	const reconciledFromDetachedChild = typeof result.reconciledFromDetachedChild === "string" ? result.reconciledFromDetachedChild : undefined;
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
		...(result.source ? { source: result.source } : {}),
		...(taskInfo ? { taskInfo } : {}),
		resultPreview: summary,
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
		...(handoffPath ? { handoffPath } : {}),
		...(workflowRunId ? { workflowRunId } : {}),
		...(childRuns.length ? { childRuns } : {}),
		...(reconciledFromDetachedChild ? { reconciledFromDetachedChild } : {}),
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

	const settle = (items: PendingCompletion[], accepted: boolean) => {
		for (const item of items) {
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
			(owned ? accepted : rejected).push(item);
		}
		settle(rejected, false);
		settle(accepted, sendCompletion(pi, accepted));
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
		if (disposed || typeof result.sessionId !== "string") return Promise.resolve(false);
		if (result.source === "foreground") {
			if (result.sessionId !== state.currentSessionId) return Promise.resolve(false);
		} else if (!ownsResult(result.sessionId, result.completionOwnerId)) return Promise.resolve(false);
		if (result.intercomDelivered === true) return Promise.resolve(true);
		const key = buildCompletionKey(result, "notify");
		const seenAt = seen.get(key);
		if (seenAt !== undefined && now() - seenAt <= ttlMs) return Promise.resolve(true);
		if (seenAt !== undefined) seen.delete(key);
		const inFlight = pending.get(key);
		if (inFlight) return inFlight;
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
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const batcher of batchers.values()) settle(batcher.dispose(), false);
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
