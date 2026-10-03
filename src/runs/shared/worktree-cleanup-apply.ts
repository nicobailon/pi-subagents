import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { readParallelHandoffManifest } from "./parallel-handoff.ts";
import { buildWorktreeCleanupPlan, isRegisteredCleanupWorktree, resolveCleanupRepoRoot, samePath, worktreeCleanupContentPayload, worktreeCleanupPlanPath, WORKTREE_CLEANUP_PLAN_TTL_MS, type BuildWorktreeCleanupPlanInput, type WorktreeCleanupPlan, type WorktreeCleanupPlanEntry } from "./worktree-cleanup-plan.ts";
import { withHandoffWriteLock, withRepositoryWorktreeLock } from "./worktree-lock.ts";
import { withWorktreeTransaction } from "./worktree.ts";

export type CleanupReceipt = {
	version: 1; planId: string; repoRoot: string; contentHash: string;
	state: "applying" | "complete" | "partial";
	startedAt: number; completedAt?: number; error?: string;
	entries: Array<{ path: string; branch: string; state: "removing" | "removed" | "kept" | "failed"; reason: string }>;
};

function assertContainedRealPath(repoRoot: string, candidate: string, create = false): void {
	const relative = path.relative(repoRoot, candidate);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Cleanup evidence must be inside the selected repository.");
	let current = repoRoot;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		if (!fs.existsSync(current) && create) fs.mkdirSync(current, { mode: 0o700 });
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error(`Cleanup evidence cannot use a symlink: ${current}`);
	}
}

export function loadReviewedCleanupPlan(repo: string, planId: string, now = Date.now()): WorktreeCleanupPlan {
	const repoRoot = resolveCleanupRepoRoot(repo);
	const file = worktreeCleanupPlanPath(repoRoot, planId);
	assertContainedRealPath(repoRoot, file);
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Cleanup plan is not a bounded regular file.");
	const plan = JSON.parse(fs.readFileSync(file, "utf-8")) as WorktreeCleanupPlan;
	if (plan.version !== 1 || plan.planId !== planId || plan.repoRoot !== repoRoot || !Number.isFinite(plan.createdAt) || !Number.isFinite(plan.expiresAt) || plan.createdAt > now || (plan.expiresAt <= now && !fs.existsSync(file.replace(/\.json$/, ".claim"))) || plan.expiresAt - plan.createdAt !== WORKTREE_CLEANUP_PLAN_TTL_MS) throw new Error("Cleanup plan is invalid, expired, or belongs to another repository.");
	if (!Array.isArray(plan.entries) || plan.entries.length > 512 || !Array.isArray(plan.baseDirs) || plan.baseDirs.length !== 1 || !plan.baseDirs.every((item) => typeof item === "string" && path.isAbsolute(item)) || !Array.isArray(plan.metadataPaths) || !plan.metadataPaths.every((item) => typeof item === "string" && path.isAbsolute(item)) || !Array.isArray(plan.pruneCandidates)) throw new Error("Cleanup plan has invalid inventory fields.");
	const paths = new Set<string>();
	for (const entry of plan.entries) {
		if (!entry || typeof entry.path !== "string" || !path.isAbsolute(entry.path) || typeof entry.branch !== "string" || !["remove", "keep", "unknown"].includes(entry.decision) || !entry.preconditions || entry.preconditions.path !== entry.path || entry.preconditions.branch !== entry.branch || !Array.isArray(entry.reasons) || !entry.reasons.every((reason) => typeof reason === "string") || paths.has(entry.path)) throw new Error("Cleanup plan has invalid or duplicate entries.");
		paths.add(entry.path);
	}
	const hash = createHash("sha256").update(JSON.stringify(worktreeCleanupContentPayload(plan))).digest("hex");
	if (plan.contentHash !== hash) throw new Error("Cleanup plan content hash does not match; create and review a fresh plan.");
	return plan;
}

function recordRemoval(entry: WorktreeCleanupPlanEntry): void {
	const manifest = readParallelHandoffManifest(entry.handoffPath!);
	if (!manifest || manifest.runId !== entry.runId) throw new Error("Handoff ownership changed before recording removal.");
	const tasks = manifest.groups.flatMap((group) => group.cleanup.tasks).filter((task) => task.index === entry.taskIndex && samePath(path.resolve(path.dirname(entry.handoffPath!), task.path), entry.path) && task.branch === entry.branch);
	if (tasks.length !== 1) throw new Error("Handoff task no longer identifies exactly one removed worktree.");
	if (tasks[0]!.worktreeRemoved) return;
	tasks[0]!.worktreeRemoved = true;
	tasks[0]!.branchRemoved = false;
	tasks[0]!.preserved = true;
	tasks[0]!.reason = "reviewed cleanup removed worktree; local branch retained";
	manifest.updatedAt = Date.now();
	writePrivateAtomicJson(entry.handoffPath!, manifest);
}

export async function applyReviewedCleanupPlan(input: {
	repo: string; planId: string; authorized: boolean; signal?: AbortSignal;
	foregroundRunOwnership?: BuildWorktreeCleanupPlanInput["foregroundRunOwnership"];
	/** Internal retention seam: shrink the reviewed batch while holding the repository lock. */
	select?: (plan: WorktreeCleanupPlan) => Set<string>;
}): Promise<{ receipt: CleanupReceipt; receiptPath: string; reused: boolean }> {
	if (!input.authorized) throw new Error("Worktree cleanup requires discardWorktree authorization.");
	return withWorktreeTransaction(() => withRepositoryWorktreeLock(input.repo, async () => {
		const plan = loadReviewedCleanupPlan(input.repo, input.planId);
		const claimPath = worktreeCleanupPlanPath(plan.repoRoot, plan.planId).replace(/\.json$/, ".claim");
		const receiptPath = path.join(claimPath, "receipt.json");
		assertContainedRealPath(plan.repoRoot, path.dirname(claimPath));
		try { fs.mkdirSync(claimPath, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			assertContainedRealPath(plan.repoRoot, receiptPath);
			// A claimed plan is never destructively replayed, even after interruption.
			const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8")) as CleanupReceipt;
			if (receipt.version !== 1 || receipt.planId !== plan.planId || receipt.repoRoot !== plan.repoRoot || receipt.contentHash !== plan.contentHash || !Array.isArray(receipt.entries) || !["applying", "complete", "partial"].includes(receipt.state)) throw new Error("Claimed cleanup plan has an invalid receipt; inspect it before creating a fresh plan.");
			// Reconcile only a journaled attempt whose directory and Git registration
			// are both gone. A recreated path is never changed or removed on replay.
			for (const entry of plan.entries.filter((entry) => receipt.state !== "complete" && entry.decision === "remove" && receipt.entries.some((item) => (item?.state === "removing" || item?.state === "removed") && item.path === entry.path && item.branch === entry.branch))) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				input.signal?.throwIfAborted();
				try { fs.lstatSync(entry.path); continue; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				if (!isRegisteredCleanupWorktree(plan.repoRoot, entry.path) && entry.handoffPath) {
					const item = receipt.entries.find((item) => item.path === entry.path && item.branch === entry.branch)!;
					if (item.state === "removing") {
						item.state = "removed";
						item.reason = "interrupted removal reconciled; local branch retained";
						writePrivateAtomicJson(receiptPath, receipt);
					}
					withHandoffWriteLock(entry.handoffPath, () => recordRemoval(entry));
				}
			}
			return { receipt, receiptPath, reused: true };
		}
		const receipt: CleanupReceipt = { version: 1, planId: plan.planId, repoRoot: plan.repoRoot, contentHash: plan.contentHash, state: "applying", startedAt: Date.now(), entries: [] };
		writePrivateAtomicJson(receiptPath, receipt);
		try {
			const selected = input.select?.(plan);
			for (const entry of plan.entries.filter((item) => item.decision === "remove")) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				input.signal?.throwIfAborted();
				if (selected && !selected.has(entry.path)) {
					receipt.entries.push({ path: entry.path, branch: entry.branch, state: "kept", reason: "outside the current retention excess" });
				} else {
					try {
						if (!entry.handoffPath) throw new Error("Reviewed entry has no handoff ownership.");
						withHandoffWriteLock(entry.handoffPath, () => {
							const manifest = readParallelHandoffManifest(entry.handoffPath!);
							if (!manifest || manifest.runId !== entry.runId) throw new Error("Handoff ownership changed before cleanup validation.");
							const fresh = buildWorktreeCleanupPlan({ repo: plan.repoRoot, candidatePaths: [entry.path], handoffPaths: plan.metadataPaths, worktreeBaseDir: path.dirname(plan.baseDirs[0]!), foregroundRunOwnership: input.foregroundRunOwnership });
							const candidate = fresh.entries.find((item) => item.path === entry.path);
							if (fresh.warnings?.some((warning) => /capped|failed to inspect/.test(warning)) || !candidate || candidate.decision !== "remove" || candidate.handoffPath !== entry.handoffPath || candidate.runId !== entry.runId || candidate.taskIndex !== entry.taskIndex || candidate.patchPath !== entry.patchPath || JSON.stringify(candidate.preconditions) !== JSON.stringify(entry.preconditions)) {
								receipt.entries.push({ path: entry.path, branch: entry.branch, state: "kept", reason: candidate?.reasons.join("; ") || "reviewed ownership or Git facts changed" });
								return;
							}
							input.signal?.throwIfAborted();
							const journalEntry: CleanupReceipt["entries"][number] = { path: entry.path, branch: entry.branch, state: "removing", reason: "removal prepared; outcome not yet recorded" };
							receipt.entries.push(journalEntry);
							writePrivateAtomicJson(receiptPath, receipt); // Admit the attempt before Git can remove anything.
							const removed = spawnSync("git", ["-C", plan.repoRoot, "worktree", "remove", "--", entry.path], { encoding: "utf-8", windowsHide: true });
							if (removed.status !== 0) throw new Error(removed.error?.message || removed.stderr.trim() || "git worktree remove failed");
							journalEntry.state = "removed";
							journalEntry.reason = "worktree removed; local branch retained";
							writePrivateAtomicJson(receiptPath, receipt); // Evidence precedes secondary manifest bookkeeping.
							recordRemoval(entry);
						});
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						const removed = receipt.entries.find((item) => item.path === entry.path && item.state === "removed");
						if (removed) { removed.reason += `; removal bookkeeping failed: ${reason}`; receipt.error = reason; }
						else {
							const pending = receipt.entries.find((item) => item.path === entry.path && item.state === "removing");
							if (pending) { pending.reason += `; operation failed: ${reason}`; receipt.error = reason; }
							else receipt.entries.push({ path: entry.path, branch: entry.branch, state: "failed", reason });
						}
					}
				}
				writePrivateAtomicJson(receiptPath, receipt);
			}
			receipt.state = !receipt.error && receipt.entries.every((entry) => entry.state === "removed") ? "complete" : "partial";
		} catch (error) {
			receipt.state = "partial";
			receipt.error = error instanceof Error ? error.message : String(error);
		}
		receipt.completedAt = Date.now();
		writePrivateAtomicJson(receiptPath, receipt);
		return { receipt, receiptPath, reused: false };
	}, { signal: input.signal }));
}

export function formatCleanupReceipt(result: { receipt: CleanupReceipt; receiptPath: string; reused: boolean }): string {
	const { receipt } = result;
	return [`Worktree cleanup ${receipt.planId}: ${receipt.state}${result.reused ? " (previous receipt; plan not replayed)" : ""}`, "Local branches retained.", ...receipt.entries.map((entry) => `- ${entry.path}: ${entry.state}; ${entry.reason}`), ...(receipt.error ? [receipt.error] : []), `Receipt: ${result.receiptPath}`].join("\n");
}
