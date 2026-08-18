import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncStatus } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { encodeIndexSegment } from "./index-segment.ts";
import { updateTerminalRunIndex } from "./terminal-run-index.ts";
import { isStorageCapacityError } from "../../shared/file-system-retry.ts";

export const ACTIVE_RUN_INDEX_DIR = ".active-runs";
export const DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS = 24 * 60 * 60 * 1000;

const TOOL_CALL_INDEX_DIR = "tool-calls";

function indexDir(asyncDirRoot: string): string {
	return path.join(asyncDirRoot, ACTIVE_RUN_INDEX_DIR);
}

function toolCallIndexDir(asyncDirRoot: string, toolCallId: string): string {
	return path.join(indexDir(asyncDirRoot), TOOL_CALL_INDEX_DIR, encodeIndexSegment(toolCallId));
}

function toolCallIndexPath(asyncDir: string, toolCallId: string): string {
	return path.join(toolCallIndexDir(path.dirname(asyncDir), toolCallId), path.basename(asyncDir));
}

function markerPath(asyncDir: string): string {
	return path.join(indexDir(path.dirname(asyncDir)), path.basename(asyncDir));
}

function removeEmptyAncestors(start: string, stop: string): void {
	let current = start;
	while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
		try {
			fs.rmdirSync(current);
		} catch {
			return;
		}
		current = path.dirname(current);
	}
}

export function isActiveAsyncState(state: AsyncStatus["state"]): boolean {
	return state === "queued" || state === "running";
}

function releaseToolCallAliases(asyncDir: string): void {
	const root = path.join(indexDir(path.dirname(asyncDir)), TOOL_CALL_INDEX_DIR);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			console.error(`Failed to inspect async active-run tool-call index root '${root}':`, error);
		}
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const aliasMarker = path.join(root, entry.name, path.basename(asyncDir));
		try {
			fs.rmSync(aliasMarker, { force: true });
			removeEmptyAncestors(path.dirname(aliasMarker), root);
		} catch {
			// Alias cleanup must not affect the authoritative active-run marker.
		}
	}
}

export function releaseActiveRunIndex(asyncDir: string): void {
	try {
		fs.rmSync(markerPath(asyncDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	releaseToolCallAliases(asyncDir);
}

export function updateActiveRunIndex(asyncDir: string, state: AsyncStatus["state"], toolCallId?: string, options: { retryCapacityErrors?: boolean } = {}): void {
	const marker = markerPath(asyncDir);
	if (isActiveAsyncState(state)) {
		fs.mkdirSync(path.dirname(marker), { recursive: true });
		fs.writeFileSync(marker, "", { flag: "a" });
		if (toolCallId) {
			try {
				const toolCallMarker = toolCallIndexPath(asyncDir, toolCallId);
				fs.mkdirSync(path.dirname(toolCallMarker), { recursive: true });
				fs.writeFileSync(toolCallMarker, "", { flag: "a" });
			} catch (error) {
				// Tool-call aliases are optional. The authoritative active-run marker
				// must keep the launch discoverable even when alias indexing fails.
				console.error(`Failed to write async active-run tool-call index for '${asyncDir}':`, error);
			}
		}
		return;
	}
	releaseActiveRunIndex(asyncDir);
	const status = readStatus(asyncDir);
	if (status && status.state === state) {
		try {
			updateTerminalRunIndex(asyncDir, status);
		} catch (error) {
			if (options.retryCapacityErrors && isStorageCapacityError(error)) throw error;
			console.error(`Failed to write async terminal-run index for '${asyncDir}':`, error);
		}
	}
}

export function activeRunMarkerAgeMs(asyncDir: string, now = Date.now()): number | undefined {
	try {
		return Math.max(0, now - fs.statSync(markerPath(asyncDir)).mtimeMs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function readActiveRunIndex(asyncDirRoot: string): string[] | undefined {
	try {
		return fs.readdirSync(indexDir(asyncDirRoot), { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function readActiveRunToolCallIndex(asyncDirRoot: string, toolCallId: string): string[] {
	try {
		return fs.readdirSync(toolCallIndexDir(asyncDirRoot, toolCallId), { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
}
