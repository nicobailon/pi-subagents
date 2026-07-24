const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;
const RETRYABLE_FILE_SYSTEM_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

export const DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;

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
