import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget } from "../../tui/render.ts";
import { formatControlNoticeMessage } from "../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type AsyncParallelGroupStatus,
	type AsyncStartedEvent,
	type ControlEvent,
	type SubagentState,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";


function isValidParallelGroup(group: AsyncParallelGroupStatus, stepCount: number, chainStepCount: number): boolean {
	return Number.isInteger(group.start)
		&& Number.isInteger(group.count)
		&& Number.isInteger(group.stepIndex)
		&& group.start >= 0
		&& group.count > 0
		&& group.stepIndex >= 0
		&& group.stepIndex < chainStepCount
		&& group.start + group.count <= stepCount;
}

function normalizeParallelGroups(groups: AsyncParallelGroupStatus[] | undefined, stepCount: number, chainStepCount: number): AsyncParallelGroupStatus[] {
	if (!groups?.length) return [];
	return groups.filter((group) => isValidParallelGroup(group, stepCount, chainStepCount));
}

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
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
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const cursor = stat.size < (job.controlEventCursor ?? 0) ? 0 : (job.controlEventCursor ?? 0);
			if (stat.size <= cursor) return;
			const buffer = Buffer.alloc(stat.size - cursor);
			fs.readSync(fd, buffer, 0, buffer.length, cursor);
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			job.controlEventCursor = cursor + lastNewline + 1;
			for (const line of buffer.subarray(0, lastNewline).toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					continue;
				}
				if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") continue;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || !Array.isArray(record.channels)) continue;
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
				};
				if (record.channels.includes("event")) {
					pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
				}
				if (record.event.type !== "active_long_running" && record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
						...payload,
						to: record.intercom.to,
						message: record.intercom.message,
					});
				}
			}
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			for (const job of state.asyncJobs.values()) {
				try {
					emitNewControlEvents(job);
					const reconciliation = reconcileAsyncRun(job.asyncDir, {
						resultsDir,
						kill: options.kill,
						now: options.now,
						startedRun: {
							runId: job.asyncId,
							pid: job.pid,
							sessionId: job.sessionId,
							mode: job.mode,
							agents: job.agents,
							startedAt: job.startedAt,
							sessionFile: job.sessionFile,
						},
					});
					const status = reconciliation.status ?? readStatus(job.asyncDir);
					if (status) {
						const previousStatus = job.status;
						job.status = status.state;
						job.sessionId = status.sessionId ?? job.sessionId;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt;
						job.currentPath = status.currentPath;
						job.turnCount = status.turnCount ?? job.turnCount;
						job.toolCount = status.toolCount ?? job.toolCount;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.startedAt = status.startedAt ?? job.startedAt;
						job.updatedAt = status.lastUpdate ?? Date.now();
						if (status.steps?.length) {
							const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
							job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
							const activeGroup = status.currentStep !== undefined
								? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
								: undefined;
							const visibleSteps = activeGroup
								? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count)
								: status.steps;
							job.activeParallelGroup = Boolean(activeGroup);
							job.agents = visibleSteps.map((step) => step.agent);
							job.stepsTotal = visibleSteps.length;
							job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
							job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
							if (status.state === "complete") job.completedSteps = visibleSteps.length;
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
						if ((job.status === "complete" || job.status === "failed" || job.status === "paused") && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
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
					if (!state.cleanupTimers.has(job.asyncId)) {
						scheduleCleanup(job.asyncId);
					}
				}
			}

			if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.chain ? "chain" : "single",
			agents,
			stepsTotal: firstGroupCount ?? agents?.length,
			hasParallelGroups: validParallelGroups.length > 0,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			startedAt: now,
			updatedAt: now,
		});
		ensurePoller();
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
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
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	return { ensurePoller, handleStarted, handleComplete, resetJobs };
}
