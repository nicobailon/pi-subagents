import * as fs from "node:fs";
import * as path from "node:path";

type AtomicJsonFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync">;

type AtomicJsonWriterOptions = {
	fs?: AtomicJsonFs;
	now?: () => number;
	pid?: number;
	random?: () => number;
	mode?: number;
	retryRenameErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
};

const DEFAULT_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;
const RETRYABLE_RENAME_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;

function waitSync(delayMs: number): void {
	if (delayMs <= 0) return;
	if (WAIT_VIEW) {
		try {
			// writeAtomicJson is synchronous because callers often update status from sync callbacks.
			// Atomics.wait gives Windows rename locks time to clear without burning CPU.
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

function isRetryableRenameError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_RENAME_ERROR_CODES.has(code);
}

function renameWithRetry(
	fsImpl: AtomicJsonFs,
	sourcePath: string,
	targetPath: string,
	retryDelaysMs: readonly number[],
	wait: (delayMs: number) => void,
): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fsImpl.renameSync(sourcePath, targetPath);
			return;
		} catch (error) {
			const delayMs = retryDelaysMs[attempt];
			if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
			wait(delayMs);
		}
	}
}

export function createAtomicJsonWriter(options: AtomicJsonWriterOptions = {}): (filePath: string, payload: object) => void {
	const fsImpl = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const random = options.random ?? Math.random;
	const mode = options.mode;
	const retryRenameErrors = options.retryRenameErrors ?? process.platform === "win32";
	const retryDelaysMs = retryRenameErrors ? options.retryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS : [];
	const wait = options.wait ?? waitSync;
	return (filePath: string, payload: object): void => {
		fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
		const tempPath = path.join(
			path.dirname(filePath),
			`.${path.basename(filePath)}.${pid}.${now()}.${random().toString(36).slice(2)}.tmp`,
		);
		try {
			fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			renameWithRetry(fsImpl, tempPath, filePath, retryDelaysMs, wait);
		} finally {
			fsImpl.rmSync(tempPath, { force: true });
		}
	};
}

export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
