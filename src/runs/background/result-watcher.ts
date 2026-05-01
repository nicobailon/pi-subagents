import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	type IntercomEventBus,
	type SubagentState,
} from "../../shared/types.ts";
import {
	buildSubagentResultIntercomPayload,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";

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
			const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8")) as {
				id?: string;
				runId?: string;
				agent?: string;
				success?: boolean;
				state?: string;
				mode?: string;
				summary?: string;
				results?: Array<{
					agent?: string;
					output?: string;
					error?: string;
					success?: boolean;
					artifactPaths?: { outputPath?: string };
					intercomTarget?: string;
				}>;
				sessionId?: string;
				cwd?: string;
				sessionFile?: string;
				asyncDir?: string;
				intercomTarget?: string;
			};
			if (data.sessionId && data.sessionId !== state.currentSessionId) return;
			if (!data.sessionId && data.cwd && data.cwd !== state.baseCwd) return;

			const now = Date.now();
			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
				fsApi.unlinkSync(resultPath);
				return;
			}

			const intercomTarget = data.intercomTarget?.trim();
			if (intercomTarget) {
				const childResults = Array.isArray(data.results) && data.results.length > 0
					? data.results
					: [{
						agent: data.agent,
						output: data.summary,
						success: data.success,
					}];
				const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
				const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
					? data.mode
					: childResults.length > 1 ? "chain" : "single";
				const payload = buildSubagentResultIntercomPayload({
					to: intercomTarget,
					runId,
					mode,
					source: "async",
					children: childResults.map((result = {}, index) => {
						const baseOutput = result.output ?? data.summary;
						const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
						const output = hasRealOutput ? baseOutput : "(no output)";
						const summary = result.success === false && result.error
							? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
							: output;
						return {
							agent: result.agent ?? data.agent ?? `step-${index + 1}`,
							status: resolveSubagentResultStatus({
								success: result.success,
								state: data.state === "paused" || typeof result.success !== "boolean" ? data.state : undefined,
							}),
							summary,
							index,
							artifactPath: result.artifactPaths?.outputPath,
							sessionPath: data.sessionFile,
							intercomTarget: result.intercomTarget,
						};
					}),
					asyncId: data.id,
					asyncDir: data.asyncDir,
				});
				const delivered = await deliverSubagentResultIntercomEvent(pi.events, payload);
				if (!delivered) {
					console.error(`Subagent async grouped result intercom delivery was not acknowledged for '${resultPath}'.`);
				}
			}

			pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, data);
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
