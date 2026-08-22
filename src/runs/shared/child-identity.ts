import type { AsyncStatus } from "../../shared/types.ts";

export type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];

export interface ResolvedAsyncStatusChild {
	index: number;
	step: AsyncStatusStep;
	id: string;
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

export function resolveAsyncStatusChild(status: Pick<AsyncStatus, "runId" | "steps">, childId: string): AsyncStatusChildResolution {
	const matches: ResolvedAsyncStatusChild[] = [];
	for (const [index, step] of (status.steps ?? []).entries()) {
		if (!asyncStatusChildIdentityCandidates(step, index).includes(childId)) continue;
		matches.push({ index, step, id: asyncStatusChildIdentity(step, index) });
	}
	if (matches.length === 1) return { ok: true, child: matches[0]! };
	if (matches.length > 1) return { ok: false, code: "ambiguous", message: `Child '${childId}' is ambiguous under async run '${status.runId}'.` };
	return { ok: false, code: "not_found", message: `Child '${childId}' was not found under async run '${status.runId}'.` };
}

export function isStoppableAsyncStatusStep(step: AsyncStatusStep): boolean {
	return step.status === "pending" || step.status === "running";
}
