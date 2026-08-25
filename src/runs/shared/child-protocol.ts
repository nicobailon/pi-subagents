import { Buffer } from "node:buffer";
import type { ProtocolOutputLimit } from "../../shared/types.ts";

export type { ProtocolOutputLimit } from "../../shared/types.ts";

export const MAX_CHILD_PENDING_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 128 * 1024;
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;
const MAX_PROJECTED_JSON_DEPTH = 256;

export interface OversizedLineProjection {
	push(chunk: Buffer): boolean;
	finish(): string | undefined;
}

export interface OversizedLineProjector {
	accepts(prefix: string): boolean;
	create(): OversizedLineProjection;
}

type JsonContainer =
	| { type: "array"; state: "value-or-end" | "value" | "comma-or-end" }
	| { type: "object"; state: "key-or-end" | "key" | "colon" | "value" | "comma-or-end"; key?: string };

type JsonToken =
	| { type: "string"; role: "key" | "value"; value: string; capture: boolean; escape: boolean; unicodeDigits: number; unicodeValue: string }
	| { type: "literal"; expected: string; index: number; value: boolean | null }
	| { type: "number"; phase: "minus" | "zero" | "int" | "dot" | "frac" | "exp" | "exp-sign" | "exp-digits" };

function createPiAggregateProjection(): OversizedLineProjection {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const stack: JsonContainer[] = [];
	let rootState: "value" | "end" = "value";
	let token: JsonToken | undefined;
	let valid = true;
	let eventType: string | undefined;
	let willRetry: boolean | undefined;

	const parent = (): JsonContainer | undefined => stack.at(-1);
	const isTopLevelField = (key: string | undefined): boolean => stack.length === 1 && parent()?.type === "object" && (key === "type" || key === "willRetry");

	const completeValue = (value?: string | boolean | null): void => {
		const container = parent();
		if (!container) {
			rootState = "end";
			return;
		}
		if (container.type === "object") {
			if (stack.length === 1 && container.key === "type" && typeof value === "string") eventType = value;
			if (stack.length === 1 && container.key === "willRetry" && typeof value === "boolean") willRetry = value;
			container.key = undefined;
			container.state = "comma-or-end";
		} else container.state = "comma-or-end";
	};

	const startValue = (char: string): boolean => {
		const container = parent();
		const key = container?.type === "object" ? container.key : undefined;
		if (isTopLevelField(key)) {
			if (key === "type") eventType = undefined;
			else willRetry = undefined;
		}
		if (char === "{" || char === "[") {
			if (stack.length >= MAX_PROJECTED_JSON_DEPTH) return false;
			stack.push(char === "{" ? { type: "object", state: "key-or-end" } : { type: "array", state: "value-or-end" });
			return true;
		}
		if (char === '"') {
			token = { type: "string", role: "value", value: "", capture: key === "type" && stack.length === 1, escape: false, unicodeDigits: 0, unicodeValue: "" };
			return true;
		}
		if (char === "t") token = { type: "literal", expected: "true", index: 1, value: true };
		else if (char === "f") token = { type: "literal", expected: "false", index: 1, value: false };
		else if (char === "n") token = { type: "literal", expected: "null", index: 1, value: null };
		else if (char === "-") token = { type: "number", phase: "minus" };
		else if (char === "0") token = { type: "number", phase: "zero" };
		else if (char >= "1" && char <= "9") token = { type: "number", phase: "int" };
		else return false;
		return true;
	};

	const closeContainer = (): true => {
		stack.pop();
		completeValue();
		return true;
	};

	const processChar = (char: string): boolean => {
		if (token?.type === "string") {
			if (token.unicodeDigits > 0) {
				if (!/[0-9a-fA-F]/.test(char)) return false;
				token.unicodeValue += char;
				token.unicodeDigits--;
				if (token.unicodeDigits === 0 && token.capture) {
					if (token.value.length >= 64) return false;
					token.value += String.fromCharCode(Number.parseInt(token.unicodeValue, 16));
				}
				return true;
			}
			if (token.escape) {
				token.escape = false;
				if (char === "u") { token.unicodeDigits = 4; token.unicodeValue = ""; return true; }
				if (!'"\\/bfnrt'.includes(char)) return false;
				if (token.capture) {
					if (token.value.length >= 64) return false;
					token.value += ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[char] ?? char;
				}
				return true;
			}
			if (char === "\\") { token.escape = true; return true; }
			if (char === '"') {
				const finished = token;
				token = undefined;
				if (finished.role === "key") {
					const container = parent();
					if (!container || container.type !== "object") return false;
					container.key = finished.value;
					container.state = "colon";
				} else completeValue(finished.capture ? finished.value : undefined);
				return true;
			}
			if (char.charCodeAt(0) < 0x20) return false;
			if (token.capture) {
				if (token.value.length >= 64) return false;
				token.value += char;
			}
			return true;
		}
		if (token?.type === "literal") {
			if (char !== token.expected[token.index]) return false;
			token.index++;
			if (token.index === token.expected.length) {
				const value = token.value;
				token = undefined;
				completeValue(value);
			}
			return true;
		}
		if (token?.type === "number") {
			const phase = token.phase;
			if (phase === "minus") {
				if (char === "0") token.phase = "zero";
				else if (char >= "1" && char <= "9") token.phase = "int";
				else return false;
				return true;
			}
			if (phase === "zero" || phase === "int") {
				if (char >= "0" && char <= "9") { if (phase === "zero") return false; return true; }
				if (char === ".") { token.phase = "dot"; return true; }
				if (char === "e" || char === "E") { token.phase = "exp"; return true; }
			} else if (phase === "dot") {
				if (char >= "0" && char <= "9") { token.phase = "frac"; return true; }
				return false;
			} else if (phase === "frac") {
				if (char >= "0" && char <= "9") return true;
				if (char === "e" || char === "E") { token.phase = "exp"; return true; }
			} else if (phase === "exp") {
				if (char === "+" || char === "-") { token.phase = "exp-sign"; return true; }
				if (char >= "0" && char <= "9") { token.phase = "exp-digits"; return true; }
				return false;
			} else if (phase === "exp-sign") {
				if (char >= "0" && char <= "9") { token.phase = "exp-digits"; return true; }
				return false;
			} else if (phase === "exp-digits" && char >= "0" && char <= "9") return true;
			if (!["zero", "int", "frac", "exp-digits"].includes(phase)) return false;
			token = undefined;
			completeValue();
			return processChar(char);
		}
		if (char === " " || char === "\t" || char === "\r" || char === "\n") return true;
		const container = parent();
		if (!container) return rootState === "value" ? startValue(char) : false;
		if (container.type === "object") {
			if (container.state === "key-or-end" || container.state === "key") {
				if (char === "}" && container.state === "key-or-end") return closeContainer();
				if (char !== '"') return false;
				token = { type: "string", role: "key", value: "", capture: stack.length === 1, escape: false, unicodeDigits: 0, unicodeValue: "" };
				return true;
			}
			if (container.state === "colon") {
				if (char !== ":") return false;
				container.state = "value";
				return true;
			}
			if (container.state === "value") return startValue(char);
			if (char === ",") { container.state = "key"; return true; }
			if (char === "}") return closeContainer();
			return false;
		}
		if (container.state === "value-or-end" || container.state === "value") {
			if (char === "]" && container.state === "value-or-end") return closeContainer();
			return startValue(char);
		}
		if (char === ",") { container.state = "value"; return true; }
		if (char === "]") return closeContainer();
		return false;
	};

	const processText = (text: string): boolean => {
		for (const char of text) if (!processChar(char)) return false;
		return true;
	};

	return {
		push(chunk) {
			if (!valid) return false;
			try { valid = processText(decoder.decode(chunk, { stream: true })); }
			catch { valid = false; }
			return valid;
		},
		finish() {
			try { valid = valid && processText(decoder.decode()); }
			catch { valid = false; }
			if (token?.type === "number" && ["zero", "int", "frac", "exp-digits"].includes(token.phase)) {
				token = undefined;
				completeValue();
			}
			if (!valid || token || stack.length !== 0 || rootState !== "end") return undefined;
			if (eventType === "turn_end") return '{"type":"turn_end"}';
			if (eventType === "agent_end" && typeof willRetry === "boolean") return JSON.stringify({ type: "agent_end", willRetry });
			if (eventType === "compaction_end" && typeof willRetry === "boolean") return JSON.stringify({ type: "compaction_end", willRetry });
			return undefined;
		},
	};
}

/**
 * Pi JSON mode emits granular message/tool events followed by aggregate
 * `turn_end`, `agent_end`, and `compaction_end` events that can duplicate
 * large payloads. Parallel image reads can make one aggregate record exceed
 * the child line limit even though every granular event was valid. Replace
 * only syntactically valid, redundant records with the lifecycle fields the
 * runners consume.
 */
export const PI_AGGREGATE_EVENT_PROJECTOR: OversizedLineProjector = {
	accepts(prefix) {
		return prefix.startsWith('{"type":"turn_end"') || prefix.startsWith('{"type":"agent_end"') || prefix.startsWith('{"type":"compaction_end"');
	},
	create: createPiAggregateProjection,
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
	let projection: OversizedLineProjection | undefined;
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
		projection = undefined;
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
			const projected = projection?.finish();
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
		projection = undefined;
		projectedPrefix = Buffer.alloc(0);
		projectedTail = Buffer.alloc(0);
		projectedBytes = 0;
	};

	const append = (segment: Buffer): boolean => {
		if (segment.length === 0) return true;
		if (projectingOversizedLine) {
			projectedBytes += segment.length;
			projectedTail = diagnosticTail(projectedTail, segment);
			return projection?.push(segment) === true || failLimit(projectedBytes, projectedPrefix, projectedTail);
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
				const candidate = options.oversizedLineProjector.create();
				if (!candidate.push(prior) || !candidate.push(segment)) return failLimit(observedBytes, prefix, tail);
				pending = [];
				pendingBytes = 0;
				projectingOversizedLine = true;
				projection = candidate;
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

export interface ChildLifecycleState {
	compactionRetryActive: boolean;
}

export function projectChildLifecycle(event: { type?: string; willRetry?: unknown }, terminalAssistantStop = false, state?: ChildLifecycleState): ChildLifecycleAction {
	if (event.type === "compaction_end") {
		if (state) state.compactionRetryActive = event.willRetry === true;
		return event.willRetry === true ? "cancel-drain" : "none";
	}
	if (event.type === "agent_start" || event.type === "auto_retry_start") {
		if (state) state.compactionRetryActive = false;
	}
	if (event.type === "agent_end" && event.willRetry === true) return "cancel-drain";
	if (event.type === "agent_end" && state) state.compactionRetryActive = false;
	if (event.type === "agent_settled") return state?.compactionRetryActive ? "none" : "start-drain";
	if (terminalAssistantStop) return "start-drain";
	return "none";
}
