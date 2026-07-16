import { Buffer } from "node:buffer";
import type { ProtocolOutputLimit } from "../../shared/types.ts";

export type { ProtocolOutputLimit } from "../../shared/types.ts";

export const MAX_CHILD_PENDING_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 128 * 1024;
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;

export function formatProtocolOutputLimit(limit: ProtocolOutputLimit): string {
	return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline).`;
}

export function createBoundedLineReader(options: {
	stream?: "stdout" | "stderr";
	maxPendingLineBytes?: number;
	onLine: (line: string) => void;
	onLimit: (limit: ProtocolOutputLimit) => void;
}): {
	push(chunk: Buffer | string): void;
	end(): void;
	exceeded(): boolean;
} {
	const maxPendingLineBytes = options.maxPendingLineBytes ?? MAX_CHILD_PENDING_LINE_BYTES;
	if (!Number.isInteger(maxPendingLineBytes) || maxPendingLineBytes < 1) {
		throw new Error("maxPendingLineBytes must be a positive integer.");
	}
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let limitExceeded = false;

	const emitPending = (): void => {
		if (pendingBytes === 0) return;
		options.onLine(Buffer.concat(pending, pendingBytes).toString("utf8"));
		pending = [];
		pendingBytes = 0;
	};

	const append = (segment: Buffer): boolean => {
		if (segment.length === 0) return true;
		const observedBytes = pendingBytes + segment.length;
		if (observedBytes > maxPendingLineBytes) {
			const prior = pendingBytes > 0 ? Buffer.concat(pending, pendingBytes) : Buffer.alloc(0);
			const prefixFromPrior = prior.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES);
			const prefix = prefixFromPrior.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
				? prefixFromPrior
				: Buffer.concat([prefixFromPrior, segment.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES - prefixFromPrior.length)]);
			const tailFromSegment = segment.subarray(Math.max(0, segment.length - MAX_PROTOCOL_DIAGNOSTIC_BYTES));
			const tail = tailFromSegment.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
				? tailFromSegment
				: Buffer.concat([prior.subarray(Math.max(0, prior.length - (MAX_PROTOCOL_DIAGNOSTIC_BYTES - tailFromSegment.length))), tailFromSegment]);
			limitExceeded = true;
			pending = [];
			pendingBytes = 0;
			options.onLimit({
				code: "protocol_output_limit",
				stream: options.stream ?? "stdout",
				limitBytes: maxPendingLineBytes,
				observedBytes,
				diagnosticPrefix: prefix.toString("utf8"),
				diagnosticTail: tail.toString("utf8"),
			});
			return false;
		}
		pending.push(segment);
		pendingBytes = observedBytes;
		return true;
	};

	return {
		push(chunk) {
			if (limitExceeded) return;
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			let start = 0;
			for (let index = 0; index < bytes.length; index++) {
				if (bytes[index] !== 0x0a) continue;
				if (!append(bytes.subarray(start, index))) return;
				emitPending();
				start = index + 1;
			}
			append(bytes.subarray(start));
		},
		end() {
			if (!limitExceeded) emitPending();
		},
		exceeded: () => limitExceeded,
	};
}

function trimUtf8Start(buffer: Buffer, maxBytes: number): Buffer {
	let start = Math.max(0, buffer.length - maxBytes);
	while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
	return buffer.subarray(start);
}

function trimIncompleteUtf8End(buffer: Buffer): Buffer {
	if (buffer.length === 0) return buffer;
	let start = buffer.length - 1;
	while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
	if (start < 0) return Buffer.alloc(0);
	const lead = buffer[start]!;
	const expected = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
	return buffer.length - start < expected ? buffer.subarray(0, start) : buffer;
}

const BOUNDED_CAPTURE_SEPARATOR = Buffer.from("\n...[stderr truncated]...\n");

/**
 * Capture both the beginning and end of a byte stream without exceeding the
 * configured retained-byte bound. The rendered text also stays within that
 * bound and never begins or ends with a partial UTF-8 sequence.
 */
export function createBoundedByteCapture(maxBytes = MAX_CHILD_STDERR_BYTES): {
	push(chunk: Buffer | string): void;
	text(): string;
	byteLength(): number;
	truncated(): boolean;
} {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer.");
	const separator = maxBytes > BOUNDED_CAPTURE_SEPARATOR.length + 1 ? BOUNDED_CAPTURE_SEPARATOR : Buffer.alloc(0);
	const evidenceBytes = maxBytes - separator.length;
	const headLimit = Math.ceil(evidenceBytes / 2);
	const tailLimit = evidenceBytes - headLimit;
	let head = Buffer.alloc(0);
	let tail = Buffer.alloc(0);
	let wasTruncated = false;

	const firstBytes = (left: Buffer, right: Buffer, limit: number): Buffer => {
		if (left.length >= limit) return left.subarray(0, limit);
		return Buffer.concat([left, right.subarray(0, limit - left.length)]);
	};
	const lastBytes = (left: Buffer, right: Buffer, limit: number): Buffer => {
		if (limit === 0) return Buffer.alloc(0);
		if (right.length >= limit) return right.subarray(right.length - limit);
		const leftBytes = Math.min(left.length, limit - right.length);
		return Buffer.concat([left.subarray(left.length - leftBytes), right]);
	};

	return {
		push(chunk) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			if (bytes.length === 0) return;
			if (!wasTruncated && head.length + bytes.length <= maxBytes) {
				head = Buffer.concat([head, bytes]);
				return;
			}
			if (!wasTruncated) {
				tail = lastBytes(head, bytes, tailLimit);
				head = firstBytes(head, bytes, headLimit);
				wasTruncated = true;
				return;
			}
			tail = lastBytes(tail, bytes, tailLimit);
		},
		text() {
			if (!wasTruncated) return trimIncompleteUtf8End(head).toString("utf8");
			const safeHead = trimIncompleteUtf8End(head);
			const safeTail = trimIncompleteUtf8End(trimUtf8Start(tail, tail.length));
			return Buffer.concat([safeHead, separator, safeTail]).toString("utf8");
		},
		byteLength: () => wasTruncated ? head.length + tail.length : head.length,
		truncated: () => wasTruncated,
	};
}

export function createBoundedByteTail(maxBytes = MAX_CHILD_STDERR_BYTES): {
	push(chunk: Buffer | string): void;
	text(): string;
	byteLength(): number;
} {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer.");
	let tail = Buffer.alloc(0);
	return {
		push(chunk) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			tail = trimUtf8Start(Buffer.concat([tail, bytes]), maxBytes);
		},
		text: () => trimIncompleteUtf8End(tail).toString("utf8"),
		byteLength: () => tail.length,
	};
}

export type ChildLifecycleAction = "start-drain" | "cancel-drain" | "none";

export function projectChildLifecycle(event: { type?: string; willRetry?: unknown }, terminalAssistantStop = false): ChildLifecycleAction {
	if (event.type === "agent_end" && event.willRetry === true) return "cancel-drain";
	if (event.type === "agent_settled") return "start-drain";
	if (terminalAssistantStop) return "start-drain";
	return "none";
}
