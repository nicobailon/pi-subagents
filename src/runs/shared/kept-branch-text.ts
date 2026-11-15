export interface KeptBranch {
	branch: string;
	tip: string;
}

const KEPT_BRANCH_LINE = /^Kept branch (\S+) at ([0-9a-f]+): its commits are on no other branch\.$/;

/** Kept branches from a saved handoff reference, which is read back from disk. */
export function readKeptBranches(value: unknown): KeptBranch[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is KeptBranch => typeof entry?.branch === "string" && typeof entry?.tip === "string");
}

export function formatKeptBranchLines(keptBranches: readonly KeptBranch[]): string[] {
	return keptBranches.map(({ branch, tip }) => `Kept branch ${branch} at ${tip.slice(0, 12)}: its commits are on no other branch.`);
}

/** Reads the kept-branch lines at the start of `lines`, stopping at the first other line. */
export function parseKeptBranchLines(lines: string[]): KeptBranch[] {
	const kept: KeptBranch[] = [];
	for (const line of lines) {
		const match = line.match(KEPT_BRANCH_LINE);
		if (!match) break;
		kept.push({ branch: match[1]!, tip: match[2]! });
	}
	return kept;
}
