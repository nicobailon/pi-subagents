import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const IGNORED_CHANGE_PREFIXES = [".pi-subagents/", "tmp/", "node_modules/"];
const IGNORED_CHANGE_PATHS = new Set([".pi-subagents", "tmp", "node_modules"]);
const IGNORED_CHANGE_SEGMENTS = new Set([".git", ".pi-subagents", "node_modules"]);

const DEFAULT_MAX_HASH_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_HASH_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_HASH_ENTRIES = 2_000;

function positiveEnvNumber(name: string, fallback: number): number {
	const parsed = Number(process.env[name]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Read at call time (not module load) so tests can override env guards after
// this module is imported.
function maxHashFileBytes(): number {
	return positiveEnvNumber("PI_SUBAGENTS_MAX_HASH_FILE_BYTES", DEFAULT_MAX_HASH_FILE_BYTES);
}

function maxHashTotalBytes(): number {
	return positiveEnvNumber("PI_SUBAGENTS_MAX_HASH_TOTAL_BYTES", DEFAULT_MAX_HASH_TOTAL_BYTES);
}

function maxHashEntries(): number {
	return positiveEnvNumber("PI_SUBAGENTS_MAX_HASH_ENTRIES", DEFAULT_MAX_HASH_ENTRIES);
}

export interface WatchdogRepoChangeSignature {
	root: string;
	key: string;
	changedPaths: string[];
}

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
	if (result.status !== 0) return undefined;
	return result.stdout;
}

function normalizeRelPath(value: string): string {
	return value.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function ignoredRelPath(relPath: string): boolean {
	const normalized = normalizeRelPath(relPath);
	return IGNORED_CHANGE_PATHS.has(normalized)
		|| IGNORED_CHANGE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
		|| normalized.split("/").some((segment) => IGNORED_CHANGE_SEGMENTS.has(segment));
}

interface HashBudget {
	entries: number;
	bytes: number;
	maxEntries: number;
	maxBytes: number;
}

function useHashEntryBudget(budget: HashBudget): boolean {
	if (budget.entries >= budget.maxEntries) return false;
	budget.entries++;
	return true;
}

function hashFile(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function largeFileHash(stat: fs.Stats): string {
	return "large:" + stat.size + ":" + Math.floor(stat.mtimeMs);
}

function hashFileEntry(normalized: string, fullPath: string, stat: fs.Stats, budget: HashBudget): unknown {
	let hash: string;
	if (stat.size > maxHashFileBytes() || budget.bytes + stat.size > budget.maxBytes) {
		hash = largeFileHash(stat);
	} else {
		try {
			hash = hashFile(fullPath);
			budget.bytes += stat.size;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// A file racing away between lstat and read: mirror the lstat ENOENT path.
			if (code === "ENOENT") return { path: normalized, state: "deleted" };
			// Any other read failure (too-large, EACCES, EISDIR, ...) degrades to the
			// metadata marker so one unreadable file never discards the whole signature.
			hash = largeFileHash(stat);
			if (code !== "ERR_FS_FILE_TOO_LARGE") {
				console.warn("[pi-subagents] watchdog hashFile fell back to metadata for", normalized + ":", (error as Error)?.message);
			}
		}
	}
	return { path: normalized, state: "file", mode: stat.mode & 0o777, size: stat.size, hash };
}

function gitWorktreeEntry(normalized: string, fullPath: string): unknown {
	const status = git(fullPath, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
	return {
		path: normalized,
		state: "git-worktree",
		head: git(fullPath, ["rev-parse", "HEAD"])?.trim(),
		dirty: Boolean(status),
		statusKey: status ? createHash("sha256").update(status).digest("hex") : undefined,
	};
}

function hashPath(root: string, relPath: string, budget: HashBudget): unknown {
	const normalized = normalizeRelPath(relPath);
	if (!useHashEntryBudget(budget)) return { path: normalized, state: "skipped", reason: "entry-limit" };
	const fullPath = path.join(root, normalized);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(fullPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: normalized, state: "deleted" };
		throw error;
	}
	if (stat.isSymbolicLink()) {
		return { path: normalized, state: "symlink", target: fs.readlinkSync(fullPath) };
	}
	if (stat.isDirectory()) {
		if (fs.existsSync(path.join(fullPath, ".git"))) return gitWorktreeEntry(normalized, fullPath);
		const entries = fs.readdirSync(fullPath)
			.map((entry) => normalizeRelPath(path.posix.join(normalized, entry)))
			.filter((entry) => !ignoredRelPath(entry))
			.sort();
		const remainingEntries = Math.max(0, budget.maxEntries - budget.entries);
		const selectedEntries = entries.slice(0, remainingEntries);
		const childEntries = selectedEntries.map((entry) => hashPath(root, entry, budget));
		if (selectedEntries.length < entries.length) {
			childEntries.push({ path: normalized, state: "skipped-children", reason: "entry-limit", count: entries.length - selectedEntries.length });
		}
		return { path: normalized, state: "dir", entries: childEntries };
	}
	if (stat.isFile()) return hashFileEntry(normalized, fullPath, stat, budget);
	return { path: normalized, state: "other", mode: stat.mode };
}

function parsePorcelainZ(raw: string): Array<{ status: string; paths: string[] }> {
	const tokens = raw.split("\0").filter(Boolean);
	const entries: Array<{ status: string; paths: string[] }> = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.length < 4) continue;
		const status = token.slice(0, 2);
		const relPath = token.slice(3);
		const paths = [relPath];
		if (status[0] === "R" || status[0] === "C") {
			const originalPath = tokens[++index];
			if (originalPath) paths.push(originalPath);
		}
		entries.push({ status, paths });
	}
	return entries;
}

function buildRepoChangeSignature(root: string, statusOutput: string): WatchdogRepoChangeSignature {
	const entries = parsePorcelainZ(statusOutput)
		.map((entry) => ({
			status: entry.status,
			paths: entry.paths.map(normalizeRelPath).filter((relPath) => !ignoredRelPath(relPath)),
		}))
		.filter((entry) => entry.paths.length > 0)
		.sort((a, b) => `${a.status} ${a.paths.join("\0")}`.localeCompare(`${b.status} ${b.paths.join("\0")}`));
	const changedPaths = [...new Set(entries.flatMap((entry) => entry.paths))].sort();
	const budget: HashBudget = { entries: 0, bytes: 0, maxEntries: maxHashEntries(), maxBytes: maxHashTotalBytes() };
	const payload = entries.map((entry) => ({
		status: entry.status,
		paths: entry.paths,
		content: entry.paths.map((relPath) => hashPath(root, relPath, budget)),
	}));
	const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	return { root, key, changedPaths };
}

export function computeWatchdogRepoChangeSignature(cwd: string): WatchdogRepoChangeSignature | undefined {
	const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	if (!root) return undefined;
	const statusOutput = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (statusOutput === undefined) return undefined;
	try {
		return buildRepoChangeSignature(root, statusOutput);
	} catch (error) {
		console.warn("[pi-subagents] watchdog repo change signature failed:", (error as Error)?.message);
		return undefined;
	}
}

function toolNameFromMessage(message: Record<string, unknown>): string {
	const value = message.toolName ?? message.name;
	return typeof value === "string" ? value : "";
}

function toolResultSucceeded(message: Record<string, unknown>): boolean {
	return message.isError !== true && message.error === undefined;
}

function messageIndicatesRepoEdit(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const input = message as Record<string, unknown>;
	const role = input.role;
	if (role !== "toolResult" && role !== "tool") return false;
	const toolName = toolNameFromMessage(input);
	return (toolName === "edit" || toolName === "write") && toolResultSucceeded(input);
}

export function eventIndicatesRepoEdit(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const input = event as Record<string, unknown>;
	if (input.type === "turn_end" || input.event === "turn_end") {
		return [input.message, ...(Array.isArray(input.toolResults) ? input.toolResults : [])].some(messageIndicatesRepoEdit);
	}
	if (input.type === "tool_result" || input.event === "tool_result") return messageIndicatesRepoEdit({ role: "toolResult", ...input });
	if (input.type !== "tool_result_end" && input.event !== "tool_result_end") return false;
	return messageIndicatesRepoEdit(input.message);
}
