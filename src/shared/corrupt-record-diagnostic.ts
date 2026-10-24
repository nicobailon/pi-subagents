import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";

const reported = new Map<string, string>();
const MAX_REPORTED_CORRUPT_RECORDS = 512;
const MAX_FINGERPRINT_BYTES = 16 * 1024 * 1024;

export function corruptRecordPath(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const match = error.message.match(/^Invalid mission (?:binding )?file '(.+)'(?::|$)/);
	return match?.[1];
}

/** Return true once per unchanged corrupt file observation; changed bytes are eligible again. */
export function shouldReportCorruptRecord(filePath: string): boolean {
	let fingerprint: string;
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > MAX_FINGERPRINT_BYTES) {
			fingerprint = `oversized:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
		} else {
			const bytes = fs.readFileSync(filePath);
			fingerprint = createHash("sha256").update(bytes).digest("hex");
		}
	} catch {
		// A missing/unreadable file is not evidence that the corrupt bytes are unchanged.
		return true;
	}
	const key = path.resolve(filePath);
	if (reported.get(key) === fingerprint) return false;
	reported.delete(key);
	reported.set(key, fingerprint);
	while (reported.size > MAX_REPORTED_CORRUPT_RECORDS) {
		const oldest = reported.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		reported.delete(oldest);
	}
	return true;
}
