import * as fs from "node:fs";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.ts";

type AccessibleDirFs = Pick<typeof fs, "accessSync" | "mkdirSync" | "rmSync">;

type AccessibleDirOptions = {
	fs?: AccessibleDirFs;
	retryDirectoryErrors?: boolean;
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
	/** Injectable pid override for deterministic pid-scoped fallback paths in tests. */
	pid?: number;
};

/**
 * Ensure a directory exists and is readable/writable.
 *
 * On Windows a persistent `EPERM`/`EACCES` (typically corrupted NTFS ACLs after
 * wake-from-sleep on Azure AD/Entra ID machines) can make `mkdirSync` fail
 * permanently. Transient locks are handled by retrying; once the retries are
 * exhausted the directory is recreated in place, and if that is still blocked a
 * fresh pid-scoped sibling path is created and returned so extension load does
 * not crash the whole Pi process.
 *
 * @returns the directory path to use — the requested path when it is usable,
 * otherwise the pid-scoped fallback path that was actually created.
 */
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
	const recreateInPlace = (): boolean => {
		try {
			fsImpl.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Deletion also blocked — fall through to pid-scoped fallback below.
			return false;
		}
		try {
			mkdirWithRetry(dirPath);
			accessWithRetry(dirPath);
			return true;
		} catch {
			return false;
		}
	};
	const pidScopedFallback = (): string => {
		const fallback = `${dirPath}-${pid}`;
		mkdirWithRetry(fallback);
		accessWithRetry(fallback);
		return fallback;
	};

	try {
		mkdirWithRetry(dirPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "EPERM" && code !== "EACCES") throw error;
		// ACL corruption: try delete + recreate in place; if still blocked use a
		// fresh pid-scoped sibling path.
		if (recreateInPlace()) return dirPath;
		return pidScopedFallback();
	}

	try {
		accessWithRetry(dirPath);
		return dirPath;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "EPERM" && code !== "EACCES") throw error;
		if (recreateInPlace()) return dirPath;
		return pidScopedFallback();
	}
}
