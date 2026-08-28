import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { PROJECT_SUBAGENTS_RELATIVE_DIR } from "../../shared/artifacts.ts";
import { DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS, activeRunMarkerAgeMs } from "../background/active-run-index.ts";
import type {
	AsyncStatus,
	ParallelHandoffChild,
	ParallelHandoffCleanupTask,
	ParallelHandoffGroup,
	ParallelHandoffManifest,
} from "../../shared/types.ts";
import { isTerminalParallelHandoffChildStatus } from "./parallel-handoff.ts";

export const WORKTREE_CLEANUP_PLAN_VERSION = 1 as const;
export const WORKTREE_CLEANUP_PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_DISCOVERED_HANDOFFS = 256;
const MAX_PLAN_ENTRIES = 512;
const MAX_METADATA_FILE_BYTES = 2 * 1024 * 1024;

export type WorktreeCleanupPlanState = "safe" | "ineligible" | "stale" | "dirty" | "active" | "unknown";
export type WorktreeCleanupPlanDecision = "remove" | "keep" | "unknown";
export type WorktreeCleanupPlanSource = "git" | "metadata" | "both";
export type ForegroundRunOwnership = "active" | "terminal" | "unknown";

export interface WorktreeCleanupPlanPreconditions {
	path: string;
	branch: string;
	worktreeHead?: string;
	branchTip?: string;
	baseCommit?: string;
	statusDigest?: string;
	recordedBaseDir?: string;
	targetRef?: string;
}

export interface WorktreeCleanupPlanEntry {
	path: string;
	branch: string;
	decision: WorktreeCleanupPlanDecision;
	state: WorktreeCleanupPlanState;
	reasons: string[];
	source: WorktreeCleanupPlanSource;
	willDeleteBranch?: boolean;
	runId?: string;
	handoffPath?: string;
	taskIndex?: number;
	baseCommit?: string;
	patchPath?: string;
	targetRef?: string;
	preconditions: WorktreeCleanupPlanPreconditions;
}

export interface WorktreeCleanupPlan {
	version: typeof WORKTREE_CLEANUP_PLAN_VERSION;
	planId: string;
	repoRoot: string;
	createdAt: number;
	expiresAt: number;
	baseDirs: string[];
	metadataPaths: string[];
	entries: WorktreeCleanupPlanEntry[];
	pruneCandidates: string[];
	warnings?: string[];
	contentHash: string;
}

export interface BuildWorktreeCleanupPlanInput {
	repo: string;
	handoffPath?: string;
	/** Internal test and migration seam for explicitly supplied handoff records. */
	handoffPaths?: string[];
	worktreeBaseDir?: string;
	now?: number;
	planId?: string;
	/** Current-process proof for foreground owners; unknown must remain non-removable. */
	foregroundRunOwnership?: (runId: string) => ForegroundRunOwnership;
}

export interface CreatedWorktreeCleanupPlan {
	plan: WorktreeCleanupPlan;
	planPath: string;
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
}

interface GitWorktreeRecord {
	path: string;
	head: string;
	branch?: string;
	prunable?: string;
}

interface ManifestMetadataRecord {
	manifestPath: string;
	manifest: ParallelHandoffManifest;
	group: ParallelHandoffGroup;
	task: ParallelHandoffCleanupTask;
	child: ParallelHandoffChild;
	status?: AsyncStatus;
	statusPath: string;
	statusError?: string;
}

interface ManifestReadResult {
	manifest?: ParallelHandoffManifest;
	error?: string;
}

interface PathInspection {
	resolved: string;
	realpath?: string;
	missing: boolean;
	symlink: boolean;
	directory: boolean;
	error?: string;
}

interface RunStateInspection {
	kind: "terminal" | "active" | "unknown" | "stale";
	reason?: string;
}

function runGit(cwd: string, args: string[]): GitResult {
	try {
		const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", windowsHide: true });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			status: result.status,
			...(result.error ? { error: result.error } : {}),
		};
	} catch (error) {
		return {
			stdout: "",
			stderr: "",
			status: null,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

function gitFailure(result: GitResult, command: string): string {
	return result.error?.message || result.stderr.trim() || result.stdout.trim() || `${command} failed`;
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) throw new Error(gitFailure(result, `git -C ${cwd} ${args.join(" ")}`));
	return result.stdout.trim();
}

function realpathExisting(
	candidate: string,
	nativeRealpath: (filePath: string) => string = fs.realpathSync.native,
	fallbackRealpath: (filePath: string) => string = fs.realpathSync,
): string {
	try {
		return nativeRealpath(candidate);
	} catch {
		return fallbackRealpath(candidate);
	}
}

/** Internal test seam; this is not part of the public subagent tool API. */
export const __testables = { realpathExisting };

function comparablePath(candidate: string): string {
	let current = path.resolve(candidate);
	const missingSegments: string[] = [];
	let canonical = current;
	while (true) {
		try {
			canonical = path.join(realpathExisting(current), ...missingSegments.reverse());
			break;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) break;
			missingSegments.push(path.basename(current));
			current = parent;
		}
	}
	const normalized = path.normalize(canonical);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
	if (comparablePath(left) === comparablePath(right)) return true;
	if (process.platform !== "win32") return false;
	// Git for Windows and Node can spell the same temp directory with different
	// drive/short-name aliases. The directory identity is the final bounded
	// fallback; never accept aliases when the filesystem cannot prove identity.
	try {
		const leftStat = fs.statSync(left);
		const rightStat = fs.statSync(right);
		return leftStat.dev !== 0 && leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

function resolveExistingPath(candidate: string): string {
	try {
		return realpathExisting(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

function pathInside(root: string, candidate: string, strict = false): boolean {
	const normalizedRoot = comparablePath(root);
	const normalizedCandidate = comparablePath(candidate);
	if (!strict && normalizedRoot === normalizedCandidate) return true;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative !== ""
		&& relative !== ".."
		&& !relative.startsWith(`..${path.sep}`)
		&& !path.isAbsolute(relative);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf-8").digest("hex");
}

function validatePlanId(planId: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(planId) || planId === "." || planId === "..") {
		throw new Error("worktree cleanup plan id must contain only letters, numbers, dots, underscores, or hyphens");
	}
	return planId;
}

function resolveRepoRoot(repo: string): string {
	const requested = path.resolve(repo);
	const toplevel = runGitChecked(requested, ["rev-parse", "--show-toplevel"]);
	return realpathExisting(toplevel);
}

function resolveCleanupBaseDir(repoRoot: string, configuredBaseDir: string | undefined): string {
	const raw = configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR ?? os.tmpdir();
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("worktree base directory cannot be empty");
	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	return path.resolve(path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded));
}

export function parseGitWorktreeList(raw: string): GitWorktreeRecord[] {
	const records: GitWorktreeRecord[] = [];
	let current: GitWorktreeRecord | undefined;
	const flush = (): void => {
		if (current?.path) records.push(current);
		current = undefined;
	};

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) {
			flush();
			continue;
		}
		if (line.startsWith("worktree ")) {
			flush();
			current = { path: line.slice("worktree ".length), head: "" };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
		else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length).trim();
		else if (line === "detached") delete current.branch;
		else if (line.startsWith("prunable ")) current.prunable = line.slice("prunable ".length).trim();
	}
	flush();
	return records;
}

function listGitWorktrees(repoRoot: string): GitWorktreeRecord[] {
	const result = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	if (result.status !== 0) throw new Error(gitFailure(result, `git -C ${repoRoot} worktree list --porcelain`));
	return parseGitWorktreeList(result.stdout);
}

function readJsonFile(filePath: string): unknown {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readManifest(manifestPath: string): ManifestReadResult {
	try {
		const stat = fs.lstatSync(manifestPath);
		if (stat.isSymbolicLink() || !stat.isFile()) return { error: `parallel handoff manifest is not a regular file: ${manifestPath}` };
		if (stat.size > MAX_METADATA_FILE_BYTES) return { error: `parallel handoff manifest exceeds the ${MAX_METADATA_FILE_BYTES}-byte limit: ${manifestPath}` };
		const parsed = readJsonFile(manifestPath);
		if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.groups)) {
			return { error: `invalid parallel handoff manifest version or groups: ${manifestPath}` };
		}
		return { manifest: parsed as unknown as ParallelHandoffManifest };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") return { error: `parallel handoff manifest not found: ${manifestPath}` };
		return { error: `failed to read parallel handoff manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function discoverHandoffPaths(repoRoot: string, input: BuildWorktreeCleanupPlanInput): { paths: string[]; warnings: string[] } {
	const paths: string[] = [];
	const warnings: string[] = [];
	const add = (candidate: string): void => {
		const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(repoRoot, candidate);
		if (!paths.some((existing) => comparablePath(existing) === comparablePath(resolved))) paths.push(resolved);
	};

	if (input.handoffPath) add(input.handoffPath);
	for (const candidate of input.handoffPaths ?? []) add(candidate);

	// Project artifacts have a fixed, shallow handoff layout. Do not walk a temp
	// or session root: those roots contain unrelated operator data and are not a
	// source of ownership for cleanup candidates.
	const artifactsDir = path.join(repoRoot, PROJECT_SUBAGENTS_RELATIVE_DIR, "artifacts");
	const projectHandoffPath = path.join(artifactsDir, "handoff.json");
	if (fs.existsSync(projectHandoffPath)) add(projectHandoffPath);
	const handoffsDir = path.join(artifactsDir, "handoffs");
	try {
		const stat = fs.lstatSync(handoffsDir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			warnings.push(`ignored non-directory handoff metadata root: ${handoffsDir}`);
		} else {
			const entries = fs.readdirSync(handoffsDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
				.map((entry) => entry.name)
				.sort()
				.slice(0, MAX_DISCOVERED_HANDOFFS);
			for (const entry of entries) add(path.join(handoffsDir, entry));
			if (entries.length === MAX_DISCOVERED_HANDOFFS) warnings.push(`handoff metadata discovery capped at ${MAX_DISCOVERED_HANDOFFS} files`);
		}
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code !== "ENOENT") warnings.push(`failed to inspect handoff metadata root ${handoffsDir}: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { paths: paths.sort((left, right) => comparablePath(left).localeCompare(comparablePath(right))), warnings: [...new Set(warnings)].sort() };
}

function readStatusBesideManifest(manifestPath: string): { status?: AsyncStatus; statusPath: string; error?: string } {
	const statusPath = path.join(path.dirname(manifestPath), "status.json");
	try {
		const stat = fs.lstatSync(statusPath);
		if (stat.isSymbolicLink() || !stat.isFile()) return { statusPath, error: `async status is not a regular file: ${statusPath}` };
		if (stat.size > MAX_METADATA_FILE_BYTES) return { statusPath, error: `async status exceeds the ${MAX_METADATA_FILE_BYTES}-byte limit: ${statusPath}` };
		const parsed = readJsonFile(statusPath);
		if (!isRecord(parsed) || typeof parsed.state !== "string" || typeof parsed.runId !== "string") {
			return { statusPath, error: `invalid async status beside manifest: ${statusPath}` };
		}
		return { status: parsed as unknown as AsyncStatus, statusPath };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") return { statusPath };
		return { statusPath, error: `failed to read async status ${statusPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function manifestMetadata(manifestPath: string, manifest: ParallelHandoffManifest, warnings: string[]): ManifestMetadataRecord[] {
	const records: ManifestMetadataRecord[] = [];
	const groups = manifest.groups.slice(0, MAX_PLAN_ENTRIES);
	if (manifest.groups.length > groups.length) warnings.push(`handoff group discovery capped at ${MAX_PLAN_ENTRIES} groups in ${manifestPath}`);
	for (const group of groups) {
		if (!isRecord(group) || !Array.isArray(group.cleanup?.tasks) || !Array.isArray(group.children)) {
			warnings.push(`ignored malformed handoff group in ${manifestPath}`);
			continue;
		}
		const statusInfo = readStatusBesideManifest(manifestPath);
		const tasks = group.cleanup.tasks.slice(0, MAX_PLAN_ENTRIES);
		if (group.cleanup.tasks.length > tasks.length) warnings.push(`cleanup task discovery capped at ${MAX_PLAN_ENTRIES} tasks in ${manifestPath}`);
		for (const task of tasks) {
			if (!isRecord(task) || typeof task.path !== "string" || !task.path.trim() || typeof task.branch !== "string" || !task.branch.trim() || typeof task.index !== "number" || !Number.isInteger(task.index) || task.index < 0) {
				warnings.push(`ignored malformed cleanup task in ${manifestPath}`);
				continue;
			}
			const matchingChildren = group.children.filter((candidate) => isRecord(candidate) && candidate.taskIndex === task.index);
			if (matchingChildren.length !== 1 || !isRecord(matchingChildren[0]) || typeof matchingChildren[0].status !== "string") {
				warnings.push(`cleanup task ${task.index} does not have exactly one valid child metadata record in ${manifestPath}`);
				continue;
			}
			records.push({
				manifestPath,
				manifest,
				group,
				task: task as unknown as ParallelHandoffCleanupTask,
				child: matchingChildren[0] as unknown as ParallelHandoffChild,
				...(statusInfo.status ? { status: statusInfo.status } : {}),
				statusPath: statusInfo.statusPath,
				...(statusInfo.error ? { statusError: statusInfo.error } : {}),
			});
		}
	}
	return records;
}

function loadMetadata(input: BuildWorktreeCleanupPlanInput, repoRoot: string): { records: ManifestMetadataRecord[]; paths: string[]; warnings: string[] } {
	const discovered = discoverHandoffPaths(repoRoot, input);
	const records: ManifestMetadataRecord[] = [];
	const warnings = [...discovered.warnings];
	const explicitPath = input.handoffPath ? path.isAbsolute(input.handoffPath) ? path.resolve(input.handoffPath) : path.resolve(repoRoot, input.handoffPath) : undefined;
	for (const manifestPath of discovered.paths) {
		const result = readManifest(manifestPath);
		if (!result.manifest) {
			if (explicitPath && comparablePath(manifestPath) === comparablePath(explicitPath)) warnings.push(result.error!);
			continue;
		}
		const manifestRoot = resolveExistingPath(manifestPath);
		if (manifestRoot !== manifestPath && fs.lstatSync(manifestPath).isSymbolicLink()) {
			warnings.push(`ignored symlinked handoff manifest: ${manifestPath}`);
			continue;
		}
		records.push(...manifestMetadata(manifestPath, result.manifest, warnings));
	}
	return { records, paths: discovered.paths, warnings: [...new Set(warnings)].sort() };
}

function inspectPath(candidate: string): PathInspection {
	const resolved = path.resolve(candidate);
	try {
		const stat = fs.lstatSync(resolved);
		if (stat.isSymbolicLink()) return { resolved, missing: false, symlink: true, directory: false };
		return { resolved, realpath: realpathExisting(resolved), missing: false, symlink: false, directory: stat.isDirectory() };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code === "ENOENT") return { resolved, missing: true, symlink: false, directory: false };
		return { resolved, missing: false, symlink: false, directory: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function metadataPath(manifestPath: string, candidate: string): string {
	return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(path.dirname(manifestPath), candidate);
}

function metadataRecordPath(record: ManifestMetadataRecord): string {
	return metadataPath(record.manifestPath, record.task.path);
}

function metadataPatchPath(record: ManifestMetadataRecord): string | undefined {
	const patchPath = record.child.patch?.path;
	return typeof patchPath === "string" && patchPath.trim() ? metadataPath(record.manifestPath, patchPath) : undefined;
}

function metadataOutputPaths(record: ManifestMetadataRecord): string[] {
	return [record.child.outputPath, record.child.structuredOutputPath, record.child.sessionPath, record.child.patch?.path]
		.filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
		.map((candidate) => metadataPath(record.manifestPath, candidate));
}

function metadataReportPaths(record: ManifestMetadataRecord): string[] {
	return [record.child.outputPath, record.child.structuredOutputPath, record.child.sessionPath]
		.filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
		.map((candidate) => metadataPath(record.manifestPath, candidate));
}

function terminalRunState(status: AsyncStatus["state"]): boolean {
	return status === "complete" || status === "failed" || status === "partial" || status === "paused" || status === "stopped" || status === "rejected";
}

function inspectRunState(record: ManifestMetadataRecord, now: number, foregroundRunOwnership?: (runId: string) => ForegroundRunOwnership): RunStateInspection {
	if (record.statusError) return { kind: "unknown", reason: record.statusError };
	if (record.status) {
		if (record.status.runId !== record.manifest.runId) return { kind: "unknown", reason: `status run id '${record.status.runId}' does not match manifest run '${record.manifest.runId}'` };
		if (record.status.state === "queued" || record.status.state === "running") return { kind: "active", reason: `owning run is ${record.status.state}` };
		if (!terminalRunState(record.status.state)) return { kind: "unknown", reason: `owning run has unknown state '${record.status.state}'` };
	} else if (record.manifest.source === "async") {
		return { kind: "unknown", reason: `async status is missing beside ${record.manifestPath}` };
	}

	if (record.group.children.length === 0 || !record.group.children.every((child) => isTerminalParallelHandoffChildStatus(child.status))) {
		return { kind: "active", reason: "owning handoff still has a non-terminal child" };
	}
	if (record.manifest.source === "foreground") {
		try {
			const ownership = foregroundRunOwnership?.(record.manifest.runId) ?? "unknown";
			if (ownership === "active") return { kind: "active", reason: "owning foreground run is still active" };
			if (ownership !== "terminal") return { kind: "unknown", reason: "foreground owning-run state is not provably terminal" };
			return { kind: "terminal" };
		} catch (error) {
			return { kind: "unknown", reason: `failed to inspect foreground owning run: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	try {
		const markerAge = activeRunMarkerAgeMs(path.dirname(record.statusPath), now);
		if (markerAge !== undefined) {
			if (markerAge <= DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS) return { kind: "active", reason: "owning run still has a recent active marker" };
			return { kind: "stale", reason: `terminal active marker is stale (${Math.floor(markerAge / 1000)}s old)` };
		}
	} catch (error) {
		return { kind: "unknown", reason: `failed to inspect active-run marker: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { kind: "terminal" };
}

function buildEntryBase(input: {
	path: string;
	branch: string;
	source: WorktreeCleanupPlanSource;
	git?: GitWorktreeRecord;
	metadata?: ManifestMetadataRecord;
	targetHead: string;
}): WorktreeCleanupPlanEntry {
	const recordedBaseDir = path.dirname(input.path);
	const patchPath = input.metadata ? metadataPatchPath(input.metadata) : undefined;
	return {
		path: input.path,
		branch: input.branch,
		decision: "unknown",
		state: "unknown",
		reasons: [],
		source: input.source,
		...(input.metadata ? { runId: input.metadata.manifest.runId, handoffPath: input.metadata.manifestPath, taskIndex: input.metadata.task.index } : {}),
		...(input.metadata?.group.baseCommit ? { baseCommit: input.metadata.group.baseCommit } : {}),
		...(patchPath ? { patchPath } : {}),
		targetRef: input.targetHead,
		preconditions: {
			path: input.path,
			branch: input.branch,
			...(input.git?.head ? { worktreeHead: input.git.head } : {}),
			...(input.metadata?.group.baseCommit ? { baseCommit: input.metadata.group.baseCommit } : {}),
			recordedBaseDir,
			targetRef: input.targetHead,
		},
	};
}

function blockedEntry(entry: WorktreeCleanupPlanEntry, state: WorktreeCleanupPlanState, decision: WorktreeCleanupPlanDecision, reason: string): WorktreeCleanupPlanEntry {
	return { ...entry, state, decision, reasons: [...entry.reasons, reason] };
}

function inspectStatus(worktreePath: string): { output?: string; digest?: string; error?: string } {
	const result = runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (result.status !== 0) return { error: gitFailure(result, `git -C ${worktreePath} status --porcelain=v1`) };
	const output = result.stdout;
	return { output, digest: sha256(output) };
}

function resolveCommit(repoRoot: string, commit: string): { value?: string; error?: string } {
	const result = runGit(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
	if (result.status !== 0) return { error: gitFailure(result, `git -C ${repoRoot} rev-parse ${commit}`) };
	return { value: result.stdout.trim() };
}

function resolveBranchTip(repoRoot: string, branch: string): { value?: string; error?: string } {
	const result = runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
	if (result.status !== 0) return { error: gitFailure(result, `git -C ${repoRoot} rev-parse refs/heads/${branch}`) };
	return { value: result.stdout.trim() };
}

function isPatchCaptured(record: ManifestMetadataRecord, worktreePath: string): { path?: string; error?: string } {
	const patchPath = metadataPatchPath(record);
	if (!patchPath || record.child.patch?.error !== undefined || record.child.patch?.changed !== true) return {};
	const inspection = inspectPath(patchPath);
	if (inspection.error) return { error: `captured patch cannot be inspected: ${inspection.error}` };
	if (inspection.missing || !inspection.realpath) return { error: "captured handoff patch is missing" };
	let patchStat: fs.Stats;
	try {
		patchStat = fs.statSync(patchPath);
	} catch (error) {
		return { error: `captured patch cannot be inspected: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!patchStat.isFile()) return { error: "captured handoff patch is not a file" };
	if (pathInside(worktreePath, inspection.realpath)) return { error: "durable handoff patch lives inside the worktree" };
	if (patchStat.size <= 0) return { error: "captured handoff patch is empty" };
	return { path: patchPath };
}

function buildManagedEntry(input: {
	repoRoot: string;
	baseDir: string;
	targetHead: string;
	rootPath: string;
	git: GitWorktreeRecord;
	record: ManifestMetadataRecord;
	otherGitRecords: GitWorktreeRecord[];
	now: number;
	foregroundRunOwnership?: (runId: string) => ForegroundRunOwnership;
}): WorktreeCleanupPlanEntry {
	const { repoRoot, baseDir, targetHead, rootPath, git, record, foregroundRunOwnership } = input;
	const gitWorktreePath = path.resolve(git.path);
	const metadataWorktreePath = metadataRecordPath(record);
	const worktreePath = resolveExistingPath(metadataWorktreePath);
	const entry = buildEntryBase({ path: worktreePath, branch: git.branch ?? "", source: "both", git, metadata: record, targetHead });
	if (typeof record.manifest.runId !== "string" || !record.manifest.runId.trim()) return blockedEntry(entry, "unknown", "unknown", "handoff metadata has no valid owning run id");
	if (record.manifest.source !== "foreground" && record.manifest.source !== "async") return blockedEntry(entry, "unknown", "unknown", "handoff metadata has an unknown source");
	if (typeof record.group.repoRoot !== "string" || !record.group.repoRoot.trim()) return blockedEntry(entry, "unknown", "unknown", "handoff metadata has no repository root");
	if (!samePath(metadataWorktreePath, gitWorktreePath)) return blockedEntry(entry, "unknown", "unknown", "metadata worktree path does not identify the Git worktree");
	const gitPathInspection = inspectPath(gitWorktreePath);
	if (gitPathInspection.error) return blockedEntry(entry, "unknown", "unknown", `Git worktree path could not be inspected: ${gitPathInspection.error}`);
	if (gitPathInspection.missing) return blockedEntry(entry, "stale", "unknown", "Git worktree path is missing from disk");
	if (gitPathInspection.symlink) return blockedEntry(entry, "unknown", "unknown", "Git worktree path is a symlink; cleanup requires a real directory");
	const pathInspection = inspectPath(worktreePath);
	if (pathInspection.error) return blockedEntry(entry, "unknown", "unknown", `worktree path could not be inspected: ${pathInspection.error}`);
	if (pathInspection.missing) return blockedEntry(entry, "stale", "unknown", "worktree path is missing from disk");
	if (pathInspection.symlink) return blockedEntry(entry, "unknown", "unknown", "worktree path is a symlink; cleanup requires a real directory");
	if (!pathInspection.directory || !pathInspection.realpath) return blockedEntry(entry, "unknown", "unknown", "worktree path is not a directory");
	if (!pathInside(baseDir, pathInspection.realpath, true)) return blockedEntry(entry, "ineligible", "keep", `worktree real path is outside configured base directory '${baseDir}'`);

	if (rootPath === comparablePath(pathInspection.realpath)) return blockedEntry(entry, "ineligible", "keep", "worktree is the repository root");
	if (!git.branch) return blockedEntry(entry, "unknown", "unknown", "detached worktrees have no metadata-recorded branch");
	if (record.task.branch !== git.branch) return blockedEntry(entry, "unknown", "unknown", `metadata branch '${record.task.branch}' does not match Git branch '${git.branch}'`);
	if (record.task.worktreeRemoved) return blockedEntry(entry, "stale", "unknown", "handoff metadata already records this worktree as removed");
	if (record.task.preserved !== true) return blockedEntry(entry, "unknown", "unknown", "handoff metadata does not mark this worktree as preserved");
	if (record.group.cleanup.state !== "partial") return blockedEntry(entry, "unknown", "unknown", "handoff cleanup state does not indicate a preserved worktree pending cleanup");
	const cleanupReason = typeof record.task.reason === "string" ? record.task.reason.toLowerCase() : "";
	if (cleanupReason.includes("retained child resume")) return blockedEntry(entry, "ineligible", "keep", "retained child resume still requires this worktree cwd");
	if (cleanupReason.includes("cleanup pending durable handoff capture")) return blockedEntry(entry, "ineligible", "keep", "durable handoff capture is still pending for this worktree");
	if (record.group.repoRoot && comparablePath(resolveExistingPath(record.group.repoRoot)) !== comparablePath(repoRoot)) {
		return blockedEntry(entry, "unknown", "unknown", "handoff repository root does not match the requested repository");
	}
	if (input.otherGitRecords.some((candidate) => candidate.branch === git.branch && comparablePath(candidate.path) !== comparablePath(git.path))) {
		return blockedEntry(entry, "unknown", "unknown", "metadata-recorded branch is checked out in another Git worktree");
	}
	if (git.branch === input.otherGitRecords.find((candidate) => comparablePath(candidate.path) === rootPath)?.branch) {
		return blockedEntry(entry, "ineligible", "keep", "metadata-recorded branch is checked out at the repository root");
	}

	const runState = inspectRunState(record, input.now, foregroundRunOwnership);
	if (runState.kind === "unknown") return blockedEntry(entry, "unknown", "unknown", runState.reason ?? "owning run state is unknown");
	if (runState.kind === "active") return blockedEntry(entry, "active", "keep", runState.reason ?? "owning run is active");
	if (runState.kind === "stale") return blockedEntry(entry, "stale", "unknown", runState.reason ?? "terminal active marker is stale");

	const baseCommit = record.group.baseCommit;
	if (typeof baseCommit !== "string" || !baseCommit.trim()) return blockedEntry(entry, "unknown", "unknown", "handoff metadata has no base commit");
	const resolvedBase = resolveCommit(repoRoot, baseCommit);
	if (!resolvedBase.value) return blockedEntry(entry, "unknown", "unknown", `handoff base commit is not a valid local commit: ${resolvedBase.error ?? "unknown error"}`);
	entry.baseCommit = resolvedBase.value;
	entry.preconditions.baseCommit = resolvedBase.value;
	const branchTip = resolveBranchTip(repoRoot, git.branch);
	if (!branchTip.value) return blockedEntry(entry, "unknown", "unknown", `branch tip could not be resolved: ${branchTip.error ?? "unknown error"}`);
	entry.preconditions.branchTip = branchTip.value;
	entry.preconditions.worktreeHead = git.head;
	if (branchTip.value !== git.head) return blockedEntry(entry, "unknown", "unknown", "branch tip and worktree HEAD do not match");

	const status = inspectStatus(worktreePath);
	if (status.error) return blockedEntry(entry, "unknown", "unknown", `git status failed: ${status.error}`);
	entry.preconditions.statusDigest = status.digest;
	if (status.output && status.output.trim()) return blockedEntry(entry, "dirty", "keep", "worktree has uncommitted or untracked changes");

	const diff = runGit(worktreePath, ["diff", "--quiet", resolvedBase.value, "--"]);
	if (diff.status !== 0 && diff.status !== 1) return blockedEntry(entry, "unknown", "unknown", `git diff safety check failed: ${gitFailure(diff, "git diff")}`);
	const ancestor = runGit(repoRoot, ["merge-base", "--is-ancestor", git.head, targetHead]);
	if (ancestor.status !== 0 && ancestor.status !== 1) return blockedEntry(entry, "unknown", "unknown", `local merge safety check failed: ${gitFailure(ancestor, "git merge-base --is-ancestor")}`);
	const branchTipIsAncestor = ancestor.status === 0;
	let divergenceSafe = diff.status === 0;
	if (!divergenceSafe) {
		const captured = isPatchCaptured(record, worktreePath);
		if (captured.error) return blockedEntry(entry, "ineligible", "keep", captured.error);
		if (captured.path) {
			entry.patchPath = captured.path;
			divergenceSafe = true;
		} else {
			if (branchTipIsAncestor) divergenceSafe = true;
			else return blockedEntry(entry, "ineligible", "keep", "committed divergence is neither preserved by a handoff patch nor merged into the local target HEAD");
		}
	}
	if (!divergenceSafe) return blockedEntry(entry, "unknown", "unknown", "worktree divergence safety could not be established");

	for (const reportPath of [record.manifestPath, ...metadataReportPaths(record)]) {
		const inspection = inspectPath(reportPath);
		if (inspection.error) return blockedEntry(entry, "unknown", "unknown", `durable handoff path could not be inspected: ${inspection.error}`);
		const comparable = inspection.realpath ?? (inspection.symlink ? resolveExistingPath(reportPath) : inspection.resolved);
		if (pathInside(pathInspection.realpath, comparable)) return blockedEntry(entry, "ineligible", "keep", `durable handoff path is inside the worktree: ${reportPath}`);
		if (inspection.missing) return blockedEntry(entry, "unknown", "unknown", `durable handoff path is missing: ${reportPath}`);
		if (inspection.symlink) return blockedEntry(entry, "unknown", "unknown", `durable handoff path is a symlink: ${reportPath}`);
	}

	for (const durablePath of metadataOutputPaths(record)) {
		const inspection = inspectPath(durablePath);
		const comparable = inspection.realpath ?? (inspection.symlink ? resolveExistingPath(durablePath) : inspection.resolved);
		if (pathInside(pathInspection.realpath, comparable)) return blockedEntry(entry, "ineligible", "keep", `durable report or patch path is inside the worktree: ${durablePath}`);
	}

	entry.state = "safe";
	entry.decision = "remove";
	entry.willDeleteBranch = branchTipIsAncestor;
	entry.reasons.push("extension-owned metadata, terminal run, contained clean worktree, and local divergence checks passed");
	if (!branchTipIsAncestor) entry.reasons.push("local branch tip is not an ancestor of target HEAD; future apply must retain the branch");
	return entry;
}

function buildUnknownGitEntry(input: { git: GitWorktreeRecord; targetHead: string }): WorktreeCleanupPlanEntry {
	const pathValue = resolveExistingPath(input.git.path);
	const entry = buildEntryBase({ path: pathValue, branch: input.git.branch ?? "", source: "git", git: input.git, targetHead: input.targetHead });
	return blockedEntry(entry, "unknown", "unknown", "no matching extension-owned handoff metadata was found");
}

function buildMissingMetadataEntry(input: { record: ManifestMetadataRecord; targetHead: string }): WorktreeCleanupPlanEntry | undefined {
	if (input.record.task.worktreeRemoved && input.record.task.branchRemoved) return undefined;
	const pathValue = metadataRecordPath(input.record);
	const entry = buildEntryBase({ path: pathValue, branch: input.record.task.branch, source: "metadata", metadata: input.record, targetHead: input.targetHead });
	return blockedEntry(entry, "stale", "unknown", "handoff metadata records a worktree that is not present in Git worktree state");
}

function contentPayload(plan: Omit<WorktreeCleanupPlan, "contentHash" | "planId" | "createdAt" | "expiresAt">): unknown {
	return {
		version: plan.version,
		repoRoot: plan.repoRoot,
		baseDirs: plan.baseDirs,
		metadataPaths: plan.metadataPaths,
		entries: plan.entries,
		pruneCandidates: plan.pruneCandidates,
		...(plan.warnings ? { warnings: plan.warnings } : {}),
	};
}

function stableEntrySort(left: WorktreeCleanupPlanEntry, right: WorktreeCleanupPlanEntry): number {
	return comparablePath(left.path).localeCompare(comparablePath(right.path)) || left.branch.localeCompare(right.branch);
}

export function buildWorktreeCleanupPlan(input: BuildWorktreeCleanupPlanInput): WorktreeCleanupPlan {
	if (typeof input.repo !== "string" || !input.repo.trim()) throw new Error("worktree cleanup plan requires a repository path");
	const repoRoot = resolveRepoRoot(input.repo);
	const now = input.now ?? Date.now();
	if (!Number.isFinite(now)) throw new Error("worktree cleanup plan timestamp must be finite");
	const baseDir = resolveCleanupBaseDir(repoRoot, input.worktreeBaseDir);
	const gitRecords = listGitWorktrees(repoRoot);
	const targetHead = runGitChecked(repoRoot, ["rev-parse", "HEAD"]);
	const rootPath = comparablePath(repoRoot);
	const metadata = loadMetadata(input, repoRoot);
	const metadataByPath = new Map<string, ManifestMetadataRecord[]>();
	for (const record of metadata.records) {
		const key = comparablePath(metadataRecordPath(record));
		const records = metadataByPath.get(key) ?? [];
		records.push(record);
		metadataByPath.set(key, records);
	}

	const linkedGit = gitRecords.filter((record) => !samePath(record.path, repoRoot));
	const entries: WorktreeCleanupPlanEntry[] = [];
	const matchedMetadataRecords = new Set<ManifestMetadataRecord>();
	for (const git of linkedGit) {
		const records = metadataByPath.get(comparablePath(git.path)) ?? (git.branch
			? metadata.records.filter((record) => record.task.branch === git.branch && samePath(metadataRecordPath(record), git.path))
			: []);
		if (records.length === 1) matchedMetadataRecords.add(records[0]!);
		if (records.length !== 1) entries.push(buildUnknownGitEntry({ git, targetHead }));
		else entries.push(buildManagedEntry({
			repoRoot,
			baseDir,
			targetHead,
			rootPath,
			git,
			record: records[0]!,
			otherGitRecords: gitRecords,
			now,
			foregroundRunOwnership: input.foregroundRunOwnership,
		}));
	}

	const gitPathKeys = new Set(linkedGit.map((record) => comparablePath(record.path)));
	for (const [key, records] of metadataByPath) {
		if (gitPathKeys.has(key) || records.length !== 1 || matchedMetadataRecords.has(records[0]!)) continue;
		const missing = buildMissingMetadataEntry({ record: records[0]!, targetHead });
		if (missing) entries.push(missing);
	}

	entries.sort(stableEntrySort);
	const warnings = metadata.warnings;
	if (entries.length > MAX_PLAN_ENTRIES) {
		warnings.push(`cleanup plan entry count capped at ${MAX_PLAN_ENTRIES}; remaining worktrees are not evaluated`);
		entries.splice(MAX_PLAN_ENTRIES);
	}
	const pruneCandidates = entries
		.filter((entry) => entry.decision === "unknown" && entry.state === "stale" && gitRecords.some((record) => record.prunable && comparablePath(record.path) === comparablePath(entry.path)))
		.map((entry) => entry.path)
		.sort((left, right) => comparablePath(left).localeCompare(comparablePath(right)));
	const basePlan = {
		version: WORKTREE_CLEANUP_PLAN_VERSION,
		repoRoot,
		baseDirs: [baseDir],
		metadataPaths: metadata.paths,
		entries,
		pruneCandidates,
		...(warnings.length ? { warnings: [...new Set(warnings)].sort() } : {}),
	};
	const contentHash = sha256(JSON.stringify(contentPayload(basePlan)));
	const planId = validatePlanId(input.planId ?? randomUUID());
	return {
		...basePlan,
		planId,
		createdAt: now,
		expiresAt: now + WORKTREE_CLEANUP_PLAN_TTL_MS,
		contentHash,
	};
}

export function worktreeCleanupPlanPath(repoRoot: string, planId: string): string {
	return path.join(repoRoot, PROJECT_SUBAGENTS_RELATIVE_DIR, "cleanup-plans", `${validatePlanId(planId)}.json`);
}

export function createWorktreeCleanupPlan(input: BuildWorktreeCleanupPlanInput): CreatedWorktreeCleanupPlan {
	const plan = buildWorktreeCleanupPlan(input);
	const planPath = worktreeCleanupPlanPath(plan.repoRoot, plan.planId);
	writeAtomicJson(planPath, plan);
	return { plan, planPath };
}

function formatPlanEntry(entry: WorktreeCleanupPlanEntry): string {
	const target = entry.branch ? `${entry.path} [${entry.branch}]` : entry.path;
	return `- ${target}: ${entry.reasons.join("; ") || "no reason recorded"}`;
}

export function formatWorktreeCleanupPlan(created: CreatedWorktreeCleanupPlan): string {
	const { plan, planPath } = created;
	const removable = plan.entries.filter((entry) => entry.decision === "remove");
	const branches = removable.filter((entry) => entry.willDeleteBranch === true);
	const kept = plan.entries.filter((entry) => entry.decision === "keep");
	const unknown = plan.entries.filter((entry) => entry.decision === "unknown");
	const section = (title: string, entries: WorktreeCleanupPlanEntry[], empty: string): string[] => [
		title,
		...(entries.length ? entries.map(formatPlanEntry) : [`- ${empty}`]),
	];
	const lines = [
		`Worktree cleanup plan ${plan.planId}`,
		`Repository: ${plan.repoRoot}`,
		`Expires: ${new Date(plan.expiresAt).toISOString()}`,
		`Entries: ${plan.entries.length}`,
		"",
		...section("Will remove", removable, "none"),
		"",
		...section("Will delete local branches", branches, "none (plan-only mode; no branch will be deleted)"),
		"",
		...section("Will keep, with reasons", kept, "none"),
		"",
		...section("Unknown, needs manual review", unknown, "none"),
		"",
		"Prune candidates",
		...(plan.pruneCandidates.length ? plan.pruneCandidates.map((candidate) => `- ${candidate}`) : ["- none (plan-only mode does not prune Git metadata)"]),
		...(plan.warnings?.length ? ["", "Warnings", ...plan.warnings.map((warning) => `- ${warning}`)] : []),
		"",
		`Plan saved: ${planPath}`,
		"Plan-only mode: no worktrees or branches were removed.",
	];
	return lines.join("\n");
}
