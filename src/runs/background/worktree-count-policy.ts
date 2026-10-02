import { buildWorktreeCleanupPlan, createWorktreeCleanupPlan, listOwnedWorktreeInventory, type BuildWorktreeCleanupPlanInput } from "../shared/worktree-cleanup-plan.ts";
import { applyReviewedCleanupPlan } from "../shared/worktree-cleanup-apply.ts";

export type WorktreeCountReport = {
	repoRoot: string; countExact: boolean; limit: number; before: number; retained: number;
	state: "below-limit" | "cleaned" | "protected" | "deferred";
	warnings: string[]; removed: number; receiptPath?: string;
};

/** Run in the maintenance worker; the parent never executes the synchronous Git checks. */
export async function enforceWorktreeRetainCount(input: BuildWorktreeCleanupPlanInput & { limit: number; authorized: boolean; signal?: AbortSignal }): Promise<WorktreeCountReport> {
	if (!input.authorized) throw new Error("Automatic worktree cleanup requires discardWorktree auto authorization.");
	if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("worktreeRetainCount must be a positive safe integer.");
	input.signal?.throwIfAborted();
	const inventory = listOwnedWorktreeInventory(input);
	const report: WorktreeCountReport = { repoRoot: inventory.repoRoot, countExact: inventory.warnings.length === 0, limit: input.limit, before: inventory.owned.length, retained: inventory.owned.length, removed: 0, state: "below-limit", warnings: [...inventory.warnings] };
	if (inventory.warnings.length) { report.state = "deferred"; return report; }
	const excess = inventory.owned.length - input.limit;
	if (excess <= 0) return report;
	const candidates: string[] = [];
	for (const tree of inventory.owned) {
		input.signal?.throwIfAborted();
		const plan = buildWorktreeCleanupPlan({ ...input, handoffPaths: inventory.owned.map((item) => item.handoffPath), candidatePaths: [tree.path] });
		const entry = plan.entries.find((item) => item.path === tree.path);
		if (entry?.decision === "remove") candidates.push(tree.path);
		else report.warnings.push(`${tree.path}: ${entry?.reasons.join("; ") || "ownership is not provable"}`);
		if (candidates.length >= excess) break;
	}
	if (candidates.length === 0) { report.state = "protected"; return report; }
	input.signal?.throwIfAborted();
	const created = createWorktreeCleanupPlan({ ...input, handoffPaths: inventory.owned.map((item) => item.handoffPath), candidatePaths: candidates });
	const applied = await applyReviewedCleanupPlan({ repo: inventory.repoRoot, planId: created.plan.planId, authorized: true, signal: input.signal, foregroundRunOwnership: input.foregroundRunOwnership,
		select: () => {
			const current = listOwnedWorktreeInventory(input);
			if (current.warnings.length) return new Set<string>();
			const currentExcess = Math.max(0, current.owned.length - input.limit);
			const stillOwned = new Set(current.owned.map((item) => item.path));
			return new Set(candidates.filter((candidate) => stillOwned.has(candidate)).slice(0, currentExcess));
		},
	});
	report.receiptPath = applied.receiptPath;
	report.removed = applied.receipt.entries.filter((entry) => entry.state === "removed").length;
	const remaining = listOwnedWorktreeInventory(input);
	report.retained = remaining.owned.length;
	report.countExact = remaining.warnings.length === 0;
	report.warnings.push(...remaining.warnings);
	report.state = report.countExact ? (report.retained <= input.limit ? "cleaned" : "protected") : "deferred";
	for (const entry of applied.receipt.entries.filter((entry) => entry.state !== "removed")) report.warnings.push(`${entry.path}: ${entry.reason}`);
	if (applied.receipt.error) report.warnings.push(applied.receipt.error);
	return report;
}
