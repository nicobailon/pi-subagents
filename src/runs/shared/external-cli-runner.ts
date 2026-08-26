import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import type { ExternalProcessStatus } from "../../shared/types.ts";
import { createOwnedProcessTreeController, type OwnedProcessTreeController } from "../background/owned-process-tree.ts";
import { omitExtensionBindingsEnv } from "./extension-bindings.ts";
import {
	invalidateExternalCliPreflight,
	preflightExternalCli,
	type ExternalCliPreflightResult,
	type ExternalCliPreflightSpec,
} from "./external-cli-preflight.ts";

const MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
const MAX_ERROR_TAIL_BYTES = 64 * 1024;
const MAX_RAW_LOG_BYTES = 8 * 1024 * 1024;
const MAX_PARSER_LINE_BYTES = 256 * 1024;
const MAX_PARSER_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_PARSER_OUTPUT_BYTES = 1024 * 1024;
const MAX_OVERSIZED_LINE_PREFIX_BYTES = 512;
const MAX_SKIPPABLE_LINE_BYTES = 1024 * 1024;
const PARSER_PROGRESS_INTERVAL_MS = 100;

export function buildExternalCliPrompt(systemInstructions: string, task: string): string {
	return `<System instructions>\n${systemInstructions.trim()}\n\n<Task>\n${task}`;
}

export interface ExternalCliParserProgress {
	phase: string;
	eventCount: number;
	message?: string;
}

export interface ExternalCliParserTerminal {
	state: "completed" | "failed";
	output?: string;
	error?: string;
}

export interface ExternalCliParser {
	parseLine(line: string): ExternalCliParserProgress | undefined;
	/** Inspect only a bounded prefix when a non-terminal event exceeds the normal line cap. */
	skipOversizedLine?(prefix: string, byteLength: number): ExternalCliParserProgress | undefined;
	finish(): ExternalCliParserTerminal | undefined;
}

export function parseExternalCliJsonlEvent(line: string, label: string, maxTypeLength: number): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch (error) {
		throw new Error(`${label} emitted malformed JSONL: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} emitted a JSONL event that is not an object.`);
	const event = value as Record<string, unknown>;
	if (typeof event.type !== "string" || !event.type || event.type.length > maxTypeLength) throw new Error(`${label} emitted a JSONL event with an invalid type.`);
	return event;
}

export interface ExternalCliRunResult {
	output: string;
	exitCode: number | null;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	processSignal?: string | null;
	externalProcess: ExternalProcessStatus;
	parserTerminal?: ExternalCliParserTerminal;
	preflight?: ExternalCliPreflightResult;
}

interface StreamLimits {
	stdoutLogBytes?: number;
	stderrLogBytes?: number;
	parserLineBytes?: number;
	parserStreamBytes?: number;
	parserOutputBytes?: number;
}

function narrowLimit(value: number | undefined, ceiling: number, label: string): number {
	if (value === undefined) return ceiling;
	assert(Number.isInteger(value) && value > 0 && value <= ceiling, `${label} may only narrow the code-owned ${ceiling}-byte limit.`);
	return value;
}

function externalEnvironment(allowlist: readonly string[] | undefined, values: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
	if (!allowlist) return omitExtensionBindingsEnv(process.env);
	const allowed = new Set(allowlist);
	const env: NodeJS.ProcessEnv = {};
	for (const key of allowed) {
		if (!key || key.includes("=") || key.includes("\0")) throw new Error(`Invalid external CLI environment key: ${JSON.stringify(key)}.`);
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	for (const [key, value] of Object.entries(values ?? {})) {
		if (!allowed.has(key)) throw new Error(`External CLI environment value '${key}' is not in the adapter allowlist.`);
		env[key] = value;
	}
	return omitExtensionBindingsEnv(env);
}

function createByteTail(maxBytes: number): { push(chunk: Buffer): void; text(): string } {
	const chunks: Buffer[] = [];
	let bytes = 0;
	return {
		push(chunk) {
			chunks.push(chunk);
			bytes += chunk.length;
			while (bytes > maxBytes && chunks.length > 0) {
				const first = chunks[0]!;
				const excess = bytes - maxBytes;
				if (first.length <= excess) {
					chunks.shift();
					bytes -= first.length;
				} else {
					chunks[0] = first.subarray(excess);
					bytes -= excess;
				}
			}
		},
		text: () => Buffer.concat(chunks, bytes).toString("utf-8"),
	};
}

function writeBoundedLog(source: NodeJS.ReadableStream, stream: fs.WriteStream, chunk: Buffer, state: { bytes: number; total: number }, limit: number): void {
	state.total += chunk.length;
	const remaining = limit - state.bytes;
	if (remaining <= 0) return;
	const bytes = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
	state.bytes += bytes.length;
	if (!stream.write(bytes)) {
		source.pause();
		stream.once("drain", () => source.resume());
	}
}

function classifyInvalidation(error: string): "auth" | "permission" | "launch" {
	if (/auth|unauthori[sz]ed|credential|login/i.test(error)) return "auth";
	if (/permission|forbidden|denied|read.?only/i.test(error)) return "permission";
	return "launch";
}

function terminateExternalProcessTree(pid: number, controller: OwnedProcessTreeController): Promise<unknown> {
	if (process.platform !== "win32") return controller.terminate();
	return new Promise((resolve) => {
		const cleanup = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		cleanup.once("error", () => { void controller.terminate().then(resolve); });
		cleanup.once("close", () => { void controller.terminate().then(resolve); });
	});
}

export function runExternalCli(input: {
	command: string;
	args?: string[];
	cwd: string;
	prompt: string;
	asyncDir: string;
	stepIndex: number;
	environment?: { allowlist: readonly string[]; values?: Readonly<Record<string, string>> };
	preflight?: ExternalCliPreflightSpec;
	parser?: ExternalCliParser;
	finalOutputPath?: string;
	promptFilePath?: string;
	temporaryDirectories?: readonly string[];
	limits?: StreamLimits;
	registerTimeout?: (stop: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	timeoutMessage?: string;
	stopMessage?: string;
	onProcess?: (process: ExternalProcessStatus) => void;
	onParserProgress?: (progress: ExternalCliParserProgress) => void;
	onStdout?: (chunk: Buffer) => void;
	onStderr?: (chunk: Buffer) => void;
}): Promise<ExternalCliRunResult> {
	const limits = {
		stdoutLogBytes: narrowLimit(input.limits?.stdoutLogBytes, MAX_RAW_LOG_BYTES, "stdoutLogBytes"),
		stderrLogBytes: narrowLimit(input.limits?.stderrLogBytes, MAX_RAW_LOG_BYTES, "stderrLogBytes"),
		parserLineBytes: narrowLimit(input.limits?.parserLineBytes, MAX_PARSER_LINE_BYTES, "parserLineBytes"),
		parserStreamBytes: narrowLimit(input.limits?.parserStreamBytes, MAX_PARSER_STREAM_BYTES, "parserStreamBytes"),
		parserOutputBytes: narrowLimit(input.limits?.parserOutputBytes, MAX_PARSER_OUTPUT_BYTES, "parserOutputBytes"),
	};
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const stdoutPath = path.join(input.asyncDir, `external-${input.stepIndex}.stdout.log`);
		const stderrPath = path.join(input.asyncDir, `external-${input.stepIndex}.stderr.log`);
		fs.mkdirSync(input.asyncDir, { recursive: true });
		const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "w" });
		const stderrStream = fs.createWriteStream(stderrPath, { flags: "w" });
		const streamsFinished = Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
		const createdDirectories: string[] = [];
		let promptFileCreated = false;
		const cleanupTemporaryPaths = () => {
			if (input.promptFilePath && promptFileCreated) fs.rmSync(input.promptFilePath, { force: true });
			for (const directory of createdDirectories.reverse()) fs.rmSync(directory, { recursive: true, force: true });
		};
		const env = externalEnvironment(input.environment?.allowlist, input.environment?.values);
		let preflight: ExternalCliPreflightResult | undefined;
		try {
			for (const directory of input.temporaryDirectories ?? []) {
				fs.mkdirSync(directory, { mode: 0o700 });
				createdDirectories.push(directory);
			}
			if (input.promptFilePath) {
				const promptDescriptor = fs.openSync(input.promptFilePath, "wx", 0o600);
				promptFileCreated = true;
				try { fs.writeFileSync(promptDescriptor, input.prompt, { encoding: "utf-8" }); }
				finally { fs.closeSync(promptDescriptor); }
			}
			if (input.preflight) preflight = preflightExternalCli(input.command, input.preflight, env, input.cwd);
		} catch (error) {
			const endedAt = Date.now();
			const externalProcess = { startedAt, endedAt, durationMs: endedAt - startedAt, exitCode: 1, processSignal: null, stdoutPath, stderrPath, ...(input.finalOutputPath ? { finalOutputPath: input.finalOutputPath } : {}) } satisfies ExternalProcessStatus;
			stdoutStream.end();
			stderrStream.end();
			void streamsFinished.then((streamResults) => {
				try { cleanupTemporaryPaths(); }
				catch (cleanupError) { reject(cleanupError); return; }
				const streamFailure = streamResults.find((streamResult) => streamResult.status === "rejected");
				if (streamFailure?.status === "rejected") reject(streamFailure.reason);
				else resolve({ output: "", exitCode: 1, error: error instanceof Error ? error.message : String(error), processSignal: null, externalProcess });
			});
			return;
		}
		const stdoutTail = createByteTail(MAX_OUTPUT_TAIL_BYTES);
		const stderrTail = createByteTail(MAX_ERROR_TAIL_BYTES);
		const stdoutLog = { bytes: 0, total: 0 };
		const stderrLog = { bytes: 0, total: 0 };
		let parserBytes = 0;
		let pendingLine = Buffer.alloc(0);
		let pendingLineBytes = 0;
		let pendingLineOversizedAccepted = false;
		let parserError: Error | undefined;
		let parserTerminal: ExternalCliParserTerminal | undefined;
		let latestProgress: ExternalCliParserProgress | undefined;
		let progressTimer: NodeJS.Timeout | undefined;
		let timedOut = false;
		let stopped = false;
		let settled = false;
		let processTree: OwnedProcessTreeController | undefined;
		let processPid: number | undefined;
		let termination: Promise<unknown> | undefined;
		const flushProgress = () => {
			if (!latestProgress) return;
			input.onParserProgress?.(latestProgress);
			latestProgress = undefined;
		};
		const reportProgress = (progress: ExternalCliParserProgress) => {
			if (!progress.phase || progress.phase.length > 64 || !Number.isSafeInteger(progress.eventCount) || progress.eventCount < 0) {
				failParser(new Error("External CLI parser returned invalid progress metadata."));
				return;
			}
			latestProgress = { ...progress, ...(progress.message ? { message: progress.message.slice(0, 512) } : {}) };
			if (progressTimer) return;
			progressTimer = setTimeout(() => {
				progressTimer = undefined;
				flushProgress();
			}, PARSER_PROGRESS_INTERVAL_MS);
			progressTimer.unref?.();
		};
		const terminate = (reason: "timeout" | "stop") => {
			if (settled || timedOut || stopped || parserError) return;
			timedOut = reason === "timeout";
			stopped = reason === "stop";
			if (processTree && processPid !== undefined) termination = terminateExternalProcessTree(processPid, processTree);
		};
		const failParser = (error: unknown) => {
			if (parserError) return;
			parserError = error instanceof Error ? error : new Error(String(error));
			if (input.preflight) invalidateExternalCliPreflight(input.command, input.preflight, "parser");
			if (processTree && processPid !== undefined) termination = terminateExternalProcessTree(processPid, processTree);
		};
		const parseLine = (line: Buffer, byteLength = line.length): boolean => {
			if (!input.parser || parserError) return false;
			if (byteLength > limits.parserLineBytes) {
				const progress = input.limits?.parserLineBytes === undefined
					? input.parser.skipOversizedLine?.(line.subarray(0, MAX_OVERSIZED_LINE_PREFIX_BYTES).toString("utf-8"), byteLength)
					: undefined;
				if (progress) { reportProgress(progress); return true; }
				failParser(new Error("External CLI parser line exceeded its byte limit."));
				return false;
			}
			try {
				const progress = input.parser.parseLine(line.toString("utf-8"));
				if (progress) reportProgress(progress);
			} catch (error) { failParser(error); }
			return false;
		};
		const appendPendingLine = (chunk: Buffer) => {
			pendingLineBytes += chunk.length;
			if (pendingLineOversizedAccepted) {
				if (pendingLineBytes > MAX_SKIPPABLE_LINE_BYTES) failParser(new Error("External CLI parser line exceeded its byte limit."));
				return;
			}
			if (pendingLineBytes <= limits.parserLineBytes) {
				pendingLine = Buffer.concat([pendingLine, chunk]);
				return;
			}
			if (pendingLineBytes > MAX_SKIPPABLE_LINE_BYTES) {
				failParser(new Error("External CLI parser line exceeded its byte limit."));
				return;
			}
			if (pendingLine.length > MAX_OVERSIZED_LINE_PREFIX_BYTES) pendingLine = pendingLine.subarray(0, MAX_OVERSIZED_LINE_PREFIX_BYTES);
			const remainingPrefixBytes = MAX_OVERSIZED_LINE_PREFIX_BYTES - pendingLine.length;
			if (remainingPrefixBytes > 0) pendingLine = Buffer.concat([pendingLine, chunk.subarray(0, remainingPrefixBytes)]);
			pendingLineOversizedAccepted = parseLine(pendingLine, pendingLineBytes);
		};
		const finishPendingLine = () => {
			if (!pendingLineOversizedAccepted) parseLine(pendingLine, pendingLineBytes);
			pendingLine = Buffer.alloc(0);
			pendingLineBytes = 0;
			pendingLineOversizedAccepted = false;
		};
		const parseChunk = (chunk: Buffer) => {
			if (!input.parser || parserError) return;
			parserBytes += chunk.length;
			if (parserBytes > limits.parserStreamBytes) {
				failParser(new Error("External CLI parser stream exceeded its byte limit."));
				return;
			}
			let start = 0;
			for (let index = 0; index < chunk.length; index++) {
				if (chunk[index] !== 0x0a) continue;
				appendPendingLine(chunk.subarray(start, index));
				finishPendingLine();
				start = index + 1;
			}
			appendPendingLine(chunk.subarray(start));
		};
		const child = spawn(preflight?.binaryPath ?? input.command, input.args ?? [], {
			cwd: input.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
		}) as ChildProcessWithoutNullStreams;
		if (typeof child.pid === "number") {
			processPid = child.pid;
			processTree = createOwnedProcessTreeController(child.pid, { termGraceMs: 2_000 });
		}
		const initialProcess: ExternalProcessStatus = {
			...(typeof child.pid === "number" ? { pid: child.pid } : {}),
			startedAt,
			stdoutPath,
			stderrPath,
			...(input.finalOutputPath ? { finalOutputPath: input.finalOutputPath } : {}),
		};
		input.onProcess?.(initialProcess);
		child.stdout.on("data", (chunk: Buffer) => {
			parseChunk(chunk);
			writeBoundedLog(child.stdout, stdoutStream, chunk, stdoutLog, limits.stdoutLogBytes);
			input.onStdout?.(chunk);
			stdoutTail.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			writeBoundedLog(child.stderr, stderrStream, chunk, stderrLog, limits.stderrLogBytes);
			input.onStderr?.(chunk);
			stderrTail.push(chunk);
		});
		input.registerTimeout?.(() => terminate("timeout"));
		input.registerStop?.(() => terminate("stop"));
		child.stdin.on("error", () => {});
		child.stdin.end(input.promptFilePath ? undefined : input.prompt);
		let spawnError: Error | undefined;
		child.once("error", (error) => { spawnError = error; });
		child.stdout.once("end", () => {
			if (!input.parser || parserError) return;
			if (pendingLineBytes > 0) finishPendingLine();
			try {
				parserTerminal = input.parser.finish();
				if (!parserTerminal) failParser(new Error("External CLI parser did not produce a terminal state."));
				else if (Buffer.byteLength(parserTerminal.output ?? "", "utf-8") > limits.parserOutputBytes) failParser(new Error("External CLI parser terminal output exceeded its byte limit."));
				else if (Buffer.byteLength(parserTerminal.error ?? "", "utf-8") > 4 * 1024) failParser(new Error("External CLI parser terminal error exceeded its byte limit."));
			} catch (error) { failParser(error); }
		});
		child.once("close", (exitCode, signal) => {
			settled = true;
			if (progressTimer) clearTimeout(progressTimer);
			flushProgress();
			input.registerTimeout?.(undefined);
			input.registerStop?.(undefined);
			void (async () => {
				if (termination) await termination;
				else if (processTree) await processTree.finishAfterWriterClose();
				const endedAt = Date.now();
				const externalProcess: ExternalProcessStatus = {
					...initialProcess,
					endedAt,
					durationMs: endedAt - startedAt,
					exitCode,
					processSignal: signal,
					stdoutBytes: stdoutLog.total,
					stderrBytes: stderrLog.total,
					...(stdoutLog.total > stdoutLog.bytes ? { stdoutTruncated: true } : {}),
					...(stderrLog.total > stderrLog.bytes ? { stderrTruncated: true } : {}),
				};
				input.onProcess?.(externalProcess);
				const stderr = stderrTail.text().trim();
				const parserFailure = parserError?.message ?? (parserTerminal?.state === "failed" ? parserTerminal.error ?? "External CLI parser reported terminal failure." : undefined);
				const error = stopped
					? input.stopMessage ?? "Subagent stopped by user."
					: timedOut
						? input.timeoutMessage ?? "Subagent timed out."
						: spawnError?.message ?? parserFailure ?? (exitCode === 0 ? undefined : stderr || `External CLI exited with code ${exitCode}.`);
				if (error && input.preflight && !parserError) invalidateExternalCliPreflight(input.command, input.preflight, classifyInvalidation(error));
				const result: ExternalCliRunResult = {
					output: (!parserError && parserTerminal?.state === "completed" ? parserTerminal.output ?? "" : stdoutTail.text()).trim(),
					exitCode: timedOut || stopped || spawnError || parserFailure ? 1 : exitCode,
					...(error ? { error } : {}),
					...(timedOut ? { timedOut: true } : {}),
					...(stopped ? { stopped: true } : {}),
					processSignal: signal,
					externalProcess,
					...(parserTerminal ? { parserTerminal } : {}),
					...(preflight ? { preflight } : {}),
				};
				stdoutStream.end();
				stderrStream.end();
				const streamResults = await streamsFinished;
				const streamFailure = streamResults.find((streamResult) => streamResult.status === "rejected");
				try { cleanupTemporaryPaths(); }
				catch (cleanupError) { reject(cleanupError); return; }
				if (streamFailure?.status === "rejected") reject(streamFailure.reason);
				else resolve(result);
			})();
		});
	});
}
