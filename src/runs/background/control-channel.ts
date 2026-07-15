/**
 * Cross-OS control channel for async subagent runs.
 *
 * Background runs are detached OS processes. The original control path delivered
 * an interrupt with `process.kill(pid, SIGUSR2|SIGBREAK)`, but Windows cannot
 * deliver those signals cross-process via `process.kill` and throws `ENOSYS`,
 * which left async runs uninterruptible (no stop, no live steer) on Windows.
 *
 * This module adds a portable, file-based control inbox inside the run directory.
 * The parent drops an interrupt request file; the runner watches the inbox and
 * routes the request into its existing graceful `interruptRunner()` (pause +
 * resumable), identically on every platform. The OS signal is kept only as an
 * opportunistic fast-path; its failure is non-fatal because the file inbox is
 * authoritative.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { POLL_INTERVAL_MS } from "../../shared/types.ts";
import { resolveWatchPath } from "../../shared/utils.ts";

/**
 * Opportunistic fast-path interrupt signal. On Unix `SIGUSR2` is trapped by the
 * runner; on Windows `process.kill(pid, "SIGBREAK")` is not deliverable
 * cross-process and throws `ENOSYS`, so the file inbox below is the real channel.
 */
export const INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

export type ControlChannelFs = Pick<typeof fs, "mkdirSync" | "existsSync" | "rmSync" | "watch" | "readdirSync" | "readFileSync" | "realpathSync">;
export type ControlChannelTimers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => unknown;

export interface InterruptRequest {
	type: "interrupt";
	ts?: number;
	source?: string;
	reason?: string;
}

export interface TimeoutRequest {
	type: "timeout";
	ts?: number;
	source?: string;
	reason?: string;
}

export interface StopRequest {
	type: "stop";
	ts?: number;
	source?: string;
	reason?: string;
}

export interface SteerRequest {
	type: "steer";
	id: string;
	ts: number;
	message: string;
	targetIndex?: number;
	targetIndexes?: number[];
	source?: string;
}

export interface SteerCapability {
	type: "steer-capability";
	protocolVersion: 1;
	index: number;
	pid: number;
	readyAt: number;
	supported: boolean;
}

export interface SteerAck {
	type: "steer-ack";
	protocolVersion: 1;
	requestId: string;
	index: number;
	ts: number;
	state: "delivered" | "failed";
	message: string;
}

const STEER_REQUESTS_DIR = "steer-requests";
const STEER_TARGETS_DIR = "steer-targets";
const STEER_CAPABILITIES_DIR = "steer-capabilities";
const STEER_ACKS_DIR = "steer-acks";
const STEER_INBOX_CLOSED_FILE = "steer-inbox-closed.json";
const MAX_STEER_MESSAGE_BYTES = 128 * 1024;
const MAX_STEER_REQUEST_ID_LENGTH = 256;

/** Control inbox directory inside an async run dir. */
export function controlInboxDir(asyncDir: string): string {
	return path.join(asyncDir, "control");
}

/** Path of the portable interrupt request file. */
export function interruptRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "interrupt.json");
}

/** Path of the portable timeout request file. */
export function timeoutRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "timeout.json");
}

/** Path of the portable manual stop request file. */
export function stopRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "stop.json");
}

/** Directory of parent-to-runner steering requests. */
export function steerRequestsDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}

export function steerInboxClosedPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_INBOX_CLOSED_FILE);
}

export function closeSteerInbox(asyncDir: string, state: string): void {
	writeAtomicJson(steerInboxClosedPath(asyncDir), { version: 1, closedAt: Date.now(), state });
}

/** Per-child inbox consumed by the child prompt runtime inside the Pi process. */
export function stepSteerInboxDir(asyncDir: string, index: number): string {
	assertChildIndex(index);
	return path.join(controlInboxDir(asyncDir), STEER_TARGETS_DIR, String(index));
}

export function steerCapabilitiesDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_CAPABILITIES_DIR);
}

export function steerCapabilityPath(asyncDir: string, index: number): string {
	assertChildIndex(index);
	return path.join(steerCapabilitiesDir(asyncDir), `${index}.json`);
}

export function steerAcksDir(asyncDir: string, index: number): string {
	assertChildIndex(index);
	return path.join(controlInboxDir(asyncDir), STEER_ACKS_DIR, String(index));
}

function steerAckFileName(requestId: string): string {
	return `${Buffer.from(requestId).toString("base64url")}.json`;
}

export function steerAckPathFromDir(dir: string, requestId: string): string {
	if (!/^[^\s]+$/.test(requestId) || requestId.length > 256) throw new Error("steer acknowledgment requestId is invalid.");
	return path.join(dir, steerAckFileName(requestId));
}

function assertChildIndex(index: number): void {
	if (!Number.isInteger(index) || index < 0 || index > 1_000_000) throw new Error("steer child index must be a non-negative integer.");
}

function steerRequestFileName(request: SteerRequest): string {
	return `${String(request.ts).padStart(13, "0")}-${Buffer.from(request.id).toString("base64url")}.json`;
}

function validSteerRequest(request: Partial<SteerRequest>): request is SteerRequest {
	return request.type === "steer"
		&& typeof request.id === "string"
		&& /^[^\s]+$/.test(request.id)
		&& request.id.length <= MAX_STEER_REQUEST_ID_LENGTH
		&& typeof request.ts === "number"
		&& Number.isFinite(request.ts)
		&& request.ts > 0
		&& typeof request.message === "string"
		&& Boolean(request.message.trim())
		&& Buffer.byteLength(request.message, "utf8") <= MAX_STEER_MESSAGE_BYTES
		&& (request.targetIndex === undefined || (Number.isInteger(request.targetIndex) && request.targetIndex >= 0 && request.targetIndex <= 1_000_000))
		&& (request.targetIndexes === undefined || (
			request.targetIndex === undefined
			&& Array.isArray(request.targetIndexes)
			&& request.targetIndexes.length > 0
			&& request.targetIndexes.length <= 1_000
			&& request.targetIndexes.every((index) => Number.isInteger(index) && index >= 0 && index <= 1_000_000)
			&& new Set(request.targetIndexes).size === request.targetIndexes.length
		))
		&& (request.source === undefined || (typeof request.source === "string" && Boolean(request.source.trim()) && request.source.length <= 256));
}

export function writeSteerRequestToDir(dir: string, request: SteerRequest): string {
	if (!validSteerRequest(request)) throw new Error("steer request is malformed or exceeds transport limits.");
	const requestPath = path.join(dir, steerRequestFileName(request));
	writeAtomicJson(requestPath, request);
	return requestPath;
}

export function writeSteerCapabilityAt(filePath: string, capability: Omit<SteerCapability, "type" | "protocolVersion">): string {
	assertChildIndex(capability.index);
	if (!Number.isInteger(capability.pid) || capability.pid <= 0) throw new Error("steer capability pid must be a positive integer.");
	if (!Number.isFinite(capability.readyAt) || capability.readyAt <= 0) throw new Error("steer capability readyAt must be a finite timestamp.");
	const record: SteerCapability = { type: "steer-capability", protocolVersion: 1, ...capability };
	writeAtomicJson(filePath, record);
	return filePath;
}

export function writeSteerCapability(asyncDir: string, capability: Omit<SteerCapability, "type" | "protocolVersion">): string {
	return writeSteerCapabilityAt(steerCapabilityPath(asyncDir, capability.index), capability);
}

export function writeSteerAckAt(filePath: string, ack: Omit<SteerAck, "type" | "protocolVersion">): string {
	assertChildIndex(ack.index);
	if (!/^[^\s]+$/.test(ack.requestId) || ack.requestId.length > 256) throw new Error("steer acknowledgment requestId is invalid.");
	if (!Number.isFinite(ack.ts) || ack.ts <= 0) throw new Error("steer acknowledgment ts must be a finite timestamp.");
	if (!ack.message.trim() || ack.message.length > 1000) throw new Error("steer acknowledgment message is invalid.");
	const record: SteerAck = { type: "steer-ack", protocolVersion: 1, ...ack, message: ack.message.trim() };
	writeAtomicJson(filePath, record);
	return filePath;
}

export function writeSteerAck(asyncDir: string, ack: Omit<SteerAck, "type" | "protocolVersion">): string {
	return writeSteerAckAt(path.join(steerAcksDir(asyncDir, ack.index), steerAckFileName(ack.requestId)), ack);
}

/**
 * Parent side: drop a portable interrupt request the runner's inbox watcher will
 * pick up regardless of OS. Written atomically (temp + rename), dir auto-created.
 */
export function requestAsyncInterrupt(
	asyncDir: string,
	payload: Omit<InterruptRequest, "type"> = {},
	deps: { now?: () => number } = {},
): string {
	const requestPath = interruptRequestPath(asyncDir);
	const request: InterruptRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "interrupt" };
	writeAtomicJson(requestPath, request);
	return requestPath;
}

export function requestAsyncTimeout(
	asyncDir: string,
	payload: Omit<TimeoutRequest, "type"> = {},
	deps: { now?: () => number } = {},
): string {
	const requestPath = timeoutRequestPath(asyncDir);
	const request: TimeoutRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "timeout" };
	writeAtomicJson(requestPath, request);
	return requestPath;
}

export function requestAsyncStop(
	asyncDir: string,
	payload: Omit<StopRequest, "type"> = {},
	deps: { now?: () => number } = {},
): string {
	const requestPath = stopRequestPath(asyncDir);
	const request: StopRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "stop" };
	writeAtomicJson(requestPath, request);
	return requestPath;
}

export function requestAsyncSteer(
	asyncDir: string,
	payload: { message: string; targetIndex?: number; targetIndexes?: number[]; source?: string; id?: string; ts?: number },
	deps: { now?: () => number; randomId?: () => string } = {},
): string {
	const message = payload.message.trim();
	if (!message) throw new Error("steer message must not be empty.");
	if (Buffer.byteLength(message, "utf8") > MAX_STEER_MESSAGE_BYTES) throw new Error(`steer message exceeds ${MAX_STEER_MESSAGE_BYTES} UTF-8 bytes.`);
	if (payload.targetIndex !== undefined && (!Number.isInteger(payload.targetIndex) || payload.targetIndex < 0 || payload.targetIndex > 1_000_000)) {
		throw new Error("steer targetIndex must be an integer between 0 and 1000000.");
	}
	if (payload.targetIndexes !== undefined && (
		!Array.isArray(payload.targetIndexes)
		|| payload.targetIndex !== undefined
		|| payload.targetIndexes.length === 0
		|| payload.targetIndexes.length > 1_000
		|| payload.targetIndexes.some((index) => !Number.isInteger(index) || index < 0 || index > 1_000_000)
		|| new Set(payload.targetIndexes).size !== payload.targetIndexes.length
	)) {
		throw new Error("steer targetIndexes must contain 1-1000 unique non-negative integers and cannot be combined with targetIndex.");
	}
	const closedPath = steerInboxClosedPath(asyncDir);
	if (fs.existsSync(closedPath)) throw new Error("Async run no longer accepts steering requests.");
	const request: SteerRequest = {
		type: "steer",
		id: payload.id ?? deps.randomId?.() ?? randomUUID(),
		ts: payload.ts ?? deps.now?.() ?? Date.now(),
		message,
		...(payload.targetIndex !== undefined ? { targetIndex: payload.targetIndex } : {}),
		...(payload.targetIndexes !== undefined ? { targetIndexes: [...payload.targetIndexes] } : {}),
		...(payload.source ? { source: payload.source } : {}),
	};
	const requestPath = writeSteerRequestToDir(steerRequestsDir(asyncDir), request);
	if (fs.existsSync(closedPath)) {
		fs.rmSync(requestPath, { force: true });
		throw new Error("Async run stopped accepting steering before the request was committed.");
	}
	return requestPath;
}

export function enqueueStepSteer(asyncDir: string, index: number, request: SteerRequest): string {
	assertChildIndex(index);
	const { targetIndexes: _targetIndexes, ...singleTargetRequest } = request;
	return writeSteerRequestToDir(stepSteerInboxDir(asyncDir, index), { ...singleTargetRequest, targetIndex: index, type: "steer" });
}

function parseSteerCapability(raw: unknown): SteerCapability | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<SteerCapability>;
	if (input.type !== "steer-capability" || input.protocolVersion !== 1) return undefined;
	if (!Number.isInteger(input.index) || input.index < 0 || input.index > 1_000_000) return undefined;
	if (!Number.isInteger(input.pid) || input.pid <= 0 || !Number.isFinite(input.readyAt) || input.readyAt <= 0 || typeof input.supported !== "boolean") return undefined;
	return { type: "steer-capability", protocolVersion: 1, index: input.index, pid: input.pid, readyAt: input.readyAt, supported: input.supported };
}

function parseSteerAck(raw: unknown): SteerAck | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<SteerAck>;
	if (input.type !== "steer-ack" || input.protocolVersion !== 1 || typeof input.requestId !== "string" || !/^[^\s]+$/.test(input.requestId) || input.requestId.length > 256) return undefined;
	if (!Number.isInteger(input.index) || input.index < 0 || input.index > 1_000_000 || !Number.isFinite(input.ts) || input.ts <= 0) return undefined;
	if (input.state !== "delivered" && input.state !== "failed") return undefined;
	if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 1000) return undefined;
	return { type: "steer-ack", protocolVersion: 1, requestId: input.requestId, index: input.index, ts: input.ts, state: input.state, message: input.message.trim() };
}

export function readSteerCapability(asyncDir: string, index: number): SteerCapability | undefined {
	try {
		return parseSteerCapability(JSON.parse(fs.readFileSync(steerCapabilityPath(asyncDir, index), "utf-8")));
	} catch {
		return undefined;
	}
}

export function consumeSteerCapabilities(asyncDir: string, fsImpl: Pick<typeof fs, "existsSync" | "readdirSync" | "readFileSync"> = fs): SteerCapability[] {
	const dir = steerCapabilitiesDir(asyncDir);
	if (!fsImpl.existsSync(dir)) return [];
	const capabilities: SteerCapability[] = [];
	for (const entry of fsImpl.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name)).sort()) {
		try {
			const capability = parseSteerCapability(JSON.parse(fsImpl.readFileSync(path.join(dir, entry), "utf-8")));
			if (capability) capabilities.push(capability);
		} catch {
			// A partially written or malformed capability is ignored until a valid one arrives.
		}
	}
	return capabilities;
}

export function consumeSteerAcks(asyncDir: string, fsImpl: Pick<typeof fs, "existsSync" | "readdirSync" | "readFileSync" | "rmSync"> = fs): SteerAck[] {
	const root = path.join(controlInboxDir(asyncDir), STEER_ACKS_DIR);
	if (!fsImpl.existsSync(root)) return [];
	const acks: SteerAck[] = [];
	let indexNames: string[];
	try { indexNames = fsImpl.readdirSync(root).filter((name) => /^\d+$/.test(name)); } catch { return []; }
	for (const indexName of indexNames) {
		const dir = path.join(root, indexName);
		let entries: string[];
		try { entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); } catch { continue; }
		for (const entry of entries) {
			const target = path.join(dir, entry);
			let ack: SteerAck | undefined;
			try { ack = parseSteerAck(JSON.parse(fsImpl.readFileSync(target, "utf-8"))); } catch { ack = undefined; }
			try { fsImpl.rmSync(target, { force: true }); } catch { continue; }
			if (ack) acks.push(ack);
		}
	}
	return acks;
}

function parseSteerRequest(raw: unknown): SteerRequest | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<SteerRequest>;
	if (!validSteerRequest(input)) return undefined;
	return {
		type: "steer",
		id: input.id.trim(),
		ts: input.ts,
		message: input.message.trim(),
		...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
		...(input.targetIndexes !== undefined ? { targetIndexes: [...input.targetIndexes] } : {}),
		...(typeof input.source === "string" && input.source.trim() ? { source: input.source } : {}),
	};
}

export function consumeSteerRequestsFromDir(dir: string, fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs): SteerRequest[] {
	if (!fsImpl.existsSync(dir)) return [];
	const requests: SteerRequest[] = [];
	for (const entry of fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
		const requestPath = path.join(dir, entry);
		let parsed: SteerRequest | undefined;
		try {
			parsed = parseSteerRequest(JSON.parse(fsImpl.readFileSync(requestPath, "utf-8")));
		} catch {
			parsed = undefined;
		}
		try {
			fsImpl.rmSync(requestPath, { recursive: true });
		} catch {
			// Already removed by a concurrent check — do not execute it twice.
			continue;
		}
		if (parsed) requests.push(parsed);
	}
	return requests.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}

export function consumeSteerRequests(asyncDir: string, fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs): SteerRequest[] {
	return consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl);
}

/**
 * Runner side: consume a pending interrupt request. Idempotent — removes the file
 * so each distinct request fires exactly once. Returns whether one was pending.
 */
export function consumeInterruptRequest(
	asyncDir: string,
	fsImpl: Pick<typeof fs, "existsSync" | "rmSync"> = fs,
): boolean {
	const requestPath = interruptRequestPath(asyncDir);
	if (!fsImpl.existsSync(requestPath)) return false;
	try {
		fsImpl.rmSync(requestPath, { force: true, recursive: true });
	} catch {
		// Already removed by a concurrent check — still counts as consumed.
	}
	return true;
}

export function consumeTimeoutRequest(
	asyncDir: string,
	fsImpl: Pick<typeof fs, "existsSync" | "rmSync"> = fs,
): boolean {
	const requestPath = timeoutRequestPath(asyncDir);
	if (!fsImpl.existsSync(requestPath)) return false;
	try {
		fsImpl.rmSync(requestPath, { force: true, recursive: true });
	} catch {
		// Already removed by a concurrent check — still counts as consumed.
	}
	return true;
}

export function consumeStopRequest(
	asyncDir: string,
	fsImpl: Pick<typeof fs, "existsSync" | "rmSync"> = fs,
): boolean {
	const requestPath = stopRequestPath(asyncDir);
	if (!fsImpl.existsSync(requestPath)) return false;
	try {
		fsImpl.rmSync(requestPath, { force: true, recursive: true });
	} catch {
		// Already removed by a concurrent check — still counts as consumed.
	}
	return true;
}

/**
 * Parent side: portable interrupt = authoritative file request + best-effort OS
 * signal. The signal is only a latency optimization on Unix; ENOSYS on Windows
 * is swallowed because the file inbox is authoritative there. Other signal
 * failures are surfaced because they usually mean the runner is not alive to
 * consume the request.
 */
export function deliverInterruptRequest(input: {
	asyncDir: string;
	pid?: number;
	kill?: KillFn;
	signal?: NodeJS.Signals;
	now?: () => number;
	source?: string;
}): void {
	const requestPath = requestAsyncInterrupt(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
	if (typeof input.pid === "number" && input.pid > 0) {
		try {
			(input.kill ?? process.kill)(input.pid, input.signal ?? INTERRUPT_SIGNAL);
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSYS") {
				// File inbox is authoritative when custom cross-process signals are unavailable.
				return;
			}
			try {
				fs.rmSync(requestPath, { force: true });
			} catch {
				// Best effort cleanup; the caller still gets the signal failure.
			}
			throw error;
		}
	}
}

export function deliverTimeoutRequest(input: {
	asyncDir: string;
	pid?: number;
	kill?: KillFn;
	signal?: NodeJS.Signals;
	now?: () => number;
	source?: string;
}): void {
	requestAsyncTimeout(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
}

export function deliverStopRequest(input: {
	asyncDir: string;
	pid?: number;
	kill?: KillFn;
	signal?: NodeJS.Signals;
	now?: () => number;
	source?: string;
}): void {
	requestAsyncStop(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
}

/**
 * Runner side: watch the control inbox and route interrupt requests into
 * `onInterrupt`. Uses `fs.watch` when available plus an interval poll as a
 * portable safety net (covers filesystems/platforms where `fs.watch` is
 * unreliable). Fires once per distinct request. Returns a disposer.
 */
export function watchAsyncControlInbox(
	asyncDir: string,
	opts: {
		onInterrupt: () => void;
		onTimeout?: () => void;
		onStop?: () => void;
		onSteer?: (request: SteerRequest) => void;
		onSteerCapability?: (capability: SteerCapability) => void;
		onSteerAck?: (ack: SteerAck) => void;
		pollIntervalMs?: number;
		fs?: ControlChannelFs;
		timers?: ControlChannelTimers;
	},
): () => void {
	const fsImpl = opts.fs ?? fs;
	const timers = opts.timers ?? { setInterval, clearInterval };
	const dir = controlInboxDir(asyncDir);
	try {
		fsImpl.mkdirSync(dir, { recursive: true });
	} catch {
		// Best effort — the poll/watch below tolerates a missing dir.
	}

	let disposed = false;
	const check = (): void => {
		if (disposed) return;
		try {
			if (consumeStopRequest(asyncDir, fsImpl)) opts.onStop?.();
			if (consumeTimeoutRequest(asyncDir, fsImpl)) opts.onTimeout?.();
			if (consumeInterruptRequest(asyncDir, fsImpl)) opts.onInterrupt();
			for (const request of consumeSteerRequests(asyncDir, fsImpl)) opts.onSteer?.(request);
			for (const capability of consumeSteerCapabilities(asyncDir, fsImpl)) opts.onSteerCapability?.(capability);
			for (const ack of consumeSteerAcks(asyncDir, fsImpl)) opts.onSteerAck?.(ack);
		} catch {
			// Never let inbox errors crash the runner.
		}
	};

	// Handle a request that may have arrived before the watcher started.
	check();

	let watcher: fs.FSWatcher | undefined;
	try {
		watcher = fsImpl.watch(resolveWatchPath(dir, fsImpl.realpathSync.native), () => check());
		watcher.on?.("error", () => {
			// fs.watch can emit on transient FS errors; the interval poll keeps us live.
		});
	} catch {
		watcher = undefined;
	}

	const interval = timers.setInterval(check, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
	interval.unref?.();

	return () => {
		if (disposed) return;
		disposed = true;
		try {
			watcher?.close();
		} catch {
			// ignore
		}
		timers.clearInterval(interval);
	};
}
