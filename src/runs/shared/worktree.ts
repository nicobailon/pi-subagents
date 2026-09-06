import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runSetupCommand, type SetupCommandOptions, type SetupCommandResult } from "./worktree-setup-command.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthorityDecision, type AuthorityPolicyConfig } from "../../policy/authority.ts";
import { PROJECT_SUBAGENTS_RELATIVE_DIR } from "../../shared/artifacts.ts";
import { getAgentDir } from "../../shared/utils.ts";
import type { ManagedWorktreeProvider, WorktreeNaming, WorktreeProvider } from "../../shared/types.ts";

export const DEFAULT_WORKTREE_PROVIDER: WorktreeProvider = "auto";
export const DEFAULT_WORKTREE_BASE_REF = "HEAD";
export const DEFAULT_WORKTREE_BRANCH_PREFIX = "pi-subagents/";
/** Internal marker used to defer Worktrunk-dependent instruction paths to launch time. */
export const WORKTREE_AGENT_CWD_PLACEHOLDER = path.join(path.parse(process.cwd()).root, "__pi_subagents_worktree_cwd__");
const WORKTREE_NAMING_COMPONENT_MAX_BYTES = 96;
const WORKTREE_NAMING_LABEL_MAX_BYTES = 256;
const WORKTREE_NAMING_BRANCH_MAX_BYTES = 256;
const WORKTREE_COMMAND_OUTPUT_MAX_BYTES = 128 * 1024;
const WORKTRUNK_COMMAND = process.platform === "win32" ? "git" : "wt";
const WORKTRUNK_ARG_PREFIX = process.platform === "win32" ? ["wt"] : [];
export const MACHINE_DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--default-prefix", "--line-prefix=", "--no-relative"] as const;
const MACHINE_PATCH_OPTIONS = [...MACHINE_DIFF_OPTIONS, "--binary"] as const;
const PATCH_VALIDATION_OPTIONS = ["apply", "--check", "--cached", "--reverse", "--binary", "--whitespace=nowarn"] as const;

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
	signal?: AbortSignal;
	/** Existing absolute run deadline only; setup does not start a child budget. */
	deadlineAt?: number;
	onProgress?: (snapshot: WorktreeSetupProgress) => void;
	agents?: string[];
	/** Optional stable labels used to make branch identity readable. */
	labels?: Array<string | undefined>;
	/** Original task text used for the agent-plus-slug naming fallback. */
	tasks?: Array<string | undefined>;
	/** Worktree allocator selection; auto prefers Worktrunk when available. */
	provider?: WorktreeProvider;
	/** Git ref used as the worktree base; defaults to `HEAD`. */
	baseRef?: string;
	/** Branch namespace; defaults to `pi-subagents/`. */
	branchPrefix?: string;
	setupHook?: WorktreeSetupHookConfig;
	baseDir?: string;
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

/** In-memory evidence only. Callers project this into existing handoff diagnostics. */
export interface WorktreeSetupProgress {
	setup: WorktreeSetup;
	attempts: Array<{ index: number; branch: string; path?: string; validated: boolean; command?: WorktreeSetupProgress["command"]; hookCommand?: WorktreeSetupProgress["command"] }>;
	phase: string;
	command?: { command: string; args: string[]; pid?: number; processGroupId?: number; result?: Omit<SetupCommandResult, "stdout" | "stderr"> };
	unknown?: string;
	cleanup?: WorktreeCleanupReport;
}

export class WorktreeSetupError extends Error {
	readonly snapshot: WorktreeSetupProgress;
	constructor(error: unknown, snapshot: WorktreeSetupProgress) {
		super(`${error instanceof Error ? error.message : String(error)}${snapshot.unknown ? `; setup settlement unknown: ${snapshot.unknown}; manual reconciliation required` : ""}`, { cause: error });
		this.name = "WorktreeSetupError";
		this.snapshot = snapshot;
	}
}

let worktreeTurn: Promise<void> = Promise.resolve();
let setupActive = false;
let setupPoison: string | undefined;

function assertWorktreeMutationAllowed(): void {
	if (setupPoison) throw new Error(`Worktree mutation blocked: ${setupPoison}`);
	if (setupActive) throw new Error("Worktree setup is active; finalization must await withWorktreeTransaction");
}

/** Later async finalization owners wrap their synchronous diff/cleanup as ONE turn. */
export async function withWorktreeTransaction<T>(action: () => T | Promise<T>): Promise<T> {
	const previous = worktreeTurn;
	let release!: () => void;
	worktreeTurn = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try {
		if (setupPoison) throw new Error(`Worktree mutation blocked: ${setupPoison}`);
		return await action();
	} finally { release(); }
}

class SetupTransaction {
	readonly progress: WorktreeSetupProgress;
	readonly options: CreateWorktreesOptions;
	constructor(cwd: string, options: CreateWorktreesOptions) {
		this.options = options;
		this.progress = { setup: { cwd, baseCommit: "", worktrees: [] }, attempts: [], phase: "preflight" };
	}
	snapshot(): WorktreeSetupProgress {
		return structuredClone(this.progress);
	}
	publish(): void { this.options.onProgress?.(this.snapshot()); }
	check(): void {
		if (setupPoison) throw new Error(setupPoison);
		if (this.options.signal?.aborted) throw new Error("Worktree setup aborted");
		if (this.options.deadlineAt !== undefined && Date.now() >= this.options.deadlineAt) throw new Error("Worktree setup deadline exceeded");
	}
	unknown(error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		this.progress.unknown ??= reason;
		setupPoison ??= reason;
	}
	async command(command: string, args: string[], options: SetupCommandOptions = {}): Promise<SetupCommandResult> {
		this.check();
		this.progress.command = { command, args };
		if (this.progress.phase === "allocation") this.progress.attempts.at(-1)!.command = this.progress.command;
		if (this.progress.phase === "hook") this.progress.attempts.find((attempt) => attempt.path === options.cwd)!.hookCommand = this.progress.command;
		const result = await runSetupCommand(command, args, {
			...options, signal: this.options.signal, deadlineAt: this.options.deadlineAt,
			onSpawn: (process) => { Object.assign(this.progress.command!, process); this.publish(); },
		});
		const { stdout: _stdout, stderr: _stderr, ...metadata } = result;
		this.progress.command.result = metadata;
		if (result.processTree?.state === "unknown") this.unknown(result.error ?? "Command tree settlement unverified");
		this.publish();
		if (result.error) throw result.error;
		return result;
	}
	async git(cwd: string, args: string[], acceptedExitCodes?: readonly number[]): Promise<SetupCommandResult> {
		return this.command("git", ["-C", cwd, ...args], { acceptedExitCodes });
	}
	async gitChecked(cwd: string, args: string[]): Promise<string> {
		const result = await this.git(cwd, args);
		return result.stdout;
	}
	attempt(index: number, branch: string, worktreePath?: string): void {
		this.check();
		this.progress.phase = "allocation";
		this.progress.command = undefined;
		this.progress.attempts.push({ index, branch, path: worktreePath, validated: false });
		this.publish();
	}
	validated(worktree: WorktreeInfo): void {
		this.progress.phase = "validated";
		Object.assign(this.progress.attempts.at(-1)!, { path: worktree.path, validated: true });
		this.progress.setup.worktrees.push(worktree);
		this.publish();
	}
}

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", windowsHide: true, shell: false, ...(env ? { env: { ...process.env, ...env } } : {}) });
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

/** Validate a captured patch against the worktree index without changing either. */
export function validateWorktreePatch(worktreePath: string, patchPath: string): string | undefined {
	const result = runGit(worktreePath, [...PATCH_VALIDATION_OPTIONS, patchPath]);
	if (result.status === 0) return undefined;
	return result.stderr.trim() || result.stdout.trim() || `git -C ${worktreePath} apply --check failed`;
}

function currentWorktreePatch(worktreePath: string, baseCommit: string): { patch: string } | { error: string } {
	assertWorktreeMutationAllowed();
	let tempDir: string;
	try {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-index-"));
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
	try {
		const readTree = runGit(worktreePath, ["read-tree", "HEAD"], env);
		if (readTree.status !== 0) return { error: readTree.stderr.trim() || readTree.stdout.trim() || "git read-tree failed" };
		const add = runGit(worktreePath, ["add", "-A"], env);
		if (add.status !== 0) return { error: add.stderr.trim() || add.stdout.trim() || "git add failed" };
		const diff = runGit(worktreePath, ["diff", "--cached", ...MACHINE_PATCH_OPTIONS, baseCommit], env);
		if (diff.status !== 0) return { error: diff.stderr.trim() || diff.stdout.trim() || "git diff failed" };
		return { patch: diff.stdout };
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Cleanup safety depends on preserving the worktree, not on best-effort temp-index deletion.
		}
	}
}

export function validateWorktreePatchRepresentsCurrentWorktree(worktreePath: string, baseCommit: string, patchPath: string): string | undefined {
	const validationError = validateWorktreePatch(worktreePath, patchPath);
	if (validationError) return validationError;
	let capturedPatch: string;
	try {
		capturedPatch = fs.readFileSync(patchPath, "utf-8");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const current = currentWorktreePatch(worktreePath, baseCommit);
	if ("error" in current) return current.error || "failed to capture current worktree patch";
	if (capturedPatch !== current.patch) return "captured handoff patch does not match current worktree changes";
	return undefined;
}

async function resolveRepoState(tx: SetupTransaction, cwd: string, requestedBaseRef: string | undefined): Promise<RepoState> {
	const repoCheck = await tx.git(cwd, ["rev-parse", "--is-inside-work-tree"], [0, 128]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") throw new Error("worktree isolation requires a git repository");
	const rawPrefix = (await tx.gitChecked(cwd, ["rev-parse", "--show-prefix"])).trim();
	const cwdRelative = rawPrefix ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";
	const toplevel = (await tx.gitChecked(cwd, ["rev-parse", "--show-toplevel"])).trim();

	// pi-subagents writes durable runtime state under .pi/subagents/ by default;
	// that state must not make managed isolation unusable for later runs.
	const status = await tx.gitChecked(toplevel, ["status", "--porcelain", "--", `:!${PROJECT_SUBAGENTS_RELATIVE_DIR}`]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseRef = normalizeWorktreeBaseRef(requestedBaseRef) ?? DEFAULT_WORKTREE_BASE_REF;
	let baseCommit: string;
	try {
		const base = await tx.git(toplevel, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], [0, 128]);
		if (base.status !== 0) throw new Error(base.stderr.trim() || "ref not found");
		baseCommit = base.stdout.trim();
	} catch (error) {
		throw new Error(`baseRef '${baseRef}' could not be resolved to a commit: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
	}
	if (!baseCommit) throw new Error(`baseRef '${baseRef}' could not be resolved to a commit`);
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	let existing = resolved;
	const missingSegments: string[] = [];
	while (true) {
		try {
			let realpath: string;
			try {
				realpath = fs.realpathSync.native(existing);
			} catch {
				realpath = fs.realpathSync(existing);
			}
			return path.join(realpath, ...missingSegments.reverse());
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
	if (!ref || ref === "@" || Buffer.byteLength(ref, "utf-8") > 1024 || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("..") || ref.includes("@{")) return false;
	if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(ref)) return false;
	if (/[[\]\\~^:?*\u0000-\u0020\u007f]/u.test(ref) || ref.endsWith(".") || ref.endsWith(".lock")) return false;
	return ref.split("/").every((component) => component.length > 0 && component !== "." && component !== ".." && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}

/** Normalize and validate a configured worktree base ref without resolving it. */
export function normalizeWorktreeBaseRef(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !validGitRef(value)) throw new Error("baseRef must be a valid Git ref: use HEAD or a supported named ref (for example, refs/heads/main). Full 40/64-character commit IDs and revision expressions are unsupported.");
	return value;
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

function runWorktrunk(args: string[], cwd?: string): WorktreeCommandResult {
	try {
		const result = spawnSync(WORKTRUNK_COMMAND, [...WORKTRUNK_ARG_PREFIX, ...args], {
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

async function resolveSetupProvider(tx: SetupTransaction, requested: WorktreeProvider | undefined, baseDir?: string): Promise<ManagedWorktreeProvider> {
	const selection = requested ?? DEFAULT_WORKTREE_PROVIDER;
	if (selection !== "auto" && selection !== "native" && selection !== "worktrunk") throw new Error('worktree provider must be "auto", "native", or "worktrunk"');
	if (selection === "native") return "native";
	if (hasConfiguredWorktreeBaseDir(baseDir)) {
		if (selection === "worktrunk") throw new Error("worktreeProvider='worktrunk' cannot be combined with worktreeBaseDir or PI_SUBAGENTS_WORKTREE_DIR");
		return "native";
	}
	let reason: string | undefined;
	try {
		const probeExitCodes = Array.from({ length: 256 }, (_, code) => code);
		const version = await tx.command(WORKTRUNK_COMMAND, [...WORKTRUNK_ARG_PREFIX, "--version"], { maxBuffer: WORKTREE_COMMAND_OUTPUT_MAX_BYTES, acceptedExitCodes: probeExitCodes });
		if (version.status !== 0 || !/\b(?:wt\s+)?v?(\d+\.\d+(?:\.\d+)?)\b/i.test(version.stdout.trim())) reason = "Worktrunk is unavailable or returned an invalid version";
		else {
			const help = await tx.command(WORKTRUNK_COMMAND, [...WORKTRUNK_ARG_PREFIX, "switch", "--help"], { maxBuffer: WORKTREE_COMMAND_OUTPUT_MAX_BYTES, acceptedExitCodes: probeExitCodes });
			const missing = ["--create", "--base", "--no-cd", "--no-hooks", "--format"].filter((flag) => !`${help.stdout}\n${help.stderr}`.includes(flag));
			if (help.status !== 0 || missing.length) reason = `Worktrunk switch capability unavailable: ${missing.join(", ")}`;
		}
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		reason = error.message;
	}
	if (!reason) return "worktrunk";
	if (selection === "worktrunk") throw new Error(`Worktrunk provider is unavailable: ${reason}`);
	return "native";
}

/** Whether a launch must bind its worktree-dependent paths after allocation. */
export function shouldDeferWorktreeCwd(requested: WorktreeProvider | undefined, baseDir?: string): boolean {
	return (requested ?? DEFAULT_WORKTREE_PROVIDER) !== "native" && !hasConfiguredWorktreeBaseDir(baseDir);
}

/**
 * Resolves the dedicated worktree root: the configured base directory or
 * PI_SUBAGENTS_WORKTREE_DIR when set, otherwise a `worktrees` folder sibling
 * to the repository. Managed leaves always nest one level deeper under the
 * project folder (`basename(repoRoot)`).
 */
function resolveWorktreeDedicatedRoot(configuredBaseDir: string | undefined, repoRoot: string): string {
	const rawBaseDir = configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR;
	let expanded: string;
	if (rawBaseDir === undefined || (configuredBaseDir === undefined && !rawBaseDir.trim())) {
		expanded = path.join(path.dirname(repoRoot), "worktrees");
	} else {
		const trimmed = rawBaseDir.trim();
		if (!trimmed) throw new Error("worktree base directory cannot be empty");

		const candidate = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
		expanded = path.isAbsolute(candidate) ? candidate : path.resolve(repoRoot, candidate);
	}
	const extensionsDir = normalizeComparableCwd(path.join(getAgentDir(), "extensions"));
	if (isPathInside(extensionsDir, normalizeComparableCwd(expanded))) {
		throw new Error(`worktree base directory cannot be inside Pi extensions directory: ${extensionsDir}. Choose a directory outside it.`);
	}
	return expanded;
}

function buildNativeProjectPath(dedicatedRoot: string, repoRoot: string): string {
	return path.join(dedicatedRoot, path.basename(repoRoot));
}

/**
 * Creates the project folder (parents included) so `git worktree add` can create
 * the leaf inside it. Must only run after `assertSafeWorktreeLocation` accepted
 * the planned leaf — an unsafe base must never be materialized on disk.
 */
function ensureProjectWorktreeDir(dedicatedRoot: string, repoRoot: string): void {
	try {
		fs.mkdirSync(buildNativeProjectPath(dedicatedRoot, repoRoot), { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to create worktree base directory ${dedicatedRoot}: ${message}`);
	}
}

function buildNativeWorktreePath(dedicatedRoot: string, repoRoot: string, runId: string, index: number): string {
	return path.join(buildNativeProjectPath(dedicatedRoot, repoRoot), `pi-worktree-${sanitizeWorktreePathComponent(runId, 120)}-${index}`);
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	if (!relative || relative === ".") return true;
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isStrictChildPath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return Boolean(relative) && relative !== "." && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Fail closed before `git worktree add`: reject unsafe planned/realpath locations. */
function assertSafeWorktreeLocation(worktreePath: string, repoRoot: string, dedicatedRoot: string): void {
	const resolvedLeaf = normalizeComparableCwd(worktreePath);
	const resolvedRepoRoot = normalizeComparableCwd(repoRoot);
	const projectDir = normalizeComparableCwd(buildNativeProjectPath(dedicatedRoot, repoRoot));
	const repoParent = normalizeComparableCwd(path.dirname(resolvedRepoRoot));
	const leafParent = normalizeComparableCwd(path.dirname(resolvedLeaf));
	const extensionsDir = normalizeComparableCwd(path.join(getAgentDir(), "extensions"));

	if (isPathInside(extensionsDir, projectDir) || isPathInside(extensionsDir, resolvedLeaf)) {
		throw new Error(`worktree path cannot be inside Pi extensions directory: ${extensionsDir}. Choose a directory outside it.`);
	}
	if (isPathInside(resolvedRepoRoot, resolvedLeaf)) {
		throw new Error(`worktree path would land inside the repository checkout: ${resolvedLeaf}`);
	}
	if (leafParent === repoParent) {
		throw new Error(`worktree path would be a direct child of the repository parent: ${resolvedLeaf}`);
	}
	if (!isStrictChildPath(projectDir, resolvedLeaf)) {
		throw new Error(`worktree path must be a strict child of the project worktree directory ${projectDir}: ${resolvedLeaf}`);
	}
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
	const dedicatedRoot = resolveWorktreeDedicatedRoot(baseDir, repoRoot);
	const worktreePath = buildNativeWorktreePath(dedicatedRoot, repoRoot, runId, index);
	assertSafeWorktreeLocation(worktreePath, repoRoot, dedicatedRoot);
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

async function runWorktreeSetupHook(
	tx: SetupTransaction,
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
): Promise<string[]> {
	tx.progress.phase = "hook";
	let result: SetupCommandResult;
	try {
		result = await tx.command(hook.hookPath, [], {
			cwd: input.worktreePath,
			input: JSON.stringify(input),
			hookTimeoutMs: hook.timeoutMs,
		});
	} catch (error) {
		throw new Error(`worktree setup hook failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	tx.progress.phase = "hook-validation";

	try {
		const output = parseWorktreeSetupHookOutput(result.stdout);
		if (output.syntheticPaths === undefined) return [];
		if (!Array.isArray(output.syntheticPaths)) {
			throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
		}
		const uniquePaths = new Set<string>();
		for (const candidate of output.syntheticPaths) {
			if (typeof candidate !== "string") throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
			const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
			if ((await tx.gitChecked(input.worktreePath, ["ls-files", "--", normalizedPath])).trim()) {
				throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
			}
			uniquePaths.add(normalizedPath);
		}
		return [...uniquePaths];
	} catch (error) {
		// Semantic rejection occurs after exit: retain uncertainty, never signal an old PID.
		tx.unknown(error);
		throw error;
	}
}

async function finalizeCreatedWorktree(
	tx: SetupTransaction,
	toplevel: string,
	cwdRelative: string,
	runId: string,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	worktree: WorktreeInfo,
): Promise<WorktreeInfo> {
	const agentCwd = cwdRelative ? path.join(worktree.path, cwdRelative) : worktree.path;
	tx.check();
	const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktree.path);
	const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];
	if (setupHook) {
		const hookSyntheticPaths = await runWorktreeSetupHook(tx, setupHook, {
			version: 1, repoRoot: toplevel, worktreePath: worktree.path, agentCwd,
			branch: worktree.branch, index: worktree.index, runId, baseCommit, agent,
		});
		syntheticPaths.push(...hookSyntheticPaths);
	}
	return { ...worktree, agentCwd, nodeModulesLinked, syntheticPaths };
}

async function createNativeWorktree(
	tx: SetupTransaction,
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	dedicatedRoot: string,
	labels: Array<string | undefined> | undefined,
	tasks: Array<string | undefined> | undefined,
	branchPrefix: string | undefined,
): Promise<WorktreeInfo> {
	const naming = buildWorktreeNaming({ runId, index, agent, label: labels?.[index], task: tasks?.[index], branchPrefix });
	const worktreePath = buildNativeWorktreePath(dedicatedRoot, toplevel, runId, index);
	assertSafeWorktreeLocation(worktreePath, toplevel, dedicatedRoot);
	// Absence is required before claiming any partial artifacts from this attempt.
	const branch = await tx.git(toplevel, ["show-ref", "--verify", "--quiet", `refs/heads/${naming.requestedBranch}`], [0, 1]);
	let pathExists = false;
	try { fs.lstatSync(worktreePath); pathExists = true; }
	catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
	if (branch.status !== 1 || pathExists) throw new Error(`worktree path or branch already exists: ${worktreePath}, ${naming.requestedBranch}`);
	tx.attempt(index, naming.requestedBranch, worktreePath);
	ensureProjectWorktreeDir(dedicatedRoot, toplevel);
	await tx.git(toplevel, ["worktree", "add", worktreePath, "-b", naming.requestedBranch, baseCommit]);
	const worktree: WorktreeInfo = {
		path: worktreePath,
		agentCwd: worktreePath,
		branch: naming.requestedBranch,
		index,
		nodeModulesLinked: false,
		syntheticPaths: [],
		provider: "native",
		naming,
	};
	tx.validated(worktree);
	return finalizeCreatedWorktree(tx, toplevel, cwdRelative, runId, baseCommit, setupHook, agent, worktree);
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

async function createWorktrunkWorktree(
	tx: SetupTransaction,
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	agents: string[] | undefined,
	labels: Array<string | undefined> | undefined,
	tasks: Array<string | undefined> | undefined,
	branchPrefix: string | undefined,
): Promise<WorktreeInfo> {
	const naming = buildWorktreeNaming({ runId, index, agent: agents?.[index], label: labels?.[index], task: tasks?.[index], branchPrefix });
	const args = ["-C", toplevel, "switch", "--create", naming.requestedBranch, "--base", baseCommit, "--no-cd", "--no-hooks", "--format", "json"];
	tx.attempt(index, naming.requestedBranch);
	const result = await tx.command(WORKTRUNK_COMMAND, [...WORKTRUNK_ARG_PREFIX, ...args], { cwd: toplevel, maxBuffer: WORKTREE_COMMAND_OUTPUT_MAX_BYTES });
	tx.progress.phase = "validation";
	try {
		const output = parseWorktrunkSwitchOutput(result.stdout);
		if (output.action !== "created" || output.created_branch !== true || output.branch !== naming.requestedBranch || output.base_branch !== baseCommit) {
			throw new Error("Worktrunk provisioning returned inconsistent creation metadata");
		}
		if (typeof output.path !== "string" || !path.isAbsolute(output.path)) throw new Error("Worktrunk provisioning returned a non-absolute worktree path");
		const worktreePathCandidate = path.resolve(output.path);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(worktreePathCandidate);
		} catch (error) {
			throw new Error(`Worktrunk provisioning returned a missing worktree path: ${worktreePathCandidate}`, { cause: error instanceof Error ? error : undefined });
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Worktrunk provisioning returned a path that is not a real directory");
		const worktreePath = normalizeComparableCwd(worktreePathCandidate);
		if (worktreePath === normalizeComparableCwd(toplevel)) throw new Error("Worktrunk provisioning returned the source checkout path");
		const sourceCommonDirRaw = (await tx.gitChecked(toplevel, ["rev-parse", "--git-common-dir"])).trim();
		const returnedCommonDirRaw = (await tx.gitChecked(worktreePath, ["rev-parse", "--git-common-dir"])).trim();
		const sourceCommonDir = normalizeComparableCwd(path.isAbsolute(sourceCommonDirRaw) ? sourceCommonDirRaw : path.resolve(toplevel, sourceCommonDirRaw));
		const returnedCommonDir = normalizeComparableCwd(path.isAbsolute(returnedCommonDirRaw) ? returnedCommonDirRaw : path.resolve(worktreePath, returnedCommonDirRaw));
		if (returnedCommonDir !== sourceCommonDir) throw new Error("Worktrunk provisioning returned a worktree for a different repository");
		const returnedBranch = (await tx.gitChecked(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
		if (returnedBranch !== naming.requestedBranch) throw new Error("Worktrunk provisioning returned a worktree on a different branch");
		const returnedHead = (await tx.gitChecked(worktreePath, ["rev-parse", "HEAD"])).trim();
		if (returnedHead !== baseCommit) throw new Error("Worktrunk provisioning returned a worktree at a different base commit");
		const worktree: WorktreeInfo = {
			path: worktreePath,
			agentCwd: cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath,
			branch: naming.requestedBranch,
			index,
			nodeModulesLinked: false,
			syntheticPaths: [],
			provider: "worktrunk",
			naming,
		};
		tx.validated(worktree);
		return worktree;
	} catch (error) {
		tx.unknown(error);
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	assertWorktreeMutationAllowed();
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
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", ...MACHINE_DIFF_OPTIONS, "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(worktree.path, ["diff", "--cached", ...MACHINE_PATCH_OPTIONS, setup.baseCommit]);
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", ...MACHINE_DIFF_OPTIONS, "--numstat", setup.baseCommit]);
	fs.writeFileSync(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}

	const validationError = validateWorktreePatch(worktree.path, patchPath);
	if (validationError) throw new Error(`captured worktree patch is not machine-applyable: ${validationError}`);

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
		const baseDiff = runGit(worktree.path, ["diff", "--quiet", ...MACHINE_DIFF_OPTIONS, setup.baseCommit, "--"]);
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
			let patchValidationError: string | undefined;
			let patchCaptured = false;
			if (captured !== undefined
				&& captured.error === undefined
				&& fs.existsSync(captured.patchPath)
				&& handoffRecordsPatch(intent.handoffManifestPath, captured.patchPath)) {
				try {
					if (fs.statSync(captured.patchPath).size > 0) {
						patchValidationError = validateWorktreePatchRepresentsCurrentWorktree(worktree.path, setup.baseCommit, captured.patchPath);
						patchCaptured = patchValidationError === undefined;
					}
				} catch (error) {
					patchValidationError = error instanceof Error ? error.message : String(error);
				}
			}
			if (!patchCaptured) {
				const reason = patchValidationError
					? `captured handoff patch failed validation: ${patchValidationError}`
					: "worktree contains changes that are not represented by a captured handoff patch";
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

async function compensateSetup(tx: SetupTransaction): Promise<WorktreeCleanupReport> {
	const { setup, attempts } = tx.progress;
	const report: WorktreeCleanupReport = { state: "partial", tasks: [], pruned: false, errors: [] };
	tx.progress.cleanup = report;
	tx.progress.phase = "rollback";
	// Cancellation stops allocation, not accounting. Compensation has ONLY the
	// remaining original absolute deadline; it does not reuse the launch signal.
	const git = async (args: string[], acceptedExitCodes: readonly number[] = [0]) => {
		if (setupPoison) throw new Error(setupPoison);
		tx.progress.command = { command: "git", args: ["-C", setup.cwd, ...args] };
		const result = await runSetupCommand("git", tx.progress.command.args, {
			deadlineAt: tx.options.deadlineAt, acceptedExitCodes,
			onSpawn: (process) => { Object.assign(tx.progress.command!, process); tx.publish(); },
		});
		const { stdout: _stdout, stderr: _stderr, ...metadata } = result;
		tx.progress.command.result = metadata;
		if (result.processTree?.state === "unknown") tx.unknown(result.error ?? "Rollback command settlement unverified");
		tx.publish();
		if (result.error || result.status === null || !acceptedExitCodes.includes(result.status)) throw result.error ?? new Error(result.stderr.trim() || "Rollback command failed");
		return result;
	};
	for (const attempt of [...attempts].reverse()) {
		if (!attempt.path) {
			tx.unknown(`Allocation path unconfirmed for branch ${attempt.branch}`);
			report.errors!.push(tx.progress.unknown!);
			continue;
		}
		const known = setup.worktrees.find((worktree) => worktree.index === attempt.index);
		const task: WorktreeCleanupTask = { index: attempt.index, path: attempt.path, branch: attempt.branch,
			provider: known?.provider ?? "native", naming: known?.naming, worktreeRemoved: false, branchRemoved: false };
		report.tasks.push(task);
		try {
			if (normalizeComparableCwd(attempt.path) === normalizeComparableCwd(setup.cwd)) throw new Error("Refusing source-checkout removal");
			if (attempt.validated) {
				await git(["worktree", "remove", "--force", attempt.path]);
				task.worktreeRemoved = true;
			} else {
				// Native attempts were absent before mutation. Reconcile only exact
				// registered path/branch identity; never recursively delete a guessed leaf.
				const listed = (await git(["worktree", "list", "--porcelain"])).stdout;
				const entry = listed.split("\n\n").find((block) => block.split("\n").includes(`worktree ${attempt.path}`));
				if (entry) {
					if (!entry.split("\n").includes(`branch refs/heads/${attempt.branch}`)) {
						tx.unknown("Partial allocation ownership mismatch");
						throw new Error(tx.progress.unknown);
					}
					await git(["worktree", "remove", "--force", attempt.path]);
				} else if (fs.existsSync(attempt.path)) {
					tx.unknown("Unregistered partial allocation retained");
					throw new Error(tx.progress.unknown);
				}
				task.worktreeRemoved = true;
			}
			const branch = await git(["show-ref", "--verify", "--quiet", `refs/heads/${attempt.branch}`], [0, 1]);
			if (branch.status === 0) await git(["branch", "-D", attempt.branch]);
			task.branchRemoved = true;
		} catch (error) {
			task.preserved = true;
			task.errors = [error instanceof Error ? error.message : String(error)];
		}
	}
	try {
		if (attempts.length > 0) { await git(["worktree", "prune"]); report.pruned = true; }
	} catch (error) { report.errors!.push(error instanceof Error ? error.message : String(error)); }
	if (tx.progress.unknown) report.errors!.push(tx.progress.unknown);
	report.tasks.sort((a, b) => a.index - b.index);
	if (!setupPoison && (report.pruned || attempts.length === 0) && report.tasks.every((task) => task.worktreeRemoved && task.branchRemoved) && !report.errors!.length) report.state = "complete";
	return report;
}

async function allocateWorktrees(tx: SetupTransaction, cwd: string, runId: string, count: number): Promise<WorktreeSetup> {
	const options = tx.options;
	tx.check();
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("worktree count must be a non-negative integer");
	const repo = await resolveRepoState(tx, cwd, options?.baseRef);
	tx.progress.setup.cwd = repo.toplevel;
	tx.progress.setup.baseCommit = repo.baseCommit;
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const provider = await resolveSetupProvider(tx, options?.provider, options?.baseDir);
	const branchPrefix = normalizeWorktreeBranchPrefix(options?.branchPrefix);
	const dedicatedRoot = provider === "native" ? resolveWorktreeDedicatedRoot(options?.baseDir, repo.toplevel) : undefined;
	const worktrees = tx.progress.setup.worktrees;

	try {
		if (provider === "native") {
			for (let index = 0; index < count; index++) {
				worktrees[index] = await createNativeWorktree(
					tx,
					repo.toplevel,
					repo.cwdRelative,
					runId,
					index,
					repo.baseCommit,
					setupHook,
					options?.agents?.[index],
					dedicatedRoot!,
					options?.labels,
					options?.tasks,
					branchPrefix,
				);
			}
		} else {
			for (let index = 0; index < count; index++) {
				await createWorktrunkWorktree(
					tx,
					repo.toplevel,
					repo.cwdRelative,
					runId,
					index,
					repo.baseCommit,
					options?.agents,
					options?.labels,
					options?.tasks,
					branchPrefix,
				);
			}
			for (let index = 0; index < worktrees.length; index++) {
				worktrees[index] = await finalizeCreatedWorktree(
					tx,
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
		tx.check();
		tx.progress.phase = "ready";
		tx.publish();
		tx.check();
		return tx.progress.setup;
	} catch (error) {
		await compensateSetup(tx);
		throw error;
	}
}

export async function createWorktrees(cwd: string, runId: string, count: number, options: CreateWorktreesOptions = {}): Promise<WorktreeSetup> {
	const tx = new SetupTransaction(cwd, options);
	try {
		return await withWorktreeTransaction(async () => {
			setupActive = true;
			try { return await allocateWorktrees(tx, cwd, runId, count); }
			finally { setupActive = false; }
		});
	} catch (error) {
		if (setupPoison) tx.progress.unknown ??= setupPoison;
		tx.progress.cleanup ??= { state: tx.progress.unknown ? "partial" : "complete", tasks: [], pruned: false, errors: tx.progress.unknown ? [tx.progress.unknown] : [] };
		try { tx.publish(); } catch (publicationError) {
			tx.progress.cleanup?.errors?.push(`Recovery publication failed: ${String(publicationError)}`);
		}
		throw new WorktreeSetupError(error, tx.snapshot());
	}
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	assertWorktreeMutationAllowed();
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
	assertWorktreeMutationAllowed();
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
