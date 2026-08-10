import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import type { WaitCompletion } from "../../shared/types.ts";

const REPLAY_VERSION = 1;
const ARCHIVE_VERSION = 1;
const ARCHIVE_TEXT_LIMIT_BYTES = 64 * 1024;
const REPLAY_DIR_NAME = "completion-replay";
const ARCHIVE_DIR_NAME = "output-archives";

export interface CompletionArchiveEntry {
	agent?: string;
	source: "output-artifact" | "session" | "result-tail";
	path?: string;
	text?: string;
	truncated?: boolean;
}

export interface CompletionArchive {
	version: 1;
	runId: string;
	createdAt: number;
	entries: CompletionArchiveEntry[];
}

export interface CompletionReplayRecord {
	version: 1;
	runId: string;
	sessionId: string;
	completedAt: number;
	expiresAt: number;
	completion: WaitCompletion;
	archivePath: string;
}

function safeRunFile(runId: string): string {
	return `${encodeURIComponent(runId)}.json`;
}

export function completionReplayPath(resultsDir: string, runId: string): string {
	return path.join(resultsDir, REPLAY_DIR_NAME, safeRunFile(runId));
}

export function completionArchivePath(resultsDir: string, runId: string): string {
	return path.join(resultsDir, ARCHIVE_DIR_NAME, safeRunFile(runId));
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function existingFile(value: unknown): string | undefined {
	const filePath = nonEmptyString(value);
	if (!filePath) return undefined;
	try {
		return fs.statSync(filePath).isFile() ? filePath : undefined;
	} catch {
		return undefined;
	}
}

function tailUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(value, "utf-8");
	if (bytes.length <= maxBytes) return { text: value, truncated: false };
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return { text: bytes.subarray(start).toString("utf-8"), truncated: true };
}

function outputArtifactPath(child: Record<string, unknown>): string | undefined {
	if (!child.artifactPaths || typeof child.artifactPaths !== "object" || Array.isArray(child.artifactPaths)) return undefined;
	return existingFile((child.artifactPaths as Record<string, unknown>).outputPath);
}

/** Create a small archive that references saved child artifacts and retains only bounded fallback output text. */
export function writeCompletionArchive(resultsDir: string, runId: string, data: Record<string, unknown>, createdAt: number): string {
	const entries: CompletionArchiveEntry[] = [];
	const fallback: string[] = [];
	const results = Array.isArray(data.results) ? data.results : [];
	for (const value of results) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const child = value as Record<string, unknown>;
		const agent = nonEmptyString(child.agent);
		const artifactPath = outputArtifactPath(child);
		if (artifactPath) {
			entries.push({ ...(agent ? { agent } : {}), source: "output-artifact", path: artifactPath });
			continue;
		}
		const sessionPath = existingFile(child.sessionFile);
		if (sessionPath) {
			entries.push({ ...(agent ? { agent } : {}), source: "session", path: sessionPath });
			continue;
		}
		const output = nonEmptyString(child.output);
		const error = nonEmptyString(child.error);
		if (output || error) {
			fallback.push([agent ? `[${agent}]` : undefined, error ? `Error: ${error}` : undefined, output].filter(Boolean).join("\n"));
		}
	}
	if (results.length === 0) {
		const sessionPath = existingFile(data.sessionFile);
		if (sessionPath) entries.push({ source: "session", path: sessionPath });
	}
	if (entries.length === 0 && fallback.length === 0) {
		const summary = nonEmptyString(data.summary);
		if (summary) fallback.push(summary);
	}
	if (fallback.length > 0) {
		const bounded = tailUtf8(fallback.join("\n\n"), ARCHIVE_TEXT_LIMIT_BYTES);
		entries.push({ source: "result-tail", text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
	}
	const archive: CompletionArchive = { version: ARCHIVE_VERSION, runId, createdAt, entries };
	const archivePath = completionArchivePath(resultsDir, runId);
	writePrivateAtomicJson(archivePath, archive);
	return archivePath;
}

function parseCompletion(value: unknown, runId: string): WaitCompletion | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const completion = value as Partial<WaitCompletion>;
	if (completion.runId !== runId) return undefined;
	return completion as WaitCompletion;
}

function parseReplay(value: unknown): CompletionReplayRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<CompletionReplayRecord>;
	if (record.version !== REPLAY_VERSION
		|| typeof record.runId !== "string"
		|| typeof record.sessionId !== "string"
		|| typeof record.completedAt !== "number"
		|| typeof record.expiresAt !== "number"
		|| typeof record.archivePath !== "string") return undefined;
	const completion = parseCompletion(record.completion, record.runId);
	return completion ? { ...record, completion } as CompletionReplayRecord : undefined;
}

function parseArchive(value: unknown): CompletionArchive | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const archive = value as Partial<CompletionArchive>;
	if (archive.version !== ARCHIVE_VERSION || typeof archive.runId !== "string" || typeof archive.createdAt !== "number" || !Array.isArray(archive.entries)) return undefined;
	const entries = archive.entries.flatMap((value): CompletionArchiveEntry[] => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const entry = value as Partial<CompletionArchiveEntry>;
		if (entry.source !== "output-artifact" && entry.source !== "session" && entry.source !== "result-tail") return [];
		return [{
			...(typeof entry.agent === "string" ? { agent: entry.agent } : {}),
			source: entry.source,
			...(typeof entry.path === "string" ? { path: entry.path } : {}),
			...(typeof entry.text === "string" ? { text: entry.text } : {}),
			...(entry.truncated === true ? { truncated: true } : {}),
		}];
	});
	return { version: ARCHIVE_VERSION, runId: archive.runId, createdAt: archive.createdAt, entries };
}

/** Persist a terminal completion before its one-shot result file is removed. */
export function writeCompletionReplay(input: {
	resultsDir: string;
	runId: string;
	sessionId: string;
	completion: WaitCompletion;
	data: Record<string, unknown>;
	now: number;
	ttlMs: number;
}): CompletionReplayRecord {
	const archivePath = writeCompletionArchive(input.resultsDir, input.runId, input.data, input.now);
	const completion = { ...input.completion, archivePath };
	const record: CompletionReplayRecord = {
		version: REPLAY_VERSION,
		runId: input.runId,
		sessionId: input.sessionId,
		completedAt: input.now,
		expiresAt: input.now + input.ttlMs,
		completion,
		archivePath,
	};
	writePrivateAtomicJson(completionReplayPath(input.resultsDir, input.runId), record);
	cleanupCompletionReplay(input.resultsDir, input.now, input.ttlMs);
	return record;
}

/** Read a current replay record. Unknown fields are ignored and unknown versions are skipped. */
export function readCompletionReplay(resultsDir: string, runId: string, options: { sessionId?: string; now?: number } = {}): CompletionReplayRecord | undefined {
	const replayPath = completionReplayPath(resultsDir, runId);
	let parsed: CompletionReplayRecord | undefined;
	try {
		parsed = parseReplay(JSON.parse(fs.readFileSync(replayPath, "utf-8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!parsed) return undefined;
	if (options.sessionId !== undefined && parsed.sessionId !== options.sessionId) return undefined;
	if (parsed.expiresAt <= (options.now ?? Date.now())) {
		try { fs.rmSync(replayPath, { force: true }); } catch { /* best-effort expiry */ }
		try { fs.rmSync(parsed.archivePath, { force: true }); } catch { /* best-effort expiry */ }
		return undefined;
	}
	return parsed;
}

export function readCompletionArchive(archivePath: string): CompletionArchive | undefined {
	try {
		return parseArchive(JSON.parse(fs.readFileSync(archivePath, "utf-8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Opportunistically remove expired replay and orphan archive files without affecting delivery. */
export function cleanupCompletionReplay(resultsDir: string, now: number, maxAgeMs: number): void {
	const replayDir = path.join(resultsDir, REPLAY_DIR_NAME);
	try {
		for (const file of fs.readdirSync(replayDir)) {
			if (!file.endsWith(".json")) continue;
			const filePath = path.join(replayDir, file);
			try {
				const record = parseReplay(JSON.parse(fs.readFileSync(filePath, "utf-8")));
				if (record && record.expiresAt <= now) {
					fs.rmSync(filePath, { force: true });
					fs.rmSync(record.archivePath, { force: true });
				} else if (!record && now - fs.statSync(filePath).mtimeMs > maxAgeMs) {
					fs.rmSync(filePath, { force: true });
				}
			} catch { /* one bad entry must not block cleanup */ }
		}
	} catch { /* replay directory may not exist yet */ }
	const archiveDir = path.join(resultsDir, ARCHIVE_DIR_NAME);
	try {
		for (const file of fs.readdirSync(archiveDir)) {
			const filePath = path.join(archiveDir, file);
			try {
				if (now - fs.statSync(filePath).mtimeMs > maxAgeMs) fs.rmSync(filePath, { force: true });
			} catch { /* one bad entry must not block cleanup */ }
		}
	} catch { /* archive directory may not exist yet */ }
}
