import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { OutputMode, SavedOutputReference } from "../../shared/types.ts";

const READ_ONLY_OUTPUT_TOOLS = new Set([
	"read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content",
	"source_check", "intercom", "contact_supervisor", "structured_output", "watchdog_diff",
]);

function hasOutputWriteCapability(tools: string[] | undefined, mcpDirectTools: string[] | undefined): boolean {
	if ((mcpDirectTools?.length ?? 0) > 0 || tools === undefined) return true;
	return tools.some((tool) => !READ_ONLY_OUTPUT_TOOLS.has(tool));
}

export interface SingleOutputSnapshot {
	exists: boolean;
	mtimeMs?: number;
	size?: number;
	error?: string;
}

function missingFileStatError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function snapshotFromStatError(error: unknown): SingleOutputSnapshot {
	if (missingFileStatError(error)) return { exists: false };
	return { exists: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Content the child itself sent to the configured output path, taken from its
 * last `write` tool call whose tool result reports success. Unlike reading the
 * path from disk, this cannot be polluted by a sibling run writing the same
 * path (#420); requiring the successful tool result keeps failed, cancelled,
 * or unanswered write calls from counting as authored output. Returns
 * undefined when no such write exists (e.g. bash or edit-based construction),
 * in which case callers must not assume file authorship.
 */
export function extractChildWrittenOutput(
	messages: Message[] | undefined,
	outputPath: string | undefined,
	cwd?: string,
): string | undefined {
	if (!messages?.length || !outputPath) return undefined;
	const resolvedTarget = path.resolve(cwd ?? ".", outputPath);
	const comparableTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
	const successfulCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError === false && typeof message.toolCallId === "string") {
			successfulCallIds.add(message.toolCallId);
		}
	}
	let content: string | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.name !== "write" || !successfulCallIds.has(part.id)) continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (typeof args.path !== "string" || typeof args.content !== "string") continue;
			const resolvedWritePath = path.resolve(cwd ?? ".", args.path);
			const comparableWritePath = process.platform === "win32" ? resolvedWritePath.toLowerCase() : resolvedWritePath;
			if (comparableWritePath !== comparableTarget) continue;
			content = args.content;
		}
	}
	return content;
}

export function normalizeSingleOutputOverride(
	output: string | boolean | undefined,
	defaultOutput: string | undefined,
): string | false | undefined {
	if (output === false || output === "false") return false;
	if (output === true || output === "true") return defaultOutput;
	if (typeof output === "string" && output.length > 0) return output;
	return undefined;
}

export function resolveSingleOutputPath(
	output: string | boolean | undefined,
	runtimeCwd: string,
	requestedCwd?: string,
	relativeBaseDir?: string,
): string | undefined {
	if (typeof output !== "string" || !output || output === "false" || output === "true") return undefined;
	if (path.isAbsolute(output)) return output;
	if (relativeBaseDir) return path.resolve(relativeBaseDir, output);
	const baseCwd = requestedCwd
		? (path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(runtimeCwd, requestedCwd))
		: runtimeCwd;
	return path.resolve(baseCwd, output);
}

interface OutputInstructionCapabilities {
	tools?: string[];
	mcpDirectTools?: string[];
}

export function requestedOutputPathFromTask(task: string): string | undefined {
	for (const line of task.split(/\r?\n/).reverse()) {
		const match = line.match(/^\s*(?:Write your findings to(?: exactly this path)?:|The runtime will persist it to exactly this path:)\s*(.+?)\s*$/i);
		if (!match?.[1]) continue;
		const requested = match[1].trim();
		return requested.startsWith("`") && requested.endsWith("`") ? requested.slice(1, -1) : requested;
	}
	return undefined;
}

export function outputPathMappingFromTask(task: string, savedPath: string | undefined): { requestedPath: string; savedPath: string } | undefined {
	const requestedPath = requestedOutputPathFromTask(task);
	if (!requestedPath || !savedPath) return undefined;
	if (path.isAbsolute(requestedPath) && path.normalize(requestedPath) === path.normalize(savedPath)) return undefined;
	return { requestedPath, savedPath };
}

export function injectSingleOutputInstruction(task: string, outputPath: string | undefined, capabilities?: OutputInstructionCapabilities): string {
	if (!outputPath) return task;
	const delivery = !capabilities || hasOutputWriteCapability(capabilities.tools, capabilities.mcpDirectTools)
		? `Write your findings to exactly this path: ${outputPath}`
		: [
			"Return the complete artifact in your final response.",
			`The runtime will persist it to exactly this path: ${outputPath}`,
			"Do not call contact_supervisor merely because no write-capable tool is available.",
		].join("\n");
	return [
		`${task}\n\n---\n**Output:**`,
		delivery,
		"This path is authoritative for this run.",
		"Ignore any other output filename or output path mentioned elsewhere, including output destinations in the system prompt or the task instructions.",
	].join("\n");
}

function countLines(text: string): number {
	if (!text) return 0;
	const newlineMatches = text.match(/\r\n|\r|\n/g);
	return (newlineMatches?.length ?? 0) + (/[\r\n]$/.test(text) ? 0 : 1);
}

function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatSavedOutputReference(savedPath: string, fullOutput: string): SavedOutputReference {
	const absolutePath = path.resolve(savedPath);
	const bytes = Buffer.byteLength(fullOutput, "utf-8");
	const lines = countLines(fullOutput);
	return {
		path: absolutePath,
		bytes,
		lines,
		message: `Output saved to: ${absolutePath} (${formatByteSize(bytes)}, ${lines} ${lines === 1 ? "line" : "lines"}). Read this file if needed.`,
	};
}

const INLINE_OUTPUT_HEAD_CHARS = 2_000;
/** Larger files are not read to check a cap; the output then stays whole. */
const MAX_FULL_OUTPUT_FILE_BYTES = 50 * 1024 * 1024;
/** The line finalizeSingleOutput appends when inline output was also saved to an explicit output file. */
const SAVED_OUTPUT_LINE = /\n\nOutput saved to: (.+) \([^()\n]*\)\. Read this file if needed\.$/;
/** How many trailing `\n\n` blocks a file-backed head may be followed by, such as a timed-out child's recovery summary. */
const MAX_UNFILED_TRAILING_BLOCKS = 8;

function readFullOutputFile(filePath: string): string | undefined {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > MAX_FULL_OUTPUT_FILE_BYTES) return undefined;
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/** The longest prefix of output, ending before at most `maxTrailingBlocks` of its last `\n\n` blocks, that the file holds and that is worth capping. */
function fileBackedHead(output: string, fullOutput: string, maxTrailingBlocks: number): string | undefined {
	if (fullOutput.includes(output)) return output;
	let end = output.length;
	for (let attempt = 0; attempt < maxTrailingBlocks; attempt++) {
		end = output.lastIndexOf("\n\n", end - 1);
		if (end <= INLINE_OUTPUT_HEAD_CHARS) return undefined;
		const head = output.slice(0, end);
		if (fullOutput.includes(head)) return head;
	}
	return undefined;
}

/**
 * Keeps at most INLINE_OUTPUT_HEAD_CHARS of a child's output inline and points to the file holding all of it.
 * Files come only from run records, never from the child's text: a trailing `Output saved to:` line is kept as the
 * pointer only when it names the run's recorded saved-output path, and that recorded path is what gets read.
 * Trailing blocks the file does not hold, such as a timed-out child's recovery summary, stay inline after the pointer.
 * Output stays whole when it is short or no readable file contains it, so no text is lost.
 */
export function capInlineOutput(output: string, files: { artifactPath?: string; savedPath?: string }): string {
	const match = files.savedPath ? output.match(SAVED_OUTPUT_LINE) : null;
	const savedLine = match && files.savedPath && match[1] === path.resolve(files.savedPath) ? match : undefined;
	const body = savedLine ? output.slice(0, savedLine.index) : output;
	const filePath = savedLine ? files.savedPath : files.artifactPath;
	if (body.length <= INLINE_OUTPUT_HEAD_CHARS || !filePath) return output;
	const fullOutput = readFullOutputFile(filePath);
	if (fullOutput === undefined) return output;
	const head = fileBackedHead(body, fullOutput, savedLine ? 0 : MAX_UNFILED_TRAILING_BLOCKS);
	if (head === undefined) return output;
	const lineEnd = head.lastIndexOf("\n", INLINE_OUTPUT_HEAD_CHARS);
	let end = lineEnd >= INLINE_OUTPUT_HEAD_CHARS - 200 ? lineEnd : INLINE_OUTPUT_HEAD_CHARS;
	if (/[\uD800-\uDBFF]/.test(head[end - 1] ?? "")) end -= 1;
	if (savedLine) return `${head.slice(0, end)}\n…${output.slice(body.length)}`;
	const reference = formatSavedOutputReference(filePath, fullOutput);
	return `${head.slice(0, end)}\n…\nFull output: ${reference.path} (${formatByteSize(reference.bytes)}, ${reference.lines} ${reference.lines === 1 ? "line" : "lines"}). Read it if needed.${body.slice(head.length)}`;
}

/** Applies capInlineOutput to each `agent:\noutput` section of a run summary whose child output is long. */
export function capSummaryOutputs(summary: string, results: ReadonlyArray<{ agent?: unknown; output?: unknown; artifactPaths?: { outputPath?: unknown }; artifactOutputSaveFailed?: unknown; savedOutputPath?: unknown }> | undefined): string {
	let capped = summary;
	for (const result of results ?? []) {
		if (typeof result.agent !== "string" || typeof result.output !== "string" || result.output.length <= INLINE_OUTPUT_HEAD_CHARS) continue;
		const artifactPath = result.artifactOutputSaveFailed === true || typeof result.artifactPaths?.outputPath !== "string" ? undefined : result.artifactPaths.outputPath;
		const savedPath = typeof result.savedOutputPath === "string" && result.savedOutputPath ? result.savedOutputPath : undefined;
		const section = `${result.agent}:\n${result.output}`;
		const index = capped.indexOf(section);
		if (index < 0) continue;
		capped = `${capped.slice(0, index)}${result.agent}:\n${capInlineOutput(result.output, { artifactPath, savedPath })}${capped.slice(index + section.length)}`;
	}
	return capped;
}

export function validateFileOnlyOutputMode(outputMode: OutputMode | undefined, outputPath: string | undefined, context: string): string | undefined {
	if (outputMode === "file-only" && !outputPath) {
		return `${context} sets outputMode: "file-only" but does not configure an output file. Set output to a path or use outputMode: "inline".`;
	}
	return undefined;
}

export function resolveSingleOutputClaimPath(outputPath: string): string {
	let existing = path.resolve(outputPath);
	const missingSegments: string[] = [];
	while (!fs.existsSync(existing)) {
		missingSegments.unshift(path.basename(existing));
		const parent = path.dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	return path.join(fs.realpathSync(existing), ...missingSegments);
}

function outputClaimError(outputPath: string, expectedClaimPath: string | undefined): string | undefined {
	if (expectedClaimPath && resolveSingleOutputClaimPath(outputPath) !== expectedClaimPath) return "Output path changed after it was claimed.";
	return undefined;
}

export function captureSingleOutputSnapshot(outputPath: string | undefined): SingleOutputSnapshot | undefined {
	if (!outputPath) return undefined;
	try {
		const stat = fs.statSync(outputPath);
		return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
	} catch (error) {
		return snapshotFromStatError(error);
	}
}

function inspectSingleOutputChange(
	outputPath: string,
	beforeRun: SingleOutputSnapshot | undefined,
): { changed: boolean; error?: string } {
	if (beforeRun?.error) return { changed: false, error: beforeRun.error };
	try {
		const stat = fs.statSync(outputPath);
		return {
			changed: !beforeRun?.exists || stat.mtimeMs !== beforeRun.mtimeMs || stat.size !== beforeRun.size,
		};
	} catch (error) {
		if (missingFileStatError(error)) return { changed: false };
		return { changed: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function hasSingleOutputChangedSinceSnapshot(
	outputPath: string | undefined,
	beforeRun: SingleOutputSnapshot | undefined,
): boolean | undefined {
	if (!outputPath) return undefined;
	const inspected = inspectSingleOutputChange(outputPath, beforeRun);
	return inspected.error ? undefined : inspected.changed;
}

function persistSingleOutput(
	outputPath: string | undefined,
	fullOutput: string,
	expectedClaimPath?: string,
): { savedPath?: string; error?: string; fatalError?: boolean } {
	if (!outputPath) return {};
	try {
		const claimError = outputClaimError(outputPath, expectedClaimPath);
		if (claimError) return { error: claimError, fatalError: true };
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, fullOutput, "utf-8");
		return { savedPath: outputPath };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export function resolveSingleOutput(
	outputPath: string | undefined,
	fallbackOutput: string,
	beforeRun: SingleOutputSnapshot | undefined,
	expectedClaimPath?: string,
): { fullOutput: string; savedPath?: string; saveError?: string; fatalError?: boolean } {
	if (!outputPath) return { fullOutput: fallbackOutput };
	const claimError = outputClaimError(outputPath, expectedClaimPath);
	if (claimError) return { fullOutput: fallbackOutput, saveError: claimError, fatalError: true };

	const changedSinceStart = inspectSingleOutputChange(outputPath, beforeRun);
	if (changedSinceStart.error) {
		return {
			fullOutput: fallbackOutput,
			saveError: `Failed to inspect output file: ${changedSinceStart.error}`,
		};
	}

	if (changedSinceStart.changed) {
		try {
			return { fullOutput: fs.readFileSync(outputPath, "utf-8"), savedPath: outputPath };
		} catch (error) {
			return {
				fullOutput: fallbackOutput,
				saveError: `Failed to read changed output file: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const save = persistSingleOutput(outputPath, fallbackOutput, expectedClaimPath);
	if (save.savedPath) return { fullOutput: fallbackOutput, savedPath: save.savedPath };
	return { fullOutput: fallbackOutput, saveError: save.error, ...(save.fatalError ? { fatalError: true } : {}) };
}

export function finalizeSingleOutput(params: {
	fullOutput: string;
	truncatedOutput?: string;
	outputPath?: string;
	outputMode?: OutputMode;
	exitCode: number;
	/** Keep the saved-output reference when a post-run acceptance gate rejects an otherwise completed child. */
	preserveSavedOutput?: boolean;
	savedPath?: string;
	outputReference?: SavedOutputReference;
	saveError?: string;
}): { displayOutput: string; savedPath?: string; outputReference?: SavedOutputReference; saveError?: string } {
	let displayOutput = params.truncatedOutput || params.fullOutput;
	if ((params.exitCode === 0 || params.preserveSavedOutput) && params.savedPath) {
		const outputReference = params.outputReference ?? formatSavedOutputReference(params.savedPath, params.fullOutput);
		if (params.outputMode === "file-only") {
			return { displayOutput: outputReference.message, savedPath: params.savedPath, outputReference };
		}
		if (!displayOutput.includes(outputReference.message)) displayOutput += `\n\n${outputReference.message}`;
		return { displayOutput, savedPath: params.savedPath, outputReference };
	}
	if (params.exitCode === 0 && params.saveError && params.outputPath) {
		displayOutput += `\n\nOutput file error: ${params.outputPath}\n${params.saveError}`;
		return { displayOutput, saveError: params.saveError };
	}
	return { displayOutput };
}

/**
 * Determines whether an output resolution error represents an unrecoverable settlement failure.
 * Returns true for fatal claim-path mismatches in any mode, or when required file-only output
 * fails to persist without a savedPath. Inline and optional outputs remain nonfatal warnings.
 */
export function isSettlementFatalOutputError(
	resolvedOutput: { savedPath?: string; saveError?: string; fatalError?: boolean },
	outputMode?: OutputMode,
): boolean {
	return resolvedOutput.fatalError === true
		|| (outputMode === "file-only" && !resolvedOutput.savedPath && Boolean(resolvedOutput.saveError));
}
