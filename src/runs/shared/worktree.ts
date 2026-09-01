import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthorityDecision, type AuthorityPolicyConfig } from "../../policy/authority.ts";
import { PROJECT_SUBAGENTS_RELATIVE_DIR } from "../../shared/artifacts.ts";
import { getAgentDir } from "../../shared/utils.ts";
import type { ManagedWorktreeProvider, WorktreeNaming, WorktreeProvider } from "../../shared/types.ts";

export const DEFAULT_WORKTREE_PROVIDER: WorktreeProvider = "auto";
export const DEFAULT_WORKTREE_BRANCH_PREFIX = "pi-subagents/";
/** Internal marker used to defer Worktrunk-dependent instruction paths to launch time. */
export const WORKTREE_AGENT_CWD_PLACEHOLDER = path.join(path.parse(process.cwd()).root, "__pi_subagents_worktree_cwd__");
const WORKTREE_NAMING_COMPONENT_MAX_BYTES = 96;
const WORKTREE_NAMING_LABEL_MAX_BYTES = 256;
const WORKTREE_NAMING_BRANCH_MAX_BYTES = 256;
const WORKTREE_COMMAND_OUTPUT_MAX_BYTES = 128 * 1024;

export interface WorktreeNamingInput {
	runId: string;
	index: number;
	/** Explicit step index; otherwise a trailing `-sN` in runId is used. */
	stepIndex?: number;
	/** Explicit task index; defaults to index. */
	taskIndex?: number;
	/** Label precedence is lane/workflow key, output/stable key, then this label. */
	agent?: string;
	label?: string;
	laneKey?: string;
	workflowKey?: string;
	outputName?: string;
	taskKey?: string;
	task?: string;
	branchPrefix?: string;
}

export interface WorktreeCommandResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
}

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
	capturedDiffs?: WorktreeDiff[];
}

export interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
	provider?: ManagedWorktreeProvider;
	naming?: WorktreeNaming;
}

export interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
	error?: string;
}

export interface WorktreeCleanupTask {
	index: number;
	path: string;
	branch: string;
	provider?: ManagedWorktreeProvider;
	naming?: WorktreeNaming;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	preserved?: boolean;
	reason?: string;
	errors?: string[];
}

export type WorktreeCleanupIntent =
	| { kind: "preserve"; capturedDiffs?: WorktreeDiff[]; handoffManifestPath?: string; cleanupBlocker?: string }
	| {
		kind: "discard";
		authorization:
			| { kind: "policy"; policy?: AuthorityPolicyConfig }
			| { kind: "confirmed"; policy?: AuthorityPolicyConfig };
	}
	| { kind: "setup-rollback" };

export interface WorktreeCleanupReport {
	state: "complete" | "partial";
	tasks: WorktreeCleanupTask[];
	pruned: boolean;
	errors?: string[];
}

interface WorktreeTaskCwdConflict {
	index: number;
	agent: string;
	cwd: string;
}

interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

export interface CreateWorktreesOptions {
	agents?: string[];
	/** Optional stable labels used to make branch identity readable. */
	labels?: Array<string | undefined>;
	/** Original task text used for the agent-plus-slug naming fallback. */
	tasks?: Array<string | undefined>;
	/** Worktree allocator selection; auto prefers Worktrunk when available. */
	provider?: WorktreeProvider;
	/** Branch namespace; defaults to `pi-subagents/`. */
	branchPrefix?: string;
	setupHook?: WorktreeSetupHookConfig;
	baseDir?: string;
	/** Called with deterministic ownership metadata before setup hooks and child launch; native reports planned paths before allocation, while Worktrunk reports its returned paths after allocation. */
	beforeCreate?: (setup: WorktreeSetup) => void;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", windowsHide: true, shell: false });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function findGitWorktreePath(cwd: string, branch: string): string | undefined {
	const targetBranch = `branch refs/heads/${branch}`;
	let currentPath: string | undefined;
	for (const line of runGitChecked(cwd, ["worktree", "list", "--porcelain"]).split("\n")) {
		if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
		else if (line.trim() === targetBranch) return currentPath;
	}
	return undefined;
}

function resolveRepoState(cwd: string): RepoState {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();

	// pi-subagents writes durable runtime state under .pi/subagents/ by default;
	// that state must not make managed isolation unusable for later runs.
	const status = runGitChecked(toplevel, ["status", "--porcelain", "--", `:!${PROJECT_SUBAGENTS_RELATIVE_DIR}`]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	let existing = resolved;
	const missingSegments: string[] = [];
	while (true) {
		try {
			return path.join(fs.realpathSync(existing), ...missingSegments.reverse());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) return resolved;
			missingSegments.push(path.basename(existing));
			existing = parent;
		}
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		if (!task.cwd) continue;
		const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
		if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
		return { index, agent: task.agent, cwd: task.cwd };
	}
	return undefined;
}

export function formatWorktreeTaskCwdConflict(
	conflict: WorktreeTaskCwdConflict,
	sharedCwd: string,
): string {
	return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function shortWorktreeHash(value: string): string {
	return createHash("sha256").update(value, "utf-8").digest("hex").slice(0, 8);
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
	const truncated = Buffer.from(value, "utf-8").subarray(0, maxBytes).toString("utf-8");
	return /[\uD800-\uDFFF]$/u.test(truncated) ? truncated.slice(0, -1) : truncated;
}

/** Convert an arbitrary label to a single safe filesystem/branch component. */
export function sanitizeWorktreePathComponent(value: string, maxBytes = WORKTREE_NAMING_COMPONENT_MAX_BYTES): string {
	const raw = value.trim();
	let normalized = raw
		.replace(/[\\/\s]+/g, "-")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "");
	if (!normalized) return "task";
	const changed = normalized !== raw;
	if (changed || Buffer.byteLength(normalized, "utf-8") > maxBytes) {
		const suffix = `-${shortWorktreeHash(raw || "task")}`;
		const prefix = truncateUtf8(normalized, Math.max(1, maxBytes - Buffer.byteLength(suffix, "utf-8"))).replace(/[._-]+$/g, "");
		normalized = `${prefix || "task"}${suffix}`;
	}
	return truncateUtf8(normalized, maxBytes).replace(/^[._-]+|[._-]+$/g, "") || "task";
}

function validGitRef(ref: string): boolean {
	if (!ref || Buffer.byteLength(ref, "utf-8") > 1024 || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("..") || ref.includes("@{")) return false;
	if (/[[\]\\~^:?*\u0000-\u0020]/u.test(ref) || ref.endsWith(".") || ref.endsWith(".lock")) return false;
	return ref.split("/").every((component) => component.length > 0 && component !== "." && component !== ".." && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}

/** Normalize and validate the configured Git branch namespace. */
export function normalizeWorktreeBranchPrefix(value: string | undefined): string {
	const raw = value === undefined ? DEFAULT_WORKTREE_BRANCH_PREFIX : value.trim();
	if (!raw) throw new Error("worktree branch prefix cannot be empty");
	if (raw.includes("\\") || /[\u0000-\u001f\u007f\s]/u.test(raw) || raw.startsWith("/") || raw.includes("//") || raw.includes("..") || raw.includes("@{")) {
		throw new Error("worktree branch prefix contains invalid Git ref characters");
	}
	const withoutTrailingSlash = raw.replace(/\/+$/u, "");
	if (!withoutTrailingSlash || withoutTrailingSlash.startsWith("-") || withoutTrailingSlash.split("/").some((component) => component === "." || component === ".." || component.startsWith("."))) {
		throw new Error("worktree branch prefix contains an invalid Git ref component");
	}
	const prefix = `${withoutTrailingSlash}/`;
	if (!validGitRef(`${prefix}task`)) throw new Error("worktree branch prefix is not a valid Git ref namespace");
	return prefix;
}

function runShortId(runId: string): string {
	const base = runId.replace(/-s\d+$/u, "");
	const normalized = sanitizeWorktreePathComponent(base || runId, 16);
	return normalized.length > 12 ? normalized.slice(0, 12) : normalized;
}

function nonNegativeNamingIndex(value: number | undefined, label: string, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`${label} must be a non-negative integer`);
	return resolved;
}

/** Build the shared branch identity used by native and Worktrunk allocation. */
export function buildWorktreeNaming(input: WorktreeNamingInput): WorktreeNaming {
	if (!input.runId.trim()) throw new Error("worktree run id cannot be empty");
	const index = nonNegativeNamingIndex(input.index, "worktree index", 0);
	const stepIndex = nonNegativeNamingIndex(input.stepIndex, "worktree step index", Number(input.runId.match(/-s(\d+)$/u)?.[1] ?? 0));
	const taskIndex = nonNegativeNamingIndex(input.taskIndex, "worktree task index", index);
	const label = input.laneKey?.trim()
		|| input.workflowKey?.trim()
		|| input.outputName?.trim()
		|| input.taskKey?.trim()
		|| input.label?.trim()
		|| (input.agent?.trim() && input.task?.trim() ? `${input.agent.trim()}-${input.task.trim()}` : undefined)
		|| input.agent?.trim()
		|| "task";
	const branchPrefix = normalizeWorktreeBranchPrefix(input.branchPrefix);
	const labelComponent = sanitizeWorktreePathComponent(label);
	const pathComponentBase = `${labelComponent}-${runShortId(input.runId)}-s${stepIndex}-t${taskIndex}`;
	const sanitizedPathComponent = validGitRef(`${branchPrefix}${pathComponentBase}`)
		? pathComponentBase
		: sanitizeWorktreePathComponent(pathComponentBase, WORKTREE_NAMING_COMPONENT_MAX_BYTES);
	let requestedBranch = `${branchPrefix}${sanitizedPathComponent}`;
	if (!validGitRef(requestedBranch) || Buffer.byteLength(requestedBranch, "utf-8") > WORKTREE_NAMING_BRANCH_MAX_BYTES) {
		const suffix = `-${shortWorktreeHash(pathComponentBase)}`;
		const available = Math.max(1, WORKTREE_NAMING_BRANCH_MAX_BYTES - Buffer.byteLength(branchPrefix, "utf-8") - Buffer.byteLength(suffix, "utf-8"));
		requestedBranch = `${branchPrefix}${truncateUtf8(pathComponentBase, available).replace(/[._-]+$/g, "")}${suffix}`;
	}
	if (!validGitRef(requestedBranch) || Buffer.byteLength(requestedBranch, "utf-8") > WORKTREE_NAMING_BRANCH_MAX_BYTES) throw new Error(`generated worktree branch is not a valid Git ref: ${requestedBranch}`);
	const metadataLabel = truncateUtf8(label.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim() || "task", WORKTREE_NAMING_LABEL_MAX_BYTES);
	return {
		requestedBranch,
		branchPrefix,
		label: metadataLabel,
		sanitizedPathComponent: requestedBranch.slice(branchPrefix.length),
	};
}

function hasConfiguredWorktreeBaseDir(baseDir: string | undefined): boolean {
	return baseDir !== undefined
		? true
		: (process.env.PI_SUBAGENTS_WORKTREE_DIR?.trim().length ?? 0) > 0;
}

interface WorktrunkCapability {
	available: boolean;
	reason?: string;
}

interface SourceCheckoutSnapshot {
	head: string;
	branch?: string;
}

function runWorktrunk(args: string[], cwd?: string): WorktreeCommandResult {
	try {
		const result = spawnSync("wt", args, {
			cwd,
			encoding: "utf-8",
			windowsHide: true,
			shell: false,
			maxBuffer: WORKTREE_COMMAND_OUTPUT_MAX_BYTES,
		});
		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		if (Buffer.byteLength(stdout, "utf-8") > WORKTREE_COMMAND_OUTPUT_MAX_BYTES) throw new Error("Worktrunk stdout exceeds the output limit");
		return { stdout, stderr, status: result.status, ...(result.error ? { error: result.error } : {}) };
	} catch (error) {
		return { stdout: "", stderr: "", status: null, error: error instanceof Error ? error : new Error(String(error)) };
	}
}

function probeWorktrunk(): WorktrunkCapability {
	const result = runWorktrunk(["--version"]);
	if (result.status !== 0) return { available: false, reason: result.error?.message || result.stderr.trim() || "Worktrunk is unavailable" };
	const version = result.stdout.trim().match(/\b(?:wt\s+)?v?(\d+\.\d+(?:\.\d+)?)\b/i)?.[1];
	if (!version) return { available: false, reason: "Worktrunk returned an invalid version" };
	const help = runWorktrunk(["switch", "--help"]);
	if (help.status !== 0) return { available: false, reason: help.error?.message || help.stderr.trim() || "Worktrunk switch capability is unavailable" };
	const helpText = `${help.stdout}\n${help.stderr}`;
	const requiredCapabilities = ["--create", "--base", "--no-cd", "--no-hooks", "--format"];
	const missing = requiredCapabilities.filter((flag) => !helpText.includes(flag));
	if (missing.length > 0) return { available: false, reason: `Worktrunk switch is missing required capabilities: ${missing.join(", ")}` };
	return { available: true };
}

function snapshotSourceCheckout(toplevel: string, head: string): SourceCheckoutSnapshot {
	const branch = runGit(toplevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branchName = branch.status === 0 ? branch.stdout.trim() : "";
	return branchName ? { head, branch: branchName } : { head };
}

function restoreSourceCheckoutIfWorktrunkSwitchedIt(toplevel: string, createdBranch: string, sourceCheckout: SourceCheckoutSnapshot): void {
	const current = runGit(toplevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (current.status !== 0 || current.stdout.trim() !== createdBranch) return;
	runGitChecked(toplevel, sourceCheckout.branch ? ["checkout", sourceCheckout.branch] : ["checkout", "--detach", sourceCheckout.head]);
}

/** Resolve a requested provider without silently switching after allocation starts. */
export function resolveWorktreeProvider(requested: WorktreeProvider | undefined, baseDir?: string): ManagedWorktreeProvider {
	const selection = requested ?? DEFAULT_WORKTREE_PROVIDER;
	if (selection !== "auto" && selection !== "native" && selection !== "worktrunk") throw new Error(`worktree provider must be "auto", "native", or "worktrunk"`);
	if (selection === "native") return "native";
	if (hasConfiguredWorktreeBaseDir(baseDir)) {
		if (selection === "worktrunk") throw new Error("worktreeProvider='worktrunk' cannot be combined with worktreeBaseDir or PI_SUBAGENTS_WORKTREE_DIR");
		return "native";
	}
	const capability = probeWorktrunk();
	if (capability.available) return "worktrunk";
	if (selection === "worktrunk") throw new Error(`Worktrunk provider is unavailable: ${capability.reason ?? "unknown capability failure"}`);
	return "native";
}

/** Whether a launch must bind its worktree-dependent paths after allocation. */
export function shouldDeferWorktreeCwd(requested: WorktreeProvider | undefined, baseDir?: string): boolean {
	return (requested ?? DEFAULT_WORKTREE_PROVIDER) !== "native" && !hasConfiguredWorktreeBaseDir(baseDir);
}

function resolveWorktreeBaseDir(configuredBaseDir: string | undefined, repoRoot: string): string {
	const rawBaseDir = configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR;
	if (rawBaseDir === undefined || (configuredBaseDir === undefined && !rawBaseDir.trim())) return os.tmpdir();

	const trimmed = rawBaseDir.trim();
	if (!trimmed) throw new Error("worktree base directory cannot be empty");

	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
	const extensionsDir = normalizeComparableCwd(path.join(getAgentDir(), "extensions"));
	const relativeToExtensions = path.relative(extensionsDir, normalizeComparableCwd(resolved));
	if (!relativeToExtensions || (!relativeToExtensions.startsWith(`..${path.sep}`) && relativeToExtensions !== ".." && !path.isAbsolute(relativeToExtensions))) {
		throw new Error(`worktree base directory cannot be inside Pi extensions directory: ${extensionsDir}. Choose a directory outside it.`);
	}
	try {
		fs.mkdirSync(resolved, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to create worktree base directory ${resolved}: ${message}`);
	}
	return resolved;
}

function buildNativeWorktreePath(baseDir: string, runId: string, index: number): string {
	return path.join(baseDir, `pi-worktree-${sanitizeWorktreePathComponent(runId, 120)}-${index}`);
}

function resolveRepoCwdRelative(cwd: string): string {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix
		? path.normalize(rawPrefix.replace(/[\\/]+$/, ""))
		: "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number, baseDir?: string): string {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const repoRoot = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const worktreePath = buildNativeWorktreePath(resolveWorktreeBaseDir(baseDir, repoRoot), runId, index);
	return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
}

function parseHookTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	return {
		hookPath: resolvedPath,
		timeoutMs: parseHookTimeout(config.timeoutMs),
	};
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
	const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
	return result.status === 0 && result.stdout.trim().length > 0;
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	return parsed as WorktreeSetupHookOutput;
}

function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
): string[] {
	const result = spawnSync(hook.hookPath, [], {
		windowsHide: true,
		cwd: input.worktreePath,
		encoding: "utf-8",
		input: JSON.stringify(input),
		timeout: hook.timeoutMs,
		shell: false,
	});

	if (result.error) {
		const code = "code" in result.error ? result.error.code : undefined;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		throw new Error(`worktree setup hook failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	if (output.syntheticPaths === undefined) return [];
	if (!Array.isArray(output.syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		if (typeof candidate !== "string") {
			throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
		}
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

function finalizeCreatedWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	worktree: WorktreeInfo,
): WorktreeInfo {
	const agentCwd = cwdRelative ? path.join(worktree.path, cwdRelative) : worktree.path;
	try {
		const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktree.path);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];
		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: toplevel,
				worktreePath: worktree.path,
				agentCwd,
				branch: worktree.branch,
				index: worktree.index,
				runId,
				baseCommit,
				agent,
			});
			syntheticPaths.push(...hookSyntheticPaths);
		}
		return { ...worktree, agentCwd, nodeModulesLinked, syntheticPaths };
	} catch (error) {
		try { runGitChecked(toplevel, ["worktree", "remove", "--force", worktree.path]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		try { runGitChecked(toplevel, ["branch", "-D", worktree.branch]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		throw error;
	}
}

function createNativeWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	baseDir: string,
	labels: Array<string | undefined> | undefined,
	tasks: Array<string | undefined> | undefined,
	branchPrefix: string | undefined,
): WorktreeInfo {
	const naming = buildWorktreeNaming({ runId, index, agent, label: labels?.[index], task: tasks?.[index], branchPrefix });
	const worktreePath = buildNativeWorktreePath(baseDir, runId, index);
	const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", naming.requestedBranch, baseCommit]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}
	return finalizeCreatedWorktree(toplevel, cwdRelative, runId, baseCommit, setupHook, agent, {
		path: worktreePath,
		agentCwd: worktreePath,
		branch: naming.requestedBranch,
		index,
		nodeModulesLinked: false,
		syntheticPaths: [],
		provider: "native",
		naming,
	});
}

interface WorktrunkSwitchOutput {
	action?: unknown;
	branch?: unknown;
	path?: unknown;
	created_branch?: unknown;
	base_branch?: unknown;
}

function parseWorktrunkSwitchOutput(rawStdout: string): WorktrunkSwitchOutput {
	if (Buffer.byteLength(rawStdout, "utf-8") > WORKTREE_COMMAND_OUTPUT_MAX_BYTES) throw new Error("Worktrunk provisioning output exceeds the output limit");
	const trimmed = rawStdout.trim();
	if (!trimmed) throw new Error("Worktrunk provisioning returned empty stdout; expected JSON object");
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(`Worktrunk provisioning returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Worktrunk provisioning stdout must be a JSON object");
	return parsed as WorktrunkSwitchOutput;
}

function createWorktrunkWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	agents: string[] | undefined,
	labels: Array<string | undefined> | undefined,
	tasks: Array<string | undefined> | undefined,
	branchPrefix: string | undefined,
): WorktreeInfo {
	const naming = buildWorktreeNaming({ runId, index, agent: agents?.[index], label: labels?.[index], task: tasks?.[index], branchPrefix });
	const sourceCheckout = snapshotSourceCheckout(toplevel, baseCommit);
	const args = ["-C", toplevel, "switch", "--create", naming.requestedBranch, "--base", baseCommit, "--no-cd", "--no-hooks", "--format", "json"];
	const result = runWorktrunk(args, toplevel);
	if (result.status !== 0) {
		const message = result.error?.message || result.stderr.trim() || result.stdout.trim() || "Worktrunk provisioning failed";
		throw new Error(`Worktrunk provisioning failed: ${message}`);
	}
	let createdAllocation = false;
	let returnedPath: string | undefined;
	try {
		const output = parseWorktrunkSwitchOutput(result.stdout);
		createdAllocation = output.action === "created" && output.created_branch === true;
		if (typeof output.path === "string" && path.isAbsolute(output.path)) returnedPath = path.resolve(output.path);
		if (!createdAllocation || output.branch !== naming.requestedBranch || output.base_branch !== baseCommit) {
			throw new Error("Worktrunk provisioning returned inconsistent creation metadata");
		}
		if (typeof output.path !== "string" || !path.isAbsolute(output.path)) throw new Error("Worktrunk provisioning returned a non-absolute worktree path");
		const worktreePathCandidate = returnedPath;
		if (!worktreePathCandidate) throw new Error("Worktrunk provisioning returned a non-absolute worktree path");
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(worktreePathCandidate);
		} catch (error) {
			throw new Error(`Worktrunk provisioning returned a missing worktree path: ${worktreePathCandidate}`, { cause: error instanceof Error ? error : undefined });
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Worktrunk provisioning returned a path that is not a real directory");
		const worktreePath = normalizeComparableCwd(worktreePathCandidate);
		if (worktreePath === normalizeComparableCwd(toplevel)) throw new Error("Worktrunk provisioning returned the source checkout path");
		const sourceCommonDirRaw = runGitChecked(toplevel, ["rev-parse", "--git-common-dir"]).trim();
		const returnedCommonDirRaw = runGitChecked(worktreePath, ["rev-parse", "--git-common-dir"]).trim();
		const sourceCommonDir = normalizeComparableCwd(path.isAbsolute(sourceCommonDirRaw) ? sourceCommonDirRaw : path.resolve(toplevel, sourceCommonDirRaw));
		const returnedCommonDir = normalizeComparableCwd(path.isAbsolute(returnedCommonDirRaw) ? returnedCommonDirRaw : path.resolve(worktreePath, returnedCommonDirRaw));
		if (returnedCommonDir !== sourceCommonDir) throw new Error("Worktrunk provisioning returned a worktree for a different repository");
		const returnedBranch = runGitChecked(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
		if (returnedBranch !== naming.requestedBranch) throw new Error("Worktrunk provisioning returned a worktree on a different branch");
		const returnedHead = runGitChecked(worktreePath, ["rev-parse", "HEAD"]).trim();
		if (returnedHead !== baseCommit) throw new Error("Worktrunk provisioning returned a worktree at a different base commit");
		return {
			path: worktreePath,
			agentCwd: cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath,
			branch: naming.requestedBranch,
			index,
			nodeModulesLinked: false,
			syntheticPaths: [],
			provider: "worktrunk",
			naming,
		};
	} catch (error) {
		if (createdAllocation) {
			try { restoreSourceCheckoutIfWorktrunkSwitchedIt(toplevel, naming.requestedBranch, sourceCheckout); } catch {
				// Best-effort rollback; preserve the validation failure.
			}
			try {
				const listedPath = findGitWorktreePath(toplevel, naming.requestedBranch);
				const candidates = [listedPath, returnedPath].filter((candidate, candidateIndex, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === candidateIndex);
				for (const candidate of candidates) {
					if (normalizeComparableCwd(candidate) === normalizeComparableCwd(toplevel)) continue;
					try {
						runGitChecked(toplevel, ["worktree", "remove", "--force", candidate]);
						break;
					} catch {
						// Try another provider-reported/listed path before giving up.
					}
				}
			} catch {
				// Best-effort rollback; preserve the validation failure.
			}
			try { runGitChecked(toplevel, ["branch", "-D", naming.requestedBranch]); } catch {
				// Best-effort rollback; preserve the validation failure.
			}
		}
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string, error?: string): WorktreeDiff {
	return {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
		...(error ? { error } : {}),
	};
}

function parseNumstat(numstat: string): { filesChanged: number; insertions: number; deletions: number } {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree);
	runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(worktree.path, ["diff", "--cached", setup.baseCommit]);
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	fs.writeFileSync(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}

	const parsed = parseNumstat(numstat);
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
	};
}

function writeEmptyPatch(patchPath: string): void {
	try {
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		// Diff artifact writing is best-effort in error paths.
	}
}

function handoffRecordsPatch(manifestPath: string | undefined, patchPath: string): boolean {
	if (!manifestPath || !fs.existsSync(manifestPath)) return false;
	try {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
			version?: unknown;
			groups?: Array<{ children?: Array<{ patch?: { path?: unknown; error?: unknown } }> }>;
		};
		if (manifest.version !== 1 || !Array.isArray(manifest.groups)) return false;
		const resolvedPatchPath = path.resolve(patchPath);
		return manifest.groups.some((group) => Array.isArray(group.children) && group.children.some((child) =>
			child.patch?.error === undefined
			&& typeof child.patch?.path === "string"
			&& path.resolve(child.patch.path) === resolvedPatchPath,
		));
	} catch {
		return false;
	}
}

function cleanupSingleWorktree(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	intent: WorktreeCleanupIntent,
): WorktreeCleanupTask {
	const errors: string[] = [];
	let worktreeRemoved = false;
	let branchRemoved = false;
	if (intent.kind === "preserve" && intent.cleanupBlocker) {
		return {
			index: worktree.index,
			path: worktree.path,
			branch: worktree.branch,
			...(worktree.provider ? { provider: worktree.provider } : {}),
			...(worktree.naming ? { naming: worktree.naming } : {}),
			worktreeRemoved: false,
			branchRemoved: false,
			preserved: true,
			reason: intent.cleanupBlocker,
		};
	}
	if (intent.kind !== "setup-rollback") {
		try {
			removeSyntheticPathsBeforeDiff(worktree);
		} catch (error) {
			errors.push(`synthetic path cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const status = runGit(worktree.path, ["status", "--porcelain"]);
		const baseDiff = runGit(worktree.path, ["diff", "--quiet", setup.baseCommit, "--"]);
		if (status.status !== 0 || (baseDiff.status !== 0 && baseDiff.status !== 1)) {
			const reason = status.status !== 0
				? status.stderr.trim() || status.stdout.trim() || "git status failed"
				: baseDiff.stderr.trim() || baseDiff.stdout.trim() || "git diff check failed";
			return {
				index: worktree.index,
				path: worktree.path,
				branch: worktree.branch,
				...(worktree.provider ? { provider: worktree.provider } : {}),
				...(worktree.naming ? { naming: worktree.naming } : {}),
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "cleanup safety check failed",
				errors: [...errors, `cleanup refused: ${reason}`],
			};
		}
		const hasWork = status.stdout.trim().length > 0 || baseDiff.status === 1;
		if (hasWork && intent.kind === "preserve") {
			const captured = (intent.capturedDiffs ?? setup.capturedDiffs)?.find((diff) => diff.index === worktree.index);
			const patchCaptured = captured !== undefined
				&& captured.error === undefined
				&& fs.existsSync(captured.patchPath)
				&& fs.statSync(captured.patchPath).size > 0
				&& handoffRecordsPatch(intent.handoffManifestPath, captured.patchPath);
			if (!patchCaptured) {
				const reason = "worktree contains changes that are not represented by a captured handoff patch";
				return {
					index: worktree.index,
					path: worktree.path,
					branch: worktree.branch,
					...(worktree.provider ? { provider: worktree.provider } : {}),
					...(worktree.naming ? { naming: worktree.naming } : {}),
					worktreeRemoved: false,
					branchRemoved: false,
					preserved: true,
					reason,
					errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
				};
			}
		}
		if (hasWork && intent.kind === "discard") {
			const decision = resolveAuthorityDecision({ action: "discardWorktree", policy: intent.authorization.policy });
			const authorized = decision === "auto" || (decision === "confirm" && intent.authorization.kind === "confirmed");
			if (!authorized) {
				const reason = decision === "forbid"
					? "authority policy forbids worktree discard"
					: "worktree discard requires explicit user confirmation";
				return {
					index: worktree.index,
					path: worktree.path,
					branch: worktree.branch,
					...(worktree.provider ? { provider: worktree.provider } : {}),
					...(worktree.naming ? { naming: worktree.naming } : {}),
					worktreeRemoved: false,
					branchRemoved: false,
					preserved: true,
					reason,
					errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
				};
			}
		}
	}
	try {
		runGitChecked(setup.cwd, ["worktree", "remove", "--force", worktree.path]);
		worktreeRemoved = true;
	} catch (error) {
		errors.push(`worktree removal failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (worktreeRemoved) {
		try {
			runGitChecked(setup.cwd, ["branch", "-D", worktree.branch]);
			branchRemoved = true;
		} catch (error) {
			errors.push(`branch removal failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		index: worktree.index,
		path: worktree.path,
		branch: worktree.branch,
		...(worktree.provider ? { provider: worktree.provider } : {}),
		...(worktree.naming ? { naming: worktree.naming } : {}),
		worktreeRemoved,
		branchRemoved,
		...(errors.length ? { errors } : {}),
	};
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("worktree count must be a non-negative integer");
	const repo = resolveRepoState(cwd);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	let provider = resolveWorktreeProvider(options?.provider, options?.baseDir);
	const branchPrefix = normalizeWorktreeBranchPrefix(options?.branchPrefix);
	let baseDir = provider === "native" ? resolveWorktreeBaseDir(options?.baseDir, repo.toplevel) : undefined;
	const worktrees: WorktreeInfo[] = [];

	try {
		if (provider === "native") {
			const plannedSetup: WorktreeSetup = {
				cwd: repo.toplevel,
				baseCommit: repo.baseCommit,
				worktrees: Array.from({ length: count }, (_, index) => {
					const naming = buildWorktreeNaming({ runId, index, agent: options?.agents?.[index], label: options?.labels?.[index], task: options?.tasks?.[index], branchPrefix });
					const worktreePath = buildNativeWorktreePath(baseDir!, runId, index);
					return {
						path: worktreePath,
						agentCwd: repo.cwdRelative ? path.join(worktreePath, repo.cwdRelative) : worktreePath,
						branch: naming.requestedBranch,
						index,
						nodeModulesLinked: false,
						syntheticPaths: [],
						provider: "native",
						naming,
					};
				}),
			};
			options?.beforeCreate?.(plannedSetup);
			for (let index = 0; index < count; index++) {
				worktrees.push(createNativeWorktree(
						 repo.toplevel,
					repo.cwdRelative,
					runId,
					index,
					repo.baseCommit,
					setupHook,
					options?.agents?.[index],
					baseDir!,
					options?.labels,
					options?.tasks,
					branchPrefix,
				));
			}
		} else {
			for (let index = 0; index < count; index++) {
				worktrees.push(createWorktrunkWorktree(
					repo.toplevel,
					repo.cwdRelative,
					runId,
					index,
					repo.baseCommit,
					options?.agents,
					options?.labels,
					options?.tasks,
					branchPrefix,
				));
			}
			// Worktrunk determines its path only after creation. Journal the exact
			// returned ownership before Pi runs setup hooks or launches a child.
			options?.beforeCreate?.({ cwd: repo.toplevel, baseCommit: repo.baseCommit, worktrees: [...worktrees] });
			for (let index = 0; index < worktrees.length; index++) {
				worktrees[index] = finalizeCreatedWorktree(
					repo.toplevel,
					repo.cwdRelative,
					runId,
					repo.baseCommit,
					setupHook,
					options?.agents?.[index],
					worktrees[index]!,
				);
			}
		}
	} catch (error) {
		cleanupWorktrees({
			cwd: repo.toplevel,
			worktrees,
			baseCommit: repo.baseCommit,
		}, { kind: "setup-rollback" });
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
	};
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch {
		// Returning no diffs is safer than failing the whole command on artifact-dir issues.
		return [];
	}

	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
		} catch (error) {
			// Preserve execution flow while retaining the failed capture as handoff evidence.
			writeEmptyPatch(patchPath);
			diffs.push(emptyDiff(index, agent, worktree.branch, patchPath, error instanceof Error ? error.message : String(error)));
		}
	}

	setup.capturedDiffs = diffs;
	return diffs;
}

export function cleanupWorktrees(
	setup: WorktreeSetup,
	intent: WorktreeCleanupIntent = { kind: "preserve", ...(setup.capturedDiffs ? { capturedDiffs: setup.capturedDiffs } : {}) },
): WorktreeCleanupReport {
	const tasks: WorktreeCleanupTask[] = [];
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		tasks.push(cleanupSingleWorktree(setup, setup.worktrees[index]!, intent));
	}
	tasks.sort((left, right) => left.index - right.index);
	const errors: string[] = [];
	let pruned = false;
	try {
		runGitChecked(setup.cwd, ["worktree", "prune"]);
		pruned = true;
	} catch (error) {
		errors.push(`worktree prune failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const state = tasks.every((task) => task.worktreeRemoved && task.branchRemoved) && pruned ? "complete" : "partial";
	return {
		state,
		tasks,
		pruned,
		...(errors.length ? { errors } : {}),
	};
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter(hasWorktreeChanges);
	if (changed.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	const patchesDir = path.dirname(changed[0]!.patchPath);
	lines.push(`Full patches: ${patchesDir}`);
	return lines.join("\n").trimEnd();
}
