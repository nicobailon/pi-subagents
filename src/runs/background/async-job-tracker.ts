import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage } from "../shared/subagent-control.ts";
import {
	type AsyncJobState,
	type AsyncStartedEvent,
	type ControlEvent,
	type SteeringNotice,
	type SubagentState,
	POLL_INTERVAL_MS,
	DIRS,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_STEERING_NOTICE_EVENT,
} from "../../shared/types.ts";
import { readStatus, resolveWatchPath } from "../../shared/utils.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { findNestedRouteForRootId, hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.ts";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { EXTERNAL_JOB_BRIDGE_REQUEST_DIR, serviceExternalJobBridgeRequests } from "../shared/external-job-bridge.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	/** Slow safety sweep for liveness repair when filesystem events are missed. */
	pollIntervalMs?: number;
	resultsDir?: string;
	widgetEnabled?: boolean;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_FLEET_JOBS = 20;
const DEFAULT_LIVENESS_INTERVAL_MS = 5000;
const EVENT_REFRESH_DEBOUNCE_MS = 25;
const WATCH_ATTACHMENT_RETRY_MS = 100;

function rememberFleetJob(state: SubagentState, job: AsyncJobState): void {
	state.fleetJobs ??= new Map();
	state.fleetJobs.set(job.asyncId, job);
	const terminal = [...state.fleetJobs.values()]
		.filter((candidate) => candidate.status === "complete" || candidate.status === "failed" || candidate.status === "paused" || candidate.status === "stopped")
		.sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0));
	for (const stale of terminal.slice(MAX_RECENT_FLEET_JOBS)) state.fleetJobs.delete(stale.asyncId);
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	refreshWidget: (ctx: ExtensionContext) => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
	restoreActiveJobs: (ctx?: ExtensionContext) => void;
	dispose: () => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const livenessIntervalMs = options.pollIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
	const resultsDir = options.resultsDir ?? DIRS.results;
	const steeringNoticeSeen = new Map<string, number>();
	const jobWatchers = new Map<string, { watchers: Map<string, fs.FSWatcher>; retryTimer?: ReturnType<typeof setTimeout> }>();
	const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const runningJobIds = new Set<string>();
	let rootWatcher: fs.FSWatcher | undefined;
	let nextLivenessAt = Date.now() + livenessIntervalMs;
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		if (state.widgetsSuspended) return;
		renderWidget(ctx, options.widgetEnabled === false ? [] : jobs);
		(ctx.ui as { requestRender?: () => void }).requestRender?.();
	};
	const rerenderLastWidget = (jobs = Array.from(state.asyncJobs.values())) => {
		const ctx = state.lastUiContext;
		if (!ctx) return;
		try {
			if (ctx.hasUI) rerenderWidget(ctx, jobs);
		} catch (error) {
			if (error instanceof Error && error.message.includes("extension ctx is stale")) {
				state.lastUiContext = null;
				return;
			}
			throw error;
		}
	};
	const requestLastWidgetRender = () => {
		const ctx = state.lastUiContext;
		if (!ctx || state.widgetsSuspended || options.widgetEnabled === false) return;
		try {
			if (ctx.hasUI) (ctx.ui as { requestRender?: () => void }).requestRender?.();
		} catch (error) {
			if (error instanceof Error && error.message.includes("extension ctx is stale")) {
				state.lastUiContext = null;
				return;
			}
			throw error;
		}
	};
	const refreshWidget = (ctx: ExtensionContext) => rerenderWidget(ctx);
	const restoredControlEventCursor = (asyncDir: string) => {
		try {
			return fs.statSync(path.join(asyncDir, "events.jsonl")).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
	};
	const findNestedRouteForJob = (runId: string) => {
		try {
			return findNestedRouteForRootId(runId);
		} catch (error) {
			console.error(`Failed to resolve nested event route for '${runId}':`, error);
			return undefined;
		}
	};
	const summaryToJob = (run: AsyncRunSummary): AsyncJobState => {
		const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, run.chainStepCount ?? run.steps.length);
		const activeGroup = run.currentStep !== undefined
			? groups.find((group) => run.currentStep! >= group.start && run.currentStep! < group.start + group.count)
			: undefined;
		const visibleSteps = activeGroup
			? run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
			: run.steps.map((step, index) => ({ ...step, index }));
		return {
			asyncId: run.id,
			asyncDir: run.asyncDir,
			toolCallId: run.toolCallId,
			status: run.state,
			sessionId: run.sessionId,
			activityState: run.activityState,
			lastActivityAt: run.lastActivityAt,
			currentTool: run.currentTool,
			currentToolStartedAt: run.currentToolStartedAt,
			currentPath: run.currentPath,
			turnCount: run.turnCount,
			toolCount: run.toolCount,
			steering: run.steering,
			mode: run.mode,
			context: run.context,
			cwd: run.cwd,
			agents: visibleSteps.map((step) => step.agent),
			currentStep: run.currentStep,
			chainStepCount: run.chainStepCount,
			parallelGroups: groups,
			steps: visibleSteps,
			stepsTotal: visibleSteps.length,
			runningSteps: visibleSteps.filter((step) => step.status === "running").length,
			completedSteps: visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length,
			hasParallelGroups: groups.length > 0,
			activeParallelGroup: Boolean(activeGroup),
			startedAt: run.startedAt,
			updatedAt: run.lastUpdate ?? run.startedAt,
			timeoutMs: run.timeoutMs,
			deadlineAt: run.deadlineAt,
			timedOut: run.timedOut,
			stopped: run.stopped,
			turnBudget: run.turnBudget,
			turnBudgetExceeded: run.turnBudgetExceeded,
			wrapUpRequested: run.wrapUpRequested,
			sessionDir: run.sessionDir,
			outputFile: run.outputFile,
			totalTokens: run.totalTokens,
			sessionFile: run.sessionFile,
			controlEventCursor: restoredControlEventCursor(run.asyncDir),
			nestedRoute: findNestedRouteForJob(run.id),
			nestedChildren: run.nestedChildren,
			parentWorkflowRunId: run.parentWorkflowRunId,
			workflowKey: run.workflowKey,
			workflow: run.workflow,
		};
	};
	const cancelCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (!existingTimer) return;
		clearTimeout(existingTimer);
		state.cleanupTimers.delete(asyncId);
	};
	const scheduleCleanup = (asyncId: string) => {
		cancelCleanup(asyncId);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			closeJobWatcher(asyncId);
			state.asyncJobs.delete(asyncId);
			rerenderLastWidget();
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
			const savedCursor = job.controlEventCursor;
			let cursor = stat.size < (savedCursor ?? 0) ? 0 : (savedCursor ?? 0);
			const startedFromTail = savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
			if (startedFromTail) cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
			if (stat.size <= cursor) return;
			const previousByte = Buffer.alloc(1);
			const startsMidLine = cursor > 0
				&& fs.readSync(fd, previousByte, 0, 1, cursor - 1) === 1
				&& previousByte[0] !== 0x0a;
			const scanEnd = Math.min(stat.size, cursor + CONTROL_EVENT_SCAN_WINDOW_BYTES);
			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (error) {
					console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
					return;
				}
				if (!parsed || typeof parsed !== "object") return;
				if ((parsed as { type?: unknown }).type === "subagent.steering.notice") {
					const notice = parsed as Partial<SteeringNotice>;
					if (typeof notice.requestId !== "string" || typeof notice.runId !== "string" || (notice.state !== "failed" && notice.state !== "partial" && notice.state !== "recovered") || typeof notice.message !== "string") return;
					if (typeof state.currentSessionId === "string" && notice.currentSessionId !== state.currentSessionId) return;
					const key = `${notice.runId}:${notice.requestId}:${notice.state}`;
					if (steeringNoticeSeen.has(key)) return;
					const now = Date.now();
					steeringNoticeSeen.set(key, now);
					if (steeringNoticeSeen.size > 200) {
						for (const [seenKey, seenAt] of steeringNoticeSeen) {
							if (now - seenAt > 10 * 60 * 1000 || steeringNoticeSeen.size > 200) steeringNoticeSeen.delete(seenKey);
						}
					}
					pi.events.emit(SUBAGENT_STEERING_NOTICE_EVENT, { ...notice, source: "async", asyncDir: job.asyncDir, noticeText: notice.message });
					return;
				}
				if ((parsed as { type?: unknown }).type !== "subagent.control") return;
				const record = parsed as { event?: ControlEvent; channels?: string[]; childIntercomTarget?: string; noticeText?: string; intercom?: { to?: string; message?: string } };
				if (!record.event || !Array.isArray(record.channels)) return;
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
			};
			let readCursor = cursor;
			let lastCompleteCursor = cursor;
			let lineParts: Buffer[] = [];
			let lineBytes = 0;
			let skippingOversizedLine = startedFromTail || startsMidLine;
			const appendLineSegment = (segment: Buffer) => {
				if (segment.length === 0 || skippingOversizedLine) return;
				if (lineBytes + segment.length > MAX_CONTROL_EVENT_LINE_BYTES) {
					lineParts = [];
					lineBytes = 0;
					skippingOversizedLine = true;
					return;
				}
				lineParts.push(segment);
				lineBytes += segment.length;
			};
			while (readCursor < scanEnd) {
				const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, scanEnd - readCursor);
				const buffer = Buffer.alloc(toRead);
				const bytesRead = fs.readSync(fd, buffer, 0, toRead, readCursor);
				if (bytesRead <= 0) break;
				const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
				let lineStart = 0;
				for (let index = 0; index < chunk.length; index++) {
					if (chunk[index] !== 0x0a) continue;
					appendLineSegment(chunk.subarray(lineStart, index));
					if (!skippingOversizedLine && lineBytes > 0) {
						handleLine(Buffer.concat(lineParts, lineBytes).toString("utf-8"));
					}
					lineParts = [];
					lineBytes = 0;
					skippingOversizedLine = false;
					lastCompleteCursor = readCursor + index + 1;
					lineStart = index + 1;
				}
				appendLineSegment(chunk.subarray(lineStart));
				readCursor += bytesRead;
				if (skippingOversizedLine) job.controlEventCursor = readCursor;
			}
			if (lastCompleteCursor > cursor) job.controlEventCursor = lastCompleteCursor;
			else if (scanEnd < stat.size || startedFromTail) job.controlEventCursor = scanEnd;
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const closeJobWatcher = (asyncId: string) => {
		const watched = jobWatchers.get(asyncId);
		if (watched?.retryTimer) clearTimeout(watched.retryTimer);
		for (const watcher of watched?.watchers.values() ?? []) watcher.close();
		jobWatchers.delete(asyncId);
		const timer = refreshTimers.get(asyncId);
		if (timer) clearTimeout(timer);
		refreshTimers.delete(asyncId);
		runningJobIds.delete(asyncId);
	};

	const refreshJob = (job: AsyncJobState): boolean => {
		const widgetStateBefore = widgetRenderKey(job);
		let nestedRefreshFailed = false;
		const refreshNestedProjection = () => {
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
		};
		try {
			emitNewControlEvents(job);
			serviceExternalJobBridgeRequests(job.asyncDir);
			try {
				if (job.nestedRoute) reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now });
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
			refreshNestedProjection();
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
					chainStepCount: job.chainStepCount,
					parallelGroups: job.parallelGroups,
					startedAt: job.startedAt,
					sessionFile: job.sessionFile,
				},
			});
			const status = reconciliation.status ?? readStatus(job.asyncDir);
			if (status) {
				const previousStatus = job.status;
				job.status = status.state;
				if (job.status === "running") runningJobIds.add(job.asyncId);
				else runningJobIds.delete(job.asyncId);
				if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused" && job.status !== "stopped") cancelCleanup(job.asyncId);
				job.sessionId = status.sessionId ?? job.sessionId;
				job.activityState = status.activityState;
				job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
				job.currentTool = status.currentTool;
				job.currentToolStartedAt = status.currentToolStartedAt;
				job.currentPath = status.currentPath;
				job.turnCount = status.turnCount ?? job.turnCount;
				job.toolCount = status.toolCount ?? job.toolCount;
				job.steering = status.steering ?? job.steering;
				job.mode = status.mode;
				job.parentWorkflowRunId = status.parentWorkflowRunId ?? job.parentWorkflowRunId;
				job.workflowKey = status.workflowKey ?? job.workflowKey;
				job.workflow = status.workflow ?? job.workflow;
				job.currentStep = status.currentStep ?? job.currentStep;
				job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
				job.startedAt = status.startedAt ?? job.startedAt;
				if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
				if (status.steps?.length) {
					const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
					job.parallelGroups = groups.length ? groups : job.parallelGroups;
					job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
					const activeGroup = status.currentStep !== undefined
						? groups.find((group) => status.currentStep! >= group.start && status.currentStep! < group.start + group.count)
						: undefined;
					const visibleSteps = activeGroup
						? status.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count).map((step, index) => ({ ...step, index: activeGroup.start + index }))
						: status.steps.map((step, index) => ({ ...step, index }));
					job.activeParallelGroup = Boolean(activeGroup);
					job.agents = visibleSteps.map((step) => step.agent);
					job.steps = visibleSteps;
					refreshNestedProjection();
					job.stepsTotal = visibleSteps.length;
					job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
					job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
					if (status.state === "complete") job.completedSteps = visibleSteps.length;
				}
				job.sessionDir = status.sessionDir ?? job.sessionDir;
				job.outputFile = status.outputFile ?? job.outputFile;
				job.totalTokens = status.totalTokens ?? job.totalTokens;
				job.timeoutMs = status.timeoutMs ?? job.timeoutMs;
				job.deadlineAt = status.deadlineAt ?? job.deadlineAt;
				job.timedOut = status.timedOut ?? job.timedOut;
				job.stopped = status.stopped ?? job.stopped;
				job.turnBudget = status.turnBudget ?? job.turnBudget;
				job.turnBudgetExceeded = status.turnBudgetExceeded ?? job.turnBudgetExceeded;
				job.wrapUpRequested = status.wrapUpRequested ?? job.wrapUpRequested;
				job.sessionFile = status.sessionFile ?? job.sessionFile;
				if (job.status === "complete" || job.status === "failed" || job.status === "paused" || job.status === "stopped") {
					rememberFleetJob(state, job);
					if (!nestedRefreshFailed && !hasLiveNestedDescendants(job.nestedChildren) && (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
						scheduleCleanup(job.asyncId);
					}
				}
				return widgetRenderKey(job) !== widgetStateBefore;
			}
			if (job.status === "queued") {
				job.status = "running";
				job.updatedAt = Date.now();
				runningJobIds.add(job.asyncId);
			}
		} catch (error) {
			if (job.status !== "failed") {
				console.error(`Failed to read async status for '${job.asyncDir}':`, error);
				job.status = "failed";
				job.updatedAt = Date.now();
			}
			runningJobIds.delete(job.asyncId);
			rememberFleetJob(state, job);
			if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) scheduleCleanup(job.asyncId);
		}
		return widgetRenderKey(job) !== widgetStateBefore;
	};

	const scheduleJobRefresh = (asyncId: string, delayMs = EVENT_REFRESH_DEBOUNCE_MS) => {
		if (refreshTimers.has(asyncId)) return;
		const timer = setTimeout(() => {
			refreshTimers.delete(asyncId);
			const job = state.asyncJobs.get(asyncId);
			if (job && refreshJob(job)) rerenderLastWidget();
		}, delayMs);
		timer.unref?.();
		refreshTimers.set(asyncId, timer);
	};

	const watchJob = (job: AsyncJobState) => {
		const watched = jobWatchers.get(job.asyncId) ?? { watchers: new Map<string, fs.FSWatcher>() };
		const active = job.status === "queued" || job.status === "running";
		const watchPath = (watchPath: string): boolean => {
			if (watched.watchers.has(watchPath)) return true;
			const nestedEventSink = job.nestedRoute?.eventSink === watchPath;
			let watcher: fs.FSWatcher;
			try {
				watcher = fs.watch(resolveWatchPath(watchPath), (_event, file) => {
					const rawFileName = file?.toString();
					const fileName = rawFileName ?? path.basename(watchPath);
					const nestedEventFile = nestedEventSink && (!rawFileName || rawFileName.endsWith(".json") || rawFileName.endsWith(".jsonl"));
					if (fileName === "status.json" || fileName === "events.jsonl" || fileName === EXTERNAL_JOB_BRIDGE_REQUEST_DIR || fileName.endsWith(".json") || nestedEventFile) {
						scheduleJobRefresh(job.asyncId);
					}
					if (watchPath !== job.asyncDir && !nestedEventSink) {
						watcher.close();
						watched.watchers.delete(watchPath);
						watchJob(job);
					}
				});
			} catch {
				return false;
			}
			watcher.on("error", () => {
				watcher.close();
				watched.watchers.delete(watchPath);
				if (watchPath.endsWith("status.json") || nestedEventSink) watchJob(job);
			});
			watcher.unref?.();
			watched.watchers.set(watchPath, watcher);
			return true;
		};
		watchPath(job.asyncDir);
		const statusPath = path.join(job.asyncDir, "status.json");
		const hadStatusWatcher = watched.watchers.has(statusPath);
		const statusWatched = watchPath(statusPath);
		if (statusWatched && !hadStatusWatcher) scheduleJobRefresh(job.asyncId);
		watchPath(path.join(job.asyncDir, "events.jsonl"));
		watchPath(path.join(job.asyncDir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR));
		if (job.nestedRoute) watchPath(job.nestedRoute.eventSink);
		if (!statusWatched && active && !watched.retryTimer) {
			watched.retryTimer = setTimeout(() => {
				watched.retryTimer = undefined;
				const current = state.asyncJobs.get(job.asyncId);
				if (current) watchJob(current);
			}, WATCH_ATTACHMENT_RETRY_MS);
			watched.retryTimer.unref?.();
		} else if (statusWatched && watched.retryTimer) {
			clearTimeout(watched.retryTimer);
			watched.retryTimer = undefined;
		}
		if (watched.watchers.size > 0 || watched.retryTimer) jobWatchers.set(job.asyncId, watched);
		else jobWatchers.delete(job.asyncId);
	};

	const watchAsyncRoot = () => {
		if (rootWatcher) return;
		try {
			rootWatcher = fs.watch(resolveWatchPath(asyncDirRoot), (_event, file) => {
				const runDirName = file?.toString();
				for (const job of state.asyncJobs.values()) {
					if (jobWatchers.has(job.asyncId) || (runDirName && path.basename(job.asyncDir) !== runDirName)) continue;
					watchJob(job);
					if (jobWatchers.has(job.asyncId)) scheduleJobRefresh(job.asyncId);
				}
			});
			rootWatcher.on("error", () => {
				rootWatcher?.close();
				rootWatcher = undefined;
			});
			rootWatcher.unref?.();
		} catch {
			// The liveness sweep retries if the async root is not available yet.
		}
	};

	const ensurePoller = () => {
		watchAsyncRoot();
		if (state.poller) return;
		nextLivenessAt = Date.now() + livenessIntervalMs;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				rerenderLastWidget([]);
				if (state.poller) clearInterval(state.poller);
				state.poller = null;
				rootWatcher?.close();
				rootWatcher = undefined;
				return;
			}
			const now = Date.now();
			if (now >= nextLivenessAt) {
				nextLivenessAt = now + livenessIntervalMs;
				let widgetChanged = false;
				for (const job of state.asyncJobs.values()) {
					watchJob(job);
					if (refreshJob(job)) widgetChanged = true;
				}
				if (widgetChanged) rerenderLastWidget();
			}
			if (runningJobIds.size > 0) requestLastWidgetRender();
		}, Math.min(POLL_INTERVAL_MS, livenessIntervalMs));
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		if (typeof state.currentSessionId === "string" && info.sessionId !== state.currentSessionId) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0
			? rawAgents?.slice(0, firstGroupCount)
			: rawAgents;
		const sessionRoot = state.liveAsyncSessionRoots?.get(info.id);
		state.liveAsyncSessionRoots?.delete(info.id);
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			...(typeof info.cwd === "string" ? { cwd: path.resolve(info.cwd) } : {}),
			...(sessionRoot ? { sessionRoot } : {}),
			status: "queued",
			pid: typeof info.pid === "number" ? info.pid : undefined,
			...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
			mode: info.mode ?? (info.chain ? "chain" : "single"),
			description: info.goal ?? info.task,
			agents,
			chainStepCount: info.chainStepCount,
			parallelGroups: validParallelGroups,
			nestedRoute: info.nestedRoute,
			stepsTotal: firstGroupCount ?? agents?.length,
			hasParallelGroups: validParallelGroups.length > 0,
			activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
			startedAt: now,
			updatedAt: now,
			timeoutMs: info.timeoutMs,
			deadlineAt: info.deadlineAt,
			turnBudget: info.turnBudget,
			parentWorkflowRunId: info.parentWorkflowRunId,
			workflowKey: info.workflowKey,
			controlEventCursor: 0,
		});
		const job = state.asyncJobs.get(info.id)!;
		rememberFleetJob(state, job);
		watchJob(job);
		scheduleJobRefresh(info.id, 0);
		ensurePoller();
		rerenderLastWidget();
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; state?: AsyncJobState["status"]; asyncDir?: string; sessionId?: string; stopped?: boolean };
		if (typeof state.currentSessionId === "string" && result.sessionId !== state.currentSessionId) return;
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		let nestedRefreshFailed = false;
		if (job) {
			job.status = result.state ?? (result.success ? "complete" : "failed");
			runningJobIds.delete(asyncId);
			job.stopped = result.stopped ?? job.stopped;
			job.updatedAt = Date.now();
			if (result.asyncDir && result.asyncDir !== job.asyncDir) {
				closeJobWatcher(asyncId);
				job.asyncDir = result.asyncDir;
				watchJob(job);
			}
			try {
				updateAsyncJobNestedProjection(job);
			} catch (error) {
				nestedRefreshFailed = true;
				console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
			}
		}
		if (job) rememberFleetJob(state, job);
		rerenderLastWidget();
		if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren)) scheduleCleanup(asyncId);
	};

	const dispose = () => {
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		rootWatcher?.close();
		rootWatcher = undefined;
		for (const asyncId of jobWatchers.keys()) closeJobWatcher(asyncId);
		for (const timer of refreshTimers.values()) clearTimeout(timer);
		refreshTimers.clear();
		runningJobIds.clear();
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		dispose();
		for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.fleetJobs?.clear();
		state.foregroundControls?.clear();
		state.liveAsyncSessionRoots?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	const restoreActiveJobs = (ctx?: ExtensionContext) => {
		if (ctx?.hasUI) state.lastUiContext = ctx;
		if (!state.currentSessionId) return;
		let runs: AsyncRunSummary[];
		try {
			runs = listAsyncRuns(asyncDirRoot, { states: ["queued", "running"], sessionId: state.currentSessionId, resultsDir, kill: options.kill, now: options.now });
		} catch (error) {
			console.error(`Failed to restore active async jobs from '${asyncDirRoot}':`, error);
			return;
		}
		for (const run of runs) {
			const job = summaryToJob(run);
			state.asyncJobs.set(run.id, job);
			if (job.status === "running") runningJobIds.add(job.asyncId);
			rememberFleetJob(state, job);
			watchJob(job);
		}
		if (runs.length === 0) return;
		ensurePoller();
		rerenderLastWidget();
	};

	return { ensurePoller, refreshWidget, handleStarted, handleComplete, resetJobs, restoreActiveJobs, dispose };
}
