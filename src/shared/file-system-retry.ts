const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;
const RETRYABLE_FILE_SYSTEM_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const STORAGE_CAPACITY_ERROR_CODES = new Set(["EDQUOT", "EMFILE", "ENFILE", "ENOSPC"]);

export const FS_RETRY_MAX_TOTAL_MS_ENV = "PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS";

const BASE_FILE_SYSTEM_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;

/**
 * Clamp the retry ladder to a total sleep budget, preserving its length.
 *
 * waitForFileSystemRetry blocks the calling thread, so the ladder above is also
 * a ceiling on how long a single contended rename can stall that thread: about
 * 7.9s. That is fine for a short-lived CLI. A long-lived host that loads this
 * extension in-process runs the same writers on its event loop, where an 8s
 * stall stops it serving anything at all -- and because Atomics.wait parks
 * rather than spins, it presents as an unresponsive process at 0% CPU.
 *
 * The length is preserved deliberately: run-fanout-budget.ts and
 * workflow-state.ts index this array by attempt number and treat running off
 * the end as "timed out acquiring lock". Shortening it would quietly shrink
 * those attempt budgets too, so only the sleeps shrink here.
 *
 * Unset by default, so behaviour is unchanged unless a host opts in. Opting in
 * trades lock-wait tolerance for responsiveness: entries clamped to 0 return
 * immediately, so contention that would previously have been waited out is
 * surfaced as an error sooner.
 */
export function resolveFileSystemRetryDelays(
	env: NodeJS.ProcessEnv = process.env,
	base: readonly number[] = BASE_FILE_SYSTEM_RETRY_DELAYS_MS,
): readonly number[] {
	const raw = env[FS_RETRY_MAX_TOTAL_MS_ENV];
	if (raw === undefined || raw.trim() === "") return base;
	const budget = Number(raw);
	if (!Number.isInteger(budget) || budget < 0) {
		throw new Error(`${FS_RETRY_MAX_TOTAL_MS_ENV} must be a non-negative integer number of milliseconds.`);
	}
	let spent = 0;
	return base.map((delayMs) => {
		const allowed = Math.max(0, Math.min(delayMs, budget - spent));
		spent += allowed;
		return allowed;
	});
}

export const DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS = resolveFileSystemRetryDelays();

export type FileSystemRetryOptions = {
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
};

export function waitForFileSystemRetry(delayMs: number): void {
	if (delayMs <= 0) return;
	if (WAIT_VIEW) {
		try {
			// Callers are synchronous status/result writers; Atomics.wait gives
			// Windows directory and rename locks time to clear without burning CPU.
			Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
			return;
		} catch {
			// Fall through to the portable busy wait below.
		}
	}
	const end = Date.now() + delayMs;
	while (Date.now() < end) {
		// Portable fallback for runtimes where Atomics.wait is unavailable.
	}
}

export function isRetryableFileSystemError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FILE_SYSTEM_ERROR_CODES.has(code);
}

export function isStorageCapacityError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && STORAGE_CAPACITY_ERROR_CODES.has(code);
}

export function runFileSystemOperationWithRetry<T>(operation: () => T, options: FileSystemRetryOptions = {}): T {
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	const wait = options.wait ?? waitForFileSystemRetry;
	for (let attempt = 0; ; attempt++) {
		try {
			return operation();
		} catch (error) {
			const delayMs = retryDelaysMs[attempt];
			if (delayMs === undefined || !isRetryableFileSystemError(error)) throw error;
			wait(delayMs);
		}
	}
}
