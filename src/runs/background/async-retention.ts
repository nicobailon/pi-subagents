import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { AsyncStatus } from "../../shared/types.ts";
import { MISSION_BINDING_FILE } from "../../missions/lifecycle.ts";
import { ACTIVE_RUN_INDEX_DIR } from "./active-run-index.ts";
import { encodeIndexSegment } from "./index-segment.ts";

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

interface StreamedDirEntry {
	relative: string;
	entry: fs.Dirent;
}

interface StreamedDirWindow {
	entries: StreamedDirEntry[];
	rawReads: number;
	exhausted: boolean;
	cursorCleared: boolean;
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
	opendirSync?: typeof fs.opendirSync;
}

export interface AsyncRetentionResult {
	acquired: boolean;
	scanned: number;
	deletedRuns: number;
	deletedResults: number;
	reapedTombstones: number;
	skipped: Record<string, number>;
	errors: string[];
	rawReads: number;
	sourceExhausted: Record<string, boolean>;
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

function compareRelative(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function insertSmallest(entries: StreamedDirEntry[], candidate: StreamedDirEntry, limit: number): void {
	if (limit <= 0) return;
	const index = entries.findIndex((entry) => compareRelative(candidate.relative, entry.relative) < 0);
	if (index === -1) entries.push(candidate);
	else entries.splice(index, 0, candidate);
	if (entries.length > limit) entries.pop();
}

function streamDirWindow(dir: string, limit: number, after: string | undefined, relativePath: (entry: fs.Dirent) => string, usable: (entry: fs.Dirent, relative: string) => boolean, opendirSync = fs.opendirSync): StreamedDirWindow {
	if (limit <= 0) return { entries: [], rawReads: 0, exhausted: true, cursorCleared: false };
	let handle: fs.Dir | undefined;
	try {
		handle = opendirSync(dir);
		const next: StreamedDirEntry[] = [];
		const wrapped: StreamedDirEntry[] = [];
		let rawReads = 0;
		// Directories cannot be resumed by raw position through Node. The delayed
		// cleanup pass enumerates to EOF, while this helper keeps only a bounded
		// top-k selection so memory and mutations stay bounded by the batch.
		while (true) {
			const entry = handle.readSync();
			if (!entry) break;
			rawReads += 1;
			const relative = relativePath(entry);
			if (!usable(entry, relative)) continue;
			const candidate = { relative, entry };
			insertSmallest(wrapped, candidate, limit);
			if (after === undefined || compareRelative(relative, after) > 0) insertSmallest(next, candidate, limit);
		}
		const cursorCleared = after !== undefined && next.length === 0;
		return { entries: cursorCleared ? wrapped : next, rawReads, exhausted: true, cursorCleared };
	} catch (error) {
		if (isNotFound(error)) return { entries: [], rawReads: 0, exhausted: true, cursorCleared: false };
		throw error;
	} finally {
		handle?.closeSync();
	}
}

function recordSourceScan(result: AsyncRetentionResult, source: string, scan: Pick<StreamedDirWindow, "rawReads" | "exhausted">): void {
	result.rawReads += scan.rawReads;
	result.sourceExhausted[source] = scan.exhausted;
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
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

function prunePendingSessionCursors(cursor: RetentionCursor, pendingRoot: string): void {
	const cursors = cursor.resultPendingAfterBySession;
	if (cursors === undefined) return;
	for (const session of Object.keys(cursors)) {
		if (!fs.existsSync(path.join(pendingRoot, session))) delete cursors[session];
	}
	if (Object.keys(cursors).length === 0) delete cursor.resultPendingAfterBySession;
}

function resultCandidates(resultsDir: string, cursor: RetentionCursor, pendingDirLimit: number, limit: number, result: AsyncRetentionResult, opendirSync: typeof fs.opendirSync): ResultCandidate[] {
	const candidates: ResultCandidate[] = [];
	const sourceLimit = Math.max(1, Math.ceil(limit / 4));
	const addFiles = (dir: string, kind: ResultCandidate["kind"], cursorTarget: ResultCursorTarget, source: string, budget = sourceLimit): number => {
		const remaining = Math.min(budget, limit - candidates.length);
		if (remaining <= 0) return 0;
		const before = candidates.length;
		const after = cursorTarget.type === "pending" ? cursor.resultPendingAfterBySession?.[cursorTarget.session] : cursor[cursorTarget.key];
		const scan = streamDirWindow(
			dir,
			remaining,
			after,
			(value) => path.relative(resultsDir, path.join(dir, value.name)),
			(entry) => entry.isFile() && (entry.name.startsWith(RESULT_TOMBSTONE_PREFIX) || entry.name.endsWith(".json")),
			opendirSync,
		);
		recordSourceScan(result, source, scan);
		if (scan.cursorCleared) {
			if (cursorTarget.type === "pending") delete cursor.resultPendingAfterBySession?.[cursorTarget.session];
			else delete cursor[cursorTarget.key];
		}
		for (const { entry } of scan.entries.slice(0, remaining)) {
			const fullPath = path.join(dir, entry.name);
			const tombstone = entry.name.startsWith(RESULT_TOMBSTONE_PREFIX);
			candidates.push({ path: fullPath, relative: path.relative(resultsDir, fullPath), kind: tombstone ? "tombstone" : kind, cursor: cursorTarget });
		}
		return candidates.length - before;
	};
	addFiles(resultsDir, "public", { type: "result", key: "resultPublicAfter" }, "results.public");
	const pendingRoot = path.join(resultsDir, "result-pending");
	prunePendingSessionCursors(cursor, pendingRoot);
	const pendingRemaining = Math.min(pendingDirLimit, sourceLimit, limit - candidates.length);
	const pendingScan = streamDirWindow(
		pendingRoot,
		pendingRemaining,
		cursor.pendingSessionAfter,
		(entry) => entry.name,
		(entry) => entry.isDirectory(),
		opendirSync,
	);
	recordSourceScan(result, "results.pendingSessions", pendingScan);
	if (pendingScan.cursorCleared) delete cursor.pendingSessionAfter;
	const pendingSessions = pendingScan.entries.slice(0, Math.min(pendingDirLimit, sourceLimit, limit - candidates.length));
	let pendingFileBudget = Math.min(sourceLimit, limit - candidates.length);
	for (const session of pendingSessions) {
		if (pendingFileBudget <= 0) break;
		cursor.pendingSessionAfter = session.relative;
		pendingFileBudget -= addFiles(path.join(pendingRoot, session.entry.name), "pending", { type: "pending", session: session.relative }, `results.pending.${session.entry.name}`, pendingFileBudget);
	}
	addFiles(path.join(resultsDir, "completion-replay"), "replay", { type: "result", key: "resultReplayAfter" }, "results.replay");
	addFiles(path.join(resultsDir, "output-archives"), "archive", { type: "result", key: "resultArchiveAfter" }, "results.archive");
	return candidates;
}

function processStartIdentity(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
			return fields[19] ? `linux:${fields[19]}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`], { encoding: "utf-8" });
		const started = result.status === 0 ? result.stdout.trim() : "";
		return started ? `win:${started}` : undefined;
	}
	const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
	const started = result.status === 0 ? result.stdout.trim() : "";
	return started ? `${process.platform}:${started}` : undefined;
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
		deletedRuns: result.deletedRuns,
		deletedResults: result.deletedResults,
		reapedTombstones: result.reapedTombstones,
		skipped: result.skipped,
		deleted: deletedIds.slice(0, ASYNC_RETENTION_BATCH_SIZE),
		errors: result.errors.length,
		rawReads: result.rawReads,
		sourceExhausted: result.sourceExhausted,
		durationMs: result.durationMs,
	})}\n`, "utf-8");
}

function increment(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

export function cleanupAsyncRetention(options: AsyncRetentionOptions): AsyncRetentionResult {
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
	const lockOwner: RetentionLockOwner = {
		version: 1,
		token: lockToken,
		pid,
		hostname,
		startedAt: currentTime,
		...(currentProcessStartIdentity ? { processStartIdentity: currentProcessStartIdentity } : {}),
	};
	const lockOptions = { hostname, isProcessAlive: options.isProcessAlive ?? processIsAlive, getProcessStartIdentity };
	const result: AsyncRetentionResult = { acquired: false, scanned: 0, deletedRuns: 0, deletedResults: 0, reapedTombstones: 0, skipped: {}, errors: [], rawReads: 0, sourceExhausted: {}, durationMs: 0 };
	const opendirSync = options.opendirSync ?? fs.opendirSync;
	const deletedIds: string[] = [];
	const finish = (): AsyncRetentionResult => {
		result.durationMs = Math.max(0, Date.now() - startedWall);
		appendMaintenanceLog(maintenanceRoot, result, currentTime, deletedIds);
		return result;
	};
	fs.mkdirSync(maintenanceRoot, { recursive: true });
	if (!acquireRetentionLock(lockDir, lockOwner, lockOptions)) {
		increment(result.skipped, "lock-busy");
		return finish();
	}
	result.acquired = true;
	try {
		const waitReferences = parseWaitRunIds(options.waitSubscriptionsDir ?? path.join(maintenanceRoot, "wait-subscriptions"));
		if (!waitReferences.safe) {
			increment(result.skipped, "wait-references-unknown");
			return finish();
		}
		const protectedRunIds = new Set(options.protectedRunIds ?? []);
		const cutoff = currentTime - retentionMs;
		const cursor = readCursor(maintenanceRoot);
		const runBudget = Math.ceil(batchSize / 2);
		const resultBudget = batchSize - runBudget;
		const runScan = streamDirWindow(options.asyncDirRoot, runBudget, cursor.runAfter, (entry) => entry.name, (entry) => entry.isDirectory() && entry.name !== ACTIVE_RUN_INDEX_DIR, opendirSync);
		recordSourceScan(result, "runs", runScan);
		if (runScan.cursorCleared) delete cursor.runAfter;
		const selectedRuns = runScan.entries.slice(0, runBudget);
		for (const { entry, relative } of selectedRuns) {
			result.scanned += 1;
			cursor.runAfter = relative;
			const runDir = path.join(options.asyncDirRoot, entry.name);
			try {
				const stat = fs.lstatSync(runDir);
				if (!stat.isDirectory() || stat.isSymbolicLink()) {
					increment(result.skipped, "unsafe-run-path");
					continue;
				}
				const status = readStatus(runDir);
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
					const freshWaitReferences = parseWaitRunIds(options.waitSubscriptionsDir ?? path.join(maintenanceRoot, "wait-subscriptions"));
					const finalReason = freshWaitReferences.safe
						? runSkipReason({ runDir, status, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds })
						: "wait-references-unknown";
					if (finalReason) {
						increment(result.skipped, `recheck-${finalReason}`);
						continue;
					}
					fs.rmSync(runDir, { recursive: true });
					removeRunTombstoneMarker(maintenanceRoot, status!.runId);
					result.reapedTombstones += 1;
					deletedIds.push(`run-tombstone:${status!.runId}`);
					continue;
				}
				const tombstone = path.join(options.asyncDirRoot, `${RUN_TOMBSTONE_PREFIX}${randomId()}`);
				writeRunTombstoneMarker(maintenanceRoot, status!.runId, tombstone, currentTime);
				try {
					fs.renameSync(runDir, tombstone);
				} catch (error) {
					removeRunTombstoneMarker(maintenanceRoot, status!.runId);
					throw error;
				}
				const recheckStatus = readStatus(tombstone);
				const freshWaitReferences = parseWaitRunIds(options.waitSubscriptionsDir ?? path.join(maintenanceRoot, "wait-subscriptions"));
				const recheckReason = freshWaitReferences.safe
					? runSkipReason({ runDir: tombstone, status: recheckStatus, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds })
					: "wait-references-unknown";
				if (recheckReason) {
					if (!fs.existsSync(runDir)) fs.renameSync(tombstone, runDir);
					removeRunTombstoneMarker(maintenanceRoot, status!.runId);
					increment(result.skipped, `recheck-${recheckReason}`);
					continue;
				}
				fs.rmSync(tombstone, { recursive: true });
				removeRunTombstoneMarker(maintenanceRoot, status!.runId);
				result.deletedRuns += 1;
				deletedIds.push(`run:${status!.runId}`);
			} catch (error) {
				if (!isNotFound(error)) result.errors.push(compactError(error));
			}
		}
		const selectedResults = resultCandidates(options.resultsDir, cursor, resultBudget, resultBudget, result, opendirSync);
		for (const candidate of selectedResults) {
			result.scanned += 1;
			if (candidate.cursor.type === "pending") {
				cursor.resultPendingAfterBySession ??= {};
				cursor.resultPendingAfterBySession[candidate.cursor.session] = candidate.relative;
			} else cursor[candidate.cursor.key] = candidate.relative;
			try {
				const stat = fs.lstatSync(candidate.path);
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
					const freshWaitReferences = parseWaitRunIds(options.waitSubscriptionsDir ?? path.join(maintenanceRoot, "wait-subscriptions"));
					const finalReason = freshWaitReferences.safe
						? resultSkipReason({ candidate, data, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, maintenanceRoot, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds })
						: "wait-references-unknown";
					if (finalReason) {
						increment(result.skipped, `recheck-${finalReason}`);
						continue;
					}
					fs.rmSync(candidate.path);
					result.reapedTombstones += 1;
					deletedIds.push(`result-tombstone:${resultRunId(candidate, data!)}`);
					continue;
				}
				const tombstone = path.join(path.dirname(candidate.path), `${RESULT_TOMBSTONE_PREFIX}${candidate.kind}-${randomId()}`);
				fs.renameSync(candidate.path, tombstone);
				const tombstoneCandidate = { ...candidate, path: tombstone, kind: "tombstone" as const };
				const recheckData = readJson(tombstone);
				const freshWaitReferences = parseWaitRunIds(options.waitSubscriptionsDir ?? path.join(maintenanceRoot, "wait-subscriptions"));
				const recheckReason = freshWaitReferences.safe
					? resultSkipReason({ candidate: tombstoneCandidate, data: recheckData, asyncDirRoot: options.asyncDirRoot, resultsDir: options.resultsDir, maintenanceRoot, cutoff, protectedRunIds, waitRunIds: freshWaitReferences.runIds })
					: "wait-references-unknown";
				if (recheckReason) {
					if (!fs.existsSync(candidate.path)) fs.renameSync(tombstone, candidate.path);
					increment(result.skipped, `recheck-${recheckReason}`);
					continue;
				}
				fs.rmSync(tombstone);
				result.deletedResults += 1;
				deletedIds.push(`result:${resultRunId(candidate, data!)}`);
			} catch (error) {
				if (!isNotFound(error)) result.errors.push(compactError(error));
			}
		}
		writeAtomicJson(path.join(maintenanceRoot, CURSOR_NAME), cursor);
		return finish();
	} finally {
		try { releaseRetentionLock(lockDir, lockToken); } catch { /* a stale lock blocks the next pass safely */ }
	}
}
