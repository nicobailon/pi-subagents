import type { ParallelHandoffReference } from "../../shared/types.ts";

export type KeptBranch = NonNullable<ParallelHandoffReference["keptBranches"]>[number];

const KEPT_BRANCH_LINE = /^Kept branch (\S+) at ([0-9a-f]+): its commits are on no other branch\.$/;

/** Kept branches from a saved handoff reference, which is read back from disk. */
export function readKeptBranches(value: unknown): KeptBranch[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is KeptBranch => typeof entry?.branch === "string" && typeof entry?.tip === "string");
}

export function formatKeptBranchLines(keptBranches: readonly KeptBranch[]): string[] {
	return keptBranches.map(({ branch, tip }) => `Kept branch ${branch} at ${tip.slice(0, 12)}: its commits are on no other branch.`);
}

/** The kept-branch lines follow the handoff line directly: `parseKeptBranchLines` reads them back from there. */
export function formatParallelHandoffLines(handoffPath: string, keptBranches: unknown): string[] {
	return [`Parallel handoff: ${handoffPath}`, ...formatKeptBranchLines(readKeptBranches(keptBranches))];
}

export function parseKeptBranchLines(lines: string[]): KeptBranch[] {
	const kept: KeptBranch[] = [];
	for (const line of lines) {
		const match = line.match(KEPT_BRANCH_LINE);
		if (!match) break;
		kept.push({ branch: match[1]!, tip: match[2]! });
	}
	return kept;
}
