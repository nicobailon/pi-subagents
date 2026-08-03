import { Buffer } from "node:buffer";
import type { ProtocolOutputLimit } from "../../shared/types.ts";

export type { ProtocolOutputLimit } from "../../shared/types.ts";

export const MAX_CHILD_PENDING_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 128 * 1024;
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;

export interface OversizedLineProjectionInput {
	prefix: string;
	tail: string;
	observedBytes: number;
}

export interface OversizedLineProjector {
	accepts(prefix: string): boolean;
	project(input: OversizedLineProjectionInput): string | undefined;
}

/**
 * Pi JSON mode emits granular message/tool events followed by aggregate
 * `turn_end` and `agent_end` events that duplicate those payloads. Parallel
 * image reads can make one aggregate record exceed the child line limit even
 * though every granular event was valid. Replace only those oversized,
 * redundant records with the lifecycle fields the runners consume.
 */
export const PI_AGGREGATE_EVENT_PROJECTOR: OversizedLineProjector = {
	accepts(prefix) {
		return prefix.startsWith('{"type":"turn_end"') || prefix.startsWith('{"type":"agent_end"');
	},
	project({ prefix, tail }) {
		if (prefix.startsWith('{"type":"turn_end"')) return '{"type":"turn_end"}';
		if (!prefix.startsWith('{"type":"agent_end"')) return undefined;
		const lifecycleFragments = `${prefix}\n${tail}`;
		const matches = [...lifecycleFragments.matchAll(/"willRetry":(true|false)(?=[,}])/g)];
		const value = matches.at(-1)?.[1];
		return value ? JSON.stringify({ type: "agent_end", willRetry: value === "true" }) : undefined;
	},
};

export function formatProtocolOutputLimit(limit: ProtocolOutputLimit): string {
	return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline).`;
}

export function createBoundedLineReader(options: {
	stream?: "stdout" | "stderr";
	maxPendingLineBytes?: number;
	oversizedLineProjector?: OversizedLineProjector;
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
	let projectedPrefix: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let projectedTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let projectedBytes = 0;
	let projectingOversizedLine = false;
	let limitExceeded = false;

	const diagnosticTail = (prior: Buffer, segment: Buffer): Buffer => {
		const tailFromSegment = segment.subarray(Math.max(0, segment.length - MAX_PROTOCOL_DIAGNOSTIC_BYTES));
		return tailFromSegment.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
			? tailFromSegment
			: Buffer.concat([prior.subarray(Math.max(0, prior.length - (MAX_PROTOCOL_DIAGNOSTIC_BYTES - tailFromSegment.length))), tailFromSegment]);
	};

	const failLimit = (observedBytes: number, prefix: Buffer, tail: Buffer): false => {
		limitExceeded = true;
		pending = [];
		pendingBytes = 0;
		projectingOversizedLine = false;
		projectedPrefix = Buffer.alloc(0);
		projectedTail = Buffer.alloc(0);
		projectedBytes = 0;
		options.onLimit({
			code: "protocol_output_limit",
			stream: options.stream ?? "stdout",
			limitBytes: maxPendingLineBytes,
			observedBytes,
			diagnosticPrefix: prefix.toString("utf8"),
			diagnosticTail: tail.toString("utf8"),
		});
		return false;
	};

	const finishLine = (): void => {
		if (projectingOversizedLine) {
			const projected = options.oversizedLineProjector?.project({
				prefix: projectedPrefix.toString("utf8"),
				tail: projectedTail.toString("utf8"),
				observedBytes: projectedBytes,
			});
			if (projected === undefined) {
				failLimit(projectedBytes, projectedPrefix, projectedTail);
			} else {
				options.onLine(projected);
			}
		} else if (pendingBytes > 0) {
			options.onLine(Buffer.concat(pending, pendingBytes).toString("utf8"));
		}
		pending = [];
		pendingBytes = 0;
		projectingOversizedLine = false;
		projectedPrefix = Buffer.alloc(0);
		projectedTail = Buffer.alloc(0);
		projectedBytes = 0;
	};

	const append = (segment: Buffer): boolean => {
		if (segment.length === 0) return true;
		if (projectingOversizedLine) {
			projectedBytes += segment.length;
			projectedTail = diagnosticTail(projectedTail, segment);
			return true;
		}
		const observedBytes = pendingBytes + segment.length;
		if (observedBytes > maxPendingLineBytes) {
			const prior = pendingBytes > 0 ? Buffer.concat(pending, pendingBytes) : Buffer.alloc(0);
			const prefixFromPrior = prior.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES);
			const prefix = prefixFromPrior.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
				? prefixFromPrior
				: Buffer.concat([prefixFromPrior, segment.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES - prefixFromPrior.length)]);
			const tail = diagnosticTail(prior, segment);
			if (options.oversizedLineProjector?.accepts(prefix.toString("utf8"))) {
				pending = [];
				pendingBytes = 0;
				projectingOversizedLine = true;
				projectedPrefix = prefix;
				projectedTail = tail;
				projectedBytes = observedBytes;
				return true;
			}
			return failLimit(observedBytes, prefix, tail);
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
				finishLine();
				if (limitExceeded) return;
				start = index + 1;
			}
			append(bytes.subarray(start));
		},
		end() {
			if (!limitExceeded) finishLine();
		},
		exceeded: () => limitExceeded,
	};
}

function trimToUtf8Boundary(buffer: Buffer, maxBytes: number): Buffer {
	if (buffer.length <= maxBytes) return buffer;
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
	return buffer.subarray(start);
}

export function createBoundedByteTail(maxBytes = MAX_CHILD_STDERR_BYTES): {
	push(chunk: Buffer | string): void;
	text(): string;
	byteLength(): number;
} {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer.");
	let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	return {
		push(chunk) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			tail = trimToUtf8Boundary(Buffer.concat([tail, bytes]), maxBytes);
		},
		text: () => tail.toString("utf8"),
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
