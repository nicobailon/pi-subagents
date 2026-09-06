/**
 * Cross-OS control channel for async subagent runs.
 *
 * Background runs use a detached runner process. Unix detaches it from the parent process.
 * The original control path delivered an interrupt with
 * `process.kill(pid, SIGUSR2|SIGBREAK)`, but Windows cannot
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

const STEER_REQUESTS_DIR = "steer-requests";
const STOP_REQUESTS_DIR = "stop-requests";
const REVIVAL_BRIEFS_DIR = "revival-briefs";
export const MAX_STEER_QUEUE_SIZE = 20;
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

export function consumeSteerRequestsFromDir(dir: string, fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs, onError: (error: unknown) => void = () => {}): SteerRequest[] {
	let entries: string[];
	try {
		entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch (error) {
		// Leave requests in place so the periodic poll can retry the scan.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error);
		return [];
	}
	const requests: SteerRequest[] = [];
	for (const entry of entries) {
		const requestPath = path.join(dir, entry);
		let parsed: SteerRequest | undefined;
		let text: string;
		try {
			text = fsImpl.readFileSync(requestPath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error);
			continue;
		}
		try {
			parsed = parseSteerRequest(JSON.parse(text));
		} catch {
			parsed = undefined;
		}
		try {
			fsImpl.rmSync(requestPath, { recursive: true });
		} catch (error) {
			// Already removed by a concurrent check — do not execute it twice.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error);
			continue;
		}
		if (parsed) requests.push(parsed);
	}
	return requests.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}

export function consumeSteerRequests(asyncDir: string, fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs, onError?: (error: unknown) => void): SteerRequest[] {
	return consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl, onError);
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
	onError?: (error: unknown) => void,
): StopRequest | undefined {
	let text: string;
	try {
		text = fsImpl.readFileSync(requestPath, "utf-8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) onError?.(error);
		return undefined;
	}
	let request: StopRequest | undefined;
	try {
		request = parseStopRequest(JSON.parse(text));
	} catch {
		request = undefined;
	}
	try {
		fsImpl.rmSync(requestPath, { force: true, recursive: true });
	} catch (error) {
		// Execute only after successful removal.
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) onError?.(error);
		return undefined;
	}
	return request;
}

export function consumeStopRequestPayloads(
	asyncDir: string,
	fsImpl: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync"> = fs,
	onError?: (error: unknown) => void,
): StopRequest[] {
	const dir = stopRequestsDir(asyncDir);
	const requests: StopRequest[] = [];
	if (fsImpl.existsSync(dir)) {
		let entries: string[];
		try {
			entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) onError?.(error);
			entries = [];
		}
		for (const entry of entries) {
			const request = consumeStopRequestFile(path.join(dir, entry), fsImpl, onError);
			if (request) requests.push(request);
		}
	}

	const legacyPath = stopRequestPath(asyncDir);
	if (fsImpl.existsSync(legacyPath)) {
		const request = consumeStopRequestFile(legacyPath, fsImpl, onError);
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
 * Active owner: watch and consume only kinds with installed handlers.
 * Uses `fs.watch` when available and starts interval polling
 * only when native watching is unavailable or fails. Fires once per distinct
 * request. Returns a disposer.
 */
export function watchAsyncControlInbox(
	asyncDir: string,
	opts: {
		onInterrupt?: () => void;
		onTimeout?: () => void;
		onStop?: (request: StopRequest) => void;
		onSteer?: (request: SteerRequest) => void;
		onError?: (error: unknown, phase: "install" | "scan" | "callback", request?: SteerRequest) => void;
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
	const report = (error: unknown, phase: "install" | "scan" | "callback", request?: SteerRequest): void => {
		try {
			if (opts.onError) opts.onError(error, phase, request);
			else console.error(`Control inbox ${phase} failed:`, error);
		} catch (reportError) {
			console.error("Control inbox error reporter failed:", reportError);
		}
	};
	const dirs = [
		...(opts.onInterrupt || opts.onTimeout || opts.onStop ? [dir] : []),
		...(opts.onStop ? [stopRequestsDir(asyncDir)] : []),
		...(opts.onSteer ? [steerRequestsDir(asyncDir)] : []),
	];
	if (dirs.length === 0) return () => {};
	try {
		for (const target of dirs) fsImpl.mkdirSync(target, { recursive: true });
	} catch (error) {
		report(error, "install");
	}

	let disposed = false;
	const check = (): void => {
		if (disposed) return;
		try {
			if (opts.onStop) for (const request of consumeStopRequestPayloads(asyncDir, fsImpl, (error) => report(error, "scan"))) {
				try { opts.onStop(request); } catch (error) { report(error, "callback"); }
			}
			if (opts.onTimeout && consumeTimeoutRequest(asyncDir, fsImpl)) {
				try { opts.onTimeout(); } catch (error) { report(error, "callback"); }
			}
			if (opts.onInterrupt && consumeInterruptRequest(asyncDir, fsImpl)) {
				try { opts.onInterrupt(); } catch (error) { report(error, "callback"); }
			}
			if (opts.onSteer) for (const request of consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl, (error) => report(error, "scan"))) {
				try { opts.onSteer(request); } catch (error) { report(error, "callback", request); }
			}
		} catch (error) {
			report(error, "scan");
		}
	};

	// Handle a request that may have arrived before the watcher started.
	check();

	const watchers: fs.FSWatcher[] = [];
	let interval: ReturnType<typeof setInterval> | undefined;
	let safetyInterval: ReturnType<typeof setInterval> | undefined;
	const startPolling = (): void => {
		if (interval || disposed) return;
		if (safetyInterval) { timers.clearInterval(safetyInterval); safetyInterval = undefined; }
		interval = timers.setInterval(check, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
		interval.unref?.();
	};
	try {
		if (shouldUseNativeFsWatch("runner-control-inbox", opts.platform)) {
			for (const target of dirs) {
				const watcher = fsImpl.watch(resolveWatchPath(target, fsImpl.realpathSync.native), check);
				watcher.on?.("error", startPolling);
				watchers.push(watcher);
			}
			if (!interval) {
				safetyInterval = timers.setInterval(check, opts.safetyPollIntervalMs ?? CONTROL_SAFETY_POLL_INTERVAL_MS);
				safetyInterval.unref?.();
			}
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
