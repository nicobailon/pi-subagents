export function decodeUtf8Tail(bytes: Buffer): string {
	let start = 0;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf-8");
}

export function utf8Tail(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(value, "utf-8");
	if (bytes.length <= maxBytes) return { text: value, truncated: false };
	return { text: decodeUtf8Tail(bytes.subarray(bytes.length - maxBytes)), truncated: true };
}
