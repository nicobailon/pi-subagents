import * as fs from "node:fs";
import * as path from "node:path";
import type { OutputMode, SavedOutputReference } from "../../shared/types.ts";

export interface SingleOutputSnapshot {
	exists: boolean;
	mtimeMs?: number;
	size?: number;
}

export function normalizeOutputSetting(output: string | false | undefined): string | false | undefined {
	return output === "false" ? false : output;
}

function resolveOutputBaseCwd(runtimeCwd: string, requestedCwd?: string): string {
	if (!requestedCwd) return runtimeCwd;
	return path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(runtimeCwd, requestedCwd);
}

export function resolveSingleOutputPath(
	output: string | false | undefined,
	runtimeCwd: string,
	requestedCwd?: string,
): string | undefined {
	const normalizedOutput = normalizeOutputSetting(output);
	if (typeof normalizedOutput !== "string" || !normalizedOutput) return undefined;
	if (path.isAbsolute(normalizedOutput)) return normalizedOutput;
	return path.resolve(resolveOutputBaseCwd(runtimeCwd, requestedCwd), normalizedOutput);
}

export function injectSingleOutputInstruction(task: string, outputPath: string | undefined): string {
	if (!outputPath) return task;
	return `${task}\n\n---\n**Output:** Write your findings to: ${outputPath}`;
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

function formatIoError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	} catch (error) {
		return { error: formatIoError(error) };
	}
}

function hasOutputFileChanged(outputPath: string, beforeRun: SingleOutputSnapshot | undefined): boolean | string {
	try {
		const stat = fs.statSync(outputPath);
		return !beforeRun?.exists
			|| stat.mtimeMs !== beforeRun.mtimeMs
			|| stat.size !== beforeRun.size;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		return `Failed to inspect output file: ${formatIoError(error)}`;
	}
}

export function resolveSingleOutput(
	outputPath: string | undefined,
	fallbackOutput: string,
	beforeRun: SingleOutputSnapshot | undefined,
): { fullOutput: string; savedPath?: string; saveError?: string } {
	if (!outputPath) return { fullOutput: fallbackOutput };

	const outputFileChange = hasOutputFileChanged(outputPath, beforeRun);
	if (typeof outputFileChange === "string") {
		return {
			fullOutput: fallbackOutput,
			saveError: outputFileChange,
		};
	}

	if (outputFileChange) {
		try {
			return { fullOutput: fs.readFileSync(outputPath, "utf-8"), savedPath: outputPath };
		} catch (error) {
			return {
				fullOutput: fallbackOutput,
				saveError: `Failed to read changed output file: ${formatIoError(error)}`,
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
	if (params.exitCode !== 0) return { displayOutput };

	if (params.savedPath) {
		const outputReference = params.outputReference ?? formatSavedOutputReference(params.savedPath, params.fullOutput);
		if (params.outputMode === "file-only") {
			return { displayOutput: outputReference.message, savedPath: params.savedPath, outputReference };
		}
		displayOutput += `\n\n${outputReference.message}`;
		return { displayOutput, savedPath: params.savedPath, outputReference };
	}

	if (params.saveError && params.outputPath) {
		displayOutput += `\n\nOutput file error: ${params.outputPath}\n${params.saveError}`;
		return { displayOutput, saveError: params.saveError };
	}

	return { displayOutput };
}
