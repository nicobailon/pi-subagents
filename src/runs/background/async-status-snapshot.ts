import type { AsyncJobState, SubagentState } from "../../shared/types.ts";
import {
	projectAsyncStatusSnapshot,
	type AsyncStatusSnapshotOptions,
	type AsyncStatusSnapshotV1,
} from "../shared/async-status-projection.ts";

export {
	ASYNC_STATUS_SNAPSHOT_KIND,
	ASYNC_STATUS_SNAPSHOT_VERSION,
} from "../shared/async-status-projection.ts";
export type {
	AsyncStatusSnapshotActivityV1,
	AsyncStatusSnapshotCapsV1,
	AsyncStatusSnapshotHostStepV1,
	AsyncStatusSnapshotKind,
	AsyncStatusSnapshotNodeV1,
	AsyncStatusSnapshotOmittedV1,
	AsyncStatusSnapshotOptions,
	AsyncStatusSnapshotState,
	AsyncStatusSnapshotV1,
} from "../shared/async-status-projection.ts";

export const ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

export function buildAsyncStatusSnapshot(jobs: Iterable<AsyncJobState>, options: AsyncStatusSnapshotOptions = {}): AsyncStatusSnapshotV1 {
	return projectAsyncStatusSnapshot(jobs, options);
}

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

export function buildAsyncStatusSnapshotForState(state: SubagentState | undefined, sessionId: string | null | undefined, options: AsyncStatusSnapshotOptions = {}): AsyncStatusSnapshotV1 {
	return buildAsyncStatusSnapshot(asyncStatusSnapshotJobsForState(state, sessionId), options);
}

export function encodeAsyncStatusSnapshotWidget(jobs: Iterable<AsyncJobState>, options: AsyncStatusSnapshotOptions = {}): string[] {
	return [`${ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX}${JSON.stringify(buildAsyncStatusSnapshot(jobs, options))}`];
}
