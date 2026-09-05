import { spawn } from "node:child_process";
import { createOwnedProcessTreeController } from "../background/owned-process-tree.ts";
import type { ProcessTreeTerminal } from "../../shared/types.ts";

export interface SetupCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
	/** Worktrunk uses 128 KiB; Git and hooks use spawnSync's 1 MiB default. */
	maxBuffer?: number;
	signal?: AbortSignal;
	deadlineAt?: number;
	/** Only the existing configured setup-hook timeout, not a new Git budget. */
	hookTimeoutMs?: number;
	/** Read-only probes may define negative answers as completed commands. */
	acceptedExitCodes?: readonly number[];
	onSpawn?: (process: { pid: number; processGroupId?: number }) => void;
}

export interface SetupCommandResult {
	stdout: string;
	stderr: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
	pid?: number;
	processGroupId?: number;
	/** Absent on normal completion: trusted command completion is NOT tree proof. */
	processTree?: ProcessTreeTerminal;
	outputIncomplete: boolean;
}

function commandError(message: string, code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

/**
 * Setup I/O only. Commands must await their descendants before reporting success.
 * Exit 0 + natural close + complete output still requires caller JSON/path validation.
 * Invalid output is NOT accepted completion: retain unknown ownership, never signal
 * this completed command's PID later. Callers own compensation and admission.
 */
export async function runSetupCommand(
	command: string,
	args: string[],
	options: SetupCommandOptions,
): Promise<SetupCommandResult> {
	const result: SetupCommandResult = {
		stdout: "", stderr: "", status: null, signal: null, outputIncomplete: false,
	};
	const maxBuffer = options.maxBuffer ?? 1024 * 1024;
	if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) throw new Error("Invalid setup command maxBuffer");
	if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)) throw new Error("Invalid setup deadline");
	if (options.hookTimeoutMs !== undefined && (!Number.isSafeInteger(options.hookTimeoutMs) || options.hookTimeoutMs <= 0)) {
		throw new Error("Invalid setup hook timeout");
	}
	const cancellation = (): Error | undefined => {
		if (options.signal?.aborted) return commandError("Worktree setup aborted", "ABORT_ERR");
		if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
			return commandError("Worktree setup deadline exceeded", "ETIMEDOUT");
		}
		return undefined;
	};
	result.error = cancellation();
	if (result.error) return result;

	let child;
	try {
		child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: "pipe", shell: false, windowsHide: true,
			// Isolated owned POSIX group, never unref'd or fire-and-forget.
			detached: process.platform !== "win32",
		});
	} catch (error) {
		result.error = error instanceof Error ? error : new Error(String(error));
		return result;
	}
	result.pid = child.pid;
	if (child.pid !== undefined && process.platform !== "win32") result.processGroupId = child.pid;
	const tree = child.pid === undefined ? undefined : createOwnedProcessTreeController(child.pid);
	let termination: Promise<ProcessTreeTerminal> | undefined;
	let directSettled = false;
	const releaseUnknownIO = () => {
		if (!directSettled || result.processTree?.state !== "unknown") return;
		result.error ??= commandError("Worktree setup process tree settlement is unverified", "PROCESS_TREE_UNVERIFIED");
		result.outputIncomplete = true;
		// Only local I/O is released; unknown descendant ownership remains retained.
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
	};
	const terminate = () => {
		if (termination || !tree) return;
		if (directSettled) {
			result.processTree = {
				state: "unknown", reason: "verification-failed",
				diagnostic: "Command exited before termination began; no longer safe to signal its recorded PID.",
			};
			releaseUnknownIO();
			return;
		}
		termination = tree.terminate().then((proof) => {
			result.processTree = proof;
			releaseUnknownIO();
			return proof;
		});
	};
	const fail = (error: Error) => {
		result.error ??= error;
		terminate();
	};
	const onAbort = () => fail(commandError("Worktree setup aborted", "ABORT_ERR"));
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let capturedBytes = 0;
	const capture = (chunks: Buffer[], chunk: Buffer) => {
		const remaining = maxBuffer - capturedBytes;
		if (remaining > 0) {
			const saved = Buffer.from(chunk.subarray(0, remaining));
			chunks.push(saved);
			capturedBytes += saved.length;
		}
		if (chunk.length > remaining) {
			result.outputIncomplete = true;
			fail(commandError("Worktree setup command output exceeds maxBuffer", "ENOBUFS"));
		}
	};
	const onStdout = (chunk: Buffer) => capture(stdout, chunk);
	const onStderr = (chunk: Buffer) => capture(stderr, chunk);
	child.stdout.on("data", onStdout);
	child.stderr.on("data", onStderr);
	child.stdin.on("error", fail);
	const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const directExit = new Promise<void>((resolve) => {
		child.once("exit", (status, signal) => {
			directSettled = true;
			result.status = status;
			result.signal = signal;
			if (status === null || !(options.acceptedExitCodes ?? [0]).includes(status)) terminate();
			releaseUnknownIO();
			resolve();
		});
		child.once("error", (error) => {
			fail(error);
			// A failed spawn has no direct process to await. Other errors do not prove exit.
			if (child.pid === undefined) {
				directSettled = true;
				resolve();
			}
		});
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadlineAt = Math.min(options.deadlineAt ?? Infinity,
		options.hookTimeoutMs === undefined ? Infinity : Date.now() + options.hookTimeoutMs);
	const armDeadline = () => {
		if (deadlineAt === Infinity) return;
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) fail(commandError("Worktree setup command timed out", "ETIMEDOUT"));
		else timer = setTimeout(armDeadline, Math.min(remaining, 2 ** 31 - 1));
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		armDeadline();
		if (options.signal?.aborted) onAbort();
		if (child.pid !== undefined) {
			try { options.onSpawn?.({ pid: child.pid, processGroupId: result.processGroupId }); }
			catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		}
		child.stdin.end(options.input);
		await directExit;
		if (termination) result.processTree = await termination;
		releaseUnknownIO();
		await close;
		// Abort/overflow may arrive while draining stdio after direct exit.
		if (termination) result.processTree = await termination;
		const cancelled = cancellation();
		if (cancelled) fail(cancelled);
		result.stdout = Buffer.concat(stdout).toString("utf8");
		result.stderr = Buffer.concat(stderr).toString("utf8");
		return result;
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		child.stdout.removeListener("data", onStdout);
		child.stderr.removeListener("data", onStderr);
		child.stdin.removeListener("error", fail);
	}
}
