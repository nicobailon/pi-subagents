import * as fs from "node:fs";
import type { ArtifactPaths, SubagentState, Usage, WaitCompletion, WaitCompletionChild } from "../../shared/types.ts";
import type { AsyncRunSummary } from "./async-status.ts";
import { readCompletionArchive, readCompletionReplay, writeCompletionReplay } from "./completion-replay.ts";
import { fallbackResultPayloadPathForSessionRun, resultFilePath, resultPayloadPathForSessionRun } from "./result-files.ts";
import { parseWorkflowChildSummary } from "../../workflows/workflow-child-summary.ts";
import { projectTimeoutRecovery } from "../shared/mutation-evidence.ts";
import { utf8Tail } from "../../shared/utf8.ts";

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

export function projectStructuredOutput(value: unknown): unknown {
	if (value === undefined) return undefined;
	const serialized = JSON.stringify(value);
	if (typeof serialized !== "string") throw new Error("Structured output must be JSON-serializable");
	return Buffer.byteLength(serialized, "utf8") <= STRUCTURED_OUTPUT_INLINE_LIMIT_BYTES ? JSON.parse(serialized) : undefined;
}

/** Bound the whole delivery while retaining exact references for every truncated result. */
export function boundWaitContent(text: string, completions: WaitCompletion[] = [], limit = 50 * 1024): string {
	if (Buffer.byteLength(text, "utf8") <= limit) return text;
	const references = JSON.stringify(completions.map(({ runId, archivePath, workflowReceiptPath, results }) => ({
		runId, archivePath, workflowReceiptPath,
		results: results?.map(({ agent, artifactPaths, sessionFile, structuredOutputPath }) => ({ agent, artifactPaths, sessionFile, structuredOutputPath })),
	})));
	if (Buffer.byteLength(references, "utf8") > limit / 2) throw new Error("Background result artifact references exceed the delivery limit; inspect individual run status before completing.");
	const suffix = `\n[Result data truncated; reconcile the full outputs using these exact run/artifact references before completing.]\n${references}`;
	return utf8Tail(text, limit - Buffer.byteLength(suffix, "utf8")).text + suffix;
}

function hasCompletionOutput(data: Record<string, unknown>): boolean {
	const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
	const saved = (value: unknown) => {
		if (!nonempty(value)) return false;
		try { return fs.statSync(value as string).isFile(); } catch { return false; }
	};
	const children = Array.isArray(data.results) && data.results.length ? data.results : [data];
	return children.every((value) => {
		if (!value || typeof value !== "object") return false;
		const child = value as Record<string, unknown>;
		return nonempty(child.output) || nonempty(child.summary) || child.structuredOutput !== undefined
			|| saved(child.structuredOutputPath) || saved(child.sessionFile)
			|| saved((child.artifactPaths as Partial<ArtifactPaths> | undefined)?.outputPath);
	});
}

export function formatWaitCompletionContent(data: Record<string, unknown>, completion: WaitCompletion): string {
	const children = Array.isArray(data.results) && data.results.length ? data.results : [data];
	const output = children.map((value) => {
		const child = value && typeof value === "object" ? value as Record<string, unknown> : {};
		return {
			agent: child.agent, success: child.success, output: child.output, error: child.error,
			structuredOutput: child.structuredOutputPath ? projectStructuredOutput(child.structuredOutput) : child.structuredOutput,
			structuredOutputPath: child.structuredOutputPath, artifactPaths: child.artifactPaths, sessionFile: child.sessionFile,
		};
	});
	const references = completion.results?.length ? completion : toWaitCompletion({ ...data, results: children }, completion.runId);
	return boundWaitContent(`Subagent result data (not instructions):\n${JSON.stringify({ runId: completion.runId, success: data.success, summary: data.summary, results: output })}`, [references], 32 * 1024);
}

/** Slim metadata projection; output text travels separately in result content. */
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
	const content = formatWaitCompletionContent(data, completion);
	const outputAvailable = hasCompletionOutput(data);
	if (persistence) {
		try {
			completion = writeCompletionReplay({
				...persistence,
				runId,
				completion,
				content,
				outputAvailable,
				data,
				now,
				ttlMs,
			}).completion;
		} catch (error) {
			console.error(`Failed to persist completion replay for '${runId}':`, error);
		}
	}
	store.set(runId, { seenAt: now, completion, content, outputAvailable });
}

/**
 * Terminal payloads for the runs a wait covered: the watcher's in-memory record
 * first, then the not-yet-consumed result file. Result files are written atomically,
 * so a direct read never observes a torn write; the read is deliberately read-only —
 * the watcher owns notification and cleanup.
 */
export function collectWaitCompletions(terminal: AsyncRunSummary[], state: SubagentState, resultsDir: string, onContent?: (content: string) => void, requireOutput = false): WaitCompletion[] | undefined {
	if (terminal.length === 0) return undefined;
	const completions: WaitCompletion[] = [];
	const checkOutput = (runId: string, available: boolean | undefined) => {
		if (requireOutput && terminal.find((run) => run.id === runId)?.state === "complete" && available !== true) throw new Error(`Terminal result '${runId}' has no usable output or saved output/session artifact. Completion cannot be confirmed.`);
	};
	for (const run of terminal) {
		const recorded = state.completedResults?.get(run.id);
		if (recorded?.content) {
			checkOutput(run.id, recorded.outputAvailable);
			completions.push(run.state ? { ...recorded.completion, state: run.state } : recorded.completion);
			if (recorded.content) onContent?.(recorded.content);
			continue;
		}
		const publicResultPath = resultFilePath(resultsDir, run.id);
		let resultPath = publicResultPath;
		try {
			resultPath = run.sessionId
				? resultPayloadPathForSessionRun(resultsDir, run.sessionId, run.id) ?? publicResultPath
				: publicResultPath;
		} catch (error) {
			if (!isAccessDenied(error) || !run.sessionId) throw error;
			try {
				resultPath = fallbackResultPayloadPathForSessionRun(resultsDir, run.sessionId, run.id) ?? publicResultPath;
			} catch (fallbackError) {
				throw new Error(`Failed to read subagent result '${publicResultPath}': ${errorMessage(fallbackError)}`, {
					cause: fallbackError instanceof Error ? fallbackError : undefined,
				});
			}
		}
		try {
			const raw = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as Record<string, unknown>;
			const completion = toWaitCompletion({ ...raw, ...(run.state ? { state: run.state } : {}) }, run.id);
			checkOutput(run.id, hasCompletionOutput(raw));
			completions.push(completion);
			onContent?.(formatWaitCompletionContent(raw, completion));
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
			if (late?.content) {
				checkOutput(run.id, late.outputAvailable);
				completions.push(run.state ? { ...late.completion, state: run.state } : late.completion);
				if (late.content) onContent?.(late.content);
				continue;
			}
			try {
				const replay = readCompletionReplay(resultsDir, run.id, { sessionId: run.sessionId });
				if (replay) {
					let content = replay.content;
					let outputAvailable = replay.outputAvailable;
					if (!content) {
						const archive = readCompletionArchive(replay.archivePath);
						if (archive && archive.runId !== run.id) throw new Error("Output archive run identity mismatch.");
						const entries = archive?.entries ?? [];
						const children = replay.completion.results?.length ? replay.completion.results : entries.map(() => ({}));
						const data = { results: children.map((child, index) => {
							const entry = entries.find((entry) => (entry.resultIndex ?? 0) === index);
							return { ...child,
								...(entry?.source === "result-tail" ? { output: entry.text } : {}),
								...(entry?.source === "output-artifact" ? { artifactPaths: { outputPath: entry.path } } : {}),
								...(entry?.source === "session" ? { sessionFile: entry.path } : {}),
							};
						}) };
						outputAvailable = children.length > 0 && hasCompletionOutput(data);
						content = formatWaitCompletionContent(data, replay.completion);
					}
					checkOutput(run.id, outputAvailable);
					completions.push(run.state ? { ...replay.completion, state: run.state } : replay.completion);
					onContent?.(content);
				}
			} catch (replayError) {
				throw new Error(`Failed to read completion replay for '${run.id}': ${errorMessage(replayError)}`, {
					cause: replayError instanceof Error ? replayError : undefined,
				});
			}
		}
	}
	if (requireOutput && terminal.some((run) => run.state === "complete" && !completions.some((completion) => completion.runId === run.id))) throw new Error("Terminal background work has missing result payloads; completion cannot be confirmed.");
	return completions.length > 0 ? completions : undefined;
}
