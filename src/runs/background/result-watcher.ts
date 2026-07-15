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

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;

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

type ResultFileData = {
	id?: string;
	runId?: string;
	agent?: string;
	success?: boolean;
	state?: string;
	mode?: string;
	summary?: string;
	results?: ResultFileChild[];
	nestedChildren?: unknown;
	sessionId?: string;
	cwd?: string;
	sessionFile?: string;
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

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function isNotFoundError(error: unknown): boolean {
	return getErrorCode(error) === "ENOENT";
}

function shouldFallBackToPolling(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === "EMFILE" || code === "ENOSPC";
}


export function createResultWatcher(
	pi: { events: IntercomEventBus },
	state: SubagentState,
	resultsDir: string,
	completionTtlMs: number,
	deps: ResultWatcherDeps = {},
): {
	startResultWatcher: () => void;
	primeExistingResults: () => void;
	stopResultWatcher: () => void;
} {
	const fsApi = deps.fs ?? fs;
	const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };

	const handleResult = async (file: string) => {
		const resultPath = path.join(resultsDir, file);
		if (!fsApi.existsSync(resultPath)) return;
		try {
			const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8")) as ResultFileData;
			if (typeof data.sessionId !== "string" || data.sessionId !== state.currentSessionId) return;

			const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
			const hasExplicitNestedChildren = data.nestedChildren !== undefined;
			let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
			if (!nestedChildren?.length && !hasExplicitNestedChildren) {
				try {
					nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
				} catch (error) {
					console.error(`Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`, error);
					return;
				}
			}
			const now = Date.now();
			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
				fsApi.unlinkSync(resultPath);
				return;
			}

			const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
			const resultChildren = hasResultChildren
				? data.results!
				: [{
					agent: data.agent,
					output: data.summary,
					success: data.success,
				}];
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
					status: resolveSubagentResultStatus({
						success: result.success,
						state: childState,
					}),
					summary,
					index,
					artifactPath: result.artifactPaths?.outputPath,
					...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath) ? { sessionPath } : {}),
					...(result.intercomTarget ? { intercomTarget: result.intercomTarget } : {}),
					...(childNestedChildren ? { children: childNestedChildren } : {}),
				};
			}), nestedChildren);

			const intercomTarget = data.intercomTarget?.trim();
			if (intercomTarget) {
				const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
					? data.mode
					: resultChildren.length > 1 ? "chain" : "single";
				const payload = buildSubagentResultIntercomPayload({
					to: intercomTarget,
					runId,
					mode,
					source: "async",
					children: normalizedChildren,
					asyncId: data.id,
					asyncDir: data.asyncDir,
				});
				const delivered = await deliverSubagentResultIntercomEvent(pi.events, payload);
				if (!delivered) {
					console.error(`Subagent async grouped result intercom delivery was not acknowledged for '${resultPath}'.`);
				}
			}

			pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				...data,
				runId,
				...(nestedChildren?.length ? { nestedChildren } : {}),
				...(Array.isArray(data.results) ? {
					results: hasResultChildren
						? normalizedChildren.map((child, index) => ({
							...data.results![index],
							agent: child.agent,
							status: child.status,
							summary: child.summary,
							index: child.index,
							artifactPath: child.artifactPath,
							sessionPath: child.sessionPath,
							children: child.children,
						}))
						: [],
				} : {}),
			});
			fsApi.unlinkSync(resultPath);
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to process subagent result file '${resultPath}':`, error);
		}
	};

	state.resultFileCoalescer = createFileCoalescer((file) => {
		void handleResult(file);
	}, 50);

	const primeExistingResults = () => {
		try {
			fsApi.readdirSync(resultsDir)
				.filter((f) => f.endsWith(".json"))
				.forEach((file) => state.resultFileCoalescer.schedule(file, 0));
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
		}
	};

	const startPollingFallback = (reason: unknown) => {
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) return;

		console.error(
			`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`,
		);
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
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
				scheduleRestart();
			}
		}, WATCHER_RESTART_DELAY_MS);
		state.watcherRestartTimer.unref?.();
	};

	const startResultWatcher = () => {
		if (state.watcher) return;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
			state.watcherRestartTimer = null;
		}
		try {
			const watchDir = resolveWatchPath(resultsDir, fsApi.realpathSync.native);
			state.watcher = fsApi.watch(watchDir, (ev, file) => {
				if (ev !== "rename" || !file) return;
				const fileName = file.toString();
				if (!fileName.endsWith(".json")) return;
				state.resultFileCoalescer.schedule(fileName);
			});
			state.watcher.on("error", (error) => {
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
				state.watcher?.close();
				state.watcher = null;
				scheduleRestart();
			});
			state.watcher.unref?.();
		} catch (error) {
			if (shouldFallBackToPolling(error)) {
				startPollingFallback(error);
				return;
			}
			console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
			state.watcher = null;
			scheduleRestart();
		}
	};

	const stopResultWatcher = () => {
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
		}
		state.watcherRestartTimer = null;
		state.resultFileCoalescer.clear();
	};

	return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
