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
 * resumable), identically on every platform. The file inbox is authoritative and
 * avoids signaling a PID that the extension cannot prove belongs to the runner.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { POLL_INTERVAL_MS } from "../../shared/types.ts";
import { shouldUseNativeFsWatch } from "../../shared/watch-strategy.ts";
import { resolveWatchPath } from "../../shared/utils.ts";

export type ControlChannelFs = Pick<typeof fs, "mkdirSync" | "existsSync" | "rmSync" | "watch" | "readdirSync" | "readFileSync" | "realpathSync">;

function writeJsonToExistingDir(filePath: string, payload: object): void {
	const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: "utf-8", flag: "wx" });
		fs.renameSync(tempPath, filePath);
	} finally {
		fs.rmSync(tempPath, { force: true });
	}
}
export type ControlChannelTimers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
const CONTROL_SAFETY_POLL_INTERVAL_MS = 5000;
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
	targetIndex?: number;
	childId?: string;
}

export type SteerDeliveryMode = "steer" | "follow_up" | "auto";
export type SteerDeliveryStatus = "delivered" | "queued";

export interface SteerRequest {
	type: "steer";
	id: string;
	ts: number;
	message: string;
	mode?: SteerDeliveryMode;
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
	state: "delivered" | "queued" | "failed";
	deliveryStatus?: SteerDeliveryStatus;
	message: string;
}

const STEER_REQUESTS_DIR = "steer-requests";
const STOP_REQUESTS_DIR = "stop-requests";
const REVIVAL_BRIEFS_DIR = "revival-briefs";
export const MAX_STEER_QUEUE_SIZE = 20;
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

/** Directory of parent-to-runner stop requests. */
export function stopRequestsDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STOP_REQUESTS_DIR);
}

/** Directory of parent-to-runner steering requests. */
export function steerRequestsDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}

export function steerInboxClosedPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_INBOX_CLOSED_FILE);
}

export function closeSteerInbox(asyncDir: string, state: string, write: (filePath: string, payload: object) => void = writeAtomicJson): void {
	write(steerInboxClosedPath(asyncDir), { version: 1, closedAt: Date.now(), state });
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
	if (!Number.isInteger(index) || index < 0 || index > 1_000_000) throw new Error("child index must be a non-negative integer.");
}

function validStopChildId(childId: unknown): childId is string {
	return typeof childId === "string"
		&& Boolean(childId.trim())
		&& childId.length <= 256
		&& !/[\r\n]/.test(childId);
}

function steerRequestFileName(request: SteerRequest): string {
	return `${String(request.ts).padStart(13, "0")}-${Buffer.from(request.id).toString("base64url")}.json`;
}

function stopRequestFileName(request: StopRequest): string {
	return `${String(request.ts ?? 0).padStart(13, "0")}-${randomUUID()}.json`;
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
		&& (request.mode === undefined || request.mode === "steer" || request.mode === "follow_up" || request.mode === "auto")
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

export function writeSteerRequestToExistingDir(dir: string, request: SteerRequest): string {
	if (!validSteerRequest(request)) throw new Error("steer request is malformed or exceeds transport limits.");
	const requestPath = path.join(dir, steerRequestFileName(request));
	writeJsonToExistingDir(requestPath, request);
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

function steerAckWritePath(filePath: string, ack: Omit<SteerAck, "type" | "protocolVersion">): string {
	const parsed = path.parse(filePath);
	const stateOrder = ack.state === "queued" ? "0" : ack.state === "delivered" ? "1" : "2";
	const timestamp = String(Math.trunc(ack.ts)).padStart(13, "0");
	for (let suffix = 0; suffix < 1_000; suffix += 1) {
		const candidate = path.join(parsed.dir, `${parsed.name}-${timestamp}-${stateOrder}-${ack.state}${suffix === 0 ? "" : `-${suffix}`}${parsed.ext}`);
		if (!fs.existsSync(candidate)) return candidate;
	}
	throw new Error("steer acknowledgment queue is full.");
}

export function writeSteerAckAt(filePath: string, ack: Omit<SteerAck, "type" | "protocolVersion">): string {
	assertChildIndex(ack.index);
	if (!/^[^\s]+$/.test(ack.requestId) || ack.requestId.length > 256) throw new Error("steer acknowledgment requestId is invalid.");
	if (!Number.isFinite(ack.ts) || ack.ts <= 0) throw new Error("steer acknowledgment ts must be a finite timestamp.");
	if (!ack.message.trim() || ack.message.length > 1000) throw new Error("steer acknowledgment message is invalid.");
	const record: SteerAck = { type: "steer-ack", protocolVersion: 1, ...ack, message: ack.message.trim() };
	const ackPath = steerAckWritePath(filePath, ack);
	writeAtomicJson(ackPath, record);
	return ackPath;
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
	if (payload.targetIndex !== undefined) assertChildIndex(payload.targetIndex);
	if (payload.childId !== undefined && !validStopChildId(payload.childId)) {
		throw new Error("stop childId must be a non-empty string without newlines and at most 256 characters.");
	}
	const request: StopRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "stop" };
	const requestPath = path.join(stopRequestsDir(asyncDir), stopRequestFileName(request));
	writeAtomicJson(requestPath, request);
	return requestPath;
}

export function requestAsyncSteer(
	asyncDir: string,
	payload: { message: string; mode?: SteerDeliveryMode; targetIndex?: number; targetIndexes?: number[]; source?: string; id?: string; ts?: number },
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
		...(payload.mode && payload.mode !== "steer" ? { mode: payload.mode } : {}),
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
	const { index, pid, readyAt, supported } = input;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 1_000_000) return undefined;
	if (typeof pid !== "number" || typeof readyAt !== "number" || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(readyAt) || readyAt <= 0 || typeof supported !== "boolean") return undefined;
	return { type: "steer-capability", protocolVersion: 1, index, pid, readyAt, supported };
}

function parseSteerAck(raw: unknown): SteerAck | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<SteerAck>;
	if (input.type !== "steer-ack" || input.protocolVersion !== 1 || typeof input.requestId !== "string" || !/^[^\s]+$/.test(input.requestId) || input.requestId.length > 256) return undefined;
	const { index, ts, state, message } = input;
	if (typeof index !== "number" || typeof ts !== "number" || !Number.isInteger(index) || index < 0 || index > 1_000_000 || !Number.isFinite(ts) || ts <= 0) return undefined;
	if (state !== "delivered" && state !== "queued" && state !== "failed") return undefined;
	if (input.deliveryStatus !== undefined && input.deliveryStatus !== "delivered" && input.deliveryStatus !== "queued") return undefined;
	if (typeof message !== "string" || !message.trim() || message.length > 1000) return undefined;
	return { type: "steer-ack", protocolVersion: 1, requestId: input.requestId, index, ts, state, ...(input.deliveryStatus ? { deliveryStatus: input.deliveryStatus } : {}), message: message.trim() };
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

export function consumeSteerAckFromDir(
	dir: string,
	requestId: string,
	fsImpl: Pick<typeof fs, "existsSync" | "readdirSync" | "readFileSync" | "rmSync"> = fs,
): SteerAck | undefined {
	if (!fsImpl.existsSync(dir)) return undefined;
	let entries: string[];
	try { entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); } catch { return undefined; }
	for (const entry of entries) {
		const target = path.join(dir, entry);
		let ack: SteerAck | undefined;
		try { ack = parseSteerAck(JSON.parse(fsImpl.readFileSync(target, "utf-8"))); } catch { ack = undefined; }
		if (ack?.requestId !== requestId) continue;
		try { fsImpl.rmSync(target, { force: true }); } catch { return undefined; }
		return ack;
	}
	return undefined;
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
		...(input.mode ? { mode: input.mode } : {}),
		...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
		...(input.targetIndexes !== undefined ? { targetIndexes: [...input.targetIndexes] } : {}),
		...(typeof input.source === "string" && input.source.trim() ? { source: input.source } : {}),
	};
}

export function consumeSteerRequestsFromDir(dir: string, fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs): SteerRequest[] {
	if (!fsImpl.existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		// Leave requests in place so the periodic poll can retry the scan.
		return [];
	}
	const requests: SteerRequest[] = [];
	for (const entry of entries) {
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

export function queueRevivalBrief(asyncDir: string, request: SteerRequest): string {
	const dir = path.join(controlInboxDir(asyncDir), REVIVAL_BRIEFS_DIR);
	const queued = fs.existsSync(dir) ? fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).length : 0;
	if (queued >= MAX_STEER_QUEUE_SIZE) throw new Error(`Follow-up queue is full (${MAX_STEER_QUEUE_SIZE} messages).`);
	return writeSteerRequestToDir(dir, { ...request, mode: "follow_up" });
}

export function readRevivalBriefs(asyncDir: string): Array<{ request: SteerRequest; path: string }> {
	const dir = path.join(controlInboxDir(asyncDir), REVIVAL_BRIEFS_DIR);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort().flatMap((entry) => {
		const filePath = path.join(dir, entry);
		try {
			const request = parseSteerRequest(JSON.parse(fs.readFileSync(filePath, "utf-8")));
			return request ? [{ request, path: filePath }] : [];
		} catch {
			return [];
		}
	});
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
	fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): boolean {
	return consumeStopRequestPayload(asyncDir, fsImpl) !== undefined;
}

function parseStopRequest(raw: unknown): StopRequest | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const parsed = raw as Partial<StopRequest>;
	if (parsed.type !== "stop") return undefined;
	if (Object.hasOwn(parsed, "targetIndex") && !(Number.isInteger(parsed.targetIndex) && parsed.targetIndex! >= 0 && parsed.targetIndex! <= 1_000_000)) return undefined;
	if (Object.hasOwn(parsed, "childId") && !validStopChildId(parsed.childId)) return undefined;
	return {
		type: "stop",
		...(typeof parsed.ts === "number" ? { ts: parsed.ts } : {}),
		...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
		...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
		...(parsed.targetIndex !== undefined ? { targetIndex: parsed.targetIndex } : {}),
		...(validStopChildId(parsed.childId) ? { childId: parsed.childId } : {}),
	};
}

function consumeStopRequestFile(
	requestPath: string,
	fsImpl: Pick<typeof fs, "rmSync" | "readFileSync">,
): StopRequest | undefined {
	let request: StopRequest | undefined;
	try {
		request = parseStopRequest(JSON.parse(fsImpl.readFileSync(requestPath, "utf-8")));
	} catch {
		request = undefined;
	}
	try {
		fsImpl.rmSync(requestPath, { force: true, recursive: true });
	} catch {
		// Already removed by a concurrent check — do not execute it twice.
		return undefined;
	}
	return request;
}

export function consumeStopRequestPayloads(
	asyncDir: string,
	fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): StopRequest[] {
	const dir = stopRequestsDir(asyncDir);
	const requests: StopRequest[] = [];
	if (fsImpl.existsSync(dir)) {
		let entries: string[];
		try {
			entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			const request = consumeStopRequestFile(path.join(dir, entry), fsImpl);
			if (request) requests.push(request);
		}
	}

	const legacyPath = stopRequestPath(asyncDir);
	if (fsImpl.existsSync(legacyPath)) {
		const request = consumeStopRequestFile(legacyPath, fsImpl);
		if (request) requests.push(request);
	}
	return requests.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0));
}

export function consumeStopRequestPayload(
	asyncDir: string,
	fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
): StopRequest | undefined {
	return consumeStopRequestPayloads(asyncDir, fsImpl)[0];
}

/** Parent side: write the authoritative portable interrupt request. */
export function deliverInterruptRequest(input: {
	asyncDir: string;
	now?: () => number;
	source?: string;
}): void {
	requestAsyncInterrupt(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
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
	targetIndex?: number;
	childId?: string;
}): void {
	requestAsyncStop(input.asyncDir, { ...(input.source ? { source: input.source } : {}), ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}), ...(input.childId ? { childId: input.childId } : {}) }, { now: input.now });
}

/**
 * Runner side: watch the control inbox and route interrupt requests into
 * `onInterrupt`. Uses `fs.watch` when available and starts interval polling
 * only when native watching is unavailable or fails. Fires once per distinct
 * request. Returns a disposer.
 */
export function watchAsyncControlInbox(
	asyncDir: string,
	opts: {
		onInterrupt: () => void;
		onTimeout?: () => void;
		onStop?: (request: StopRequest) => void;
		onSteer?: (request: SteerRequest) => void;
		onSteerCapability?: (capability: SteerCapability) => void;
		onSteerAck?: (ack: SteerAck) => void;
		pollIntervalMs?: number;
		safetyPollIntervalMs?: number;
		platform?: NodeJS.Platform;
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
			for (const stopRequest of consumeStopRequestPayloads(asyncDir, fsImpl)) opts.onStop?.(stopRequest);
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

	const watchers: fs.FSWatcher[] = [];
	const watchedDirs = new Set<string>();
	let interval: ReturnType<typeof setInterval> | undefined;
	let safetyInterval: ReturnType<typeof setInterval> | undefined;
	const startPolling = (): void => {
		if (interval || disposed) return;
		interval = timers.setInterval(check, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
		interval.unref?.();
	};
	const startSafetyPolling = (): void => {
		if (safetyInterval || disposed) return;
		safetyInterval = timers.setInterval(check, opts.safetyPollIntervalMs ?? CONTROL_SAFETY_POLL_INTERVAL_MS);
		safetyInterval.unref?.();
	};
	const watchDir = (target: string, create = false): void => {
		if (disposed || watchedDirs.has(target)) return;
		if (create) fsImpl.mkdirSync(target, { recursive: true });
		const watcher = fsImpl.watch(resolveWatchPath(target, fsImpl.realpathSync.native), () => {
			watchExistingSteerAckDirs();
			check();
		});
		watcher.on?.("error", startPolling);
		watchers.push(watcher);
		watchedDirs.add(target);
	};
	const watchExistingSteerAckDirs = (): void => {
		const ackRoot = path.join(dir, STEER_ACKS_DIR);
		let entries: string[];
		try {
			entries = fsImpl.readdirSync(ackRoot).filter((name) => /^\d+$/.test(name));
		} catch {
			return;
		}
		for (const entry of entries) watchDir(path.join(ackRoot, entry));
	};
	try {
		if (shouldUseNativeFsWatch("runner-control-inbox", opts.platform)) {
			watchDir(dir);
			watchDir(stopRequestsDir(asyncDir), true);
			watchDir(steerRequestsDir(asyncDir), true);
			watchDir(steerCapabilitiesDir(asyncDir), true);
			watchDir(path.join(dir, STEER_ACKS_DIR), true);
			watchExistingSteerAckDirs();
			startSafetyPolling();
		} else {
			startPolling();
		}
	} catch {
		startPolling();
	}

	return () => {
		if (disposed) return;
		disposed = true;
		for (const watcher of watchers) {
			try {
				watcher.close();
			} catch {
				// ignore
			}
		}
		if (interval) timers.clearInterval(interval);
		if (safetyInterval) timers.clearInterval(safetyInterval);
	};
}
