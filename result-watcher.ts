import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.js";
import { createFileCoalescer } from "./file-coalescer.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "./types.js";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;

type ResultWatcherFs = Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync" | "readdirSync" | "mkdirSync" | "watch">;

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
	// fs.watch can throw EMFILE/ENOSPC when the host exhausts file
	// descriptors or inotify resources. Async completions are already
	// persisted as result files, so polling is a safe degradation path.
	return code === "EMFILE" || code === "ENOSPC";
}

export function createResultWatcher(
	pi: ExtensionAPI,
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

	const handleResult = (file: string) => {
		const resultPath = path.join(resultsDir, file);
		if (!fsApi.existsSync(resultPath)) return;
		try {
			const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8").toString()) as {
				sessionId?: string;
				cwd?: string;
			};
			if (data.sessionId && data.sessionId !== state.currentSessionId) return;
			if (!data.sessionId && data.cwd && data.cwd !== state.baseCwd) return;

			const now = Date.now();
			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
				fsApi.unlinkSync(resultPath);
				return;
			}

			pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, data);
			fsApi.unlinkSync(resultPath);
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to process subagent result file '${resultPath}':`, error);
		}
	};

	state.resultFileCoalescer = createFileCoalescer(handleResult, 50);

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
			state.watcher = fsApi.watch(resultsDir, (ev, file) => {
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
