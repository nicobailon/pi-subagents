import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Protocol limits are deliberately independent from transcript/output limits. */
export const NATIVE_REMOTE_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const NATIVE_REMOTE_RPC_PROTOCOL_VERSION = 1;
export const NATIVE_REMOTE_MIN_PI_VERSION = "0.81.0";

export interface NativeRemoteRpcHandshake {
	type: "pi-subagents-ready";
	protocol: number;
	packageVersion: string;
	piVersion: string;
	capabilities: readonly string[];
	cwd: string;
	model?: string;
	tools: readonly string[];
	initialGit?: { head?: string; branch?: string; dirty?: boolean; probeError?: string };
}

/**
 * Strict LF-only JSONL decoder for Pi RPC stdout.
 *
 * Node's readline is intentionally not used because it treats U+2028/U+2029 as
 * record separators. StringDecoder preserves fragmented UTF-8 sequences. A CR
 * is accepted only immediately before LF, matching Pi's RPC contract.
 */
export class NativeRemoteJsonlDecoder {
	readonly #decoder = new StringDecoder("utf8");
	readonly #maxFrameBytes: number;
	#text = "";
	#bytes = 0;
	#ended = false;

	constructor(maxFrameBytes = NATIVE_REMOTE_RPC_MAX_FRAME_BYTES) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error("Native remote RPC frame limit must be a positive integer.");
		this.#maxFrameBytes = maxFrameBytes;
	}

	push(chunk: Uint8Array): unknown[] {
		if (this.#ended) throw new Error("Native remote RPC received bytes after EOF.");
		const records: unknown[] = [];
		let start = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (chunk[index] !== 0x0a) continue;
			const fragment = chunk.subarray(start, index);
			this.#bytes += fragment.byteLength;
			this.#assertBounded();
			this.#text += this.#decoder.write(fragment);
			records.push(this.#parseFrame(this.#text.endsWith("\r") ? this.#text.slice(0, -1) : this.#text));
			this.#text = "";
			this.#bytes = 0;
			start = index + 1;
		}
		const remainder = chunk.subarray(start);
		this.#bytes += remainder.byteLength;
		this.#assertBounded();
		this.#text += this.#decoder.write(remainder);
		return records;
	}

	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#text += this.#decoder.end();
		if (this.#bytes !== 0 || this.#text.length !== 0) throw new Error("Native remote RPC stream ended with a truncated JSONL frame.");
	}

	#assertBounded(): void {
		if (this.#bytes > this.#maxFrameBytes) throw new Error(`Native remote RPC frame exceeded ${this.#maxFrameBytes} bytes.`);
	}

	#parseFrame(frame: string): unknown {
		if (!frame) throw new Error("Native remote RPC emitted an empty JSONL frame.");
		try {
			return JSON.parse(frame) as unknown;
		} catch (error) {
			throw new Error(`Native remote RPC emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export function validateNativeRemoteHandshake(value: unknown, expected: {
	packageVersion: string;
	requiredCapabilities: readonly string[];
	requiredTools?: readonly string[];
}): NativeRemoteRpcHandshake {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native remote Pi host did not return a handshake object.");
	const record = value as Record<string, unknown>;
	if (record.type !== "pi-subagents-ready" || record.protocol !== NATIVE_REMOTE_RPC_PROTOCOL_VERSION) {
		throw new Error(`Incompatible remote native protocol; expected ${NATIVE_REMOTE_RPC_PROTOCOL_VERSION}, received ${String(record.protocol ?? "none")}.`);
	}
	if (record.packageVersion !== expected.packageVersion) {
		throw new Error(`Incompatible remote pi-subagents version; expected ${expected.packageVersion}, received ${String(record.packageVersion ?? "unknown")}.`);
	}
	if (typeof record.piVersion !== "string" || !record.piVersion || typeof record.cwd !== "string" || !record.cwd
		|| !Array.isArray(record.capabilities) || record.capabilities.some((item) => typeof item !== "string")
		|| !Array.isArray(record.tools) || record.tools.some((item) => typeof item !== "string")) {
		throw new Error("Remote native Pi handshake is incomplete.");
	}
	const version = /^(\d+)\.(\d+)\.(\d+)/u.exec(record.piVersion);
	const minimum = NATIVE_REMOTE_MIN_PI_VERSION.split(".").map(Number);
	if (!version || [Number(version[1]), Number(version[2]), Number(version[3])].some((part, index) => part < minimum[index]! && version.slice(1, index + 1).every((prior, priorIndex) => Number(prior) === minimum[priorIndex]))) {
		throw new Error(`Incompatible remote Pi runtime '${record.piVersion}'; native transport requires Pi >= ${NATIVE_REMOTE_MIN_PI_VERSION}.`);
	}
	const capabilities = record.capabilities as string[];
	const missing = expected.requiredCapabilities.filter((capability) => !capabilities.includes(capability));
	if (missing.length) throw new Error(`Remote native Pi host lacks required capabilities: ${missing.join(", ")}.`);
	const tools = record.tools as string[];
	const missingTools = expected.requiredTools?.filter((tool) => !tools.includes(tool)) ?? [];
	if (missingTools.length) throw new Error(`Remote native Pi runtime lacks required tools: ${missingTools.join(", ")}.`);
	return value as NativeRemoteRpcHandshake;
}

export function encodeNativeRemoteRpcRecord(value: unknown): Buffer {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > NATIVE_REMOTE_RPC_MAX_FRAME_BYTES) throw new Error(`Native remote RPC frame exceeded ${NATIVE_REMOTE_RPC_MAX_FRAME_BYTES} bytes.`);
	return Buffer.from(`${json}\n`, "utf8");
}

export type NativeRemoteRawWriter = (fd: number, buffer: Uint8Array, offset: number, length: number) => number;

/** Writes one bounded frame directly to an fd, bypassing Pi's redirected stdout stream. */
export function writeNativeRemoteRpcRecordSync(value: unknown, writer: NativeRemoteRawWriter = fs.writeSync, fd = 1): void {
	const frame = encodeNativeRemoteRpcRecord(value);
	let offset = 0;
	let attempts = 0;
	const maxAttempts = frame.byteLength + 128;
	while (offset < frame.byteLength) {
		if (++attempts > maxAttempts) throw new Error("Native remote RPC raw writer made too many interrupted attempts.");
		let written: number;
		try {
			written = writer(fd, frame, offset, frame.byteLength - offset);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "EINTR") continue;
			throw error;
		}
		if (!Number.isSafeInteger(written) || written <= 0 || written > frame.byteLength - offset) {
			throw new Error(`Native remote RPC raw writer made invalid progress (${String(written)} bytes).`);
		}
		offset += written;
	}
}
