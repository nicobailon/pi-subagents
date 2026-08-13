import * as fs from "node:fs";
import * as path from "node:path";
import { CHAIN_RUNS_DIR, TEMP_ARTIFACTS_DIR, type ArtifactPaths, type ArtifactDirPreference } from "./types.ts";
import { getAgentDir } from "./utils.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";
export const PROJECT_SUBAGENTS_RELATIVE_DIR = ".pi/subagents";

const PROJECT_ARTIFACT_PATHS = [
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/output.md`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_input.md`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_output.md`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker.jsonl`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_transcript.jsonl`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/run_worker_meta.json`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/progress/run/progress.md`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/outputs/output.md`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/artifacts/outputs/run/output.md`,
	`${PROJECT_SUBAGENTS_RELATIVE_DIR}/chain-runs/run.json`,
];

function globMatchesPath(pattern: string, filePath: string): boolean {
	let expression = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === undefined) break;
		if (character === "*" && pattern[index + 1] === "*") {
			index += 1;
			if (pattern[index + 1] === "/") {
				index += 1;
				expression += "(?:.*/)?";
			} else {
				expression += ".*";
			}
		} else if (character === "*") {
			expression += "[^/]*";
		} else if (character === "?") {
			expression += "[^/]";
		} else if (character === "[") {
			const end = pattern.indexOf("]", index + 1);
			if (end === -1) expression += "\\[";
			else {
				expression += pattern.slice(index, end + 1);
				index = end;
			}
		} else {
			expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	try {
		return new RegExp(`${expression}$`).test(filePath);
	} catch {
		return false;
	}
}

function normalizePattern(pattern: string): string {
	return pattern.replace(/^\.\//, "").replace(/^\//, "").replace(/\/+$/, "");
}

function patternMatchesArtifactPath(pattern: string, artifactPath: string): boolean {
	const normalized = normalizePattern(pattern);
	return normalized === PROJECT_SUBAGENTS_RELATIVE_DIR
		|| normalized === "*"
		|| artifactPath.startsWith(`${normalized}/`)
		|| globMatchesPath(normalized, artifactPath);
}

function ignoreFileExcludesProjectArtifacts(filePath: string): boolean {
	if (!fs.existsSync(filePath)) return false;
	try {
		const excluded = new Set<string>();
		for (const rawLine of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const negated = line.startsWith("!");
			const pattern = negated ? line.slice(1) : line;
			for (const artifactPath of PROJECT_ARTIFACT_PATHS) {
				if (!patternMatchesArtifactPath(pattern, artifactPath)) continue;
				if (negated) excluded.delete(artifactPath);
				else excluded.add(artifactPath);
			}
		}
		return excluded.size === PROJECT_ARTIFACT_PATHS.length;
	} catch {
		return false;
	}
}

function filesIncludeProjectArtifacts(files: unknown): boolean | undefined {
	if (!Array.isArray(files)) return undefined;
	const included = new Set<string>();
	for (const entry of files) {
		if (typeof entry !== "string") continue;
		const negated = entry.startsWith("!");
		const pattern = negated ? entry.slice(1) : entry;
		for (const artifactPath of PROJECT_ARTIFACT_PATHS) {
			if (!patternMatchesArtifactPath(pattern, artifactPath)) continue;
			if (negated) included.delete(artifactPath);
			else included.add(artifactPath);
		}
	}
	return included.size > 0;
}

/** Returns a package-publishing warning when project artifacts can enter npm packages. */
export function getProjectArtifactPackagingWarning(cwd: string): string | undefined {
	const packagePath = path.join(cwd, "package.json");
	if (!fs.existsSync(packagePath)) return undefined;

	let packageJson: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		packageJson = parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}

	const filesIncludeArtifacts = filesIncludeProjectArtifacts(packageJson.files);
	if (filesIncludeArtifacts === false) return undefined;

	const npmIgnorePath = path.join(cwd, ".npmignore");
	const ignorePath = fs.existsSync(npmIgnorePath) ? npmIgnorePath : path.join(cwd, ".gitignore");
	if (filesIncludeArtifacts === undefined && ignoreFileExcludesProjectArtifacts(ignorePath)) return undefined;

	return "Project-scoped subagent artifacts can be included when this package is published. Add '.pi/subagents/' to .npmignore, restrict package.json files, or set artifactDir to 'session' or 'temp'.";
}

export function getProjectSubagentsDir(cwd: string): string {
	return path.join(cwd, PROJECT_SUBAGENTS_RELATIVE_DIR);
}

export function getProjectArtifactsDir(cwd: string): string {
	return path.join(getProjectSubagentsDir(cwd), "artifacts");
}

export function getProjectChainRunsDir(cwd: string): string {
	return path.join(getProjectSubagentsDir(cwd), "chain-runs");
}

export function getChainRunsDir(
	projectCwd: string,
	dirPreference: ArtifactDirPreference = "session",
): string {
	switch (dirPreference) {
		case "project":
			return getProjectChainRunsDir(projectCwd);
		case "session":
		case "temp":
			return CHAIN_RUNS_DIR;
		default:
			throw new Error(`Unsupported artifactDir ${JSON.stringify(dirPreference)}; expected "project", "session", or "temp".`);
	}
}

export function getArtifactsDir(
	sessionFile: string | null,
	projectCwd?: string,
	dirPreference: ArtifactDirPreference = "session",
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
	fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
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
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, line: string): void {
	fs.appendFileSync(filePath, `${line}\n`);
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	if (maxAgeDays <= 0 || !fs.existsSync(dir)) return;

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();

	if (fs.existsSync(markerPath)) {
		const stat = fs.statSync(markerPath);
		if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) return;
	}

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = now - maxAgeMs;

	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		const filePath = path.join(dir, file);
		try {
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs < cutoff) {
				fs.unlinkSync(filePath);
			}
		} catch {
			// Artifact cleanup is best-effort housekeeping. Skip files that disappear
			// or become unreadable while scanning so one bad entry does not block the rest.
		}
	}

	fs.writeFileSync(markerPath, String(now));
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
		const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
		try {
			cleanupOldArtifacts(artifactsDir, maxAgeDays);
		} catch {
			// Session cleanup is best-effort. Keep going so one unreadable session dir
			// does not block cleanup for the rest.
		}
	}
}
