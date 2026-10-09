import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { withFileLease } from "../../shared/file-lease.ts";
import { MISSION_BINDING_FILE } from "../../missions/lifecycle.ts";
import { encodeIndexSegment, indexSegmentAliases, MAX_INDEX_SEGMENT_BYTES } from "./index-segment.ts";

const RESULT_INDEX_VERSION = 1;
const RESULT_INDEX_DIR = "result-index";
const SESSION_INDEX_DIR = "sessions";
const RUN_INDEX_DIR = "runs";
const OBSERVER_INDEX_DIR = "observers";
const TOOL_CALL_INDEX_DIR = "tool-calls";
const RESULT_PENDING_DIR = "result-pending";
const RESULT_LEASE_DIR = "result-leases";
const MISSION_OBSERVER = "mission";
const JSON_EXTENSION = ".json";
const MAX_JSON_FILE_STEM_BYTES = MAX_INDEX_SEGMENT_BYTES - Buffer.byteLength(JSON_EXTENSION, "utf-8");

export interface ResultIndexEntry {
	version: 1;
	runId: string;
	sessionId: string;
	file: string;
	writtenAt: number;
	asyncDir?: string;
}

function encodeSegment(value: string): string {
	return encodeIndexSegment(value);
}

function encodedJsonFileName(value: string): string {
	return `${encodeIndexSegment(value, MAX_JSON_FILE_STEM_BYTES)}${JSON_EXTENSION}`;
}

function encodedJsonFileNames(value: string): string[] {
	return indexSegmentAliases(value, MAX_JSON_FILE_STEM_BYTES).map((segment) => `${segment}${JSON_EXTENSION}`);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A legacy alias can be valid metadata while still being unaddressable on the current filesystem. */
function isUnaddressableResultCandidate(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENAMETOOLONG";
}

export function resultFileName(runId: string): string {
	return `${runId}${JSON_EXTENSION}`;
}

export function resultFilePath(resultsDir: string, runId: string): string {
	return path.join(resultsDir, resultFileName(runId));
}

function sessionIndexDir(resultsDir: string, sessionId: string): string {
	return path.join(resultsDir, RESULT_INDEX_DIR, SESSION_INDEX_DIR, encodeSegment(sessionId));
}

function sessionIndexDirs(resultsDir: string, sessionId: string): string[] {
	return indexSegmentAliases(sessionId).map((segment) => path.join(resultsDir, RESULT_INDEX_DIR, SESSION_INDEX_DIR, segment));
}

function resultIndexPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(sessionIndexDir(resultsDir, sessionId), encodedJsonFileName(runId));
}

function resultIndexPaths(resultsDir: string, sessionId: string, runId: string): string[] {
	return sessionIndexDirs(resultsDir, sessionId).flatMap((dir) => encodedJsonFileNames(runId).map((fileName) => path.join(dir, fileName)));
}

function runIndexPath(resultsDir: string, runId: string): string {
	return path.join(resultsDir, RESULT_INDEX_DIR, RUN_INDEX_DIR, encodedJsonFileName(runId));
}

function resultPendingPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(resultsDir, RESULT_PENDING_DIR, encodeSegment(sessionId), encodedJsonFileName(runId));
}

function resultPendingPaths(resultsDir: string, sessionId: string, runId: string): string[] {
	return indexSegmentAliases(sessionId).flatMap((segment) => encodedJsonFileNames(runId).map((fileName) => path.join(resultsDir, RESULT_PENDING_DIR, segment, fileName)));
}

function pendingSessionDirs(resultsDir: string, sessionId: string): string[] {
	return indexSegmentAliases(sessionId).map((segment) => path.join(resultsDir, RESULT_PENDING_DIR, segment));
}

function firstExistingResultFile(paths: string[]): string | undefined {
	for (const filePath of paths) {
		if (existingResultFile(filePath)) return filePath;
	}
	return undefined;
}

function observerIndexDir(resultsDir: string, observer: string): string {
	return path.join(resultsDir, RESULT_INDEX_DIR, OBSERVER_INDEX_DIR, observer);
}

function observerIndexPath(resultsDir: string, observer: string, runId: string): string {
	return path.join(observerIndexDir(resultsDir, observer), encodedJsonFileName(runId));
}

function toolCallIndexDir(resultsDir: string, toolCallId: string): string {
	return path.join(resultsDir, RESULT_INDEX_DIR, TOOL_CALL_INDEX_DIR, encodeIndexSegment(toolCallId));
}

function toolCallIndexPath(resultsDir: string, toolCallId: string, runId: string): string {
	return path.join(toolCallIndexDir(resultsDir, toolCallId), encodedJsonFileName(runId));
}

function parseResultIndexEntry(value: unknown): ResultIndexEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<ResultIndexEntry>;
	if (record.version !== RESULT_INDEX_VERSION
		|| typeof record.runId !== "string"
		|| typeof record.sessionId !== "string"
		|| typeof record.file !== "string"
		|| typeof record.writtenAt !== "number") return undefined;
	return {
		version: RESULT_INDEX_VERSION,
		runId: record.runId,
		sessionId: record.sessionId,
		file: record.file,
		writtenAt: record.writtenAt,
		...(typeof record.asyncDir === "string" ? { asyncDir: record.asyncDir } : {}),
	};
}

export function writeResultIndexForData(resultPath: string, data: Record<string, unknown>): void {
	const runId = nonEmptyString(data.runId) ?? nonEmptyString(data.id) ?? path.basename(resultPath, ".json");
	const sessionId = nonEmptyString(data.sessionId);
	if (!runId || !sessionId) return;
	const file = path.basename(resultPath);
	const entry: ResultIndexEntry = {
		version: RESULT_INDEX_VERSION,
		runId,
		sessionId,
		file,
		writtenAt: Date.now(),
		...(nonEmptyString(data.asyncDir) ? { asyncDir: nonEmptyString(data.asyncDir)! } : {}),
	};
	const resultsDir = path.dirname(resultPath);
	writeAtomicJson(resultIndexPath(resultsDir, sessionId, runId), entry);
	try {
		writeAtomicJson(runIndexPath(resultsDir, runId), entry);
	} catch (error) {
		console.error(`Failed to write async result run index for '${resultPath}':`, error);
	}
	const toolCallId = nonEmptyString(data.toolCallId);
	try {
		if (toolCallId) writeAtomicJson(toolCallIndexPath(resultsDir, toolCallId, runId), entry);
	} catch (error) {
		console.error(`Failed to write async result tool-call index for '${resultPath}':`, error);
	}
	try {
		if (entry.asyncDir && fs.existsSync(path.join(entry.asyncDir, MISSION_BINDING_FILE))) {
			writeAtomicJson(observerIndexPath(resultsDir, MISSION_OBSERVER, runId), entry);
		}
	} catch (error) {
		console.error(`Failed to write async result observer index for '${resultPath}':`, error);
	}
}

function writeIndexedPendingResultFile(resultPath: string, data: Record<string, unknown>): { runId: string; sessionId: string; resultsDir: string } {
	const runId = nonEmptyString(data.runId) ?? nonEmptyString(data.id) ?? path.basename(resultPath, ".json");
	const sessionId = nonEmptyString(data.sessionId);
	if (!sessionId) throw new Error(`Cannot write async result '${resultPath}' without a sessionId.`);
	const resultsDir = path.dirname(resultPath);
	// A consumer can take the payload and remove its indexes as soon as the payload appears,
	// so every index must exist before then. A failed index write still publishes the
	// payload, unindexed but recoverable, before the error is rethrown.
	let indexFailure: { error: unknown } | undefined;
	writeAtomicJson(resultPendingPath(resultsDir, sessionId, runId), data, () => {
		try {
			writeResultIndexForData(resultPath, data);
		} catch (error) {
			indexFailure = { error };
		}
	});
	if (indexFailure) throw indexFailure.error;
	return { runId, sessionId, resultsDir };
}

export function writePendingAsyncResultFile(resultPath: string, data: Record<string, unknown>): void {
	writeIndexedPendingResultFile(resultPath, data);
}

export function writeAsyncResultFile(resultPath: string, data: Record<string, unknown>): { state: "public" | "pending" } {
	const { runId, sessionId, resultsDir } = writeIndexedPendingResultFile(resultPath, data);
	return promotePendingResultFile(resultsDir, sessionId, runId, path.basename(resultPath), { logFailure: false }) === "promoted"
		? { state: "public" }
		: { state: "pending" };
}

export function removeResultIndex(resultsDir: string, sessionId: string | undefined, runId: string | undefined, toolCallId?: string): void {
	if (!runId) return;
	if (sessionId) {
		for (const indexPath of resultIndexPaths(resultsDir, sessionId, runId)) {
			try {
				fs.rmSync(indexPath, { force: true });
			} catch {
				// Index cleanup must not affect result delivery.
			}
		}
		for (const pendingPath of resultPendingPaths(resultsDir, sessionId, runId)) {
			try {
				fs.rmSync(pendingPath, { force: true });
			} catch {
				// Pending cleanup must not affect result delivery.
			}
		}
	}
	try {
		fs.rmSync(runIndexPath(resultsDir, runId), { force: true });
	} catch {
		// Index cleanup must not affect result delivery.
	}
	if (toolCallId) {
		try {
			fs.rmSync(toolCallIndexPath(resultsDir, toolCallId, runId), { force: true });
		} catch {
			// Index cleanup must not affect result delivery.
		}
	}
	try {
		fs.rmSync(observerIndexPath(resultsDir, MISSION_OBSERVER, runId), { force: true });
	} catch {
		// Index cleanup must not affect result delivery.
	}
}

export function removeMissionObserverIndex(resultsDir: string, runId: string | undefined): void {
	if (!runId) return;
	try {
		fs.rmSync(observerIndexPath(resultsDir, MISSION_OBSERVER, runId), { force: true });
	} catch {
		// Observer index cleanup must not affect result delivery.
	}
}

/** Serializes one run's result publication and retirement across processes. Lookups never take it. */
export function withResultRunLease<T>(resultsDir: string, runId: string, action: () => T): T {
	const leaseDir = path.join(resultsDir, RESULT_LEASE_DIR);
	fs.mkdirSync(leaseDir, { recursive: true });
	return withFileLease(path.join(leaseDir, createHash("sha256").update(runId).digest("hex")), action);
}

/**
 * The exact payload text a consumer read, with the identity its indexes are keyed by.
 * `stalePublic` is what the public path held, read just before `snapshot`, when it differed:
 * every writer goes through the pending path and promotion empties it, so a pending payload is
 * always newer than the public one beside it, and `stalePublic` is older than `snapshot`.
 */
export interface ResultSnapshot {
	runId: string;
	sessionId?: string;
	toolCallId?: string;
	snapshot: string;
	stalePublic?: string;
}

export function readResultPayload(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A directory at the public path blocks promotion; it holds no payload.
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" || isUnaddressableResultCandidate(error)) return undefined;
		throw error;
	}
}

// Pending paths come first so a reader promoting pending to public between two reads is still seen.
function resultPayloadCandidates(publicPath: string, read: ResultSnapshot): string[] {
	return [...(read.sessionId ? resultPendingPaths(path.dirname(publicPath), read.sessionId, read.runId) : []), publicPath];
}

/** A payload is one the consumer already read (or an older one it saw beside it), so not newer. */
function readByConsumer(publicPath: string, read: ResultSnapshot, candidate: string, current: string): boolean {
	return current === read.snapshot || (candidate === publicPath && current === read.stalePublic);
}

/** Call under the run's lease: whether a payload written after the consumer read now exists for the run. */
export function resultSnapshotReplaced(publicPath: string, read: ResultSnapshot): boolean {
	return resultPayloadCandidates(publicPath, read).some((candidate) => {
		const current = readResultPayload(candidate);
		return current !== undefined && !readByConsumer(publicPath, read, candidate, current);
	});
}

/**
 * Removes the payload a consumer read, the older public payload it saw beside it, and the run's
 * indexes. When a newer payload replaced it, the shared payload paths and indexes stay and only
 * the consumer's own claimed copy goes. A payload that cannot be removed is reported after the
 * indexes are gone.
 */
export function retireResultSnapshot(publicPath: string, read: ResultSnapshot, payloadPath = publicPath): "retired" | "replaced" {
	const resultsDir = path.dirname(publicPath);
	return withResultRunLease(resultsDir, read.runId, () => {
		// Check every shared path before deleting any: unleased reader promotion can move a newer
		// pending payload onto the public path between two deletions.
		if (resultSnapshotReplaced(publicPath, read)) {
			if (payloadPath !== publicPath && readResultPayload(payloadPath) === read.snapshot) fs.rmSync(payloadPath, { force: true });
			return "replaced";
		}
		let removalFailure: { error: unknown } | undefined;
		for (const candidate of new Set([...resultPayloadCandidates(publicPath, read), payloadPath])) {
			const current = readResultPayload(candidate);
			if (current === undefined || !readByConsumer(publicPath, read, candidate, current)) continue;
			try {
				fs.rmSync(candidate, { force: true });
			} catch (error) {
				removalFailure ??= { error };
			}
		}
		removeResultIndex(resultsDir, read.sessionId, read.runId, read.toolCallId);
		if (removalFailure) throw removalFailure.error;
		return "retired";
	});
}

/** Removes the mission observer index for the payload an observer handled, unless a newer payload replaced it. */
export function acknowledgeMissionObserverSnapshot(publicPath: string, read: ResultSnapshot): "acknowledged" | "replaced" {
	const resultsDir = path.dirname(publicPath);
	// With no index there is nothing to remove; skipping keeps the lease off runs without a mission.
	if (!fs.existsSync(observerIndexPath(resultsDir, MISSION_OBSERVER, read.runId))) return "acknowledged";
	return withResultRunLease(resultsDir, read.runId, () => {
		if (resultSnapshotReplaced(publicPath, read)) return "replaced";
		removeMissionObserverIndex(resultsDir, read.runId);
		return "acknowledged";
	});
}

function existingResultFile(resultPath: string): boolean {
	try {
		return fs.statSync(resultPath).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !isUnaddressableResultCandidate(error)) console.error(`Failed to inspect async result payload '${resultPath}':`, error);
		return false;
	}
}

function pendingResultExists(resultsDir: string, sessionId: string, runId: string): boolean {
	return firstExistingResultFile(resultPendingPaths(resultsDir, sessionId, runId)) !== undefined;
}

export function resultPayloadMatchesSessionRun(data: unknown, sessionId: string, runId: string): boolean {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	const record = data as Record<string, unknown>;
	return (nonEmptyString(record.runId) ?? nonEmptyString(record.id)) === runId && nonEmptyString(record.sessionId) === sessionId;
}

function pendingResultPayloadMatches(filePath: string, sessionId: string, runId: string): boolean {
	try {
		return resultPayloadMatchesSessionRun(JSON.parse(fs.readFileSync(filePath, "utf-8")), sessionId, runId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !isUnaddressableResultCandidate(error)) console.error(`Ignoring invalid pending async result '${filePath}':`, error);
		return false;
	}
}

function assertPendingResultPayloadMatches(filePath: string, sessionId: string, runId: string): boolean {
	return resultPayloadMatchesSessionRun(JSON.parse(fs.readFileSync(filePath, "utf-8")), sessionId, runId);
}

export function promotePendingResultFile(resultsDir: string, sessionId: string, runId: string, file = resultFileName(runId), options: { logFailure?: boolean } = {}): "none" | "promoted" | "pending" {
	if (file !== path.basename(file) || !file.endsWith(".json")) return "none";
	const pendingPath = firstExistingResultFile(resultPendingPaths(resultsDir, sessionId, runId));
	if (!pendingPath) return "none";
	const resultPath = path.join(resultsDir, file);
	try {
		// POSIX rename replaces the destination atomically. Deleting it first lets a
		// losing promoter unlink the result that another promoter just published.
		fs.renameSync(pendingPath, resultPath);
		return existingResultFile(resultPath) ? "promoted" : "pending";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EEXIST" || code === "EPERM" || code === "EACCES" || isUnaddressableResultCandidate(error)) {
			const pendingExists = existingResultFile(pendingPath);
			const resultExists = existingResultFile(resultPath);
			if (pendingExists) {
				if (!resultExists && options.logFailure !== false && !isUnaddressableResultCandidate(error)) console.error(`Failed to promote pending async result '${pendingPath}' to '${resultPath}':`, error);
				return "pending";
			}
			if (resultExists) return "promoted";
			if (options.logFailure !== false) console.error(`Pending async result '${pendingPath}' disappeared without a promoted result at '${resultPath}'.`);
			return "none";
		}
		if (options.logFailure !== false) console.error(`Failed to promote pending async result '${pendingPath}' to '${resultPath}':`, error);
		return "pending";
	}
}

interface ResultPayloadLocation {
	file: string;
	path: string;
	state: "public" | "pending";
}

function pendingResultLocationForSessionRun(resultsDir: string, sessionId: string, runId: string, file = resultFileName(runId)): ResultPayloadLocation | undefined {
	if (file !== path.basename(file) || !file.endsWith(".json")) return undefined;
	const pendingPath = firstExistingResultFile(resultPendingPaths(resultsDir, sessionId, runId));
	if (!pendingPath || !pendingResultPayloadMatches(pendingPath, sessionId, runId)) return undefined;
	return { file, path: pendingPath, state: "pending" };
}

export function fallbackResultPayloadPathForSessionRun(resultsDir: string, sessionId: string, runId: string): string | undefined {
	const pendingPath = firstExistingResultFile(resultPendingPaths(resultsDir, sessionId, runId));
	if (!pendingPath || !assertPendingResultPayloadMatches(pendingPath, sessionId, runId)) return undefined;
	return pendingPath;
}

/** Any pending or public result file for the run, without validating its contents. */
export function resultPayloadFileForSessionRun(resultsDir: string, sessionId: string, runId: string): string | undefined {
	return firstExistingResultFile([...resultPendingPaths(resultsDir, sessionId, runId), resultFilePath(resultsDir, runId)]);
}

function resultPayloadLocationFromIndex(resultsDir: string, entry: ResultIndexEntry): ResultPayloadLocation | undefined {
	if (entry.file !== path.basename(entry.file) || !entry.file.endsWith(".json")) return undefined;
	const pendingState = promotePendingResultFile(resultsDir, entry.sessionId, entry.runId, entry.file);
	if (pendingState === "pending") {
		return pendingResultLocationForSessionRun(resultsDir, entry.sessionId, entry.runId, entry.file);
	}
	const resultPath = path.join(resultsDir, entry.file);
	if (pendingState === "promoted" || existingResultFile(resultPath)) return { file: entry.file, path: resultPath, state: "public" };
	return undefined;
}

function readResultIndexForSessionRun(resultsDir: string, sessionId: string, runId: string): ResultIndexEntry | undefined {
	for (const indexPath of resultIndexPaths(resultsDir, sessionId, runId)) {
		try {
			const entry = parseResultIndexEntry(JSON.parse(fs.readFileSync(indexPath, "utf-8")));
			if (!entry || entry.sessionId !== sessionId || entry.runId !== runId) continue;
			return entry;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") throw error;
			if (code !== "ENOENT" && code !== "ENOTDIR" && !isUnaddressableResultCandidate(error)) {
				console.error(`Ignoring invalid async result index for '${runId}':`, error);
			}
		}
	}
	return undefined;
}

export function resultPayloadPathForSessionRun(resultsDir: string, sessionId: string, runId: string): string | undefined {
	const entry = readResultIndexForSessionRun(resultsDir, sessionId, runId);
	return (entry ? resultPayloadLocationFromIndex(resultsDir, entry) : undefined)?.path
		?? pendingResultLocationForSessionRun(resultsDir, sessionId, runId)?.path;
}

export function resultPayloadPathForMissionObserverRun(resultsDir: string, runId: string): string | undefined {
	try {
		const entry = parseResultIndexEntry(JSON.parse(fs.readFileSync(observerIndexPath(resultsDir, MISSION_OBSERVER, runId), "utf-8")));
		if (!entry || entry.runId !== runId) return undefined;
		return resultPayloadLocationFromIndex(resultsDir, entry)?.path;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR" && !isUnaddressableResultCandidate(error)) console.error(`Ignoring invalid async result observer index for '${runId}':`, error);
		return undefined;
	}
}

export function resultPayloadPathForIndexedRun(resultsDir: string, runId: string): string | undefined {
	const entryPath = runIndexPath(resultsDir, runId);
	try {
		const entry = parseResultIndexEntry(JSON.parse(fs.readFileSync(entryPath, "utf-8")));
		if (!entry || entry.runId !== runId) {
			fs.rmSync(entryPath, { force: true });
			return undefined;
		}
		// A valid index can precede its payload while the writer is publishing it, so a lookup
		// must not delete it. Payload-less indexes are swept by age in cleanupResultIndexes.
		return resultPayloadLocationFromIndex(resultsDir, entry)?.path;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (isUnaddressableResultCandidate(error)) return undefined;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			console.error(`Ignoring invalid async result run index '${entryPath}':`, error);
			try { fs.rmSync(entryPath, { force: true }); } catch {
				// Invalid optional run-index cleanup is best-effort.
			}
		}
	}
	return undefined;
}

function indexedResultFile(resultsDir: string, entry: ResultIndexEntry, includePending = false): string | undefined {
	const location = resultPayloadLocationFromIndex(resultsDir, entry);
	if (!location) return undefined;
	return includePending || location.state === "public" ? location.file : undefined;
}

function listIndexFiles(dir: string): string[] {
	let files: string[];
	try {
		files = fs.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => path.join(dir, entry.name));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EPERM" || code === "EACCES" || isUnaddressableResultCandidate(error)) return [];
		throw error;
	}
	return files;
}

function resultFilesFromIndexDir(resultsDir: string, dir: string, includePending = false): string[] {
	const candidates = new Set<string>();
	for (const entryPath of listIndexFiles(dir)) {
		try {
			const entry = parseResultIndexEntry(JSON.parse(fs.readFileSync(entryPath, "utf-8")));
			if (!entry) {
				fs.rmSync(entryPath, { force: true });
				continue;
			}
			const resultFile = indexedResultFile(resultsDir, entry, includePending);
			if (resultFile) candidates.add(resultFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !isUnaddressableResultCandidate(error)) console.error(`Ignoring invalid async result index '${entryPath}':`, error);
		}
	}
	return [...candidates];
}

export function resultFilesForSession(resultsDir: string, sessionId: string): string[] {
	const files = new Set<string>();
	for (const dir of sessionIndexDirs(resultsDir, sessionId)) {
		for (const file of resultFilesFromIndexDir(resultsDir, dir)) files.add(file);
	}
	return [...files];
}

function pendingResultFilesForSession(resultsDir: string, sessionId: string): string[] {
	const files = new Set<string>();
	for (const dir of pendingSessionDirs(resultsDir, sessionId)) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EPERM" || code === "EACCES" || isUnaddressableResultCandidate(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const pendingPath = path.join(dir, entry.name);
			try {
				const data = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as Record<string, unknown>;
				const runId = nonEmptyString(data.runId) ?? nonEmptyString(data.id);
				if (runId && nonEmptyString(data.sessionId) === sessionId) files.add(resultFileName(runId));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !isUnaddressableResultCandidate(error)) console.error(`Ignoring invalid pending async result '${pendingPath}':`, error);
			}
		}
	}
	return [...files];
}

export function resultCandidateFilesForSession(resultsDir: string, sessionId: string): string[] {
	const files = new Set<string>();
	for (const dir of sessionIndexDirs(resultsDir, sessionId)) {
		for (const file of resultFilesFromIndexDir(resultsDir, dir, true)) files.add(file);
	}
	for (const file of pendingResultFilesForSession(resultsDir, sessionId)) files.add(file);
	return [...files];
}

export function resultFilesForToolCall(resultsDir: string, toolCallId: string): string[] {
	return resultFilesFromIndexDir(resultsDir, toolCallIndexDir(resultsDir, toolCallId));
}

export function resultCandidateFilesForToolCall(resultsDir: string, toolCallId: string): string[] {
	return resultFilesFromIndexDir(resultsDir, toolCallIndexDir(resultsDir, toolCallId), true);
}

export function missionObserverResultFiles(resultsDir: string): string[] {
	return resultFilesFromIndexDir(resultsDir, observerIndexDir(resultsDir, MISSION_OBSERVER));
}

export function missionObserverResultCandidateFiles(resultsDir: string): string[] {
	return resultFilesFromIndexDir(resultsDir, observerIndexDir(resultsDir, MISSION_OBSERVER), true);
}

export function cleanupResultIndexes(resultsDir: string, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): number {
	const root = path.join(resultsDir, RESULT_INDEX_DIR);
	const cutoff = now - maxAgeMs;
	let removed = 0;
	const visit = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EPERM" || code === "EACCES" || isUnaddressableResultCandidate(error)) return;
			throw error;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
				try { fs.rmdirSync(fullPath); } catch {
					// Non-empty or concurrently removed index directories are left in place.
				}
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const stat = fs.statSync(fullPath);
				const index = parseResultIndexEntry(JSON.parse(fs.readFileSync(fullPath, "utf-8")));
				const resultFile = index ? indexedResultFile(resultsDir, index) : undefined;
				const pendingFile = index ? pendingResultExists(resultsDir, index.sessionId, index.runId) : false;
				if (!index || (!resultFile && !pendingFile && stat.mtimeMs <= cutoff)) {
					fs.rmSync(fullPath, { force: true });
					removed += 1;
				}
			} catch (error) {
				if (isUnaddressableResultCandidate(error)) continue;
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid async result index '${fullPath}':`, error);
				try {
					fs.rmSync(fullPath, { force: true });
					removed += 1;
				} catch {
					// Invalid optional index cleanup is best-effort.
				}
			}
		}
	};
	visit(root);
	return removed;
}
