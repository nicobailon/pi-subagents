import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { waitForFileSystemRetry } from "./file-system-retry.ts";

/** Coordinate a short synchronous mutation; the caller resolves file symlinks. */
export function withFileWriteLock<T>(filePath: string, action: () => T): T {
	const target = path.join(fs.realpathSync.native(path.dirname(filePath)), path.basename(filePath));
	const deadline = Date.now() + 200;
	let release: () => void;
	for (;;) {
		try {
			release = lockfile.lockSync(target, { realpath: false, stale: 60_000 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
			waitForFileSystemRetry(Math.min(10, Math.max(0, deadline - Date.now())));
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
