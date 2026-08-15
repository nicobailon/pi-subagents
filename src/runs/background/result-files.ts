import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { MISSION_BINDING_FILE } from "../../missions/lifecycle.ts";
import { encodeIndexSegment, MAX_INDEX_SEGMENT_BYTES } from "./index-segment.ts";

const RESULT_INDEX_VERSION = 1;
const RESULT_INDEX_DIR = "result-index";
const SESSION_INDEX_DIR = "sessions";
const OBSERVER_INDEX_DIR = "observers";
const TOOL_CALL_INDEX_DIR = "tool-calls";
const RESULT_PENDING_DIR = "result-pending";
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

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
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

function resultIndexPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(sessionIndexDir(resultsDir, sessionId), encodedJsonFileName(runId));
}

function resultPendingPath(resultsDir: string, sessionId: string, runId: string): string {
	return path.join(resultsDir, RESULT_PENDING_DIR, encodeSegment(sessionId), encodedJsonFileName(runId));
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
	writeAtomicJson(resultPendingPath(resultsDir, sessionId, runId), data);
	writeResultIndexForData(resultPath, data);
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
		try {
			fs.rmSync(resultIndexPath(resultsDir, sessionId, runId), { force: true });
		} catch {
			// Index cleanup must not affect result delivery.
		}
		try {
			fs.rmSync(resultPendingPath(resultsDir, sessionId, runId), { force: true });
		} catch {
			// Pending cleanup must not affect result delivery.
		}
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

function existingResultFile(resultPath: string): boolean {
	try {
		return fs.statSync(resultPath).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to inspect async result payload '${resultPath}':`, error);
		return false;
	}
}

function pendingResultExists(resultsDir: string, sessionId: string, runId: string): boolean {
	return existingResultFile(resultPendingPath(resultsDir, sessionId, runId));
}

function pendingResultPayloadMatches(filePath: string, sessionId: string, runId: string): boolean {
	try {
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
		return (nonEmptyString(data.runId) ?? nonEmptyString(data.id)) === runId && nonEmptyString(data.sessionId) === sessionId;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid pending async result '${filePath}':`, error);
		return false;
	}
}

export function promotePendingResultFile(resultsDir: string, sessionId: string, runId: string, file = resultFileName(runId), options: { logFailure?: boolean } = {}): "none" | "promoted" | "pending" {
	if (file !== path.basename(file) || !file.endsWith(".json")) return "none";
	const pendingPath = resultPendingPath(resultsDir, sessionId, runId);
	if (!existingResultFile(pendingPath)) return "none";
	const resultPath = path.join(resultsDir, file);
	try {
		// POSIX rename replaces the destination atomically. Deleting it first lets a
		// losing promoter unlink the result that another promoter just published.
		fs.renameSync(pendingPath, resultPath);
		return existingResultFile(resultPath) ? "promoted" : "pending";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EEXIST" || code === "EPERM" || code === "EACCES") {
			const pendingExists = existingResultFile(pendingPath);
			const resultExists = existingResultFile(resultPath);
			if (pendingExists) {
				if (!resultExists && options.logFailure !== false) console.error(`Failed to promote pending async result '${pendingPath}' to '${resultPath}':`, error);
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
	const pendingPath = resultPendingPath(resultsDir, sessionId, runId);
	return existingResultFile(pendingPath) && pendingResultPayloadMatches(pendingPath, sessionId, runId)
		? { file, path: pendingPath, state: "pending" }
		: undefined;
}

function pendingResultLocationForIndexedRun(resultsDir: string, runId: string): ResultPayloadLocation | undefined {
	const root = path.join(resultsDir, RESULT_PENDING_DIR);
	let sessions: fs.Dirent[];
	try {
		sessions = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to inspect pending async result root '${root}':`, error);
		return undefined;
	}
	for (const session of sessions) {
		if (!session.isDirectory()) continue;
		const pendingPath = path.join(root, session.name, encodedJsonFileName(runId));
		try {
			const data = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as Record<string, unknown>;
			if ((nonEmptyString(data.runId) ?? nonEmptyString(data.id)) === runId) return { file: resultFileName(runId), path: pendingPath, state: "pending" };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid pending async result '${pendingPath}':`, error);
		}
	}
	return undefined;
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
	try {
		const entry = parseResultIndexEntry(JSON.parse(fs.readFileSync(resultIndexPath(resultsDir, sessionId, runId), "utf-8")));
		if (!entry || entry.sessionId !== sessionId || entry.runId !== runId) return undefined;
		return entry;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") console.error(`Ignoring invalid async result index for '${runId}':`, error);
		return undefined;
	}
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
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid async result observer index for '${runId}':`, error);
		return undefined;
	}
}

export function resultPayloadPathForIndexedRun(resultsDir: string, runId: string): string | undefined {
	const root = path.join(resultsDir, RESULT_INDEX_DIR, SESSION_INDEX_DIR);
	let sessions: fs.Dirent[] = [];
	try {
		sessions = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") console.error(`Failed to inspect async result session index root '${root}':`, error);
	}
	for (const session of sessions) {
		if (!session.isDirectory()) continue;
		const entryPath = path.join(root, session.name, encodedJsonFileName(runId));
		try {
			const entry = parseResultIndexEntry(JSON.parse(fs.readFileSync(entryPath, "utf-8")));
			if (!entry || entry.runId !== runId) continue;
			const location = resultPayloadLocationFromIndex(resultsDir, entry);
			if (location) return location.path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid async result index '${entryPath}':`, error);
		}
	}
	return pendingResultLocationForIndexedRun(resultsDir, runId)?.path;
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
		if (code === "ENOENT" || code === "ENOTDIR") return [];
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
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid async result index '${entryPath}':`, error);
		}
	}
	return [...candidates];
}

export function resultFilesForSession(resultsDir: string, sessionId: string): string[] {
	return resultFilesFromIndexDir(resultsDir, sessionIndexDir(resultsDir, sessionId));
}

function pendingResultFilesForSession(resultsDir: string, sessionId: string): string[] {
	const dir = path.join(resultsDir, RESULT_PENDING_DIR, encodeSegment(sessionId));
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files = new Set<string>();
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const pendingPath = path.join(dir, entry.name);
		try {
			const data = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as Record<string, unknown>;
			const runId = nonEmptyString(data.runId) ?? nonEmptyString(data.id);
			if (runId && nonEmptyString(data.sessionId) === sessionId) files.add(resultFileName(runId));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid pending async result '${pendingPath}':`, error);
		}
	}
	return [...files];
}

export function resultCandidateFilesForSession(resultsDir: string, sessionId: string): string[] {
	return [...new Set([
		...resultFilesFromIndexDir(resultsDir, sessionIndexDir(resultsDir, sessionId), true),
		...pendingResultFilesForSession(resultsDir, sessionId),
	])];
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
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
				try { fs.rmdirSync(fullPath); } catch {}
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
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Ignoring invalid async result index '${fullPath}':`, error);
				try {
					fs.rmSync(fullPath, { force: true });
					removed += 1;
				} catch {}
			}
		}
	};
	visit(root);
	return removed;
}
