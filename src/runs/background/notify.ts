/**
 * Subagent completion notifications.
 *
 * Successful (completed) async results are held briefly and emitted as a
 * single grouped message when sibling jobs finish within a short window (see
 * `completion-batcher.ts`). Failed and paused results bypass grouping and fire
 * immediately, flushing any held successes first, so failure and attention
 * signals are never delayed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import {
	type CompletionBatchConfig,
	createCompletionBatcher,
	resolveCompletionBatchConfig,
} from "./completion-batcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.ts";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
}

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
}

interface SubagentResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode?: number;
	state?: string;
	timestamp: number;
	durationMs?: number;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
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

function formatSessionLine(details: SubagentNotifyDetails): string | undefined {
	if (!details.sessionValue) return undefined;
	return details.sessionLabel ? `${details.sessionLabel}: ${details.sessionValue}` : details.sessionValue;
}

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
	const sessionLine = formatSessionLine(details);
	return [
		`Background task ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
		"",
		details.resultPreview.trim() ? details.resultPreview : "(no output)",
		sessionLine ? "" : undefined,
		sessionLine,
	]
		.filter((line) => line !== undefined)
		.join("\n");
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

function sendCompletion(pi: Pick<ExtensionAPI, "sendMessage">, details: SubagentNotifyDetails[]): void {
	if (details.length === 0) return;
	const content = details.length === 1
		? formatSingleCompletion(details[0]!)
		: formatGroupedCompletion(details);
	pi.sendMessage(
		{
			customType: "subagent-notify",
			content,
			display: true,
		},
		{ triggerTurn: true },
	);
}

export function buildCompletionDetails(result: SubagentResult): SubagentNotifyDetails {
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
		...(taskInfo ? { taskInfo } : {}),
		resultPreview: summary,
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
		...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
	};
}

export default function registerSubagentNotify(
	pi: ExtensionAPI,
	options: RegisterSubagentNotifyOptions = {},
): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const batcherStoreKey = "__pi_subagents_notify_batcher__";
	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[unsubscribeStoreKey];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}
	const previousBatcher = globalStore[batcherStoreKey];
	if (previousBatcher && typeof (previousBatcher as { dispose?: () => void }).dispose === "function") {
		try {
			(previousBatcher as { dispose: () => void }).dispose();
		} catch {
			// Best effort cleanup for a stale batcher from an older reload.
		}
	}

	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;
	const nowFn = options.now ?? Date.now;
	const batchConfig = resolveCompletionBatchConfig(options.batchConfig);

	const batcher = createCompletionBatcher<SubagentNotifyDetails>({
		config: batchConfig,
		emit: (items) => sendCompletion(pi, items),
		...(options.timers ? { timers: options.timers } : {}),
		now: nowFn,
	});
	globalStore[batcherStoreKey] = batcher;

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const now = nowFn();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const details = buildCompletionDetails(result);
		if (details.status !== "completed") {
			// Failures and paused runs bypass grouping. Flush any held
			// successes first so they are not stranded behind this signal,
			// then emit the non-completion result immediately.
			batcher.flush();
			sendCompletion(pi, [details]);
			return;
		}
		batcher.push(details);
	};

	globalStore[unsubscribeStoreKey] = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
}
