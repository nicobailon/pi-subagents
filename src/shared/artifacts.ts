import * as fs from "node:fs";
import * as path from "node:path";
import { CHAIN_RUNS_DIR, TEMP_ARTIFACTS_DIR, type ArtifactPaths, type ArtifactDirPreference } from "./types.ts";
import { writePrivateAtomicJson } from "./atomic-json.ts";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.ts";
import { getAgentDir } from "./utils.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROJECT_ARTIFACT_ROOT = ".pi-subagents";

export function getProjectSubagentsDir(cwd: string): string {
	return path.join(cwd, PROJECT_ARTIFACT_ROOT);
}

export function getProjectArtifactsDir(cwd: string): string {
	return path.join(getProjectSubagentsDir(cwd), "artifacts");
}

export function getProjectChainRunsDir(cwd: string): string {
	return path.join(getProjectSubagentsDir(cwd), "chain-runs");
}

export function getChainRunsDir(
	sessionFile: string | null,
	projectCwd: string,
	dirPreference: ArtifactDirPreference = "project",
): string {
	if (dirPreference === "session") return sessionFile ? path.join(path.dirname(sessionFile), "subagent-chain-runs") : CHAIN_RUNS_DIR;
	if (dirPreference === "temp") return CHAIN_RUNS_DIR;
	return getProjectChainRunsDir(projectCwd);
}

export function getArtifactsDir(
	sessionFile: string | null,
	projectCwd?: string,
	dirPreference: ArtifactDirPreference = "project",
): string {
	switch (dirPreference) {
		case "session":
			if (sessionFile) {
				const sessionDir = path.dirname(sessionFile);
				return path.join(sessionDir, "subagent-artifacts");
			}
			return TEMP_ARTIFACTS_DIR;
		case "temp":
			return TEMP_ARTIFACTS_DIR;
		case "project":
			if (projectCwd) return getProjectArtifactsDir(projectCwd);
			if (sessionFile) {
				const sessionDir = path.dirname(sessionFile);
				return path.join(sessionDir, "subagent-artifacts");
			}
			return TEMP_ARTIFACTS_DIR;
		default:
			throw new Error(`Unsupported artifactDir ${JSON.stringify(dirPreference)}; expected "project", "session", or "temp".`);
	}
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		transcriptPath: path.join(artifactsDir, `${base}_transcript.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

export function ensureArtifactsDir(dir: string): void {
	let existingParent = path.dirname(dir);
	while (!fs.existsSync(existingParent)) {
		const next = path.dirname(existingParent);
		if (next === existingParent) break;
		existingParent = next;
	}
	if (fs.existsSync(existingParent) && fs.lstatSync(existingParent).isSymbolicLink()) throw new Error(`Artifact parent must not be a symlink: ${existingParent}`);
	const retryDelaysMs = process.platform === "win32" ? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS : [];
	runFileSystemOperationWithRetry(() => fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE }), { retryDelaysMs, wait: waitForFileSystemRetry });
	runFileSystemOperationWithRetry(() => {
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Artifact path must be a real directory: ${dir}`);
		if (process.platform !== "win32") fs.chmodSync(dir, PRIVATE_DIR_MODE);
	}, { retryDelaysMs, wait: waitForFileSystemRetry });
}

export function openPrivateArtifactFile(filePath: string, append: boolean): number {
	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Artifact file must not be a symlink: ${filePath}`);
	const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC) | noFollow;
	const fd = fs.openSync(filePath, flags, PRIVATE_FILE_MODE);
	try {
		if (process.platform !== "win32") fs.fchmodSync(fd, PRIVATE_FILE_MODE);
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

export function createPrivateArtifactWriteStream(filePath: string, append: boolean): fs.WriteStream {
	const fd = openPrivateArtifactFile(filePath, append);
	try {
		return fs.createWriteStream(filePath, { fd, autoClose: true });
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

function writePrivateFile(filePath: string, content: string, append: boolean): void {
	const fd = openPrivateArtifactFile(filePath, append);
	try {
		fs.writeFileSync(fd, append ? `${content}\n` : content, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

export function writeArtifact(filePath: string, content: string): void {
	writePrivateFile(filePath, content, false);
}

export function formatOutputArtifactContent(input: {
	output: string;
	error?: string;
	transcriptPath?: string;
	metadataPath?: string;
}): string {
	if (input.output.trim() || !input.error) return input.output;
	const lines = ["Subagent run failed before producing output.", "", "Error:", input.error];
	if (input.transcriptPath) lines.push("", `Transcript: ${input.transcriptPath}`);
	if (input.metadataPath) lines.push(`Metadata: ${input.metadataPath}`);
	return lines.join("\n");
}

export function writeMetadata(filePath: string, metadata: object): void {
	writePrivateAtomicJson(filePath, metadata);
}

export function appendJsonl(filePath: string, line: string): void {
	writePrivateFile(filePath, line, true);
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	if (!fs.existsSync(dir)) return;
	const rootStat = fs.lstatSync(dir);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();

	if (fs.existsSync(markerPath)) {
		const stat = fs.lstatSync(markerPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return;
		if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) return;
	}

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = now - maxAgeMs;

	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		const filePath = path.join(dir, file);
		try {
			const stat = fs.lstatSync(filePath);
			if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
				fs.unlinkSync(filePath);
			}
		} catch {
			// Artifact cleanup is best-effort housekeeping. Skip files that disappear
			// or become unreadable while scanning so one bad entry does not block the rest.
		}
	}

	writePrivateFile(markerPath, String(now), false);
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
	cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

	const sessionsBase = path.join(getAgentDir(), "sessions");
	if (!fs.existsSync(sessionsBase)) return;

	let dirs: string[];
	try {
		dirs = fs.readdirSync(sessionsBase);
	} catch {
		// Session artifact cleanup is best-effort. If the sessions root cannot be read,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		const sessionDir = path.join(sessionsBase, dir);
		const artifactsDir = path.join(sessionDir, "subagent-artifacts");
		try {
			const sessionStat = fs.lstatSync(sessionDir);
			if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) continue;
			cleanupOldArtifacts(artifactsDir, maxAgeDays);
		} catch {
			// Session cleanup is best-effort. Keep going so one unreadable session dir
			// does not block cleanup for the rest.
		}
	}
}
