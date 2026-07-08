import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const IGNORED_CHANGE_PREFIXES = [".pi-subagents/", "tmp/", "node_modules/"];
const IGNORED_CHANGE_PATHS = new Set([".pi-subagents", "tmp", "node_modules"]);

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
	return IGNORED_CHANGE_PATHS.has(normalized) || IGNORED_CHANGE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function hashFile(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashPath(root: string, relPath: string): unknown {
	const normalized = normalizeRelPath(relPath);
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
		const entries = fs.readdirSync(fullPath)
			.map((entry) => normalizeRelPath(path.posix.join(normalized, entry)))
			.filter((entry) => !ignoredRelPath(entry))
			.sort();
		return { path: normalized, state: "dir", entries: entries.map((entry) => hashPath(root, entry)) };
	}
	if (stat.isFile()) {
		return { path: normalized, state: "file", mode: stat.mode & 0o777, size: stat.size, hash: hashFile(fullPath) };
	}
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

export function computeWatchdogRepoChangeSignature(cwd: string): WatchdogRepoChangeSignature | undefined {
	const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	if (!root) return undefined;
	const statusOutput = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (statusOutput === undefined) return undefined;
	const entries = parsePorcelainZ(statusOutput)
		.map((entry) => ({
			status: entry.status,
			paths: entry.paths.map(normalizeRelPath).filter((relPath) => !ignoredRelPath(relPath)),
		}))
		.filter((entry) => entry.paths.length > 0)
		.sort((a, b) => `${a.status} ${a.paths.join("\0")}`.localeCompare(`${b.status} ${b.paths.join("\0")}`));
	const changedPaths = [...new Set(entries.flatMap((entry) => entry.paths))].sort();
	const payload = entries.map((entry) => ({
		status: entry.status,
		paths: entry.paths,
		content: entry.paths.map((relPath) => hashPath(root, relPath)),
	}));
	const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	return { root, key, changedPaths };
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
