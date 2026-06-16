import * as fs from "node:fs";
import * as path from "node:path";

type RenameSync = (src: string, dest: string) => void;

interface WriteAtomicJsonOptions {
	renameSync?: RenameSync;
	maxRenameRetries?: number;
	delayMsForAttempt?: (attempt: number) => number;
}

export function isRetryableAtomicRenameError(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function sleepSync(delayMs: number): void {
	const end = Date.now() + delayMs;
	while (Date.now() < end) { /* spin-wait: sync context, cannot await */ }
}

function renameWithRetry(
	src: string,
	dest: string,
	maxRetries: number,
	renameSync: RenameSync,
	delayMsForAttempt: (attempt: number) => number,
): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(src, dest);
			return;
		} catch (err: unknown) {
			if (attempt >= maxRetries || !isRetryableAtomicRenameError(err)) throw err;
			sleepSync(delayMsForAttempt(attempt));
		}
	}
}

export function writeAtomicJson(filePath: string, payload: object, options: WriteAtomicJsonOptions = {}): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
		renameWithRetry(
			tempPath,
			filePath,
			options.maxRenameRetries ?? 3,
			options.renameSync ?? fs.renameSync,
			options.delayMsForAttempt ?? ((attempt) => 50 * (2 ** attempt)),
		);
	} finally {
		fs.rmSync(tempPath, { force: true });
	}
}
