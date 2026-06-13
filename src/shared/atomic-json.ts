import * as fs from "node:fs";
import * as path from "node:path";

function renameWithRetry(src: string, dest: string, maxRetries: number): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(src, dest);
			return;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (attempt >= maxRetries || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
			const delayMs = 50 * (2 ** attempt);
			const end = Date.now() + delayMs;
			while (Date.now() < end) { /* spin-wait: sync context, cannot await */ }
		}
	}
}

export function writeAtomicJson(filePath: string, payload: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf-8");
		renameWithRetry(tempPath, filePath, 3);
	} finally {
		fs.rmSync(tempPath, { force: true });
	}
}
