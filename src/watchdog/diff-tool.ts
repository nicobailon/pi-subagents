import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";

export const WATCHDOG_DIFF_TOOL_NAME = "watchdog_diff";
export const WATCHDOG_DIFF_MAX_CHARS = 24_000;
const UNTRACKED_FILE_MAX_CHARS = 4_000;
const UNTRACKED_FILE_MAX_BYTES = UNTRACKED_FILE_MAX_CHARS * 4;
const UNTRACKED_OPEN_FLAGS = fs.constants.O_RDONLY
	| (process.platform === "win32" ? 0 : fs.constants.O_NONBLOCK)
	| (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_LABEL_CHARS = 160;
const MAX_UNTRACKED_NOTE_CHARS = 160;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const SAFE_GIT_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.attributesFile=", "-c", "core.excludesFile="] as const;
const GIT_NULL_CONFIG = process.platform === "win32" ? "NUL" : os.devNull;

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Repo root plus the commit the review compares against, captured when the session starts. */
export interface WatchdogDiffBaseline {
	root: string;
	rootDevice: number;
	rootInode: number;
	ref: string;
}

const WatchdogDiffParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Restrict the diff to one file or directory, relative to the repo root." })),
	stat: Type.Optional(Type.Boolean({ description: "Return per-file change counts instead of the full diff." })),
}, { additionalProperties: false });

type WatchdogDiffParams = Static<typeof WatchdogDiffParams>;

function gitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "GIT" || key.startsWith("GIT_")) delete env[key];
	}
	env.GIT_CONFIG_GLOBAL = GIT_NULL_CONFIG;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_ATTR_NOSYSTEM = "1";
	return env;
}

function runGit(root: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitEnv() });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? result.error?.message ?? "").trim() };
}

const PINNED_GIT_RUNNER_SCRIPT = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const GIT_MAX_BUFFER = ${GIT_MAX_BUFFER};
function errorMessage(error) {
	return error && typeof error.message === "string" ? error.message : String(error);
}
function gitEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "GIT" || key.startsWith("GIT_")) delete env[key];
	}
	env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : os.devNull;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_ATTR_NOSYSTEM = "1";
	env.GIT_WORK_TREE = ".";
	return env;
}
function write(value) {
	process.stdout.write(JSON.stringify(value));
}
function resultRecord(result) {
	return { type: "result", status: result.status, stdout: result.stdout ?? "", stderr: String(result.stderr ?? (result.error && result.error.message) ?? "").trim() };
}
function runGit(args) {
	return spawnSync("git", args, { encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: gitEnv() });
}
function safeGitConfig() {
	return ["-c", "core.fsmonitor=false", "-c", "core.attributesFile=", "-c", "core.excludesFile="];
}
function isolatedDiff(request) {
	const common = runGit([...safeGitConfig(), "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (common.status !== 0) return common;
	const index = runGit([...safeGitConfig(), "rev-parse", "--path-format=absolute", "--git-path", "index"]);
	if (index.status !== 0) return index;
	const gitDir = fs.mkdtempSync(require("node:path").join(os.tmpdir(), "watchdog-diff-git-"));
	try {
		fs.mkdirSync(require("node:path").join(gitDir, "objects", "info"), { recursive: true });
		fs.mkdirSync(require("node:path").join(gitDir, "refs", "heads"), { recursive: true });
		fs.writeFileSync(require("node:path").join(gitDir, "HEAD"), request.ref + "\\n");
		fs.writeFileSync(require("node:path").join(gitDir, "config"), "[core]\\nrepositoryformatversion = 0\\nfilemode = false\\nbare = false\\n");
		fs.writeFileSync(require("node:path").join(gitDir, "objects", "info", "alternates"), common.stdout.trim() + "/objects\\n");
		fs.copyFileSync(index.stdout.trim(), require("node:path").join(gitDir, "index"));
		return runGit(["--git-dir", gitDir, "--work-tree", ".", ...request.args]);
	} finally {
		fs.rmSync(gitDir, { recursive: true, force: true });
	}
}
try {
	const stats = fs.statSync(".");
	if (String(stats.dev) !== process.argv[1] || String(stats.ino) !== process.argv[2]) {
		write({ type: "root-mismatch" });
		process.exit(0);
	}
	const request = JSON.parse(process.argv[3] ?? "[]");
	if (Array.isArray(request)) {
		if (!request.every((arg) => typeof arg === "string")) throw new Error("invalid git args");
		write(resultRecord(runGit(request)));
	} else if (request && request.mode === "isolated-diff" && typeof request.ref === "string" && Array.isArray(request.args) && request.args.every((arg) => typeof arg === "string")) {
		write(resultRecord(isolatedDiff(request)));
	} else {
		throw new Error("invalid git request");
	}
} catch (error) {
	write({ type: "error", error: errorMessage(error) });
}
`;

type BaselineGitRequest = string[] | { mode: "isolated-diff"; ref: string; args: string[] };

function runBaselineGit(baseline: WatchdogDiffBaseline, request: BaselineGitRequest): GitResult {
	const result = spawnSync(process.execPath, ["-e", PINNED_GIT_RUNNER_SCRIPT, String(baseline.rootDevice), String(baseline.rootInode), JSON.stringify(request)], {
		cwd: baseline.root,
		encoding: "utf-8",
		maxBuffer: GIT_MAX_BUFFER * 4,
		windowsHide: true,
		env: gitEnv(),
	});
	if (result.error) throw new Error(`watchdog_diff pinned git runner failed: ${result.error.message}`);
	const raw = result.stdout.trim();
	if (!raw) throw new Error(`watchdog_diff pinned git runner failed: ${result.stderr.trim() || `exit ${result.status ?? "unknown"}`}`);
	let record: { type?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown; error?: unknown };
	try {
		record = JSON.parse(raw) as typeof record;
	} catch (error) {
		throw new Error(`watchdog_diff pinned git runner returned invalid output: ${formatError(error)}`);
	}
	if (record.type === "root-mismatch") throw new Error("watchdog_diff repository root changed since the baseline was captured.");
	if (record.type === "error") throw new Error(`watchdog_diff pinned git runner failed: ${typeof record.error === "string" ? record.error : "unknown error"}`);
	if (record.type !== "result") throw new Error("watchdog_diff pinned git runner returned an invalid response.");
	return { ok: record.status === 0, stdout: typeof record.stdout === "string" ? record.stdout : "", stderr: typeof record.stderr === "string" ? record.stderr : "" };
}

/** Capture the current commit so later diffs cover everything since the session began, including child commits. */
export function captureWatchdogDiffBaseline(cwd: string): WatchdogDiffBaseline | undefined {
	const toplevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!toplevel.ok) return undefined;
	const head = runGit(cwd, ["rev-parse", "HEAD"]);
	if (!head.ok) return undefined;
	const ref = head.stdout.trim();
	if (!toplevel.stdout.trim() || !ref) return undefined;
	try {
		const root = fs.realpathSync(toplevel.stdout.trim());
		const stats = fs.statSync(root);
		return { root, rootDevice: stats.dev, rootInode: stats.ino, ref };
	} catch {
		return undefined;
	}
}

function validatePath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("-")) throw new Error("watchdog_diff path must not start with '-'.");
	if (path.isAbsolute(trimmed)) throw new Error("watchdog_diff path must be relative to the repo root.");
	if (trimmed.split(/[\\/]/).includes("..")) throw new Error("watchdog_diff path must not contain '..'.");
	return trimmed;
}

function untrackedFiles(baseline: WatchdogDiffBaseline, pathFilter: string | undefined): { files: string[]; error?: string } {
	const result = runBaselineGit(baseline, [...SAFE_GIT_CONFIG, "ls-files", "--others", "--exclude-standard", "-z", "--", ...(pathFilter ? [pathFilter] : [])]);
	if (!result.ok) return { files: [], error: `git ls-files failed: ${result.stderr || "unknown error"}` };
	return { files: result.stdout.split("\0").filter(Boolean) };
}

function sameFileIdentity(beforeOpen: fs.Stats, afterOpen: fs.Stats): boolean {
	// The descriptor check closes the lstat/open replacement race for symlinks and FIFOs.
	return beforeOpen.dev === afterOpen.dev && beforeOpen.ino === afterOpen.ino;
}

function sameRegularFileRead(beforeOpen: fs.Stats, afterOpen: fs.Stats): boolean {
	return sameFileIdentity(beforeOpen, afterOpen)
		&& beforeOpen.mode === afterOpen.mode
		&& beforeOpen.size === afterOpen.size
		&& beforeOpen.mtimeMs === afterOpen.mtimeMs
		&& beforeOpen.ctimeMs === afterOpen.ctimeMs;
}

function sameBaselineRoot(baseline: WatchdogDiffBaseline, stats: fs.Stats): boolean {
	return baseline.rootDevice === stats.dev && baseline.rootInode === stats.ino;
}

function ensureBaselineRoot(baseline: WatchdogDiffBaseline): fs.Stats {
	const stats = fs.statSync(baseline.root);
	if (!sameBaselineRoot(baseline, stats)) throw new Error("watchdog_diff repository root changed since the baseline was captured.");
	return stats;
}

function boundInline(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function renderPathLabel(file: string): string {
	let escaped = "";
	for (const char of file) {
		if (char === "\\") escaped += "\\\\";
		else if (char === "\n") escaped += "\\n";
		else if (char === "\r") escaped += "\\r";
		else if (char === "\t") escaped += "\\t";
		else {
			const code = char.charCodeAt(0);
			escaped += code < 32 || code === 127 ? `\\x${code.toString(16).padStart(2, "0")}` : char;
		}
	}
	return boundInline(escaped, MAX_UNTRACKED_LABEL_CHARS);
}

function formatError(error: unknown): string {
	return boundInline((error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim() || "unknown error", MAX_UNTRACKED_NOTE_CHARS);
}

function isInsidePath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function ancestorSnapshot(root: string, fullPath: string): fs.Stats[] | "symlink" {
	const ancestors = [fs.lstatSync(root)];
	const relativeDir = path.relative(root, path.dirname(fullPath));
	if (!relativeDir) return ancestors;
	let current = root;
	for (const segment of relativeDir.split(path.sep)) {
		if (!segment) continue;
		current = path.join(current, segment);
		const stats = fs.lstatSync(current);
		if (stats.isSymbolicLink()) return "symlink";
		ancestors.push(stats);
	}
	return ancestors;
}

function sameAncestorSnapshot(beforeOpen: fs.Stats[], afterOpen: fs.Stats[]): boolean {
	return beforeOpen.length === afterOpen.length && beforeOpen.every((stats, index) => sameFileIdentity(stats, afterOpen[index]!));
}

interface UntrackedRender {
	label: string;
	body: string;
	note?: string;
}

function omittedUntracked(label: string, note: string): UntrackedRender {
	return { label, note, body: `+++ ${label} (untracked, ${note})` };
}

function untrackedAsDiff(root: string, rootStats: fs.Stats, file: string): UntrackedRender {
	const label = renderPathLabel(file);
	const fullPath = path.resolve(root, file);
	if (!isInsidePath(path.resolve(root), fullPath)) return omittedUntracked(label, "outside repository omitted");
	let ancestorsBeforeOpen: fs.Stats[];
	let stats: fs.Stats;
	try {
		const ancestors = ancestorSnapshot(root, fullPath);
		if (ancestors === "symlink") return omittedUntracked(label, "ancestor symlink omitted");
		if (!sameFileIdentity(rootStats, ancestors[0]!)) return omittedUntracked(label, "repository root changed since baseline omitted");
		ancestorsBeforeOpen = ancestors;
		stats = fs.lstatSync(fullPath);
	} catch (error) {
		return omittedUntracked(label, `unreadable: ${formatError(error)}`);
	}
	if (stats.isSymbolicLink()) return omittedUntracked(label, "symlink omitted");
	if (!stats.isFile()) return omittedUntracked(label, "non-regular file omitted");
	let raw: Buffer;
	let size = stats.size;
	try {
		const fd = fs.openSync(fullPath, UNTRACKED_OPEN_FLAGS);
		try {
			const openedStats = fs.fstatSync(fd);
			const ancestorsAfterOpen = ancestorSnapshot(root, fullPath);
			if (ancestorsAfterOpen === "symlink") return omittedUntracked(label, "ancestor symlink omitted");
			if (!sameFileIdentity(rootStats, ancestorsAfterOpen[0]!)) return omittedUntracked(label, "repository root changed since baseline omitted");
			if (!sameAncestorSnapshot(ancestorsBeforeOpen, ancestorsAfterOpen)) return omittedUntracked(label, "ancestor changed during read omitted");
			const currentStats = fs.lstatSync(fullPath);
			if (!sameRegularFileRead(stats, openedStats) || !sameRegularFileRead(currentStats, openedStats)) return omittedUntracked(label, "changed during read omitted");
			const realPath = fs.realpathSync(fullPath);
			if (!isInsidePath(root, realPath)) return omittedUntracked(label, "outside repository omitted");
			if (!openedStats.isFile()) return omittedUntracked(label, "non-regular file omitted");
			size = openedStats.size;
			const buffer = Buffer.alloc(Math.min(size, UNTRACKED_FILE_MAX_BYTES));
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
			raw = buffer.subarray(0, bytesRead);
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		return omittedUntracked(label, `unreadable: ${formatError(error)}`);
	}
	if (raw.includes(0)) return omittedUntracked(label, `binary, ${size} bytes`);
	let text = raw.toString("utf-8");
	let truncated = size > raw.length;
	if (text.length > UNTRACKED_FILE_MAX_CHARS) {
		text = text.slice(0, UNTRACKED_FILE_MAX_CHARS);
		truncated = true;
	}
	const lines = text.replace(/\n$/, "").split("\n").map((line) => `+${line}`);
	const note = truncated ? `truncated at ${UNTRACKED_FILE_MAX_CHARS} characters` : undefined;
	return { label, note, body: [`--- /dev/null`, `+++ ${label} (untracked)`, ...lines, ...(truncated ? [`+... (truncated at ${UNTRACKED_FILE_MAX_CHARS} characters)`] : [])].join("\n") };
}

function untrackedSummary(total: number, inspected: number, omitted: number, entries: UntrackedRender[]): string | undefined {
	if (total === 0) return undefined;
	const lines = [`Untracked files detected: ${total}${omitted > 0 ? `; inspected first ${inspected}, ${omitted} beyond the ${MAX_UNTRACKED_FILES}-file render limit.` : "."}`];
	const notes = entries.filter((entry) => entry.note).map((entry) => ` ${entry.label}: ${entry.note}`);
	if (notes.length) lines.push("Untracked file notes:", ...notes);
	return lines.join("\n");
}

function bound(text: string): string {
	if (text.length <= WATCHDOG_DIFF_MAX_CHARS) return text;
	const marker = `\n\n[... ${text.length - WATCHDOG_DIFF_MAX_CHARS} characters omitted; call again with a narrower path ...]`;
	return `${text.slice(0, WATCHDOG_DIFF_MAX_CHARS - marker.length)}${marker}`;
}

function boundSection(text: string, maxChars: number, label: string): string {
	if (text.length <= maxChars) return text;
	const marker = `\n\n[... ${text.length - maxChars} characters omitted from ${label}; call again with a narrower path ...]`;
	return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function renderSections(leadingSections: string[], untrackedSection: string | undefined, diffSection: string): string {
	if (!untrackedSection || !diffSection) return bound([...leadingSections, untrackedSection, diffSection].filter(Boolean).join("\n\n"));
	const leading = leadingSections.filter(Boolean).join("\n\n");
	const budget = Math.max(1_000, WATCHDOG_DIFF_MAX_CHARS - leading.length - 6);
	const sectionBudget = Math.floor(budget / 2);
	return bound([leading, boundSection(untrackedSection, sectionBudget, "untracked files"), boundSection(diffSection, sectionBudget, "tracked diff")].filter(Boolean).join("\n\n"));
}

/**
 * Read-only diff of the repo against the session-start baseline: tracked changes (including
 * later commits) via `git diff <baseline>`, plus untracked files rendered as additions.
 * In a shared cwd, changes that were already pending when the session started also appear.
 */
export function createWatchdogDiffTool(baseline: WatchdogDiffBaseline): AgentTool<typeof WatchdogDiffParams, { chars: number }> {
	return {
		name: WATCHDOG_DIFF_TOOL_NAME,
		label: "Watchdog diff",
		description: "Show the repository diff since the review baseline (tracked changes and untracked files). Optional path narrows it; stat:true returns per-file counts only.",
		parameters: WatchdogDiffParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: WatchdogDiffParams) {
			const pathFilter = validatePath(params.path);
			const stat = params.stat === true;
			let rootStats = ensureBaselineRoot(baseline);
			const diff = runBaselineGit(baseline, { mode: "isolated-diff", ref: baseline.ref, args: [...SAFE_GIT_CONFIG, "diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(stat ? ["--stat"] : []), baseline.ref, "--", ...(pathFilter ? [pathFilter] : [])] });
			if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr || "unknown error"}`);
			rootStats = ensureBaselineRoot(baseline);
			const untracked = untrackedFiles(baseline, pathFilter);
			rootStats = ensureBaselineRoot(baseline);
			const shown = untracked.files.slice(0, MAX_UNTRACKED_FILES);
			const omitted = untracked.files.length - shown.length;
			const untrackedEntries = stat ? [] : shown.map((file) => untrackedAsDiff(baseline.root, rootStats, file));
			const untrackedSection = shown.length
				? stat
					? ["Untracked files:", ...shown.map((file) => ` ${renderPathLabel(file)} (new)`)].join("\n")
					: untrackedEntries.map((entry) => entry.body).join("\n\n")
				: undefined;
			const leadingSections = [
				...(untracked.error ? [untracked.error] : []),
				untrackedSummary(untracked.files.length, shown.length, omitted, untrackedEntries),
			].filter((section): section is string => section !== undefined);
			const text = renderSections(leadingSections, untrackedSection, diff.stdout.trimEnd()) || `No changes since baseline ${baseline.ref.slice(0, 12)}.`;
			return { content: [{ type: "text", text }], details: { chars: text.length } };
		},
	};
}
