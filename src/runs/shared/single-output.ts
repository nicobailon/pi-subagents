import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { OutputMode, SavedOutputReference } from "../../shared/types.ts";
import { hasMutationToolCapability } from "./completion-guard.ts";

export interface SingleOutputSnapshot {
	exists: boolean;
	mtimeMs?: number;
	size?: number;
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

function formatOutputPathInstruction(outputPath: string, capabilities?: OutputInstructionCapabilities): string {
	const delivery = !capabilities || hasMutationToolCapability(capabilities.tools, capabilities.mcpDirectTools)
		? `Write your findings to exactly this path: ${outputPath}`
		: [
			"Return the complete artifact in your final response.",
			`The runtime will persist it to exactly this path: ${outputPath}`,
			"Do not call contact_supervisor merely because no write-capable tool is available.",
		].join("\n");
	return [
		delivery,
		"This path is authoritative for this run.",
		"Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.",
	].join("\n");
}

export function injectSingleOutputInstruction(task: string, outputPath: string | undefined, capabilities?: OutputInstructionCapabilities): string {
	if (!outputPath) return task;
	return `${task}\n\n---\n**Output:**\n${formatOutputPathInstruction(outputPath, capabilities)}`;
}

export function injectOutputPathSystemPrompt(systemPrompt: string, outputPath: string | undefined, capabilities?: OutputInstructionCapabilities): string {
	if (!outputPath) return systemPrompt;
	const instruction = `Runtime output path override:\n${formatOutputPathInstruction(outputPath, capabilities)}`;
	return systemPrompt ? `${systemPrompt}\n\n${instruction}` : instruction;
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

export function validateFileOnlyOutputMode(outputMode: OutputMode | undefined, outputPath: string | undefined, context: string): string | undefined {
	if (outputMode === "file-only" && !outputPath) {
		return `${context} sets outputMode: "file-only" but does not configure an output file. Set output to a path or use outputMode: "inline".`;
	}
	return undefined;
}

export function captureSingleOutputSnapshot(outputPath: string | undefined): SingleOutputSnapshot | undefined {
	if (!outputPath) return undefined;
	try {
		const stat = fs.statSync(outputPath);
		return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		// The snapshot is advisory; resolveSingleOutput reports concrete read/write failures.
		return { exists: false };
	}
}

function persistSingleOutput(
	outputPath: string | undefined,
	fullOutput: string,
): { savedPath?: string; error?: string } {
	if (!outputPath) return {};
	try {
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
): { fullOutput: string; savedPath?: string; saveError?: string } {
	if (!outputPath) return { fullOutput: fallbackOutput };

	let changedSinceStart = false;
	try {
		const stat = fs.statSync(outputPath);
		changedSinceStart = !beforeRun?.exists
			|| stat.mtimeMs !== beforeRun.mtimeMs
			|| stat.size !== beforeRun.size;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			return {
				fullOutput: fallbackOutput,
				saveError: `Failed to inspect output file: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	if (changedSinceStart) {
		try {
			return { fullOutput: fs.readFileSync(outputPath, "utf-8"), savedPath: outputPath };
		} catch (error) {
			return {
				fullOutput: fallbackOutput,
				saveError: `Failed to read changed output file: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const save = persistSingleOutput(outputPath, fallbackOutput);
	if (save.savedPath) return { fullOutput: fallbackOutput, savedPath: save.savedPath };
	return { fullOutput: fallbackOutput, saveError: save.error };
}

export function finalizeSingleOutput(params: {
	fullOutput: string;
	truncatedOutput?: string;
	outputPath?: string;
	outputMode?: OutputMode;
	exitCode: number;
	savedPath?: string;
	outputReference?: SavedOutputReference;
	saveError?: string;
}): { displayOutput: string; savedPath?: string; outputReference?: SavedOutputReference; saveError?: string } {
	let displayOutput = params.truncatedOutput || params.fullOutput;
	if (params.exitCode === 0 && params.savedPath) {
		const outputReference = params.outputReference ?? formatSavedOutputReference(params.savedPath, params.fullOutput);
		if (params.outputMode === "file-only") {
			return { displayOutput: outputReference.message, savedPath: params.savedPath, outputReference };
		}
		displayOutput += `\n\n${outputReference.message}`;
		return { displayOutput, savedPath: params.savedPath, outputReference };
	}
	if (params.exitCode === 0 && params.saveError && params.outputPath) {
		displayOutput += `\n\nOutput file error: ${params.outputPath}\n${params.saveError}`;
		return { displayOutput, saveError: params.saveError };
	}
	return { displayOutput };
}
