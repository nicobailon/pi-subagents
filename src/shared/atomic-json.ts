import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.ts";

type AtomicJsonFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync">;

const MAX_PATH_COMPONENT_BYTES = 255;

type AtomicJsonWriterOptions = {
	fs?: AtomicJsonFs;
	now?: () => number;
	pid?: number;
	random?: () => number;
	mode?: number;
	retryRenameErrors?: boolean;
	retryDirectoryErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
};

function renameWithRetry(
	fsImpl: AtomicJsonFs,
	sourcePath: string,
	targetPath: string,
	retryDelaysMs: readonly number[],
	wait: (delayMs: number) => void,
): void {
	runFileSystemOperationWithRetry(() => {
		fsImpl.renameSync(sourcePath, targetPath);
	}, { retryDelaysMs, wait });
}

function tempBaseName(filePath: string, pid: number, nowMs: number, randomId: string): string {
	const suffix = `.${pid}.${nowMs}.${randomId}.tmp`;
	const preferred = `.${path.basename(filePath)}${suffix}`;
	if (Buffer.byteLength(preferred, "utf-8") <= MAX_PATH_COMPONENT_BYTES) return preferred;
	return `.${createHash("sha256").update(path.basename(filePath)).digest("hex")}${suffix}`;
}

export function createAtomicJsonWriter(options: AtomicJsonWriterOptions = {}): (filePath: string, payload: object) => void {
	const fsImpl = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const random = options.random ?? Math.random;
	const mode = options.mode;
	const retryRenameErrors = options.retryRenameErrors ?? process.platform === "win32";
	const retryDirectoryErrors = options.retryDirectoryErrors ?? retryRenameErrors;
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	const renameRetryDelaysMs = retryRenameErrors ? retryDelaysMs : [];
	const directoryRetryDelaysMs = retryDirectoryErrors ? retryDelaysMs : [];
	const wait = options.wait ?? waitForFileSystemRetry;
	return (filePath: string, payload: object): void => {
		runFileSystemOperationWithRetry(() => {
			fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
		}, { retryDelaysMs: directoryRetryDelaysMs, wait });
		const tempPath = path.join(
			path.dirname(filePath),
			tempBaseName(filePath, pid, now(), random().toString(36).slice(2)),
		);
		let writeError: unknown;
		try {
			fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
			renameWithRetry(fsImpl, tempPath, filePath, renameRetryDelaysMs, wait);
		} catch (error) {
			writeError = error;
			throw error;
		} finally {
			try {
				fsImpl.rmSync(tempPath, { force: true });
			} catch (cleanupError) {
				// Preserve the write/rename failure: cleanup is best effort and must
				// not hide the error callers need to classify or report.
				if (writeError === undefined) throw cleanupError;
			}
		}
	};
}

export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
