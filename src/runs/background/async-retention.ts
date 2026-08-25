import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { AsyncStatus } from "../../shared/types.ts";
import { MISSION_BINDING_FILE } from "../../missions/lifecycle.ts";
import { ACTIVE_RUN_INDEX_DIR } from "./active-run-index.ts";
import { encodeIndexSegment } from "./index-segment.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

export const ASYNC_RETENTION_DAYS = 30;
export const ASYNC_RETENTION_BATCH_SIZE = 100;
export const ASYNC_RETENTION_DELAY_MS = 60_000;
export const ASYNC_RETENTION_TOMBSTONE_GRACE_MS = 24 * 60 * 60 * 1000;

const RETENTION_MS = ASYNC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const LOCK_NAME = ".async-retention.lock";
const CURSOR_NAME = ".async-retention-cursor.json";
const LOG_NAME = "async-retention-maintenance.jsonl";
const RUN_TOMBSTONE_PREFIX = ".deleting-run-";
const RESULT_TOMBSTONE_PREFIX = ".deleting-result-";
const RUN_TOMBSTONE_MARKERS_DIR = "async-retention-run-tombstones";
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;
const RUN_MODES = new Set<AsyncStatus["mode"]>(["single", "parallel", "chain", "workflow"]);
const TERMINAL_STATES = new Set<AsyncStatus["state"]>(["complete", "failed", "stopped", "rejected"]);
const RESULT_TIMESTAMP_FIELDS = ["endedAt", "completedAt", "createdAt", "writtenAt", "expiresAt", "timestamp"] as const;

interface RetentionCursor {
	version: 1;
	runAfter?: string;
	resultAfter?: string;
	resultPublicAfter?: string;
	resultPendingAfterBySession?: Record<string, string>;
	resultReplayAfter?: string;
	resultArchiveAfter?: string;
	pendingSessionAfter?: string;
}

type ResultCursorKey = keyof Pick<RetentionCursor, "resultPublicAfter" | "resultReplayAfter" | "resultArchiveAfter">;
type ResultCursorTarget = { type: "result"; key: ResultCursorKey } | { type: "pending"; session: string };

interface ResultCandidate {
	path: string;
	relative: string;
	kind: "public" | "pending" | "replay" | "archive" | "tombstone";
	cursor: ResultCursorTarget;
}

interface DiscoveredRunCandidate {
	name: string;
	relative: string;
}

type CursorOperation =
	| { type: "set"; key: Exclude<keyof RetentionCursor, "version" | "resultPendingAfterBySession">; value: string }
	| { type: "delete"; key: Exclude<keyof RetentionCursor, "version" | "resultPendingAfterBySession"> }
	| { type: "set-pending"; session: string; value: string }
	| { type: "delete-pending"; session: string };

interface RetentionDiscovery {
	discoveryDurationMs: number;
	rawReads: number;
	sourceExhausted: Record<string, boolean>;
	runCandidates: DiscoveredRunCandidate[];
	resultCandidates: Array<Omit<ResultCandidate, "path">>;
	cursorOps: CursorOperation[];
}

interface RetentionLockOwner {
	version: 1;
	token: string;
	pid: number;
	hostname: string;
	startedAt: number;
	processStartIdentity?: string;
}

export interface AsyncRetentionOptions {
	asyncDirRoot: string;
	resultsDir: string;
	waitSubscriptionsDir?: string;
	protectedRunIds?: Iterable<string>;
	now?: () => number;
	retentionMs?: number;
	tombstoneGraceMs?: number;
	batchSize?: number;
	randomId?: () => string;
	maintenanceRoot?: string;
	pid?: number;
	hostname?: string;
	processStartIdentity?: string;
	isProcessAlive?: (pid: number) => boolean | undefined;
	getProcessStartIdentity?: (pid: number) => string | undefined;
	lstatSync?: typeof fs.lstatSync;
	signal?: AbortSignal;
	discoveryWorkerUrl?: URL;
	reconcileKill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

export interface AsyncRetentionResult {
	acquired: boolean;
	scanned: number;
	repairedRuns: number;
	deletedRuns: number;
	deletedResults: number;
	reapedTombstones: number;
	skipped: Record<string, number>;
	errors: string[];
	rawReads: number;
	sourceExhausted: Record<string, boolean>;
	discoveryDurationMs: number;
	commitDurationMs: number;
	cancelled: boolean;
	workerFailed: boolean;
	durationMs: number;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function compactError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").slice(0, 240);
}

function listDir(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath).toString("utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function readStatus(runDir: string): AsyncStatus | undefined {
	const value = readJson(path.join(runDir, "status.json"));
	if (!value
		|| typeof value.runId !== "string"
		|| typeof value.state !== "string"
		|| typeof value.mode !== "string"
		|| !RUN_MODES.has(value.mode as AsyncStatus["mode"])
		|| typeof value.startedAt !== "number"
		|| !Number.isFinite(value.startedAt)) return undefined;
	return value as unknown as AsyncStatus;
}

function existingRegularFile(filePath: string | undefined): boolean {
	if (!filePath) return false;
	try {
		const stat = fs.lstatSync(filePath);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch (error) {
		return !isNotFound(error);
	}
}

function validRunId(runId: string): boolean {
	return runId.length > 0 && runId !== "." && runId !== ".." && path.basename(runId) === runId;
}

function statusTimestamp(status: AsyncStatus, runDir: string): number | undefined {
	if (status.endedAt !== undefined && (typeof status.endedAt !== "number" || !Number.isFinite(status.endedAt))) return undefined;
	if (status.lastUpdate !== undefined && (typeof status.lastUpdate !== "number" || !Number.isFinite(status.lastUpdate))) return undefined;
	const logical = status.endedAt ?? status.lastUpdate;
	try {
		const physical = Math.max(fs.statSync(runDir).mtimeMs, fs.statSync(path.join(runDir, "status.json")).mtimeMs);
		const timestamp = logical === undefined ? physical : Math.max(logical, physical);
		return Number.isFinite(timestamp) ? timestamp : undefined;
	} catch {
		return undefined;
	}
}

function hasNestedReferences(status: AsyncStatus): boolean {
	return status.isNested === true || (status.steps ?? []).some((step) => (step.children?.length ?? 0) > 0);
}

function hasResumableContract(runDir: string, status: AsyncStatus): boolean {
	const statusSessionFiles = [status.sessionFile, ...(status.steps ?? []).map((step) => step.sessionFile)];
	if (statusSessionFiles.some(existingRegularFile)) return true;
	const descriptorPath = path.join(runDir, "recovery-descriptor.json");
	if (!fs.existsSync(descriptorPath)) return false;
	const descriptor = readJson(descriptorPath);
	if (!descriptor) return true;
	const sessionFiles = [
		typeof descriptor.sessionFile === "string" ? descriptor.sessionFile : undefined,
	];
	if (descriptor.sourceRunId !== status.runId) return true;
	return sessionFiles.some(existingRegularFile);
}

function activeMarkerExists(asyncDirRoot: string, runId: string): boolean {
	return fs.existsSync(path.join(asyncDirRoot, ACTIVE_RUN_INDEX_DIR, runId));
}

function missionObserverIndexExists(resultsDir: string, runId: string): boolean {
	return fs.existsSync(path.join(resultsDir, "result-index", "observers", "mission", `${encodeIndexSegment(runId)}.json`));
}

function runTombstoneMarkerPath(maintenanceRoot: string, runId: string): string {
	return path.join(maintenanceRoot, RUN_TOMBSTONE_MARKERS_DIR, `${encodeIndexSegment(runId)}.json`);
}

function writeRunTombstoneMarker(maintenanceRoot: string, runId: string, tombstonePath: string, now: number): void {
	const markerPath = runTombstoneMarkerPath(maintenanceRoot, runId);
	fs.mkdirSync(path.dirname(markerPath), { recursive: true });
	writeAtomicJson(markerPath, { version: 1, runId, tombstonePath, createdAt: now });
}

function removeRunTombstoneMarker(maintenanceRoot: string, runId: string): void {
	fs.rmSync(runTombstoneMarkerPath(maintenanceRoot, runId), { force: true });
}

function readRunTombstoneMarker(maintenanceRoot: string, runId: string): { runId: string; tombstonePath: string } | undefined | "unreadable" {
	const markerPath = runTombstoneMarkerPath(maintenanceRoot, runId);
	try {
		const stat = fs.lstatSync(markerPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return "unreadable";
	} catch (error) {
		return isNotFound(error) ? undefined : "unreadable";
	}
	const marker = readJson(markerPath);
	if (marker?.version !== 1 || marker.runId !== runId || typeof marker.tombstonePath !== "string" || !marker.tombstonePath) return "unreadable";
	return { runId, tombstonePath: marker.tombstonePath };
}

function runTombstoneMarkerMatches(maintenanceRoot: string, runId: string, tombstonePath: string): boolean {
	const marker = readRunTombstoneMarker(maintenanceRoot, runId);
	return marker !== undefined && marker !== "unreadable" && path.resolve(marker.tombstonePath) === path.resolve(tombstonePath);
}

function runTombstoneMarkerBlocks(maintenanceRoot: string, runId: string): boolean {
	const marker = readRunTombstoneMarker(maintenanceRoot, runId);
	if (marker === undefined) return false;
	if (marker === "unreadable") return true;
	try {
		if (fs.existsSync(marker.tombstonePath)) return true;
		removeRunTombstoneMarker(maintenanceRoot, runId);
		return false;
	} catch {
		return true;
	}
}

function unresolvedHandoff(manifestPath: string): boolean {
	const manifest = readJson(manifestPath);
	if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.groups) || manifest.groups.length === 0) return true;
	return manifest.groups.some((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return true;
		const cleanup = (value as Record<string, unknown>).cleanup;
		return !cleanup || typeof cleanup !== "object" || Array.isArray(cleanup) || (cleanup as Record<string, unknown>).state !== "complete";
	});
}

function hasUnresolvedRunHandoff(runDir: string, status: AsyncStatus): boolean {
	const paths = new Set<string>();
	if (status.parallelHandoff) {
		if (typeof status.parallelHandoff.path !== "string" || !status.parallelHandoff.path) return true;
		paths.add(status.parallelHandoff.path);
	}
	const localPath = path.join(runDir, "handoff.json");
	if (fs.existsSync(localPath)) paths.add(localPath);
	return [...paths].some(unresolvedHandoff);
}

function runSkipReason(input: {
	runDir: string;
	status: AsyncStatus | undefined;
	asyncDirRoot: string;
	resultsDir: string;
	cutoff: number;
	protectedRunIds: ReadonlySet<string>;
	waitRunIds: ReadonlySet<string>;
}): string | undefined {
	const { runDir, status } = input;
	if (!status) return "invalid-status";
	if (!validRunId(status.runId)) return "identity-mismatch";
	if (path.basename(runDir) !== status.runId && !path.basename(runDir).startsWith(RUN_TOMBSTONE_PREFIX)) return "identity-mismatch";
	if (input.protectedRunIds.has(status.runId)) return "runtime-reference";
	if (input.waitRunIds.has(status.runId)) return "wait-reference";
	if (activeMarkerExists(input.asyncDirRoot, status.runId)) return "active-index";
	if (!TERMINAL_STATES.has(status.state)) return "non-terminal";
	if (status.mode === "workflow" || status.parentWorkflowRunId || status.workflowKey) return "workflow-reference";
	if (hasNestedReferences(status)) return "nested-reference";
	if (fs.existsSync(path.join(runDir, MISSION_BINDING_FILE)) || missionObserverIndexExists(input.resultsDir, status.runId)) return "mission-reference";
	if (hasUnresolvedRunHandoff(runDir, status)) return "handoff-reference";
	if (hasResumableContract(runDir, status)) return "resumable";
	const timestamp = statusTimestamp(status, runDir);
	if (timestamp === undefined) return "unknown-age";
	if (timestamp > input.cutoff) return "recent";
	return undefined;
}

function parseWaitRunIds(dir: string): { runIds: Set<string>; safe: boolean } {
	const runIds = new Set<string>();
	for (const entry of listDir(dir)) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const record = readJson(path.join(dir, entry.name));
		if (!record || typeof record.runId !== "string" || typeof record.expiresAt !== "number") return { runIds, safe: false };
		runIds.add(record.runId);
	}
	return { runIds, safe: true };
}

function readCursor(root: string): RetentionCursor {
	const value = readJson(path.join(root, CURSOR_NAME));
	return value?.version === 1 ? value as unknown as RetentionCursor : { version: 1 };
}

function processStartIdentity(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`).toString("utf8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
			return fields[19] ? `linux:${fields[19]}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`], { encoding: "utf-8", windowsHide: true });
		const started = result.status === 0 ? result.stdout.trim() : "";
		return started ? `win:${started}` : undefined;
	}
	return undefined;
}

function processIsAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

function parseLockOwner(lockDir: string): RetentionLockOwner | undefined {
	const owner = readJson(path.join(lockDir, "owner.json"));
	if (owner?.version !== 1
		|| typeof owner.token !== "string"
		|| typeof owner.pid !== "number"
		|| !Number.isInteger(owner.pid)
		|| owner.pid <= 0
		|| typeof owner.hostname !== "string"
		|| typeof owner.startedAt !== "number"
		|| !Number.isFinite(owner.startedAt)) return undefined;
	if (owner.processStartIdentity !== undefined && typeof owner.processStartIdentity !== "string") return undefined;
	return owner as unknown as RetentionLockOwner;
}

function staleLock(lockDir: string, now: number, options: Required<Pick<AsyncRetentionOptions, "hostname" | "isProcessAlive" | "getProcessStartIdentity">>): { stale: boolean; token?: string } {
	const owner = parseLockOwner(lockDir);
	if (!owner) {
		try {
			return { stale: now - fs.statSync(lockDir).mtimeMs >= LOCK_STALE_MS };
		} catch {
			return { stale: false };
		}
	}
	if (owner.hostname !== options.hostname) return { stale: false };
	const alive = options.isProcessAlive(owner.pid);
	if (alive === false) return { stale: true, token: owner.token };
	if (alive === true && owner.processStartIdentity) {
		const currentIdentity = options.getProcessStartIdentity(owner.pid);
		if (currentIdentity !== undefined && currentIdentity !== owner.processStartIdentity) return { stale: true, token: owner.token };
	}
	return { stale: now - owner.startedAt >= LOCK_STALE_MS, token: owner.token };
}

function createLockDirectory(lockDir: string, owner: RetentionLockOwner): boolean {
	try {
		fs.mkdirSync(lockDir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
		return true;
	} catch (error) {
		fs.rmSync(lockDir, { recursive: true, force: true });
		throw error;
	}
}

function acquireRetentionLock(lockDir: string, owner: RetentionLockOwner, options: Required<Pick<AsyncRetentionOptions, "hostname" | "isProcessAlive" | "getProcessStartIdentity">>): boolean {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		if (createLockDirectory(lockDir, owner)) return true;
		const stale = staleLock(lockDir, owner.startedAt, options);
		if (!stale.stale) return false;
		const staleKey = (stale.token ?? owner.token).replace(/[^A-Za-z0-9._-]/g, "-");
		const tombstone = `${lockDir}.stale-${staleKey}`;
		try {
			fs.renameSync(lockDir, tombstone);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || fs.existsSync(tombstone)) continue;
			throw error;
		}
	}
	return false;
}

function releaseRetentionLock(lockDir: string, token: string): void {
	if (parseLockOwner(lockDir)?.token !== token) return;
	fs.rmSync(lockDir, { recursive: true, force: true });
}

function resultRunId(candidate: ResultCandidate, data: Record<string, unknown>): string | undefined {
	if (typeof data.runId === "string") return data.runId;
	if (typeof data.id === "string") return data.id;
	if ((candidate.kind === "public" || candidate.kind === "pending") && path.basename(candidate.path).endsWith(".json")) return path.basename(candidate.path, ".json");
	return undefined;
}

function resultTimestamp(data: Record<string, unknown>, filePath: string): number | undefined {
	for (const field of RESULT_TIMESTAMP_FIELDS) {
		const value = data[field];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) return undefined;
	}
	const logical = RESULT_TIMESTAMP_FIELDS.map((field) => data[field])
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	try {
		return Math.max(fs.statSync(filePath).mtimeMs, ...logical);
	} catch {
		return undefined;
	}
}

function terminalResult(data: Record<string, unknown>): boolean {
	return data.success === true || data.success === false || (typeof data.state === "string" && TERMINAL_STATES.has(data.state as AsyncStatus["state"]));
}

function resultHasResumableSession(data: Record<string, unknown>): boolean {
	if (existingRegularFile(typeof data.sessionFile === "string" ? data.sessionFile : undefined)) return true;
	return Array.isArray(data.results) && data.results.some((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const sessionFile = (value as Record<string, unknown>).sessionFile;
		return existingRegularFile(typeof sessionFile === "string" ? sessionFile : undefined);
	});
}

function hasUnresolvedResultHandoff(data: Record<string, unknown>): boolean {
	if (data.parallelHandoff === undefined) return false;
	if (!data.parallelHandoff || typeof data.parallelHandoff !== "object" || Array.isArray(data.parallelHandoff)) return true;
	const manifestPath = (data.parallelHandoff as Record<string, unknown>).path;
	return typeof manifestPath !== "string" || !manifestPath || unresolvedHandoff(manifestPath);
}

function completionMode(data: Record<string, unknown>): unknown {
	return data.completion && typeof data.completion === "object" && !Array.isArray(data.completion)
		? (data.completion as Record<string, unknown>).mode
		: undefined;
}

function resultSkipReason(input: {
	candidate: ResultCandidate;
	data: Record<string, unknown> | undefined;
	asyncDirRoot: string;
	resultsDir: string;
	maintenanceRoot: string;
	cutoff: number;
	protectedRunIds: ReadonlySet<string>;
	waitRunIds: ReadonlySet<string>;
}): string | undefined {
	if (!input.data) return "invalid-result";
	const runId = resultRunId(input.candidate, input.data);
	if (!runId || !validRunId(runId)) return "invalid-result";
	if (runTombstoneMarkerBlocks(input.maintenanceRoot, runId)) return "run-tombstone-present";
	if (input.protectedRunIds.has(runId)) return "runtime-reference";
	if (input.waitRunIds.has(runId)) return "wait-reference";
	if (activeMarkerExists(input.asyncDirRoot, runId)) return "active-index";
	if (fs.existsSync(path.join(input.asyncDirRoot, runId))) return "run-present";
	if (missionObserverIndexExists(input.resultsDir, runId)) return "mission-reference";
	if (input.data.mode === "workflow" || completionMode(input.data) === "workflow" || typeof input.data.parentWorkflowRunId === "string" || typeof input.data.workflowKey === "string") return "workflow-reference";
	if (hasUnresolvedResultHandoff(input.data)) return "handoff-reference";
	if (resultHasResumableSession(input.data)) return "resumable";
	if (input.candidate.kind === "archive" && fs.existsSync(path.join(input.resultsDir, "completion-replay", `${encodeURIComponent(runId)}.json`))) return "replay-reference";
	if (!terminalResult(input.data) && input.candidate.kind !== "replay" && input.candidate.kind !== "archive" && input.candidate.kind !== "tombstone") return "non-terminal-result";
	const timestamp = resultTimestamp(input.data, input.candidate.path);
	if (timestamp === undefined) return "unknown-age";
	if (timestamp > input.cutoff) return "recent";
	return undefined;
}

function appendMaintenanceLog(root: string, result: AsyncRetentionResult, now: number, deletedIds: string[]): void {
	fs.mkdirSync(root, { recursive: true });
	fs.appendFileSync(path.join(root, LOG_NAME), `${JSON.stringify({
		at: new Date(now).toISOString(),
		acquired: result.acquired,
		scanned: result.scanned,
		repairedRuns: result.repairedRuns,
		deletedRuns: result.deletedRuns,
		deletedResults: result.deletedResults,
		reapedTombstones: result.reapedTombstones,
		skipped: result.skipped,
		deleted: deletedIds.slice(0, ASYNC_RETENTION_BATCH_SIZE),
		errors: result.errors.length,
		rawReads: result.rawReads,
		sourceExhausted: result.sourceExhausted,
		discoveryDurationMs: result.discoveryDurationMs,
		commitDurationMs: result.commitDurationMs,
		cancelled: result.cancelled,
		workerFailed: result.workerFailed,
		durationMs: result.durationMs,
	})}\n`, "utf-8");
}

function increment(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}


class RetentionCancelledError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRelative(relative: string): boolean {
	return relative.length > 0 && !path.isAbsolute(relative) && !relative.split(path.sep).includes("..");
}

function parseDiscoveryResult(message: unknown, passId: string, runBudget: number, resultBudget: number): RetentionDiscovery {
	if (!isRecord(message) || message.type !== "result" || message.passId !== passId) throw new Error("Retention discovery worker returned a stale or malformed pass id.");
	if (!Number.isFinite(message.discoveryDurationMs) || (message.discoveryDurationMs as number) < 0) throw new Error("Retention discovery worker returned an invalid duration.");
	if (!Number.isInteger(message.rawReads) || (message.rawReads as number) < 0) throw new Error("Retention discovery worker returned an invalid raw-read count.");
	if (!isRecord(message.sourceExhausted) || Object.values(message.sourceExhausted).some((value) => typeof value !== "boolean")) throw new Error("Retention discovery worker returned invalid source telemetry.");
	if (!Array.isArray(message.runCandidates) || message.runCandidates.length > runBudget) throw new Error("Retention discovery worker exceeded the run budget.");
	if (!Array.isArray(message.resultCandidates) || message.resultCandidates.length > resultBudget) throw new Error("Retention discovery worker exceeded the result budget.");
	if (!Array.isArray(message.cursorOps) || message.cursorOps.length > runBudget + resultBudget + 8) throw new Error("Retention discovery worker returned invalid cursor operations.");
	for (const candidate of message.runCandidates) {
		if (!isRecord(candidate) || typeof candidate.name !== "string" || typeof candidate.relative !== "string" || !validRunId(candidate.name) || candidate.relative !== candidate.name) throw new Error("Retention discovery worker returned an unsafe run candidate.");
	}
	const resultKinds = new Set(["public", "pending", "replay", "archive", "tombstone"]);
	const resultKeys = new Set(["resultPublicAfter", "resultReplayAfter", "resultArchiveAfter"]);
	for (const candidate of message.resultCandidates) {
		if (!isRecord(candidate) || typeof candidate.name !== "string" || typeof candidate.relative !== "string" || path.basename(candidate.name) !== candidate.name || !safeRelative(candidate.relative) || path.basename(candidate.relative) !== candidate.name || !resultKinds.has(candidate.kind as string) || !isRecord(candidate.cursor)) throw new Error("Retention discovery worker returned an unsafe result candidate.");
		const cursor = candidate.cursor;
		if (cursor.type === "pending") {
			if (typeof cursor.session !== "string" || !validRunId(cursor.session) || path.dirname(candidate.relative) !== path.join("result-pending", cursor.session)) throw new Error("Retention discovery worker returned an invalid pending candidate.");
		} else if (cursor.type === "result") {
			if (typeof cursor.key !== "string" || !resultKeys.has(cursor.key)) throw new Error("Retention discovery worker returned an invalid result cursor.");
			const expectedDir = cursor.key === "resultPublicAfter" ? "." : cursor.key === "resultReplayAfter" ? "completion-replay" : "output-archives";
			if (path.dirname(candidate.relative) !== expectedDir) throw new Error("Retention discovery worker returned a result from the wrong source.");
		} else throw new Error("Retention discovery worker returned an invalid result cursor target.");
	}
	const scalarKeys = new Set(["runAfter", "resultPublicAfter", "resultReplayAfter", "resultArchiveAfter", "pendingSessionAfter"]);
	for (const operation of message.cursorOps) {
		if (!isRecord(operation) || typeof operation.type !== "string") throw new Error("Retention discovery worker returned a malformed cursor operation.");
		if (operation.type === "set" || operation.type === "delete") {
			if (typeof operation.key !== "string" || !scalarKeys.has(operation.key) || (operation.type === "set" && (typeof operation.value !== "string" || !safeRelative(operation.value)))) throw new Error("Retention discovery worker returned an invalid scalar cursor operation.");
		} else if (operation.type === "set-pending" || operation.type === "delete-pending") {
			if (typeof operation.session !== "string" || !validRunId(operation.session) || (operation.type === "set-pending" && (typeof operation.value !== "string" || !safeRelative(operation.value)))) throw new Error("Retention discovery worker returned an invalid pending cursor operation.");
		} else throw new Error("Retention discovery worker returned an unknown cursor operation.");
	}
	return message as unknown as RetentionDiscovery;
}

function runRetentionDiscovery(input: {
	passId: string;
	asyncDirRoot: string;
	resultsDir: string;
	cursor: RetentionCursor;
	runBudget: number;
	resultBudget: number;
	workerUrl: URL;
	signal?: AbortSignal;
}): Promise<RetentionDiscovery> {
	return new Promise((resolve, reject) => {
		if (input.signal?.aborted) {
			reject(new RetentionCancelledError("Retention discovery was cancelled."));
			return;
		}
		const worker = new Worker(input.workerUrl);
		let settled = false;
		const cleanup = (): void => {
			input.signal?.removeEventListener("abort", onAbort);
			void worker.terminate();
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => fail(new RetentionCancelledError("Retention discovery was cancelled."));
		input.signal?.addEventListener("abort", onAbort, { once: true });
		worker.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
		worker.once("exit", (code) => {
			if (!settled) fail(new Error(`Retention discovery worker exited before replying (${code}).`));
		});
		worker.once("message", (message: unknown) => {
			if (settled) return;
			try {
				if (isRecord(message) && message.type === "error" && message.passId === input.passId) throw new Error(`Retention discovery failed: ${String(message.error)}`);
				const discovery = parseDiscoveryResult(message, input.passId, input.runBudget, input.resultBudget);
				settled = true;
				cleanup();
				resolve(discovery);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		worker.postMessage({ type: "discover", passId: input.passId, asyncDirRoot: input.asyncDirRoot, resultsDir: input.resultsDir, cursor: input.cursor, runBudget: input.runBudget, resultBudget: input.resultBudget });
	});
}

function applyCursorOperations(cursor: RetentionCursor, operations: CursorOperation[]): void {
	for (const operation of operations) {
		if (operation.type === "set") cursor[operation.key] = operation.value;
		else if (operation.type === "delete") delete cursor[operation.key];
		else if (operation.type === "set-pending") {
			cursor.resultPendingAfterBySession ??= {};
			cursor.resultPendingAfterBySession[operation.session] = operation.value;
		} else {
			delete cursor.resultPendingAfterBySession?.[operation.session];
			if (cursor.resultPendingAfterBySession && Object.keys(cursor.resultPendingAfterBySession).length === 0) delete cursor.resultPendingAfterBySession;
		}
	}
}

export async function cleanupAsyncRetention(options: AsyncRetentionOptions): Promise<AsyncRetentionResult> {
	const startedWall = Date.now();
	const now = options.now ?? Date.now;
	const currentTime = now();
	const retentionMs = options.retentionMs ?? RETENTION_MS;
	const tombstoneGraceMs = options.tombstoneGraceMs ?? ASYNC_RETENTION_TOMBSTONE_GRACE_MS;
	const batchSize = Math.min(ASYNC_RETENTION_BATCH_SIZE, Math.max(1, Math.trunc(options.batchSize ?? ASYNC_RETENTION_BATCH_SIZE)));
	const randomId = options.randomId ?? randomUUID;
	const maintenanceRoot = options.maintenanceRoot ?? path.dirname(options.asyncDirRoot);
	const lockDir = path.join(maintenanceRoot, LOCK_NAME);
	const lockToken = randomId();
	const pid = options.pid ?? process.pid;
	const hostname = options.hostname ?? os.hostname();
	const getProcessStartIdentity = options.getProcessStartIdentity ?? processStartIdentity;
	const currentProcessStartIdentity = options.processStartIdentity ?? getProcessStartIdentity(pid) ?? (pid === process.pid ? `runtime:${Math.round(Date.now() - process.uptime() * 1000)}` : undefined);
	const lockOwner: RetentionLockOwner = { version: 1, token: lockToken, pid, hostname, startedAt: currentTime, ...(currentProcessStartIdentity ? { processStartIdentity: currentProcessStartIdentity } : {}) };
	const lockOptions = { hostname, isProcessAlive: options.isProcessAlive ?? processIsAlive, getProcessStartIdentity };
	const result: AsyncRetentionResult = {
		acquired: false,
		scanned: 0,
		repairedRuns: 0,
		deletedRuns: 0,
		deletedResults: 0,
		reapedTombstones: 0,
		skipped: {},
		errors: [],
		rawReads: 0,
		sourceExhausted: {},
		discoveryDurationMs: 0,
		commitDurationMs: 0,
		cancelled: false,
		workerFailed: false,
		durationMs: 0,
	};
	const deletedIds: string[] = [];
	const lstatSync = options.lstatSync ?? fs.lstatSync;
	let commitStartedAt: number | undefined;
	let cursorCommitUnsafe = false;
	const finish = (): AsyncRetentionResult => {
		if (commitStartedAt !== undefined) result.commitDurationMs = Math.max(0, Date.now() - commitStartedAt);
		result.durationMs = Math.max(0, Date.now() - startedWall);
		appendMaintenanceLog(maintenanceRoot, result, currentTime, deletedIds);
		return result;
	};
	const markCancelled = (): boolean => {
		if (!options.signal?.aborted) return false;
		result.cancelled = true;
		increment(result.skipped, "cancelled");
		return true;
	};
	fs.mkdirSync(maintenanceRoot, { recursive: true });
	if (!acquireRetentionLock(lockDir, lockOwner, lockOptions)) {
		increment(result.skipped, "lock-busy");
		return finish();
	}
	result.acquired = true;
	try {
		if (markCancelled()) return finish();
		const protectedRunIds = new Set(options.protectedRunIds ?? []);
		const cutoff = currentTime - retentionMs;
		const cursor = readCursor(maintenanceRoot);
		const runBudget = Math.ceil(batchSize / 2);
		const resultBudget = batchSize - runBudget;
		const discoveryStartedAt = Date.now();
		let discovery: RetentionDiscovery;
		try {
			discovery = await runRetentionDiscovery({
				passId: randomUUID(),
				asyncDirRoot: options.asyncDirRoot,
				resultsDir: options.resultsDir,
				cursor,
				runBudget,
				resultBudget,
				workerUrl: options.discoveryWorkerUrl ?? new URL("../../../async-retention-discovery-worker.mjs", import.meta.url),
				signal: options.signal,
			});
		} catch (error) {
			result.discoveryDurationMs = Math.max(0, Date.now() - discoveryStartedAt);
			if (error instanceof RetentionCancelledError) {
				result.cancelled = true;
				increment(result.skipped, "cancelled");
			} else {
				result.workerFailed = true;
				increment(result.skipped, "worker-failure");
				result.errors.push(compactError(error));
			}
			return finish();
		}
		result.discoveryDurationMs = Math.max(0, Date.now() - discoveryStartedAt);
		result.rawReads = discovery.rawReads;
		result.sourceExhausted = discovery.sourceExhausted;
		commitStartedAt = Date.now();
		if (markCancelled()) return finish();
		if (parseLockOwner(lockDir)?.token !== lockToken) {
			increment(result.skipped, "lock-owner-changed");
			return finish();
		}
		const waitSubscriptionsDir = options.waitSubscriptionsDir ?? path.join(maintenanceRoot, "wait-subscriptions");
		// This safety scan stays on the commit thread. Wait records are the active,
		// swept subscription set. Each destructive action re-reads it to close the
		// race with a newly armed wait.
		const waitReferences = parseWaitRunIds(waitSubscriptionsDir);
		if (!waitReferences.safe) {
			increment(result.skipped, "wait-references-unknown");
			return finish();
		}
		for (const entry of discovery.runCandidates) {
			if (markCancelled()) return finish();
			result.scanned += 1;
			const runDir = path.join(options.asyncDirRoot, entry.name);
			let mutationStateChanged = false;
			try {
				const stat = lstatSync(runDir);
				if (!stat.isDirectory() || stat.isSymbolicLink()) {
					increment(result.skipped, "unsafe-run-path");
					continue;
				}
				let status = readStatus(runDir);
				if (status?.state === "running"
					&& validRunId(status.runId)
					&& path.basename(runDir) === status.runId
					&& !protectedRunIds.has(status.runId)) {
					const reconciliation = reconcileAsyncRun(runDir, {
						resultsDir: options.resultsDir,
						kill: options.reconcileKill,
						now,
					});
					status = reconciliation.status ?? undefined;
					if (reconciliation.repaired) result.repairedRuns += 1;
				}
				const initialReason = runSkipReason({ runDir, status, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, cutoff, protectedRunIds, waitRunIds: waitReferences.runIds });
				if (initialReason) {
					increment(result.skipped, initialReason);
					continue;
				}
				if (entry.name.startsWith(RUN_TOMBSTONE_PREFIX)) {
					if (!runTombstoneMarkerMatches(maintenanceRoot, status!.runId, runDir)) {
						increment(result.skipped, "run-tombstone-marker");
						continue;
					}
					if (currentTime - stat.mtimeMs < tombstoneGraceMs) {
						increment(result.skipped, "tombstone-grace");
						continue;
					}
					const freshWaitReferences = parseWaitRunIds(waitSubscriptionsDir);
					const finalReason = freshWaitReferences.safe ? runSkipReason({ runDir, status, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds }) : "wait-references-unknown";
					if (finalReason) {
						increment(result.skipped, `recheck-${finalReason}`);
						continue;
					}
					mutationStateChanged = true;
					fs.rmSync(runDir, { recursive: true });
					removeRunTombstoneMarker(maintenanceRoot, status!.runId);
					result.reapedTombstones += 1;
					deletedIds.push(`run-tombstone:${status!.runId}`);
					continue;
				}
				const tombstone = path.join(options.asyncDirRoot, `${RUN_TOMBSTONE_PREFIX}${randomId()}`);
				writeRunTombstoneMarker(maintenanceRoot, status!.runId, tombstone, currentTime);
				mutationStateChanged = true;
				try {
					fs.renameSync(runDir, tombstone);
				} catch (error) {
					removeRunTombstoneMarker(maintenanceRoot, status!.runId);
					mutationStateChanged = false;
					throw error;
				}
				const recheckStatus = readStatus(tombstone);
				const freshWaitReferences = parseWaitRunIds(waitSubscriptionsDir);
				const recheckReason = freshWaitReferences.safe ? runSkipReason({ runDir: tombstone, status: recheckStatus, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds }) : "wait-references-unknown";
				if (recheckReason) {
					if (!fs.existsSync(runDir)) {
						fs.renameSync(tombstone, runDir);
						mutationStateChanged = false;
					}
					removeRunTombstoneMarker(maintenanceRoot, status!.runId);
					if (mutationStateChanged) cursorCommitUnsafe = true;
					increment(result.skipped, `recheck-${recheckReason}`);
					continue;
				}
				fs.rmSync(tombstone, { recursive: true });
				removeRunTombstoneMarker(maintenanceRoot, status!.runId);
				result.deletedRuns += 1;
				deletedIds.push(`run:${status!.runId}`);
			} catch (error) {
				if (mutationStateChanged) cursorCommitUnsafe = true;
				if (!isNotFound(error)) result.errors.push(compactError(error));
			}
		}
		for (const discoveredCandidate of discovery.resultCandidates) {
			if (markCancelled()) return finish();
			result.scanned += 1;
			const candidate: ResultCandidate = { ...discoveredCandidate, path: path.join(options.resultsDir, discoveredCandidate.relative) };
			let mutationStateChanged = false;
			try {
				const stat = lstatSync(candidate.path);
				if (!stat.isFile() || stat.isSymbolicLink()) {
					increment(result.skipped, "unsafe-result-path");
					continue;
				}
				const data = readJson(candidate.path);
				const reason = resultSkipReason({ candidate, data, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, maintenanceRoot, cutoff, protectedRunIds, waitRunIds: waitReferences.runIds });
				if (reason) {
					increment(result.skipped, reason);
					continue;
				}
				if (candidate.kind === "tombstone") {
					if (currentTime - stat.mtimeMs < tombstoneGraceMs) {
						increment(result.skipped, "tombstone-grace");
						continue;
					}
					const freshWaitReferences = parseWaitRunIds(waitSubscriptionsDir);
					const finalReason = freshWaitReferences.safe ? resultSkipReason({ candidate, data, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, maintenanceRoot, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds }) : "wait-references-unknown";
					if (finalReason) {
						increment(result.skipped, `recheck-${finalReason}`);
						continue;
					}
					fs.rmSync(candidate.path);
					mutationStateChanged = true;
					result.reapedTombstones += 1;
					deletedIds.push(`result-tombstone:${resultRunId(candidate, data!)}`);
					continue;
				}
				const tombstone = path.join(path.dirname(candidate.path), `${RESULT_TOMBSTONE_PREFIX}${candidate.kind}-${randomId()}`);
				fs.renameSync(candidate.path, tombstone);
				mutationStateChanged = true;
				const tombstoneCandidate = { ...candidate, path: tombstone, kind: "tombstone" as const };
				const recheckData = readJson(tombstone);
				const freshWaitReferences = parseWaitRunIds(waitSubscriptionsDir);
				const recheckReason = freshWaitReferences.safe ? resultSkipReason({ candidate: tombstoneCandidate, data: recheckData, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, maintenanceRoot, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds }) : "wait-references-unknown";
				if (recheckReason) {
					if (!fs.existsSync(candidate.path)) {
						fs.renameSync(tombstone, candidate.path);
						mutationStateChanged = false;
					}
					if (mutationStateChanged) cursorCommitUnsafe = true;
					increment(result.skipped, `recheck-${recheckReason}`);
					continue;
				}
				fs.rmSync(tombstone);
				result.deletedResults += 1;
				deletedIds.push(`result:${resultRunId(candidate, data!)}`);
			} catch (error) {
				if (mutationStateChanged) cursorCommitUnsafe = true;
				if (!isNotFound(error)) result.errors.push(compactError(error));
			}
		}
		if (cursorCommitUnsafe) {
			increment(result.skipped, "commit-failure");
			return finish();
		}
		if (markCancelled()) return finish();
		if (parseLockOwner(lockDir)?.token !== lockToken) {
			increment(result.skipped, "lock-owner-changed");
			return finish();
		}
		applyCursorOperations(cursor, discovery.cursorOps);
		writeAtomicJson(path.join(maintenanceRoot, CURSOR_NAME), cursor);
		return finish();
	} finally {
		try { releaseRetentionLock(lockDir, lockToken); } catch { /* a stale lock blocks the next pass safely */ }
	}
}
