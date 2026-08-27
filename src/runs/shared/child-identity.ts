import type { AsyncStatus, NestedRunSummary } from "../../shared/types.ts";

export type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];

export interface ResolvedAsyncStatusChild {
	index: number;
	step: AsyncStatusStep;
	id: string;
	nested?: NestedRunSummary;
}

export type AsyncStatusChildResolution =
	| { ok: true; child: ResolvedAsyncStatusChild }
	| { ok: false; code: "not_found" | "ambiguous"; message: string };

export function asyncStatusChildIdentity(step: AsyncStatusStep, index: number): string {
	return step.workflowKey ?? step.runId ?? `step:${index}`;
}

export function asyncStatusChildIdentityCandidates(step: AsyncStatusStep, index: number): string[] {
	return [...new Set([step.workflowKey, step.runId, `step:${index}`].filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export function resolveAsyncStatusChild(
	status: Pick<AsyncStatus, "runId" | "steps">,
	childId: string,
	options: { includeNested?: boolean } = {},
): AsyncStatusChildResolution {
	const matches: ResolvedAsyncStatusChild[] = [];
	for (const [index, step] of (status.steps ?? []).entries()) {
		if (asyncStatusChildIdentityCandidates(step, index).includes(childId)) {
			matches.push({ index, step, id: asyncStatusChildIdentity(step, index) });
		}
		if (options.includeNested) {
			const findNested = (children: readonly NestedRunSummary[] | undefined): void => {
				for (const nested of children ?? []) {
					if (nested.id === childId) matches.push({ index, step, id: nested.id, nested });
					findNested(nested.children);
				}
			};
			findNested(step.children);
		}
	}
	if (matches.length === 1) return { ok: true, child: matches[0]! };
	if (matches.length > 1) return { ok: false, code: "ambiguous", message: `Child '${childId}' is ambiguous under async run '${status.runId}'.` };
	return { ok: false, code: "not_found", message: `Child '${childId}' was not found under async run '${status.runId}'.` };
}

export function isStoppableAsyncStatusStep(step: AsyncStatusStep): boolean {
	return step.status === "pending" || step.status === "running";
}
