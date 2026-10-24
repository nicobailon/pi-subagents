import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";

interface ReportedCorruptRecord {
	fingerprint: string;
	metadata: string;
	verifiedAt: number;
}

const reported = new Map<string, ReportedCorruptRecord>();
const MAX_REPORTED_CORRUPT_RECORDS = 512;
/** Re-read unchanged metadata periodically so same-metadata rewrites are eventually detected. */
export const CORRUPT_RECORD_REVALIDATION_INTERVAL_MS = 1_000;
const FINGERPRINT_CHUNK_BYTES = 64 * 1024;

export function corruptRecordPath(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const match = error.message.match(/^Invalid mission (?:binding )?file '(.+)'(?::|$)/);
	return match?.[1];
}

function metadataFingerprint(stat: fs.Stats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function contentFingerprint(filePath: string): string {
	const hash = createHash("sha256");
	const fd = fs.openSync(filePath, "r");
	const buffer = Buffer.allocUnsafe(FINGERPRINT_CHUNK_BYTES);
	try {
		let position = 0;
		while (true) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest("hex");
}

/** Deduplicate diagnostics for unchanged bytes, rechecking same-metadata files at a bounded interval. */
export function shouldReportCorruptRecord(filePath: string, now = Date.now()): boolean {
	const key = path.resolve(filePath);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		// A missing/unreadable file is not evidence that the corrupt bytes are unchanged.
		return true;
	}
	const metadata = metadataFingerprint(stat);
	const previous = reported.get(key);
	if (previous && previous.metadata === metadata && now - previous.verifiedAt < CORRUPT_RECORD_REVALIDATION_INTERVAL_MS) {
		reported.delete(key);
		reported.set(key, previous);
		return false;
	}

	let fingerprint: string;
	try {
		fingerprint = contentFingerprint(filePath);
	} catch {
		// A transient read failure must not suppress a future diagnostic.
		return true;
	}
	const unchanged = previous?.fingerprint === fingerprint;
	reported.delete(key);
	reported.set(key, { fingerprint, metadata, verifiedAt: now });
	while (reported.size > MAX_REPORTED_CORRUPT_RECORDS) {
		const oldest = reported.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		reported.delete(oldest);
	}
	return !unchanged;
}
