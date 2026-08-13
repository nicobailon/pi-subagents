import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import { trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import type { ExternalProcessStatus } from "../../shared/types.ts";

const HARD_KILL_DELAY_MS = 2_000;
const MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
const MAX_ERROR_TAIL_BYTES = 64 * 1024;

export function buildExternalCliPrompt(systemInstructions: string, task: string): string {
	return `<System instructions>\n${systemInstructions.trim()}\n\n<Task>\n${task}`;
}

export interface ExternalCliRunResult {
	output: string;
	exitCode: number | null;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	processSignal?: string | null;
	externalProcess: ExternalProcessStatus;
}

export function runExternalCli(input: {
	command: string;
	args?: string[];
	cwd: string;
	prompt: string;
	asyncDir: string;
	stepIndex: number;
	registerTimeout?: (stop: (() => void) | undefined) => void;
	registerStop?: (stop: (() => void) | undefined) => void;
	timeoutMessage?: string;
	stopMessage?: string;
	onProcess?: (process: ExternalProcessStatus) => void;
	onStdout?: (chunk: Buffer) => void;
	onStderr?: (chunk: Buffer) => void;
}): Promise<ExternalCliRunResult> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const stdoutPath = path.join(input.asyncDir, `external-${input.stepIndex}.stdout.log`);
		const stderrPath = path.join(input.asyncDir, `external-${input.stepIndex}.stderr.log`);
		fs.mkdirSync(input.asyncDir, { recursive: true });
		const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "w" });
		const stderrStream = fs.createWriteStream(stderrPath, { flags: "w" });
		const streamsFinished = Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
		let stdoutTail = Buffer.alloc(0);
		let stderrTail = Buffer.alloc(0);
		let timedOut = false;
		let stopped = false;
		let settled = false;
		let hardKillTimer: NodeJS.Timeout | undefined;
		const child = spawn(input.command, input.args ?? [], {
			cwd: input.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
		const initialProcess: ExternalProcessStatus = {
			...(typeof child.pid === "number" ? { pid: child.pid } : {}),
			startedAt,
			stdoutPath,
			stderrPath,
		};
		input.onProcess?.(initialProcess);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutStream.write(chunk);
			input.onStdout?.(chunk);
			stdoutTail = Buffer.concat([stdoutTail, chunk]);
			if (stdoutTail.length > MAX_OUTPUT_TAIL_BYTES) stdoutTail = stdoutTail.subarray(stdoutTail.length - MAX_OUTPUT_TAIL_BYTES);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrStream.write(chunk);
			input.onStderr?.(chunk);
			stderrTail = Buffer.concat([stderrTail, chunk]);
			if (stderrTail.length > MAX_ERROR_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - MAX_ERROR_TAIL_BYTES);
		});
		const terminate = (reason: "timeout" | "stop") => {
			if (settled || timedOut || stopped) return;
			timedOut = reason === "timeout";
			stopped = reason === "stop";
			trySignalChild(child, "SIGTERM");
			hardKillTimer = setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGKILL");
			}, HARD_KILL_DELAY_MS);
			hardKillTimer.unref?.();
		};
		input.registerTimeout?.(() => terminate("timeout"));
		input.registerStop?.(() => terminate("stop"));
		child.stdin.on("error", () => {});
		child.stdin.end(input.prompt);
		let spawnError: Error | undefined;
		child.once("error", (error) => { spawnError = error; });
		child.once("close", (exitCode, signal) => {
			settled = true;
			if (hardKillTimer) clearTimeout(hardKillTimer);
			input.registerTimeout?.(undefined);
			input.registerStop?.(undefined);
			const endedAt = Date.now();
			const externalProcess: ExternalProcessStatus = {
				...initialProcess,
				endedAt,
				durationMs: endedAt - startedAt,
				exitCode,
				processSignal: signal,
			};
			input.onProcess?.(externalProcess);
			const stderr = stderrTail.toString("utf-8").trim();
			const error = stopped
				? input.stopMessage ?? "Subagent stopped by user."
				: timedOut
					? input.timeoutMessage ?? "Subagent timed out."
					: spawnError?.message ?? (exitCode === 0 ? undefined : stderr || `External CLI exited with code ${exitCode}.`);
			const result: ExternalCliRunResult = {
				output: stdoutTail.toString("utf-8").trim(),
				exitCode: timedOut || stopped || spawnError ? 1 : exitCode,
				...(error ? { error } : {}),
				...(timedOut ? { timedOut: true } : {}),
				...(stopped ? { stopped: true } : {}),
				processSignal: signal,
				externalProcess,
			};
			stdoutStream.end();
			stderrStream.end();
			void streamsFinished.then((streamResults) => {
				const streamFailure = streamResults.find((streamResult) => streamResult.status === "rejected");
				if (streamFailure?.status === "rejected") reject(streamFailure.reason);
				else resolve(result);
			});
		});
	});
}
