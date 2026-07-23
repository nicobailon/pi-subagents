import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	type IntercomEventBus,
	type NestedRunSummary,
	type SubagentResultIntercomChild,
	type SubagentState,
} from "../../shared/types.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	compactNestedResultChildren,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.ts";
import { resolveWatchPath } from "../../shared/utils.ts";
import type { CompletionNotifier, CompletionNotification } from "./notify.ts";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;
const RETRY_DELAY_MS = 100;

type ResultWatcherFs = Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync" | "readdirSync" | "mkdirSync" | "realpathSync" | "watch">;

type ResultWatcherTimers = {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};

type ResultWatcherDeps = {
	fs?: ResultWatcherFs;
	timers?: ResultWatcherTimers;
	notifier?: Pick<CompletionNotifier, "deliver">;
};

type ResultFileChild = {
	agent?: string;
	output?: string;
	error?: string;
	success?: boolean;
	state?: string;
	stopped?: boolean;
	sessionFile?: string;
	artifactPaths?: { outputPath?: string };
	intercomTarget?: string;
	children?: unknown;
};

type ResultFileData = CompletionNotification & {
	runId?: string;
	mode?: string;
	results?: ResultFileChild[];
	nestedChildren?: unknown;
	asyncDir?: string;
	intercomTarget?: string;
};

function sanitizeNestedResultChildren(value: unknown, resultPath: string, label: string): NestedRunSummary[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		console.error(`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`);
		return undefined;
	}
	const children = value.map((child) => sanitizeSummary(child)).filter((child): child is NestedRunSummary => Boolean(child));
	if (children.length !== value.length) {
		console.error(`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`);
	}
	return children.length ? children : undefined;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
}

function isNotFound(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function shouldPoll(error: unknown): boolean {
	const code = errorCode(error);
	return code === "EMFILE" || code === "ENOSPC";
}

/**
 * Watches persisted async results for the session currently owned by this
 * runtime. `stopResultWatcher()` revokes ownership before closing resources,
 * so old callbacks can never emit or delete after reload/session replacement.
 */
export function createResultWatcher(
	pi: { events: IntercomEventBus },
	state: SubagentState,
	resultsDir: string,
	completionTtlMs: number,
	deps: ResultWatcherDeps = {},
): {
	startResultWatcher: () => void;
	primeExistingResults: (options?: { triggerTurn?: boolean }) => void;
	stopResultWatcher: () => void;
} {
	const fsApi = deps.fs ?? fs;
	const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
	const notifier = deps.notifier ?? { deliver: async () => true };
	const pendingTriggerTurn = new Map<string, boolean>();
	const processing = new Set<string>();
	let deliveryActive = true;
	let deliveryEpoch = 0;
	// The sole in-memory ownership lease. It is acquired for one active session
	// and revoked before the watcher, queues, or callbacks are torn down.
	let activeSessionId: string | null = null;

	const ownsSession = (sessionId: string, epoch: number) => {
		if (!deliveryActive || epoch !== deliveryEpoch) return false;
		if (!activeSessionId && state.currentSessionId) activeSessionId = state.currentSessionId;
		return activeSessionId === sessionId && state.currentSessionId === sessionId;
	};

	const scheduleResult = (file: string, triggerTurn: boolean, delayMs = 0) => {
		const pendingMode = pendingTriggerTurn.get(file);
		pendingTriggerTurn.set(file, pendingMode === false || !triggerTurn ? false : true);
		state.resultFileCoalescer.schedule(file, delayMs);
	};

	const handleResult = async (file: string, triggerTurn: boolean) => {
		const resultPath = path.join(resultsDir, file);
		if (processing.has(file) || !fsApi.existsSync(resultPath)) return;
		processing.add(file);
		try {
			const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8")) as ResultFileData;
			if (typeof data.sessionId !== "string" || !data.sessionId) return;
			const epoch = deliveryEpoch;
			if (!ownsSession(data.sessionId, epoch)) return;

			const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
			const hasExplicitNestedChildren = data.nestedChildren !== undefined;
			let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
			if (!nestedChildren?.length && !hasExplicitNestedChildren) {
				try {
					nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
				} catch (error) {
					console.error(`Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`, error);
					scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
					return;
				}
			}

			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (state.completionSeen.has(completionKey)) {
				if (!ownsSession(data.sessionId, epoch) || !fsApi.existsSync(resultPath)) return;
				try {
					fsApi.unlinkSync(resultPath);
				} catch (error) {
					if (!isNotFound(error)) {
						console.error(`Failed to remove delivered subagent result '${resultPath}'; will retry:`, error);
						scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
					}
				}
				return;
			}

			const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
			const resultChildren: ResultFileChild[] = hasResultChildren
				? data.results!
				: [{ agent: data.agent ?? undefined, output: data.summary, success: data.success }];
			const normalizedChildren = attachNestedChildrenToResultChildren(runId, resultChildren.map((result = {}, index): SubagentResultIntercomChild => {
				const baseOutput = result.output ?? data.summary;
				const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
				const output = hasRealOutput ? baseOutput : "(no output)";
				const summary = result.success === false && result.error
					? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
					: output;
				const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
				const childNestedChildren = sanitizeNestedResultChildren(result.children, resultPath, `results[${index}].children`);
				const childState = result.state === "paused" || result.state === "stopped"
					? result.state
					: result.stopped === true
						? "stopped"
						: data.state === "paused" || (!hasResultChildren && (data.state === "stopped" || typeof result.success !== "boolean"))
							? data.state
							: undefined;
				return {
					agent: result.agent ?? data.agent ?? `step-${index + 1}`,
					status: resolveSubagentResultStatus({ success: result.success, state: childState }),
					summary,
					index,
					artifactPath: result.artifactPaths?.outputPath,
					...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath) ? { sessionPath } : {}),
					...(result.intercomTarget ? { intercomTarget: result.intercomTarget } : {}),
					...(childNestedChildren ? { children: childNestedChildren } : {}),
				};
			}), nestedChildren);

			const intercomTarget = data.intercomTarget?.trim();
			if (intercomTarget && triggerTurn) {
				const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
					? data.mode
					: resultChildren.length > 1 ? "chain" : "single";
				const delivered = await deliverSubagentResultIntercomEvent(pi.events, buildSubagentResultIntercomPayload({
					to: intercomTarget,
					runId,
					mode,
					source: "async",
					children: normalizedChildren,
					asyncId: data.id,
					asyncDir: data.asyncDir,
				}));
				if (!ownsSession(data.sessionId, epoch)) return;
				if (!delivered) console.error(`Subagent async grouped result intercom delivery was not acknowledged for '${resultPath}'.`);
			}

			const accepted = await notifier.deliver({
				...data,
				id: data.id ?? runId,
				runId,
				triggerTurn,
				...(nestedChildren?.length ? { nestedChildren } : {}),
				...(Array.isArray(data.results) ? {
					results: hasResultChildren ? normalizedChildren.map((child, index) => ({
						...data.results![index],
						agent: child.agent,
						status: child.status,
						summary: child.summary,
						index: child.index,
						artifactPath: child.artifactPath,
						sessionPath: child.sessionPath,
						children: child.children,
					})) : [],
				} : {}),
			});
			if (!ownsSession(data.sessionId, epoch)) return;
			if (!accepted) {
				scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
				return;
			}
			markSeenWithTtl(state.completionSeen, completionKey, Date.now(), completionTtlMs);
			try {
				pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
					...data,
					runId,
					triggerTurn,
					...(nestedChildren?.length ? { nestedChildren } : {}),
					...(Array.isArray(data.results) ? {
						results: hasResultChildren ? normalizedChildren.map((child, index) => ({
							...data.results![index],
							agent: child.agent,
							status: child.status,
							summary: child.summary,
							index: child.index,
							artifactPath: child.artifactPath,
							sessionPath: child.sessionPath,
							children: child.children,
						})) : [],
					} : {}),
				});
			} catch (error) {
				console.error(`Completion observer failed for '${resultPath}':`, error);
			}
			if (!ownsSession(data.sessionId, epoch) || !fsApi.existsSync(resultPath)) return;
			try {
				fsApi.unlinkSync(resultPath);
			} catch (error) {
				if (!isNotFound(error)) {
					console.error(`Failed to remove delivered subagent result '${resultPath}'; will retry:`, error);
					scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
				}
			}
		} catch (error) {
			if (!isNotFound(error)) console.error(`Failed to process subagent result file '${resultPath}':`, error);
		} finally {
			processing.delete(file);
		}
	};

	state.resultFileCoalescer = createFileCoalescer((file) => {
		const triggerTurn = pendingTriggerTurn.get(file) !== false;
		pendingTriggerTurn.delete(file);
		void handleResult(file, triggerTurn);
	}, 50);

	const primeExistingResults = (options: { triggerTurn?: boolean } = {}) => {
		try {
			const triggerTurn = options.triggerTurn !== false;
			fsApi.readdirSync(resultsDir)
				.filter((f) => f.endsWith(".json"))
				.forEach((file) => scheduleResult(file, triggerTurn));
		} catch (error) {
			if (!isNotFound(error)) console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
		}
	};

	const startPolling = (reason: unknown) => {
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) return;
		console.error(`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${errorCode(reason) ?? "unknown error"}).`);
		primeExistingResults();
		state.watcherRestartTimer = timers.setInterval(primeExistingResults, POLL_INTERVAL_MS);
		state.watcherRestartTimer.unref?.();
	};

	const scheduleRestart = () => {
		if (state.watcherRestartTimer) return;
		state.watcherRestartTimer = timers.setTimeout(() => {
			state.watcherRestartTimer = null;
			try {
				fsApi.mkdirSync(resultsDir, { recursive: true });
				startResultWatcher();
			} catch (error) {
				if (shouldPoll(error)) return startPolling(error);
				console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
				scheduleRestart();
			}
		}, WATCHER_RESTART_DELAY_MS);
		state.watcherRestartTimer.unref?.();
	};

	const startResultWatcher = () => {
		if (state.watcher) return;
		activeSessionId = state.currentSessionId;
		deliveryActive = true;
		deliveryEpoch += 1;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
			state.watcherRestartTimer = null;
		}
		try {
			const watchDir = resolveWatchPath(resultsDir, fsApi.realpathSync.native);
			state.watcher = fsApi.watch(watchDir, (event, file) => {
				if (event !== "rename" || !file) return;
				const fileName = file.toString();
				if (fileName.endsWith(".json")) scheduleResult(fileName, true);
			});
			state.watcher.on("error", (error) => {
				if (shouldPoll(error)) return startPolling(error);
				console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
				state.watcher?.close();
				state.watcher = null;
				scheduleRestart();
			});
			state.watcher.unref?.();
		} catch (error) {
			if (shouldPoll(error)) return startPolling(error);
			console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
			state.watcher = null;
			scheduleRestart();
		}
	};

	const stopResultWatcher = () => {
		deliveryActive = false;
		activeSessionId = null;
		deliveryEpoch += 1;
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
		}
		state.watcherRestartTimer = null;
		state.resultFileCoalescer.clear();
		pendingTriggerTurn.clear();
		processing.clear();
	};

	return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
