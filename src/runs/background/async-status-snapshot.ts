import type { AsyncJobState, SubagentState } from "../../shared/types.ts";
import {
	projectAsyncStatusSnapshot as buildAsyncStatusSnapshot,
	type AsyncStatusSnapshotOptions,
	type AsyncStatusSnapshot,
} from "../shared/async-status-projection.ts";

export {
	ASYNC_STATUS_SNAPSHOT_KIND,
	ASYNC_STATUS_SNAPSHOT_VERSION,
} from "../shared/async-status-projection.ts";
export type {
	AsyncStatusSnapshotActivity,
	AsyncStatusSnapshotCaps,
	AsyncStatusSnapshotHostStep,
	AsyncStatusSnapshotKind,
	AsyncStatusSnapshotNode,
	AsyncStatusSnapshotOmitted,
	AsyncStatusSnapshotOptions,
	AsyncStatusSnapshotState,
	AsyncStatusSnapshot,
} from "../shared/async-status-projection.ts";

export const ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

export { buildAsyncStatusSnapshot };

export function asyncStatusSnapshotJobsForState(state: SubagentState | undefined, sessionId: string | null | undefined): AsyncJobState[] {
	if (!state || !sessionId || state.currentSessionId !== sessionId) return [];
	const jobs = new Map<string, AsyncJobState>();
	for (const job of state.asyncJobs.values()) {
		if (job.sessionId === sessionId) jobs.set(job.asyncId, job);
	}
	for (const job of state.fleetJobs?.values() ?? []) {
		if (job.sessionId === sessionId && !jobs.has(job.asyncId)) jobs.set(job.asyncId, job);
	}
	return [...jobs.values()];
}

export function buildAsyncStatusSnapshotForState(state: SubagentState | undefined, sessionId: string | null | undefined, options: AsyncStatusSnapshotOptions = {}): AsyncStatusSnapshot {
	return buildAsyncStatusSnapshot(asyncStatusSnapshotJobsForState(state, sessionId), options);
}

export function encodeAsyncStatusSnapshotWidget(jobs: Iterable<AsyncJobState>, options: AsyncStatusSnapshotOptions = {}): string[] {
	return [`${ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX}${JSON.stringify(buildAsyncStatusSnapshot(jobs, options))}`];
}
