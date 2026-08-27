import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncStatus } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { encodeIndexSegment } from "./index-segment.ts";

export const TERMINAL_RUN_INDEX_DIR = ".terminal-runs";

const TERMINAL_RUN_INDEX_VERSION = 1;
const TIMESTAMP_WIDTH = 16;

interface TerminalRunIndexEntry {
	version: 1;
	runId: string;
	sessionId: string;
	endedAt: number;
}

function isTerminalState(state: AsyncStatus["state"]): boolean {
	return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected";
}

function indexRoot(asyncDirRoot: string): string {
	return path.join(asyncDirRoot, TERMINAL_RUN_INDEX_DIR);
}

function sessionIndexDir(asyncDirRoot: string, sessionId: string): string {
	return path.join(indexRoot(asyncDirRoot), encodeIndexSegment(sessionId));
}

function markerName(endedAt: number, runId: string): string {
	return `${Math.max(0, Math.floor(endedAt)).toString().padStart(TIMESTAMP_WIDTH, "0")}-${encodeIndexSegment(runId)}.json`;
}

function markerPath(asyncDir: string, sessionId: string, endedAt: number): string {
	return path.join(sessionIndexDir(path.dirname(asyncDir), sessionId), markerName(endedAt, path.basename(asyncDir)));
}

function parseEntry(value: unknown): TerminalRunIndexEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Partial<TerminalRunIndexEntry>;
	if (entry.version !== TERMINAL_RUN_INDEX_VERSION
		|| typeof entry.runId !== "string" || !entry.runId
		|| typeof entry.sessionId !== "string" || !entry.sessionId
		|| typeof entry.endedAt !== "number" || !Number.isFinite(entry.endedAt)) return undefined;
	return { version: TERMINAL_RUN_INDEX_VERSION, runId: entry.runId, sessionId: entry.sessionId, endedAt: entry.endedAt };
}

export function updateTerminalRunIndex(asyncDir: string, status: AsyncStatus): void {
	if (!isTerminalState(status.state) || typeof status.sessionId !== "string" || !status.sessionId) return;
	const endedAt = status.endedAt ?? status.lastUpdate ?? status.startedAt;
	const marker = markerPath(asyncDir, status.sessionId, endedAt);
	const entry: TerminalRunIndexEntry = {
		version: TERMINAL_RUN_INDEX_VERSION,
		runId: status.runId || path.basename(asyncDir),
		sessionId: status.sessionId,
		endedAt,
	};
	writeAtomicJson(marker, entry);
}

function removeInvalidMarker(marker: string): void {
	try {
		fs.rmSync(marker, { force: true });
	} catch {
		// An advisory marker can remain for a later read when cleanup is contended.
	}
}

interface MarkerFile {
	dir: string;
	name: string;
}

function markerFiles(dir: string): MarkerFile[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => ({ dir, name: entry.name }));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
}

function sessionDirs(asyncDirRoot: string, sessionId: string | undefined): string[] {
	if (sessionId) return [sessionIndexDir(asyncDirRoot, sessionId)];
	try {
		return fs.readdirSync(indexRoot(asyncDirRoot), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(indexRoot(asyncDirRoot), entry.name));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
}

function recentMarkerFiles(dirs: string[], limit: number): string[] {
	return dirs.flatMap(markerFiles)
		.sort((left, right) => right.name.localeCompare(left.name))
		.slice(0, limit)
		.map((marker) => path.join(marker.dir, marker.name));
}

export function readRecentTerminalRunIndex(asyncDirRoot: string, options: { sessionId?: string; limit?: number } = {}): string[] {
	const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.limit));
	const candidates = recentMarkerFiles(sessionDirs(asyncDirRoot, options.sessionId), limit);
	const runIds: string[] = [];
	const seen = new Set<string>();
	for (const marker of candidates) {
		let entry: TerminalRunIndexEntry | undefined;
		try {
			entry = parseEntry(JSON.parse(fs.readFileSync(marker, "utf-8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
		}
		if (!entry || (options.sessionId !== undefined && entry.sessionId !== options.sessionId)) {
			removeInvalidMarker(marker);
			continue;
		}
		const asyncDir = path.join(asyncDirRoot, entry.runId);
		const status = readStatus(asyncDir);
		if (!status || !isTerminalState(status.state) || status.sessionId !== entry.sessionId || (status.runId && status.runId !== entry.runId)) {
			removeInvalidMarker(marker);
			continue;
		}
		if (seen.has(entry.runId)) {
			removeInvalidMarker(marker);
			continue;
		}
		seen.add(entry.runId);
		runIds.push(entry.runId);
	}
	return runIds;
}
