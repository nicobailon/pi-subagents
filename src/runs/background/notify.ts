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
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT, type SubagentState } from "../../shared/types.ts";

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused";
	source?: "async" | "foreground";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
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
	triggerTurn?: boolean;
}

interface NotifyTimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RegisterSubagentNotifyOptions {
	batchConfig?: CompletionBatchConfig;
	timers?: NotifyTimerApi;
	now?: () => number;
}

export interface CompletionNotifier {
	deliver(result: CompletionNotification): Promise<boolean>;
	dispose(): void;
}

function formatSessionLine(details: SubagentNotifyDetails): string | undefined {
	if (!details.sessionValue) return undefined;
	return details.sessionLabel ? `${details.sessionLabel}: ${details.sessionValue}` : details.sessionValue;
}

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
	const sessionLine = formatSessionLine(details);
	const taskKind = details.source === "foreground" ? "Detached foreground task" : "Background task";
	return [
		`${taskKind} ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
		"",
		details.resultPreview.trim() ? details.resultPreview : "(no output)",
		sessionLine ? "" : undefined,
		sessionLine,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

export function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const match = (lines[0] ?? "").match(/^(Background task|Detached foreground task) (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultPreview = (sessionIndex >= 0 ? body.slice(0, sessionIndex) : body).join("\n").trim() || "(no output)";
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
		resultPreview,
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
		blocks.push(`${index + 1}. ${detail.agent}${detail.taskInfo ?? ""}`);
		blocks.push(detail.resultPreview.trim() ? detail.resultPreview : "(no output)");
		if (sessionLine) blocks.push(sessionLine);
		blocks.push("");
	}
	return blocks.join("\n").trimEnd();
}

interface PendingCompletion {
	key: string;
	details: SubagentNotifyDetails;
	triggerTurn: boolean;
	resolve(accepted: boolean): void;
}

function sendCompletion(pi: Pick<ExtensionAPI, "sendMessage">, items: PendingCompletion[]): boolean {
	if (items.length === 0) return true;
	const details = items.map((item) => item.details);
	const content = details.length === 1 ? formatSingleCompletion(details[0]!) : formatGroupedCompletion(details);
	try {
		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display: true,
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
	const paused = !result.success && (
		result.exitCode === 0
		|| result.state === "paused"
		|| summary.startsWith("Paused after interrupt.")
	);
	const status = paused ? "paused" : result.success ? "completed" : "failed";
	const taskInfo =
		result.taskIndex !== undefined && result.totalTasks !== undefined
			? ` (${result.taskIndex + 1}/${result.totalTasks})`
			: undefined;

	const session =
		result.shareUrl
			? { label: "Session", value: result.shareUrl }
			: result.shareError
				? { label: "Session share error", value: result.shareError }
				: result.sessionFile
					? { label: "Session file", value: result.sessionFile }
					: undefined;
	return {
		agent,
		status,
		...(result.source ? { source: result.source } : {}),
		...(taskInfo ? { taskInfo } : {}),
		resultPreview: summary,
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
		...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
	};
}

export default function registerSubagentNotify(
	pi: ExtensionAPI,
	state: Pick<SubagentState, "currentSessionId">,
	options: RegisterSubagentNotifyOptions = {},
): CompletionNotifier {
	const seen = new Map<string, number>();
	const pending = new Map<string, Promise<boolean>>();
	const ttlMs = 10 * 60 * 1000;
	const now = options.now ?? Date.now;
	const batchConfig = resolveCompletionBatchConfig(options.batchConfig);
	const batchers = new Map<string, CompletionBatcher<PendingCompletion>>();
	let disposed = false;

	const settle = (items: PendingCompletion[], accepted: boolean) => {
		for (const item of items) {
			pending.delete(item.key);
			if (accepted) markSeenWithTtl(seen, item.key, now(), ttlMs);
			item.resolve(accepted);
		}
	};
	const emit = (items: PendingCompletion[]) => settle(items, sendCompletion(pi, items));
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
		if (disposed || typeof result.sessionId !== "string" || result.sessionId !== state.currentSessionId) return Promise.resolve(false);
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
