import { execFile } from "node:child_process";

export type TmuxErrorCode =
	| "TMUX_UNAVAILABLE"
	| "TMUX_ERROR"
	| "PANE_GONE"
	| "TIMEOUT";

export type TmuxResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: { code: TmuxErrorCode; message: string; details?: unknown } };

export interface TmuxClient {
	run(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TmuxResult<string>>;
}

type ExecTmux = (
	file: string,
	args: readonly string[],
	options: { timeout: number; signal?: AbortSignal },
	callback: (error: Error | null, stdout: string, stderr?: string) => void,
) => unknown;

function error(code: TmuxErrorCode, message: string, details?: unknown): TmuxResult<never> {
	return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function failureText(execError: Error, stderr?: string): string {
	const direct = stderr?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
	if (direct) return direct;
	const lines = execError.message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const withoutPrefix = lines.filter((line) => !/^Command failed:/.test(line));
	return withoutPrefix[0] ?? "tmux failed.";
}

function classifyFailure(text: string): TmuxErrorCode {
	const lower = text.toLowerCase();
	if (lower.includes("can't find pane") || lower.includes("can't find window")) return "PANE_GONE";
	if (lower.includes("no server running") || lower.includes("no current client")) return "TMUX_UNAVAILABLE";
	return "TMUX_ERROR";
}

export function createTmuxClient(options: { bin?: string; exec?: ExecTmux } = {}): TmuxClient {
	const bin = options.bin ?? process.env.TMUX_BIN ?? "tmux";
	const execImpl = options.exec ?? execFile;
	return {
		run(args: string[], runOptions: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TmuxResult<string>> {
			return new Promise((resolve) => {
				let settled = false;
				const abort = () => finish(error("TIMEOUT", `tmux command '${args.join(" ")}' was aborted.`));
				const finish = (result: TmuxResult<string>) => {
					if (settled) return;
					settled = true;
					runOptions.signal?.removeEventListener("abort", abort);
					resolve(result);
				};
				if (runOptions.signal?.aborted) {
					abort();
					return;
				}
				runOptions.signal?.addEventListener("abort", abort, { once: true });
				execImpl(bin, args, { timeout: runOptions.timeoutMs ?? 10_000, signal: runOptions.signal }, (execError, stdout, stderr) => {
					if (execError) {
						const code = (execError as NodeJS.ErrnoException).code;
						if (code === "ENOENT") {
							finish(error("TMUX_UNAVAILABLE", "tmux is not installed or is not on PATH."));
							return;
						}
						// Node reports its own timeout expiry as a killed child, not as our abort listener firing.
						const killed = execError as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
						if (killed.killed === true || killed.signal) {
							finish(error("TIMEOUT", `tmux command '${args.join(" ")}' timed out.`));
							return;
						}
						const text = failureText(execError, stderr);
						const exitCode = Number(code);
						finish(error(exitCode === 127 ? "TMUX_UNAVAILABLE" : classifyFailure(text), text));
						return;
					}
					finish({ ok: true, data: stdout.trim() });
				});
			});
		},
	};
}
