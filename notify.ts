/**
 * Subagent completion notifications (extension)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
}

interface SubagentResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode: number;
	timestamp: number;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
}

export default function registerSubagentNotify(pi: ExtensionAPI): void {
	const seen = new Map<string, number>();
	const ttlMs = 10 * 60 * 1000;

	const prune = (now: number) => {
		for (const [key, ts] of seen.entries()) {
			if (now - ts > ttlMs) seen.delete(key);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		const now = Date.now();
		const key = `${result.id ?? "no-id"}:${result.agent ?? "unknown"}:${result.timestamp ?? now}`;
		prune(now);
		if (seen.has(key)) return;
		seen.set(key, now);

		const agent = result.agent ?? "unknown";
		const status = result.success ? "completed" : "failed";

		const taskInfo =
			result.taskIndex !== undefined && result.totalTasks !== undefined
				? ` (${result.taskIndex + 1}/${result.totalTasks})`
				: "";

		const extra: string[] = [];
		if (result.shareUrl) {
			extra.push(`Session: ${result.shareUrl}`);
		} else if (result.shareError) {
			extra.push(`Session share error: ${result.shareError}`);
		} else if (result.sessionFile) {
			extra.push(`Session file: ${result.sessionFile}`);
		}

		const content = [
			`Background task ${status}: **${agent}**${taskInfo}`,
			"",
			result.summary,
			extra.length ? "" : undefined,
			extra.length ? extra.join("\n") : undefined,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.events.on("subagent:complete", handleComplete);
	pi.events.on("subagent_enhanced:complete", handleComplete);
	pi.events.on("async_subagent:complete", handleComplete);
}
