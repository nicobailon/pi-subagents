/**
 * Subagent completion notifications.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import { deliverBackgroundForkEvent } from "./fork-handler.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STEP_COMPLETE_EVENT, type BackgroundForkHandlersConfig } from "../../shared/types.ts";

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

interface SubagentStepResult {
	id?: string;
	runId?: string;
	agent?: string;
	index?: number;
	totalTasks?: number;
	success?: boolean;
	exitCode?: number;
	summary?: string;
	durationMs?: number;
	sessionFile?: string;
	intercomTarget?: string;
}

export default function registerSubagentNotify(pi: ExtensionAPI, backgroundForkHandlers?: BackgroundForkHandlersConfig, getParentSessionFile?: () => string | null | undefined): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[unsubscribeStoreKey];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}

	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const now = Date.now();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

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
				: "";

		const sessionLine = result.shareUrl
			? `Session: ${result.shareUrl}`
			: result.shareError
				? `Session share error: ${result.shareError}`
				: result.sessionFile
					? `Session file: ${result.sessionFile}`
					: undefined;

		const displaySummary = summary.trim() ? summary : "(no output)";
		const content = [
			`Background task ${status}: **${agent}**${taskInfo}`,
			"",
			displaySummary,
			sessionLine ? "" : undefined,
			sessionLine,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		void deliverBackgroundForkEvent(pi, backgroundForkHandlers, {
			type: "async-complete",
			title: `Background task ${status}: ${agent}${taskInfo}`,
			content,
			cwd: process.cwd(),
			parentSessionFile: getParentSessionFile?.() ?? undefined,
			details: { agent, status, taskInfo, resultPreview: displaySummary, durationMs: result.durationMs, sessionLabel: sessionLine ? "session" : undefined, sessionValue: result.shareUrl ?? result.sessionFile },
		});
	};

	const handleStepComplete = (data: unknown) => {
		const result = data as SubagentStepResult;
		const now = Date.now();
		const key = `step:${result.runId ?? result.id ?? "unknown"}:${result.index ?? "?"}:${result.exitCode ?? "?"}`;
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const agent = result.agent ?? "unknown";
		const status = result.success === false || (typeof result.exitCode === "number" && result.exitCode !== 0) ? "failed" : "completed";
		const taskInfo = result.index !== undefined && result.totalTasks !== undefined
			? ` (${result.index + 1}/${result.totalTasks})`
			: result.index !== undefined
				? ` (#${result.index + 1})`
				: "";
		const displaySummary = typeof result.summary === "string" && result.summary.trim() ? result.summary : "(no output)";
		const sessionLine = result.sessionFile ? `Session file: ${result.sessionFile}` : undefined;
		const content = [
			`Background step ${status}: **${agent}**${taskInfo}`,
			"",
			displaySummary,
			sessionLine ? "" : undefined,
			sessionLine,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		void deliverBackgroundForkEvent(pi, backgroundForkHandlers, {
			type: "async-step-complete",
			title: `Background step ${status}: ${agent}${taskInfo}`,
			content,
			cwd: process.cwd(),
			parentSessionFile: getParentSessionFile?.() ?? undefined,
			details: {
				agent,
				status,
				taskInfo,
				resultPreview: displaySummary,
				durationMs: result.durationMs,
				...(sessionLine ? { sessionLabel: "session file", sessionValue: result.sessionFile } : {}),
			},
		});
	};

	const unsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_ASYNC_STEP_COMPLETE_EVENT, handleStepComplete),
	];
	globalStore[unsubscribeStoreKey] = () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
	};
}
