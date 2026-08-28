import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { quoteExecutableForShell } from "../runs/shared/acceptance.ts";
import { createOwnedProcessTreeController, type OwnedProcessTreeController } from "../runs/background/owned-process-tree.ts";
import { resolveSingleOutputClaimPath } from "../runs/shared/single-output.ts";

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_OUTPUT_PATH_BYTES = 240;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface WorkflowHostCommandParams {
	kind: "command";
	command: string;
	timeoutMs: number;
	output?: string;
	role?: "ci" | "gate";
	provider?: string;
}

export interface WorkflowHostCommandResult {
	key: string;
	kind: "command";
	ok: boolean;
	state: "passed" | "failed" | "timed-out" | "stopped";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	outputPath: string;
	durationMs: number;
	error?: string;
}

type ProcessTreeTerminal = Awaited<ReturnType<OwnedProcessTreeController["terminate"]>>;
type ProcessTreeCleanup = ProcessTreeTerminal | { state: "unknown"; reason: "missing-process-id" };

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function boundedText(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	let end = Math.max(0, maxBytes - 3);
	while (end > 0 && byteLength(value.slice(0, end)) > maxBytes - 3) end -= 1;
	return `${value.slice(0, end)}...`;
}

export function normalizeWorkflowHostCommandParams(value: unknown, label = "runs.host params"): WorkflowHostCommandParams {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const params = value as Record<string, unknown>;
	const unknownFields = Object.keys(params).filter((field) => !["kind", "command", "timeoutMs", "output", "role", "provider"].includes(field));
	if (unknownFields.length) throw new Error(`${label} has unsupported fields: ${unknownFields.join(", ")}.`);
	if (params.kind !== "command") throw new Error(`${label}.kind must be 'command'.`);
	if (typeof params.command !== "string" || !params.command.trim()) throw new Error(`${label}.command must be a non-empty string.`);
	const command = params.command.trim();
	if (byteLength(command) > MAX_COMMAND_BYTES || /[\u0000]/.test(command)) throw new Error(`${label}.command exceeds the ${MAX_COMMAND_BYTES}-byte limit or contains NUL.`);
	if (typeof params.timeoutMs !== "number" || !Number.isInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > MAX_TIMEOUT_MS) throw new Error(`${label}.timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
	let output: string | undefined;
	if (params.output !== undefined) {
		if (typeof params.output !== "string" || !params.output.trim()) throw new Error(`${label}.output must be a non-empty relative path.`);
		output = params.output.trim();
		if (path.isAbsolute(output) || output.split(/[\\/]/).includes("..") || /[\u0000-\u001f\u007f]/.test(output) || byteLength(output) > MAX_OUTPUT_PATH_BYTES) throw new Error(`${label}.output must be a bounded relative path without traversal or control characters.`);
	}
	if (params.role !== undefined && params.role !== "ci" && params.role !== "gate") throw new Error(`${label}.role must be 'ci' or 'gate'.`);
	let provider: string | undefined;
	if (params.provider !== undefined) {
		if (typeof params.provider !== "string" || !params.provider.trim() || /[\r\n\u0000]/.test(params.provider) || byteLength(params.provider.trim()) > 64) throw new Error(`${label}.provider must be a non-empty single-line string of at most 64 bytes.`);
		provider = params.provider.trim();
	}
	return {
		kind: "command",
		command,
		timeoutMs: params.timeoutMs,
		...(output ? { output } : {}),
		...(params.role ? { role: params.role } : {}),
		...(provider ? { provider } : {}),
	};
}

function appendBounded(current: string, chunk: Buffer, limit: number): string {
	if (byteLength(current) >= limit) return current;
	return boundedText(current + chunk.toString("utf8"), limit);
}

export function resolveWorkflowHostOutputClaimPath(outputPath: string): string {
	return resolveSingleOutputClaimPath(outputPath);
}

function assertSafeExplicitOutput(cwd: string, outputPath: string, key: string): void {
	const root = fs.realpathSync(cwd);
	const outputParent = path.dirname(outputPath);
	let existingParent = outputParent;
	while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
	const existingParentReal = fs.realpathSync(existingParent);
	const existingRelative = path.relative(root, existingParentReal);
	if (existingRelative === ".." || existingRelative.startsWith(`..${path.sep}`) || path.isAbsolute(existingRelative)) throw new Error(`runs.host('${key}') output resolves outside the workflow cwd.`);
	fs.mkdirSync(outputParent, { recursive: true });
	const parent = fs.realpathSync(outputParent);
	const relative = path.relative(root, parent);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`runs.host('${key}') output resolves outside the workflow cwd.`);
	try {
		const stat = fs.lstatSync(outputPath);
		if (!stat.isFile() || stat.nlink > 1) throw new Error(`runs.host('${key}') output must be a regular, non-linked file path.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function terminateProcessTree(pid: number, controller: OwnedProcessTreeController): Promise<ProcessTreeTerminal> {
	if (process.platform !== "win32") return controller.terminate();
	return new Promise<ProcessTreeTerminal>((resolve) => {
		const cleanup = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		cleanup.once("error", () => { void controller.terminate().then(resolve); });
		cleanup.once("close", () => { void controller.terminate().then(resolve); });
	});
}

export async function executeWorkflowHostCommand(input: {
	key: string;
	params: WorkflowHostCommandParams;
	cwd: string;
	defaultOutputPath: string;
	claimedOutputPath?: string;
	signal: AbortSignal;
}): Promise<WorkflowHostCommandResult> {
	const outputPath = input.params.output ? path.resolve(input.cwd, input.params.output) : input.defaultOutputPath;
	const relative = path.relative(input.cwd, outputPath);
	if (input.params.output && (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error(`runs.host('${input.key}') output escapes the workflow cwd.`);
	if (input.params.output) assertSafeExplicitOutput(input.cwd, outputPath, input.key);
	else fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	const startedAt = Date.now();
	let stdout = "";
	let stderr = "";
	let capture = "";
	let timedOut = false;
	let stopped = false;
	let settled = false;

	return new Promise((resolve, reject) => {
		const child = spawn(quoteExecutableForShell(input.params.command), {
			cwd: input.cwd,
			env: process.env,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		const processTree = typeof child.pid === "number" ? createOwnedProcessTreeController(child.pid, { termGraceMs: 1_000 }) : undefined;
		let termination: Promise<ProcessTreeCleanup> | undefined;
		const terminate = (reason: "timeout" | "abort") => {
			if (settled) return;
			timedOut = reason === "timeout";
			stopped = reason === "abort";
			if (processTree && child.pid !== undefined) termination ??= terminateProcessTree(child.pid, processTree);
			else {
				child.kill("SIGTERM");
				termination ??= Promise.resolve({ state: "unknown", reason: "missing-process-id" });
			}
		};
		const timeout = setTimeout(() => terminate("timeout"), input.params.timeoutMs);
		timeout.unref?.();
		const onAbort = () => terminate("abort");
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk, MAX_PREVIEW_BYTES);
			capture = appendBounded(capture, chunk, MAX_CAPTURE_BYTES);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk, MAX_PREVIEW_BYTES);
			capture = appendBounded(capture, chunk, MAX_CAPTURE_BYTES);
		});
		const finish = async (exitCode: number | null, spawnError?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			input.signal.removeEventListener("abort", onAbort);
			const terminal = termination ? await termination : await processTree?.finishAfterWriterClose();
			const cleanupError = process.platform !== "win32" && terminal?.state === "unknown" ? terminal.reason : undefined;
			const state = timedOut ? "timed-out" : stopped ? "stopped" : exitCode === 0 && !spawnError && !cleanupError ? "passed" : "failed";
			const error = spawnError instanceof Error ? spawnError.message : spawnError ? String(spawnError) : cleanupError ? `Process-tree cleanup failed: ${cleanupError}.` : state === "timed-out" ? `Command timed out after ${input.params.timeoutMs}ms.` : state === "stopped" ? "Command stopped because the workflow was aborted." : state === "failed" ? `Command exited with code ${exitCode ?? "unknown"}.` : undefined;
			try {
				if (input.params.output) assertSafeExplicitOutput(input.cwd, outputPath, input.key);
				if (input.claimedOutputPath && resolveWorkflowHostOutputClaimPath(outputPath) !== input.claimedOutputPath) throw new Error(`output path changed after it was claimed.`);
				fs.writeFileSync(outputPath, capture, { encoding: "utf8", mode: 0o600 });
			} catch (writeError) {
				reject(new Error(`runs.host('${input.key}') could not save command output: ${writeError instanceof Error ? writeError.message : String(writeError)}`, { cause: writeError instanceof Error ? writeError : undefined }));
				return;
			}
			resolve({ key: input.key, kind: "command", ok: state === "passed", state, exitCode, stdout, stderr, outputPath, durationMs: Date.now() - startedAt, ...(error ? { error } : {}) });
		};
		child.on("close", (code) => { void finish(code); });
		child.on("error", (error) => { void finish(null, error); });
	});
}
