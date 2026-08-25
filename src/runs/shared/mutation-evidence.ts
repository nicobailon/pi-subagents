import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactPaths, TimeoutRecoverySummary, TrackedMutationEvidence, TrackedMutationFingerprint, TrackedMutationSnapshot } from "../../shared/types.ts";

const MAX_TRACKED_PATHS = 500;
const MAX_HASH_BYTES = 1024 * 1024;
const MAX_TIMEOUT_FILES = 20;

function gitArguments(args: string[]): string[] {
	// Mutation evidence must not block child startup on a stale fsmonitor daemon.
	return ["-c", "core.fsmonitor=false", ...args];
}

function gitOutput(cwd: string, args: string[], maxBuffer = MAX_HASH_BYTES): string {
	return execFileSync("git", gitArguments(args), { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer });
}

function splitNul(output: string): string[] {
	return output.split("\0").filter((part) => part.length > 0);
}

function hashLargeDiff(cwd: string, relativePath: string): string {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-tracked-diff-"));
	const diffPath = path.join(tempDir, "diff.patch");
	try {
		execFileSync("git", gitArguments(["diff", "--no-ext-diff", "--binary", `--output=${diffPath}`, "HEAD", "--", relativePath]), { cwd, stdio: "ignore" });
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		const fd = fs.openSync(diffPath, "r");
		try {
			for (;;) {
				const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
			}
		} finally {
			fs.closeSync(fd);
		}
		return hash.digest("hex");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function listChangedTrackedFiles(cwd: string): { paths: string[]; truncated: boolean } {
	const paths = splitNul(gitOutput(cwd, ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--"], MAX_HASH_BYTES));
	return { paths: paths.slice(0, MAX_TRACKED_PATHS), truncated: paths.length > MAX_TRACKED_PATHS };
}

function fingerprintPath(cwd: string, relativePath: string): TrackedMutationFingerprint {
	try {
		const diff = gitOutput(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", relativePath], MAX_HASH_BYTES);
		return { kind: "diff", digest: createHash("sha256").update(diff).digest("hex") };
	} catch {
		return { kind: "diff", digest: hashLargeDiff(cwd, relativePath) };
	}
}

function sameFingerprint(left: TrackedMutationFingerprint | undefined, right: TrackedMutationFingerprint): boolean {
	if (!left || left.kind !== "diff" || right.kind !== "diff") return false;
	return left.digest === right.digest;
}

export function snapshotTrackedMutations(cwd: string): TrackedMutationSnapshot {
	try {
		const changed = listChangedTrackedFiles(cwd);
		const fingerprints: Record<string, TrackedMutationFingerprint> = {};
		for (const file of changed.paths) fingerprints[file] = fingerprintPath(cwd, file);
		return { source: "tracked-files", trackedOnly: true, cwd, dirtyFiles: changed.paths, fingerprints, truncated: changed.truncated };
	} catch (error) {
		return { source: "tracked-files", trackedOnly: true, cwd, dirtyFiles: [], fingerprints: {}, unavailable: error instanceof Error ? error.message : String(error) };
	}
}

export function collectTrackedMutationEvidence(snapshot: TrackedMutationSnapshot, cwd = snapshot.cwd): TrackedMutationEvidence {
	if (snapshot.unavailable) {
		return { source: "tracked-files", trackedOnly: true, changedFiles: [], attemptedMutation: false, unavailable: snapshot.unavailable };
	}
	try {
		const current = listChangedTrackedFiles(cwd);
		const startDirty = new Set(snapshot.dirtyFiles);
		const candidates = new Set([...snapshot.dirtyFiles, ...current.paths]);
		const changedFiles: string[] = [];
		for (const file of candidates) {
			if (!startDirty.has(file)) {
				if (!snapshot.truncated) changedFiles.push(file);
				continue;
			}
			if (!sameFingerprint(snapshot.fingerprints[file], fingerprintPath(cwd, file))) changedFiles.push(file);
		}
		changedFiles.sort();
		return {
			source: "tracked-files",
			trackedOnly: true,
			changedFiles,
			attemptedMutation: changedFiles.length > 0,
			truncated: snapshot.truncated || current.truncated || undefined,
		};
	} catch (error) {
		return { source: "tracked-files", trackedOnly: true, changedFiles: [], attemptedMutation: false, unavailable: error instanceof Error ? error.message : String(error) };
	}
}

function formatPathList(paths: string[]): string {
	if (paths.length === 0) return "none";
	const shown = paths.slice(0, MAX_TIMEOUT_FILES).join(", ");
	return paths.length > MAX_TIMEOUT_FILES ? `${shown}, ... (${paths.length - MAX_TIMEOUT_FILES} more)` : shown;
}

export function buildTimeoutRecoverySummary(input: {
	termination: "timed-out" | "stopped";
	evidence: TrackedMutationEvidence;
	currentTool?: string;
	currentToolArgs?: string;
	currentPath?: string;
	sessionFile?: string;
	transcriptPath?: string;
	artifactPaths?: ArtifactPaths;
}): TimeoutRecoverySummary {
	const warning = "Inspect partial changes before retrying or resuming the child.";
	const changedFiles = input.evidence.changedFiles.slice(0, MAX_TIMEOUT_FILES);
	const lines = [
		"Recovery summary:",
		`- termination: ${input.termination}`,
		`- changed tracked files: ${input.evidence.unavailable ? `unavailable (${input.evidence.unavailable})` : formatPathList(input.evidence.changedFiles)}`,
	];
	if (input.currentTool) lines.push(`- active tool: ${input.currentTool}${input.currentToolArgs ? ` — ${input.currentToolArgs}` : ""}`);
	if (input.currentPath) lines.push(`- active path: ${input.currentPath}`);
	if (input.sessionFile) lines.push(`- session file: ${input.sessionFile}`);
	if (input.transcriptPath) lines.push(`- transcript: ${input.transcriptPath}`);
	if (input.artifactPaths?.outputPath) lines.push(`- output artifact: ${input.artifactPaths.outputPath}`);
	if (input.artifactPaths?.metadataPath) lines.push(`- metadata artifact: ${input.artifactPaths.metadataPath}`);
	lines.push(`Warning: ${warning}`);
	return {
		termination: input.termination,
		changedFiles,
		truncated: input.evidence.changedFiles.length > changedFiles.length || input.evidence.truncated || undefined,
		currentTool: input.currentTool,
		currentToolArgs: input.currentToolArgs,
		currentPath: input.currentPath,
		sessionFile: input.sessionFile,
		transcriptPath: input.transcriptPath,
		artifactPaths: input.artifactPaths,
		warning,
		message: lines.join("\n"),
	};
}
