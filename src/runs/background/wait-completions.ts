import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactPaths, SubagentState, WaitCompletion, WaitCompletionChild } from "../../shared/types.ts";
import type { AsyncRunSummary } from "./async-status.ts";
import { readCompletionReplay, writeCompletionReplay } from "./completion-replay.ts";

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Project a terminal result payload into the slim shape that is safe to surface in
 * tool_result details: run identity, per-child outcome, and the artifact trail.
 * Output text is deliberately excluded — it already travels in the tool result
 * content, and duplicating it in details would double the payload for every wait.
 */
export function toWaitCompletion(data: Record<string, unknown>, runId: string): WaitCompletion {
	const results = Array.isArray(data.results)
		? data.results.flatMap((entry): WaitCompletionChild[] => {
			if (entry === null || typeof entry !== "object") return [];
			const child = entry as Record<string, unknown>;
			const outputState = child.outputState === "present" || child.outputState === "absent" || child.outputState === "unknown"
				? child.outputState
				: undefined;
			const artifactPaths = child.artifactPaths !== null && typeof child.artifactPaths === "object"
				? (child.artifactPaths as Partial<ArtifactPaths>)
				: undefined;
			const agent = asNonEmptyString(child.agent);
			const childRunId = asNonEmptyString(child.runId);
			const error = asNonEmptyString(child.error);
			const model = asNonEmptyString(child.model);
			return [{
				...(agent ? { agent } : {}),
				...(childRunId ? { runId: childRunId } : {}),
				...(typeof child.success === "boolean" ? { success: child.success } : {}),
				...(outputState ? { outputState } : {}),
				...(error ? { error } : {}),
				...(model ? { model } : {}),
				...(artifactPaths ? { artifactPaths } : {}),
			}];
		})
		: undefined;
	const agent = asNonEmptyString(data.agent);
	const mode = asNonEmptyString(data.mode);
	const state = asNonEmptyString(data.state);
	return {
		runId,
		...(agent ? { agent } : {}),
		...(mode ? { mode } : {}),
		...(state ? { state } : {}),
		...(typeof data.success === "boolean" ? { success: data.success } : {}),
		...(results && results.length > 0 ? { results } : {}),
	};
}

/**
 * Record a consumed terminal payload for later surfacing by subagent_wait, pruning
 * stale entries with the same TTL that dedupes completion notifications. The result
 * file is deleted after delivery, so this record is the only in-process source once
 * the watcher has consumed it.
 */
export function recordWaitCompletion(
	state: SubagentState,
	runId: string,
	data: Record<string, unknown>,
	now: number,
	ttlMs: number,
	persistence?: { resultsDir: string; sessionId: string },
): void {
	const store = state.completedResults ??= new Map();
	for (const [key, entry] of store) {
		if (now - entry.seenAt > ttlMs) store.delete(key);
	}
	let completion = toWaitCompletion(data, runId);
	if (persistence) {
		try {
			completion = writeCompletionReplay({
				...persistence,
				runId,
				completion,
				data,
				now,
				ttlMs,
			}).completion;
		} catch (error) {
			console.error(`Failed to persist completion replay for '${runId}':`, error);
		}
	}
	store.set(runId, { seenAt: now, completion });
}

/**
 * Terminal payloads for the runs a wait covered: the watcher's in-memory record
 * first, then the not-yet-consumed result file. Result files are written atomically,
 * so a direct read never observes a torn write; the read is deliberately read-only —
 * the watcher owns notification and cleanup.
 */
export function collectWaitCompletions(terminal: AsyncRunSummary[], state: SubagentState, resultsDir: string): WaitCompletion[] | undefined {
	if (terminal.length === 0) return undefined;
	const completions: WaitCompletion[] = [];
	for (const run of terminal) {
		const recorded = state.completedResults?.get(run.id);
		if (recorded) {
			completions.push(recorded.completion);
			continue;
		}
		const resultPath = path.join(resultsDir, `${run.id}.json`);
		try {
			const raw = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as Record<string, unknown>;
			completions.push(toWaitCompletion(raw, run.id));
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				throw new Error(`Failed to read subagent result '${resultPath}': ${errorMessage(error)}`, {
					cause: error instanceof Error ? error : undefined,
				});
			}
			// The watcher may have consumed the file between the store check and the
			// read. Prefer its in-memory record, then the durable replay written before
			// result cleanup so watcher reloads do not lose completion details.
			const late = state.completedResults?.get(run.id);
			if (late) {
				completions.push(late.completion);
				continue;
			}
			try {
				const replay = readCompletionReplay(resultsDir, run.id, { sessionId: run.sessionId });
				if (replay) completions.push(replay.completion);
			} catch (replayError) {
				throw new Error(`Failed to read completion replay for '${run.id}': ${errorMessage(replayError)}`, {
					cause: replayError instanceof Error ? replayError : undefined,
				});
			}
		}
	}
	return completions.length > 0 ? completions : undefined;
}
