import type { Readable } from "node:stream";
/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export declare function serializeJsonLine(value: unknown): string;
/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export declare function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void;
//# sourceMappingURL=jsonl.d.ts.map