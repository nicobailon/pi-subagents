import * as fs from "node:fs";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.ts";

type AccessibleDirFs = Pick<typeof fs, "accessSync" | "mkdirSync">;

type AccessibleDirOptions = {
	fs?: AccessibleDirFs;
	retryDirectoryErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
	pid?: number;
};

export function ensureAccessibleDir(dirPath: string, options: AccessibleDirOptions = {}): string {
	const fsImpl = options.fs ?? fs;
	const pid = options.pid ?? process.pid;
	const retryDirectoryErrors = options.retryDirectoryErrors ?? process.platform === "win32";
	const retryDelaysMs = retryDirectoryErrors ? options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS : [];
	const wait = options.wait ?? waitForFileSystemRetry;

	const mkdirWithRetry = (target: string): void => {
		runFileSystemOperationWithRetry(() => {
			fsImpl.mkdirSync(target, { recursive: true });
		}, { retryDelaysMs, wait });
	};
	const accessWithRetry = (target: string): void => {
		runFileSystemOperationWithRetry(() => {
			fsImpl.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
		}, { retryDelaysMs, wait });
	};
	const fallbackPath = (): string => {
		const fallback = `${dirPath}-${pid}`;
		mkdirWithRetry(fallback);
		accessWithRetry(fallback);
		return fallback;
	};

	try {
		mkdirWithRetry(dirPath);
		accessWithRetry(dirPath);
		return dirPath;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "EPERM" && code !== "EACCES") throw error;
		return fallbackPath();
	}
}
