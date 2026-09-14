import * as fs from "node:fs";
import type { ArtifactPaths, SubagentState, Usage, WaitCompletion, WaitCompletionChild } from "../../shared/types.ts";
import type { AsyncRunSummary } from "./async-status.ts";
import { readCompletionReplay, writeCompletionReplay } from "./completion-replay.ts";
import { fallbackResultPayloadPathForSessionRun, resultFilePath, resultPayloadMatchesSessionRun, resultPayloadPathForSessionRun } from "./result-files.ts";
import { parseWorkflowChildSummary } from "../../workflows/workflow-child-summary.ts";
import { projectTimeoutRecovery } from "../shared/mutation-evidence.ts";

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function projectedUsage(value: unknown): Usage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const input = nonNegativeNumber(record.input);
	const output = nonNegativeNumber(record.output);
	const cacheRead = nonNegativeNumber(record.cacheRead);
	const cacheWrite = nonNegativeNumber(record.cacheWrite);
	const cost = nonNegativeNumber(record.cost);
	const turns = nonNegativeNumber(record.turns);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || cost === undefined || turns === undefined || !Number.isSafeInteger(turns)) return undefined;
	return { input, output, cacheRead, cacheWrite, cost, turns };
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function isAccessDenied(error: unknown): boolean {
	const code = errorCode(error);
	return code === "EPERM" || code === "EACCES";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const STRUCTURED_OUTPUT_INLINE_LIMIT_BYTES = 4 * 1024;

function waitResultPayloadCandidate(resultsDir: string, run: AsyncRunSummary): string {
	const publicPath = resultFilePath(resultsDir, run.id);
	if (!run.sessionId) return publicPath;
	try {
		const indexedPath = resultPayloadPathForSessionRun(resultsDir, run.sessionId, run.id);
		return indexedPath ?? publicPath;
	} catch (error) {
		if (!isAccessDenied(error)) throw error;
		const pendingPath = fallbackResultPayloadPathForSessionRun(resultsDir, run.sessionId, run.id);
		return pendingPath ?? publicPath;
	}
}

function readWaitResultPayload(candidatePath: string, run: AsyncRunSummary): Record<string, unknown> | undefined {
	// A terminal run without session ownership cannot safely claim a payload.
	if (!run.sessionId) return undefined;
	const payload: unknown = JSON.parse(fs.readFileSync(candidatePath, "utf-8"));
	if (!resultPayloadMatchesSessionRun(payload, run.sessionId, run.id)) return undefined;
	return payload as Record<string, unknown>;
}

export function projectStructuredOutput(value: unknown): unknown {
	if (value === undefined) return undefined;
	const serialized = JSON.stringify(value);
	if (typeof serialized !== "string") throw new Error("Structured output must be JSON-serializable");
	return Buffer.byteLength(serialized, "utf8") <= STRUCTURED_OUTPUT_INLINE_LIMIT_BYTES ? JSON.parse(serialized) : undefined;
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
			const usage = projectedUsage(child.usage);
			const sessionFile = asNonEmptyString(child.sessionFile);
			const error = asNonEmptyString(child.error);
			const model = asNonEmptyString(child.model);
			const structuredOutput = projectStructuredOutput(child.structuredOutput);
			const structuredOutputPath = asNonEmptyString(child.structuredOutputPath);
			const contextOverflow = child.contextOverflow === true;
			const timeoutRecovery = projectTimeoutRecovery(child.timeoutRecovery);
			return [{
				...(agent ? { agent } : {}),
				...(childRunId ? { runId: childRunId } : {}),
				...(usage ? { usage } : {}),
				...(sessionFile ? { sessionFile } : {}),
				...(typeof child.success === "boolean" ? { success: child.success } : {}),
				...(outputState ? { outputState } : {}),
				...(structuredOutput !== undefined ? { structuredOutput } : {}),
				...(structuredOutputPath ? { structuredOutputPath } : {}),
				...(error ? { error } : {}),
				...(model ? { model } : {}),
				...(contextOverflow ? { contextOverflow: true } : {}),
				...(artifactPaths ? { artifactPaths } : {}),
				...(timeoutRecovery ? { timeoutRecovery } : {}),
			}];
		})
		: undefined;
	const agent = asNonEmptyString(data.agent);
	const receipt = data.workflowReceipt;
	const workflowReceiptPath = receipt && typeof receipt === "object" && !Array.isArray(receipt)
		? asNonEmptyString((receipt as Record<string, unknown>).path) : undefined;
	const mode = asNonEmptyString(data.mode);
	const state = asNonEmptyString(data.state);
	const workflowChildren = parseWorkflowChildSummary(data.workflowChildren);
	if (workflowChildren && workflowChildren.workflowRunId !== runId) throw new Error("workflowChildren.workflowRunId does not match its completion run id.");
	return {
		runId,
		...(agent ? { agent } : {}),
		...(mode ? { mode } : {}),
		...(workflowReceiptPath ? { workflowReceiptPath } : {}),
		...(state ? { state } : {}),
		...(typeof data.success === "boolean" ? { success: data.success } : {}),
		...(results && results.length > 0 ? { results } : {}),
		...(workflowChildren ? { workflowChildren } : {}),
	};
}

/**
 * Record a consumed terminal payload for later surfacing by bg_wait, pruning
 * stale entries with the same TTL that dedupes completion notifications. The result
 * file is deleted after durable replay succeeds, so this record is the in-process
 * source once the watcher has consumed it. Payload ownership must be explicit and
 * agree with persistence ownership. Returns whether that replay is durable.
 */
export function recordWaitCompletion(
	state: SubagentState,
	runId: string,
	data: Record<string, unknown>,
	now: number,
	ttlMs: number,
	persistence?: { resultsDir: string; sessionId: string },
): boolean {
	const sessionId = asNonEmptyString(data.sessionId);
	if (!sessionId || !resultPayloadMatchesSessionRun(data, sessionId, runId)) return false;
	if (persistence && persistence.sessionId !== sessionId) return false;
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
	store.set(runId, { sessionId, seenAt: now, completion });
	return completion.archivePath !== undefined;
}

/**
 * Terminal payloads for the runs a wait covered: the watcher's in-memory record
 * first, then the not-yet-consumed result file. Result files are written atomically,
 * so a direct read never observes a torn write; the read is deliberately read-only —
 * the watcher owns notification and cleanup.
 */
export function collectWaitCompletions(terminal: AsyncRunSummary[], state: SubagentState, resultsDir: string, onReference?: (text: string) => void): WaitCompletion[] | undefined {
	if (terminal.length === 0) return undefined;
	const completions: WaitCompletion[] = [];
	const add = (completion: WaitCompletion, resultPath?: string): void => {
		completions.push(completion);
		// Tool details are not model context. Publish the evidence address in content
		// without copying potentially unbounded reviewer output into every wait.
		const reference = completion.archivePath ?? resultPath;
		if (reference) onReference?.(`Result [${completion.runId}]: ${reference}`);
	};
	for (const run of terminal) {
		const recorded = state.completedResults?.get(run.id);
		if (recorded && recorded.sessionId === run.sessionId) {
			if (recorded.completion.archivePath) {
				add(recorded.completion);
				continue;
			}
			try {
				const candidatePath = waitResultPayloadCandidate(resultsDir, run);
				if (!readWaitResultPayload(candidatePath, run)) {
					const replay = readCompletionReplay(resultsDir, run.id, { sessionId: run.sessionId });
					add(replay?.completion ?? recorded.completion);
					continue;
				}
				add(recorded.completion, candidatePath);
				continue;
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
			const replay = readCompletionReplay(resultsDir, run.id, { sessionId: run.sessionId });
			add(replay?.completion ?? recorded.completion);
			continue;
		}
		let candidatePath: string;
		try {
			candidatePath = waitResultPayloadCandidate(resultsDir, run);
		} catch (error) {
			const publicResultPath = resultFilePath(resultsDir, run.id);
			throw new Error(`Failed to read subagent result '${publicResultPath}': ${errorMessage(error)}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		try {
			const payload = readWaitResultPayload(candidatePath, run);
			if (!payload) {
				const replay = readCompletionReplay(resultsDir, run.id, { sessionId: run.sessionId });
				if (replay) add(replay.completion);
				continue;
			}
			add(toWaitCompletion(payload, run.id), candidatePath);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				throw new Error(`Failed to read subagent result '${candidatePath}': ${errorMessage(error)}`, {
					cause: error instanceof Error ? error : undefined,
				});
			}
			// The watcher may have consumed the file between the store check and the
			// read. Prefer its in-memory record, then the durable replay written before
			// result cleanup so watcher reloads do not lose completion details.
			const late = state.completedResults?.get(run.id);
			if (late && late.sessionId === run.sessionId) {
				add(late.completion);
				continue;
			}
			try {
				const replay = readCompletionReplay(resultsDir, run.id, { sessionId: run.sessionId });
				if (replay) add(replay.completion);
			} catch (replayError) {
				throw new Error(`Failed to read completion replay for '${run.id}': ${errorMessage(replayError)}`, {
					cause: replayError instanceof Error ? replayError : undefined,
				});
			}
		}
	}
	return completions.length > 0 ? completions : undefined;
}
