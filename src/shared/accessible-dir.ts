import * as fs from "node:fs";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.ts";

type AccessibleDirFs = Pick<typeof fs, "accessSync" | "mkdirSync">;

type AccessibleDirOptions = {
	fs?: AccessibleDirFs;
	retryDirectoryErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
};

export function ensureAccessibleDir(dirPath: string, options: AccessibleDirOptions = {}): void {
	const fsImpl = options.fs ?? fs;
	const retryDirectoryErrors = options.retryDirectoryErrors ?? process.platform === "win32";
	const retryDelaysMs = retryDirectoryErrors ? options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS : [];
	const wait = options.wait ?? waitForFileSystemRetry;

	runFileSystemOperationWithRetry(() => {
		fsImpl.mkdirSync(dirPath, { recursive: true });
	}, { retryDelaysMs, wait });
	runFileSystemOperationWithRetry(() => {
		fsImpl.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}, { retryDelaysMs, wait });
}
