import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { renderWidget } from "./render.ts";
import {
	type SubagentState,
	POLL_INTERVAL_MS,
} from "./types.ts";
import { readStatus } from "./utils.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
}

export function createAsyncJobTracker(state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs);
		ctx.ui.requestRender?.();
	};
	const scheduleCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (existingTimer) clearTimeout(existingTimer);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (!state.lastUiContext || !state.lastUiContext.hasUI) return;
			if (state.asyncJobs.size === 0) {
				rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			for (const job of state.asyncJobs.values()) {
				try {
					const status = readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.status = status.state;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.stepsTotal = status.steps?.length ?? job.stepsTotal;
						job.startedAt = status.startedAt ?? job.startedAt;
						job.updatedAt = status.lastUpdate ?? Date.now();
						if (status.steps?.length) {
							job.agents = status.steps.map((step) => step.agent);
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						if ((job.status === "complete" || job.status === "failed") && previousStatus !== job.status) {
							scheduleCleanup(job.asyncId);
						}
						continue;
					}
					job.status = job.status === "queued" ? "running" : job.status;
					job.updatedAt = Date.now();
				} catch (error) {
					console.error(`Failed to read async status for '${job.asyncDir}':`, error);
					job.status = "failed";
					job.updatedAt = Date.now();
				}
			}

			rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as {
			id?: string;
			asyncDir?: string;
			agent?: string;
			chain?: string[];
		};
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const agents = info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			mode: info.chain ? "chain" : "single",
			agents,
			stepsTotal: agents?.length,
			startedAt: now,
			updatedAt: now,
		});
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
			ensurePoller();
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
		}
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
		scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	return { ensurePoller, handleStarted, handleComplete, resetJobs };
}
