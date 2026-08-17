import { createHash } from "node:crypto";

/**
 * Keep opaque index keys below common filesystem component limits.
 *
 * Portable short values retain the historical URI-encoded representation.
 * Oversized or non-portable values use a deterministic digest so callers can
 * resolve the same index without persisting a separate lookup table.
 *
 * Encoded backslashes and trailing file extensions are not portable. Pi session
 * ids are often the full session `.jsonl` path. On Windows, `readdir` of a
 * directory whose name ends in `.jsonl` or contains `%5C` can fail with EPERM.
 */
export const MAX_INDEX_SEGMENT_BYTES = 255;
const HASHED_INDEX_SEGMENT_PREFIX = "~sha256-";
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function hashedSegment(value: string): string {
	return `${HASHED_INDEX_SEGMENT_PREFIX}${createHash("sha256").update(value).digest("hex")}`;
}

function isPortableSegment(value: string): boolean {
	return value.length > 0
		&& value !== "."
		&& value !== ".."
		&& !value.endsWith(".")
		&& !WINDOWS_RESERVED_NAME.test(value)
		&& !/%5C/i.test(value)
		&& !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(value);
}

export function encodeIndexSegment(value: string, maxBytes = MAX_INDEX_SEGMENT_BYTES): string {
	let encoded: string;
	try {
		encoded = encodeURIComponent(value);
	} catch {
		return hashedSegment(value);
	}
	if (Buffer.byteLength(encoded, "utf-8") <= maxBytes && isPortableSegment(encoded)) return encoded;
	return hashedSegment(value);
}
