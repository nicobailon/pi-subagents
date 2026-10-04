import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, waitForFileSystemRetry } from "./file-system-retry.ts";

const require = createRequire(import.meta.url);
let lockSync: typeof import("proper-lockfile").lockSync | undefined;

/** Coordinate a short synchronous mutation; the caller resolves file symlinks. */
export function withFileWriteLock<T>(filePath: string, action: () => T, options: { lockfilePath?: string } = {}): T {
	// Read-only configuration and schedule imports never load the lock library.
	const acquire = lockSync ??= require("proper-lockfile").lockSync as typeof import("proper-lockfile").lockSync;
	const target = path.join(fs.realpathSync.native(path.dirname(filePath)), path.basename(filePath));
	const waitBudget = Math.min(200, DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
	const deadline = performance.now() + waitBudget;
	let release: () => void;
	for (;;) {
		try {
			release = acquire(target, { realpath: false, stale: 60_000, ...options });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || performance.now() >= deadline) throw error;
			waitForFileSystemRetry(Math.min(10, Math.max(0, deadline - performance.now())));
		}
	}
	let failed = false;
	try {
		return action();
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		try { release(); }
		catch (error) { if (!failed) throw error; }
	}
}
